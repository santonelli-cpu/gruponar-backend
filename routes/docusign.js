const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const docusign = require('docusign-esign');
const db = require('../db');
const { requireAuth, requireRole } = require('./auth');
const { canAccessDeal, myRoleInDeal } = require('../lib/access');
const { UPLOADS_ROOT, dealDir, genFilename } = require('../lib/storage');
const docusignClient = require('../lib/docusignClient');
const { fillArmourEscrow } = require('../lib/kycFill/armourEscrow');
const { convertDocxToPdf } = require('../lib/kycFill/docxFillEngine');

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, dealDir(req.params.id)),
    filename: (req, file, cb) => cb(null, genFilename(file.originalname))
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf')
});

function getTask(dealId, taskId) {
  return db.prepare('SELECT * FROM tasks WHERE id = ? AND deal_id = ?').get(taskId, dealId);
}

// Comprador y vendedor son quienes firman los documentos de cierre (escritura,
// KYC del fiduciario, escrow) — son las únicas tareas marcadas
// requires_signature hoy. Comprador siempre primero (routingOrder '1') y
// vendedor después ('2') — DocuSign no habilita la firma del vendedor hasta
// que el comprador complete la suya.
function getSigners(dealId) {
  return db.prepare(`
    SELECT u.id AS userId, u.name, u.email, dp.role_in_deal AS roleInDeal
    FROM deal_parties dp JOIN users u ON u.id = dp.user_id
    WHERE dp.deal_id = ? AND dp.role_in_deal IN ('buyer','seller')
    ORDER BY CASE dp.role_in_deal WHEN 'buyer' THEN 0 ELSE 1 END
  `).all(dealId);
}

// POST /api/deals/:id/tasks/:taskId/document — admin/agente/abogado sube el
// contrato/documento que hay que firmar para esta tarea (distinto del
// checklist KYC de /api/deals, que vive en la tabla documents).
router.post('/deals/:id/tasks/:taskId/document', requireRole('admin', 'agent', 'lawyer'), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const task = getTask(req.params.id, req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada.' });

  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Archivo inválido.' });
    if (!req.file) return res.status(400).json({ error: 'Sube un PDF.' });
    const relPath = path.join(String(req.params.id), req.file.filename);
    db.prepare('UPDATE tasks SET document_url = ?, document_original_name = ? WHERE id = ?')
      .run(relPath, req.file.originalname, task.id);
    res.json({ ok: true });
  });
});

// POST /api/deals/:id/tasks/:taskId/generate-escrow-document — genera el
// escrow agreement de Armour Secure ya llenado (vendedor/comprador salen de
// la operación; el resto lo captura quien llama) y lo deja como el
// documento de esta tarea, listo para enviar a firma con el mismo flujo de
// arriba (comprador firma primero, luego vendedor).
router.post('/deals/:id/tasks/:taskId/generate-escrow-document', requireRole('admin', 'agent', 'lawyer'), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const task = getTask(req.params.id, req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada.' });

  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });

  const { placeDate, purchaseAgreementDescription, depositAmount, fees, expirationDate, noticeAddress } = req.body || {};
  try {
    const docxPath = path.join(dealDir(req.params.id), `escrow-${task.id}-${Date.now()}.docx`);
    fillArmourEscrow(deal, { placeDate, purchaseAgreementDescription, depositAmount, fees, expirationDate, noticeAddress }, docxPath);
    const pdfPath = convertDocxToPdf(docxPath);
    const relPath = path.join(String(req.params.id), path.basename(pdfPath));

    db.prepare('UPDATE tasks SET document_url = ?, document_original_name = ? WHERE id = ?')
      .run(relPath, 'Escrow Agreement.pdf', task.id);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error al generar el escrow agreement.' });
  }
});

// POST /api/deals/:id/tasks/:taskId/send-for-signature — arma el sobre en
// DocuSign con firma embebida para comprador y vendedor.
router.post('/deals/:id/tasks/:taskId/send-for-signature', requireRole('admin', 'agent', 'lawyer'), async (req, res) => {
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

  const signers = getSigners(req.params.id);
  if (!signers.length) {
    return res.status(400).json({ error: 'Esta operación no tiene comprador ni vendedor con cuenta ligada todavía.' });
  }

  try {
    const absPath = path.join(dealDir(req.params.id), path.basename(task.document_url));
    const documentBase64 = fs.readFileSync(absPath).toString('base64');

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
          // Firma secuencial: comprador (routingOrder '1') firma antes que
          // vendedor ('2'). Si el sobre solo tiene un firmante (ej. KYC),
          // todos comparten el mismo routingOrder y no cambia nada.
          routingOrder: p.roleInDeal === 'buyer' ? '1' : '2',
          // clientUserId (cualquier string no vacío) es lo que le dice a
          // DocuSign que este firmante usa firma EMBEBIDA (nuestro iframe)
          // en vez de mandarle un correo — omitirlo rompe todo el flujo.
          clientUserId: String(p.userId),
          tabs: {
            signHereTabs: [{ anchorString: '/sig' + (i + 1) + '/', anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '0', optional: 'true' }]
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

// POST /api/deals/:id/tasks/:taskId/signing-url — el firmante EN SESIÓN pide
// su propia URL de firma embebida (nunca la de otra persona).
router.post('/deals/:id/tasks/:taskId/signing-url', requireAuth, async (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const task = getTask(req.params.id, req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada.' });
  if (!task.docusign_envelope_id) return res.status(400).json({ error: 'Esta tarea todavía no se ha enviado a firma.' });

  const role = myRoleInDeal(req, req.params.id);
  if (!['buyer', 'seller'].includes(role)) {
    return res.status(403).json({ error: 'Solo el comprador o vendedor de esta operación pueden firmar.' });
  }

  const me = db.prepare('SELECT name, email FROM users WHERE id = ?').get(req.session.userId);

  try {
    const apiClient = await docusignClient.getAuthorizedApiClient();
    const envelopesApi = new docusign.EnvelopesApi(apiClient);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const result = await envelopesApi.createRecipientView(process.env.DOCUSIGN_ACCOUNT_ID, task.docusign_envelope_id, {
      recipientViewRequest: {
        returnUrl: `${baseUrl}/sign-return.html?dealId=${req.params.id}&taskId=${req.params.taskId}`,
        authenticationMethod: 'none',
        email: me.email,
        userName: me.name,
        clientUserId: String(req.session.userId)
      }
    });
    res.json({ url: result.url });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Error al generar la URL de firma.' });
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
        const resolved = path.resolve(UPLOADS_ROOT, task.document_url);
        if (resolved.startsWith(path.resolve(UPLOADS_ROOT) + path.sep)) fs.writeFileSync(resolved, signedBytes);
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
