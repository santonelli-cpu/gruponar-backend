const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const docusign = require('docusign-esign');
const db = require('../db');
const { requireAuth, requireRole } = require('./auth');
const { canAccessDeal } = require('../lib/access');
const { dealDir, genFilename } = require('../lib/storage');
const gcsStorage = require('../lib/gcsStorage');
const driveClient = require('../lib/googleDriveClient');
const docusignClient = require('../lib/docusignClient');
const { fillArmourEscrow } = require('../lib/kycFill/armourEscrow');
const { convertDocxToPdf } = require('../lib/kycFill/docxFillEngine');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf')
});

function getTask(dealId, taskId) {
  return db.prepare('SELECT * FROM tasks WHERE id = ? AND deal_id = ?').get(taskId, dealId);
}

// Copia el documento de una tarea (escrow agreement generado, o cualquier
// otro documento de cierre subido a mano) a la subcarpeta Escrow de Drive —
// best-effort, no bloquea la subida/generación real si Drive no está listo.
async function syncTaskDocToDrive(req, dealId, filename, buffer) {
  if (!driveClient.isConfigured() || !driveClient.isConnected()) return;
  const deal = db.prepare('SELECT drive_folder_id FROM deals WHERE id = ?').get(dealId);
  if (!deal || !deal.drive_folder_id) return;
  try {
    await driveClient.uploadFileToDealSubfolder(req, deal.drive_folder_id, 'Escrow', filename, buffer, 'application/pdf');
  } catch (err) {
    console.error('[google-drive] no se pudo copiar el documento de la tarea a Drive', dealId, filename, err.message);
  }
}

// Comprador y vendedor son quienes firman los documentos de cierre (escritura,
// KYC del fiduciario, escrow) — son las únicas tareas marcadas
// requires_signature hoy. Comprador(es) siempre primero (routingOrder '1') y
// vendedor(es) después ('2') — DocuSign no habilita la firma del vendedor
// hasta que el/los comprador(es) completen la suya. dp.id como desempate deja
// un orden estable cuando hay más de un firmante del mismo lado.
// `side`, si se manda, restringe los firmantes a solo ese lado — lo usan las
// tareas de firma ad-hoc (tasks.sign_side, ver POST /deals/:id/tasks abajo)
// para documentos que solo le tocan a comprador o a vendedor, nunca a ambos.
function getSigners(dealId, side) {
  return db.prepare(`
    SELECT u.id AS userId, u.name, u.email, dp.role_in_deal AS roleInDeal
    FROM deal_parties dp JOIN users u ON u.id = dp.user_id
    WHERE dp.deal_id = ? AND dp.role_in_deal IN ('buyer','seller')
      AND (? IS NULL OR dp.role_in_deal = ?)
    ORDER BY CASE dp.role_in_deal WHEN 'buyer' THEN 0 ELSE 1 END, dp.id
  `).all(dealId, side || null, side || null);
}

// Ancla de firma por lado — misma convención que routes/contracts.js y
// lib/kycFill/signatureBlock.js (el bloque de firmas del escrow se genera
// con estos mismos anchors), así un documento con más de un firmante por
// lado no encima varias firmas en el mismo punto.
const SIGNATURE_ANCHOR_BUYER = '/sig1/';
const SIGNATURE_ANCHOR_SELLER = '/sig2/';

function anchorForSigner(side, indexInSide) {
  const base = side === 'buyer' ? SIGNATURE_ANCHOR_BUYER : SIGNATURE_ANCHOR_SELLER;
  return indexInSide === 0 ? base : base.replace(/\/$/, `_${indexInSide + 1}/`);
}

// Índice de cada firmante dentro de su propio lado (0 = primero, usa el
// anchor base; 1+ = firmantes extra, usan el anchor con sufijo _2/_3/...).
function withSideIndex(signers) {
  const counters = { buyer: 0, seller: 0 };
  return signers.map(s => ({ ...s, sideIndex: counters[s.roleInDeal]++ }));
}

// POST /api/deals/:id/tasks — crea una tarea de firma ad-hoc para un
// documento que no tiene su propio renglón fijo en scenario-tasks.json (ej.
// un NDA o un poder que solo aplica a esta operación). Solo admin/abogado
// interno, y siempre eligiendo un solo lado firmante — si hiciera falta que
// firmen ambos ya está el escrow agreement/contrato para eso.
router.post('/deals/:id/tasks', requireRole('admin', 'lawyer'), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const deal = db.prepare('SELECT id FROM deals WHERE id = ?').get(req.params.id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });
  const { label, side } = req.body || {};
  const name = (label || '').trim();
  if (!name) return res.status(400).json({ error: 'Escribe un nombre para el documento.' });
  if (!['buyer', 'seller'].includes(side)) return res.status(400).json({ error: 'Elige si firma el comprador o el vendedor.' });
  const nextOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM tasks WHERE deal_id = ?').get(req.params.id).n;
  const info = db.prepare(`
    INSERT INTO tasks (deal_id, label_en, label_es, requires_signature, doc_type, sign_side, sort_order, created_at)
    VALUES (?, ?, ?, 1, 'manual', ?, ?, datetime('now'))
  `).run(req.params.id, name, name, side, nextOrder);
  res.json({ id: info.lastInsertRowid });
});

// POST /api/deals/:id/tasks/:taskId/document — sube el documento que hay
// que firmar para esta tarea (distinto del checklist KYC de /api/deals, que
// vive en la tabla documents). Solo admin/abogado interno: son documentos
// de cierre (escrow agreement, KYC del fiduciario) que agente/abogado
// externo no deben poder subir/reemplazar por su cuenta.
router.post('/deals/:id/tasks/:taskId/document', requireRole('admin', 'lawyer'), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const task = getTask(req.params.id, req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada.' });

  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Archivo inválido.' });
    if (!req.file) return res.status(400).json({ error: 'Sube un PDF.' });
    try {
      const key = path.join(String(req.params.id), genFilename(req.file.originalname));
      await gcsStorage.uploadBuffer(key, req.file.buffer, req.file.mimetype);
      db.prepare('UPDATE tasks SET document_url = ?, document_original_name = ? WHERE id = ?')
        .run(key, req.file.originalname, task.id);
      res.json({ ok: true });
      syncTaskDocToDrive(req, req.params.id, `${task.label_es} - ${req.file.originalname}`, req.file.buffer);
    } catch (uploadErr) {
      res.status(502).json({ error: uploadErr.message || 'Error al subir el archivo.' });
    }
  });
});

// POST /api/deals/:id/tasks/:taskId/generate-escrow-document — genera el
// escrow agreement de Armour Secure ya llenado (vendedor/comprador salen de
// la operación; el resto lo captura quien llama) y lo deja como el
// documento de esta tarea, listo para enviar a firma con el mismo flujo de
// arriba (comprador firma primero, luego vendedor). Solo admin/abogado
// interno pueden llenar y generar este documento.
router.post('/deals/:id/tasks/:taskId/generate-escrow-document', requireRole('admin', 'lawyer'), async (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const task = getTask(req.params.id, req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada.' });

  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });

  const { placeDate, purchaseAgreementDescription, depositAmount, fees, expirationDate, noticeAddress } = req.body || {};
  // Nombres reales (todos los compradores/vendedores con cuenta ligada, no
  // solo uno por lado) para el cuerpo del documento y para la tabla de
  // firmas — el mismo orden que usa el sobre de DocuSign más abajo, así los
  // anchors del documento generado coinciden con los firmantes reales.
  const signersForNames = getSigners(req.params.id);
  const sellerNames = signersForNames.filter(s => s.roleInDeal === 'seller').map(s => s.name);
  const buyerNames = signersForNames.filter(s => s.roleInDeal === 'buyer').map(s => s.name);

  let docxPath, pdfPath;
  try {
    docxPath = path.join(dealDir(req.params.id), `escrow-${task.id}-${Date.now()}.docx`);
    fillArmourEscrow(deal, { placeDate, purchaseAgreementDescription, depositAmount, fees, expirationDate, noticeAddress }, docxPath, sellerNames, buyerNames);
    pdfPath = convertDocxToPdf(docxPath);
    const key = path.join(String(req.params.id), path.basename(pdfPath));
    await gcsStorage.uploadLocalFile(key, pdfPath, 'application/pdf');
    syncTaskDocToDrive(req, req.params.id, 'Escrow Agreement.pdf', fs.readFileSync(pdfPath));

    db.prepare('UPDATE tasks SET document_url = ?, document_original_name = ? WHERE id = ?')
      .run(key, 'Escrow Agreement.pdf', task.id);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error al generar el escrow agreement.' });
  } finally {
    [docxPath, pdfPath].forEach(p => { if (p) fs.rmSync(p, { force: true }); });
  }
});

// POST /api/deals/:id/tasks/:taskId/send-for-signature — arma el sobre en
// DocuSign (comprador y vendedor firman por correo, sin pasar por el
// portal). Solo admin/abogado interno mandan a firma estos documentos de
// cierre (escrow agreement, KYC del fiduciario, etc.).
router.post('/deals/:id/tasks/:taskId/send-for-signature', requireRole('admin', 'lawyer'), async (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const task = getTask(req.params.id, req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada.' });

  if (!docusignClient.isConfigured()) {
    return res.status(501).json({
      error: 'DocuSign no está configurado todavía en este servidor.',
      hint: 'Agrega las variables DOCUSIGN_* en .env (ver README) para activar el envío real.'
    });
  }
  if (!task.document_url) {
    return res.status(400).json({ error: 'Sube el documento a firmar de esta tarea primero.' });
  }

  // El escrow agreement (y cualquier otro documento de cierre) lo firman
  // TODAS las partes, no solo las que ya tengan cuenta — si a alguna le
  // falta, se bloquea el envío en vez de mandar el sobre incompleto. Si la
  // tarea es ad-hoc y solo le toca a un lado (tasks.sign_side), la revisión
  // se limita a ese lado — al otro no le corresponde firmar este documento.
  const missingParties = db.prepare(`
    SELECT name FROM deal_party_entities
    WHERE deal_id = ? AND side = COALESCE(?, side) AND side IN ('buyer','seller')
      AND id NOT IN (SELECT deal_party_entity_id FROM deal_parties WHERE deal_party_entity_id IS NOT NULL)
  `).all(req.params.id, task.sign_side || null);
  if (missingParties.length) {
    return res.status(400).json({
      error: `Falta darles cuenta a: ${missingParties.map(p => p.name).join(', ')} — no pueden firmar sin una. Agrégales un correo (en su parte o en "Invitar") antes de mandar a firma.`
    });
  }

  const signers = withSideIndex(getSigners(req.params.id, task.sign_side));
  if (!signers.length) {
    return res.status(400).json({ error: 'Esta operación no tiene comprador ni vendedor con cuenta ligada todavía.' });
  }

  try {
    const documentBase64 = (await gcsStorage.downloadToBuffer(task.document_url)).toString('base64');

    const envelopeDefinition = {
      emailSubject: `Firma requerida: ${task.label_es}`,
      documents: [{
        documentBase64,
        name: task.document_original_name || 'Documento.pdf',
        fileExtension: 'pdf',
        documentId: '1'
      }],
      recipients: {
        signers: signers.map((p, i) => ({
          email: p.email,
          name: p.name,
          recipientId: String(i + 1),
          // Firma secuencial: comprador(es) (routingOrder '1') firman antes
          // que vendedor(es) ('2'). Si el sobre solo tiene un firmante (ej.
          // KYC), todos comparten el mismo routingOrder y no cambia nada.
          routingOrder: p.roleInDeal === 'buyer' ? '1' : '2',
          // Sin clientUserId, DocuSign manda el correo de firma directo a
          // cada parte (igual que enviarlo desde su propia página) — no
          // depende de que tengan ni usen una cuenta del portal.
          tabs: {
            // Anchor por lado + índice dentro del lado — con un solo
            // comprador/vendedor coincide con el anchor de siempre
            // (/sig1/, /sig2/); con más de uno por lado, cada firmante
            // extra cae en su propio punto (/sig1_2/, /sig2_2/...), igual
            // que el contrato de promesa y el escrow agreement generado.
            signHereTabs: [{ anchorString: anchorForSigner(p.roleInDeal, p.sideIndex), anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '0', optional: 'true' }]
          }
        }))
      },
      status: 'sent'
    };

    const apiClient = await docusignClient.getAuthorizedApiClient();
    const envelopesApi = new docusign.EnvelopesApi(apiClient);
    const result = await envelopesApi.createEnvelope(process.env.DOCUSIGN_ACCOUNT_ID, { envelopeDefinition });

    db.prepare('UPDATE tasks SET docusign_envelope_id = ?, docusign_status = ? WHERE id = ?')
      .run(result.envelopeId, 'sent', task.id);

    res.json({ ok: true, envelopeId: result.envelopeId });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Error al enviar a firma con DocuSign.' });
  }
});

// GET /api/deals/:id/tasks/:taskId/status — sincroniza el estado del sobre
// (reemplaza al webhook de DocuSign Connect, que necesitaría una URL pública
// y no aplica en localhost) — se llama al volver del iframe de firma, o a
// mano con un botón "Verificar estado".
router.get('/deals/:id/tasks/:taskId/status', requireAuth, async (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const task = getTask(req.params.id, req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada.' });
  if (!task.docusign_envelope_id) return res.json({ docusignStatus: 'not_sent', status: task.status });

  try {
    const apiClient = await docusignClient.getAuthorizedApiClient();
    const envelopesApi = new docusign.EnvelopesApi(apiClient);
    const envelope = await envelopesApi.getEnvelope(process.env.DOCUSIGN_ACCOUNT_ID, task.docusign_envelope_id);

    const docusignStatus = envelope.status;
    const newStatus = docusignStatus === 'completed' ? 'done' : task.status;

    if (docusignStatus === 'completed' && task.status !== 'done' && task.document_url) {
      try {
        const signedBytes = await docusignClient.downloadEnvelopeDocument(task.docusign_envelope_id);
        await gcsStorage.uploadBuffer(task.document_url, signedBytes, 'application/pdf');
      } catch (docErr) {
        // No bloquea la sincronización de estado — se puede reintentar en
        // la próxima llamada a /status.
      }
    }

    db.prepare('UPDATE tasks SET docusign_status = ?, status = ? WHERE id = ?')
      .run(docusignStatus, newStatus, task.id);

    res.json({ docusignStatus, status: newStatus });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Error al consultar el estado en DocuSign.' });
  }
});

module.exports = router;
