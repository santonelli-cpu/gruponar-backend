const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const docusign = require('docusign-esign');
const db = require('../db');
const { requireAuth, requireRole } = require('./auth');
const { canAccessDeal, myRoleInDeal } = require('../lib/access');
const { genFilename } = require('../lib/storage');
const gcsStorage = require('../lib/gcsStorage');
const driveClient = require('../lib/googleDriveClient');
const docusignClient = require('../lib/docusignClient');
const { extractPlaceholders, fillContractTemplate, countPdfPages } = require('../lib/contractFill/mergeEngine');
const { convertDocxToPdf } = require('../lib/kycFill/docxFillEngine');
const { getSmartSchema, expandSmartFields } = require('../lib/contractFill/smartContractFields');
const { validateBody, z } = require('../lib/validateBody');
const { rateLimitExpensive, rateLimitUpload, rateLimitWrite } = require('../lib/apiRateLimits');

const router = express.Router();

const contractTemplateSchema = z.object({
  scenario: z.enum(['purchase', 'trust', 'transfer', 'trust_termination']),
  label: z.string().trim().min(1, 'Escribe un nombre para el machote.').max(200)
}).strict();

// smartValues es un objeto dinámico (una llave por campo del esquema de
// lib/contractFill/smartContractFields.js, que puede cambiar) — se valida
// que sea un objeto de verdad, no una lista de llaves fijas como el resto.
const contractSelectSchema = z.object({
  templateId: z.number().int().positive().optional(),
  smartValues: z.record(z.string(), z.any()).optional()
}).strict();

// Los machotes (.docx) no son por operación, viven bajo un prefijo fijo del
// bucket — contract_templates.docx_file sigue guardando solo el nombre de
// archivo (sin el prefijo), igual que antes con TEMPLATES_DIR, para no
// necesitar una migración de datos de los machotes ya subidos.
const TEMPLATES_PREFIX = 'contract-templates';
const templateKey = (filename) => `${TEMPLATES_PREFIX}/${filename}`;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
});
const uploadSigned = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf')
});

// extractPlaceholders/fillContractTemplate necesitan un .docx real en disco
// (lo desempacan con el binario `unzip`) — se baja del bucket a un temporal,
// se corre `fn`, y se borra el temporal pase lo que pase.
async function withLocalTemplate(docxFile, fn) {
  const localPath = await gcsStorage.downloadToTempFile(templateKey(docxFile));
  try {
    return await fn(localPath);
  } finally {
    fs.rmSync(localPath, { force: true });
  }
}

// Ancla de firma en el propio machote — el admin/abogado la escribe como
// texto literal dentro del .docx (igual que los placeholders {{CLAVE}}),
// donde quiere que caiga la firma del PRIMER comprador/vendedor. Con el
// modelo multi-parte puede haber más de un firmante del mismo lado; el
// primero usa esta ancla del machote, los siguientes usan una ancla propia
// (/sig1_2/, /sig1_3/...) que se agrega automáticamente al documento en
// mergeEngine.insertExtraSignatureParagraphs — así cada firmante tiene su
// propio punto en el PDF y DocuSign no superpone varias firmas.
const SIGNATURE_ANCHOR_BUYER = '/sig1/';
const SIGNATURE_ANCHOR_SELLER = '/sig2/';

function anchorForSigner(side, indexInSide) {
  const base = side === 'buyer' ? SIGNATURE_ANCHOR_BUYER : SIGNATURE_ANCHOR_SELLER;
  return indexInSide === 0 ? base : base.replace(/\/$/, `_${indexInSide + 1}/`);
}

// Firmantes reales de una operación (comprador(es) + vendedor(es) con cuenta
// ligada), en un orden estable — el mismo orden se usa tanto para generar el
// documento (extraSigners en fillContractTemplate) como para armar el sobre
// de DocuSign, así los anchors coinciden entre ambos pasos.
function loadSigners(dealId) {
  return db.prepare(`
    SELECT u.id AS userId, u.name, u.email, dp.role_in_deal AS roleInDeal
    FROM deal_parties dp JOIN users u ON u.id = dp.user_id
    WHERE dp.deal_id = ? AND dp.role_in_deal IN ('buyer','seller')
    ORDER BY CASE dp.role_in_deal WHEN 'buyer' THEN 0 ELSE 1 END, dp.id
  `).all(dealId);
}

// Índice de cada firmante dentro de su propio lado (0 = primero, usa el
// anchor del machote; 1+ = firmantes extra, usan un anchor generado).
function withSideIndex(signers) {
  const counters = { buyer: 0, seller: 0 };
  return signers.map(s => ({ ...s, sideIndex: counters[s.roleInDeal]++ }));
}

function loadDeal(dealId) {
  return db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId);
}

// Carpeta de trabajo local temporal (LibreOffice/unzip necesitan archivos
// reales en disco) — el resultado final se sube a Cloud Storage y esta
// carpeta se borra, no es donde vive el archivo permanentemente.
function dealContractScratchDir(dealId) {
  const dir = path.join(os.tmpdir(), 'contract-scratch', String(dealId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Copia el contrato de promesa generado a la subcarpeta Propiedad de Drive
// (es de la operación en general, no de una parte específica) — best-effort.
async function syncContractToDrive(req, dealId, property, pdfPath, bufferOverride) {
  if (!driveClient.isConfigured() || !driveClient.isConnected()) return;
  const deal = db.prepare('SELECT drive_folder_id FROM deals WHERE id = ?').get(dealId);
  if (!deal || !deal.drive_folder_id) return;
  try {
    const buffer = bufferOverride || fs.readFileSync(pdfPath);
    await driveClient.uploadFileToDealSubfolder(req, deal.drive_folder_id, 'Propiedad', `Contrato de Promesa - ${property}.pdf`, buffer, 'application/pdf');
  } catch (err) {
    console.error('[google-drive] no se pudo copiar el contrato a Drive', dealId, err.message);
  }
}

// GET /api/contract-templates?scenario=purchase — machotes disponibles para
// ese tipo de operación. Solo admin/abogado eligen machote.
router.get('/contract-templates', requireRole('admin', 'lawyer'), (req, res) => {
  const { scenario } = req.query;
  const rows = scenario
    ? db.prepare('SELECT id, scenario, label, created_at FROM contract_templates WHERE scenario = ? ORDER BY created_at DESC').all(scenario)
    : db.prepare('SELECT id, scenario, label, created_at FROM contract_templates ORDER BY created_at DESC').all();
  res.json(rows);
});

// POST /api/contract-templates — sube un machote nuevo (.docx con {{CLAVE}}).
router.post('/contract-templates', requireRole('admin', 'lawyer'), rateLimitUpload, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Archivo inválido.' });
    if (!req.file) return res.status(400).json({ error: 'Sube un archivo .docx.' });
    // multer ya separó los campos de texto del archivo — validar aquí en
    // vez de como middleware normal, porque un validateBody de antes no
    // vería nada (multer todavía no corrió, req.body llegaría vacío).
    const parsed = contractTemplateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return res.status(400).json({ error: `Dato inválido: ${issue.message}` });
    }
    const { scenario, label } = parsed.data;
    try {
      const filename = genFilename(req.file.originalname);
      await gcsStorage.uploadBuffer(templateKey(filename), req.file.buffer, req.file.mimetype);
      const info = db.prepare('INSERT INTO contract_templates (scenario, label, docx_file, created_by) VALUES (?,?,?,?)')
        .run(scenario, label, filename, req.session.userId);
      res.json({ id: info.lastInsertRowid });
    } catch (uploadErr) {
      res.status(502).json({ error: uploadErr.message || 'Error al subir el machote.' });
    }
  });
});

// DELETE /api/contract-templates/:id — quita un machote de la lista (no
// afecta contratos ya generados con él, esos ya son archivos independientes).
router.delete('/contract-templates/:id', requireRole('admin', 'lawyer'), rateLimitWrite, async (req, res) => {
  const tpl = db.prepare('SELECT * FROM contract_templates WHERE id = ?').get(req.params.id);
  if (!tpl) return res.status(404).json({ error: 'Machote no encontrado.' });
  db.prepare('DELETE FROM contract_templates WHERE id = ?').run(tpl.id);
  await gcsStorage.deleteFile(templateKey(tpl.docx_file));
  res.json({ ok: true });
});

// GET /api/deals/:id/contract — admin/abogado: estado completo (machotes
// disponibles + campos detectados + valores guardados). Agente/comprador
// /vendedor: solo lo necesario para ver el contrato ya preparado (nada de
// machotes en blanco) — generar y editar el contrato es trabajo exclusivo
// de admin/abogado.
router.get('/deals/:id/contract', requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!canAccessDeal(req, id)) return res.status(403).json({ error: 'No autorizado.' });
  const deal = loadDeal(id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });

  const myRole = myRoleInDeal(req, id);
  const isParty = ['buyer', 'seller', 'agent'].includes(myRole);

  if (isParty) {
    return res.json({
      status: deal.contract_status,
      docusignStatus: deal.contract_docusign_status,
      hasDocument: !!deal.contract_generated_file_url
    });
  }

  const templates = db.prepare('SELECT id, scenario, label, created_at FROM contract_templates WHERE scenario = ? ORDER BY created_at DESC').all(deal.scenario);
  const template = deal.contract_template_id ? db.prepare('SELECT * FROM contract_templates WHERE id = ?').get(deal.contract_template_id) : null;
  // `rawFieldCount` es solo informativo (para el aviso de "detectamos N
  // campos, X ya salen solos") — el formulario que llena el admin es el
  // esquema compacto de smartContractFields, no la lista cruda de {{CLAVE}}.
  const rawFieldCount = template
    ? await withLocalTemplate(template.docx_file, (localPath) => extractPlaceholders(localPath).length)
    : 0;

  res.json({
    templates,
    selectedTemplateId: deal.contract_template_id,
    schema: template ? getSmartSchema() : null,
    rawFieldCount,
    smartValues: JSON.parse(deal.contract_json || '{}'),
    status: deal.contract_status,
    docusignStatus: deal.contract_docusign_status,
    hasDocument: !!deal.contract_generated_file_url
  });
});

// POST /api/deals/:id/contract — elige machote y/o guarda las respuestas del
// formulario inteligente (ver lib/contractFill/smartContractFields).
router.post('/deals/:id/contract', requireRole('admin', 'lawyer'), rateLimitWrite, validateBody(contractSelectSchema), (req, res) => {
  const { id } = req.params;
  if (!canAccessDeal(req, id)) return res.status(403).json({ error: 'No autorizado.' });
  const deal = loadDeal(id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });

  const { templateId, smartValues } = req.body;
  if (templateId !== undefined) {
    const tpl = db.prepare('SELECT * FROM contract_templates WHERE id = ? AND scenario = ?').get(templateId, deal.scenario);
    if (!tpl) return res.status(400).json({ error: 'Machote inválido para el tipo de operación de esta venta.' });
  }

  db.prepare('UPDATE deals SET contract_template_id = COALESCE(?, contract_template_id), contract_json = ? WHERE id = ?')
    .run(templateId ?? null, JSON.stringify(smartValues || JSON.parse(deal.contract_json || '{}')), id);

  res.json({ ok: true });
});

// POST /api/deals/:id/contract/generate — mail-merge del machote elegido +
// conversión a PDF. Un solo botón produce ambos formatos: el .docx (para que
// el admin lo descargue) y el .pdf (para verlo en el portal y mandarlo a
// firma).
router.post('/deals/:id/contract/generate', requireRole('admin', 'lawyer'), rateLimitExpensive, async (req, res) => {
  const { id } = req.params;
  if (!canAccessDeal(req, id)) return res.status(403).json({ error: 'No autorizado.' });
  const deal = loadDeal(id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });
  if (!deal.contract_template_id) return res.status(400).json({ error: 'Elige un machote antes de generar el contrato.' });

  const tpl = db.prepare('SELECT * FROM contract_templates WHERE id = ?').get(deal.contract_template_id);
  if (!tpl) return res.status(500).json({ error: 'El machote elegido ya no existe.' });

  let templateLocalPath, docxPath, pdfPath;
  try {
    const smartValues = JSON.parse(deal.contract_json || '{}');
    const values = expandSmartFields(deal, smartValues);
    const extraSigners = withSideIndex(loadSigners(id))
      .filter(s => s.sideIndex > 0)
      .map(s => ({ side: s.roleInDeal, name: s.name, anchor: anchorForSigner(s.roleInDeal, s.sideIndex) }));

    const dir = dealContractScratchDir(id);
    const stamp = Date.now();
    templateLocalPath = await gcsStorage.downloadToTempFile(templateKey(tpl.docx_file));
    docxPath = path.join(dir, `contrato-${stamp}.docx`);
    fillContractTemplate(templateLocalPath, values, docxPath, extraSigners);
    pdfPath = convertDocxToPdf(docxPath);

    const relDocx = path.join(String(id), 'contract', path.basename(docxPath));
    const relPdf = path.join(String(id), 'contract', path.basename(pdfPath));
    await gcsStorage.uploadLocalFile(relDocx, docxPath, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    await gcsStorage.uploadLocalFile(relPdf, pdfPath, 'application/pdf');
    syncContractToDrive(req, id, deal.property, pdfPath);

    db.prepare("UPDATE deals SET contract_status = 'generated', contract_generated_file_url = ? WHERE id = ?")
      .run(relPdf, id);

    res.json({ ok: true, docxFile: relDocx });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error al generar el contrato.' });
  } finally {
    [templateLocalPath, docxPath, pdfPath].forEach(p => { if (p) fs.rmSync(p, { force: true }); });
  }
});

// POST /api/deals/:id/contract/upload-signed — a veces el contrato de
// promesa se redacta/firma por fuera del portal — se sube ya firmado en vez
// de generarlo y mandarlo a DocuSign desde acá.
router.post('/deals/:id/contract/upload-signed', requireRole('admin', 'lawyer'), rateLimitUpload, (req, res) => {
  const { id } = req.params;
  if (!canAccessDeal(req, id)) return res.status(403).json({ error: 'No autorizado.' });
  const deal = loadDeal(id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });

  uploadSigned.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Archivo inválido.' });
    if (!req.file) return res.status(400).json({ error: 'Sube un PDF.' });
    try {
      const key = path.join(String(id), 'contract', genFilename('contrato-firmado.pdf'));
      await gcsStorage.uploadBuffer(key, req.file.buffer, 'application/pdf');
      db.prepare("UPDATE deals SET contract_status = 'signed', contract_generated_file_url = ? WHERE id = ?").run(key, id);
      res.json({ ok: true });
      syncContractToDrive(req, id, deal.property, null, req.file.buffer);
    } catch (uploadErr) {
      res.status(502).json({ error: uploadErr.message || 'Error al subir el archivo.' });
    }
  });
});

// GET /api/deals/:id/contract/file?format=pdf|docx — pdf: cualquiera con
// acceso a la operación (para ver el contrato ya preparado); docx: solo
// admin/abogado (descarga de trabajo, no es lo que firman las partes).
router.get('/deals/:id/contract/file', requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!canAccessDeal(req, id)) return res.status(403).json({ error: 'No autorizado.' });
  const format = req.query.format === 'docx' ? 'docx' : 'pdf';
  if (format === 'docx' && !['admin', 'lawyer'].includes(myRoleInDeal(req, id))) {
    return res.status(403).json({ error: 'Solo tu coordinador puede descargar el .docx de trabajo.' });
  }

  const deal = loadDeal(id);
  if (!deal || !deal.contract_generated_file_url) return res.status(404).json({ error: 'Todavía no se ha generado el contrato.' });

  const pdfKey = deal.contract_generated_file_url;
  const targetKey = format === 'docx' ? pdfKey.replace(/\.pdf$/, '.docx') : pdfKey;
  if (!await gcsStorage.existsFile(targetKey)) return res.status(404).json({ error: 'Archivo no encontrado.' });

  try {
    if (format === 'docx') {
      await gcsStorage.streamToResponse(targetKey, res, {
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        downloadName: 'Contrato de Promesa.docx'
      });
    } else {
      await gcsStorage.streamToResponse(targetKey, res, { contentType: 'application/pdf', downloadName: 'Contrato de Promesa.pdf', inline: true });
    }
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: 'Error al leer el archivo.' });
  }
});

// POST /api/deals/:id/contract/send-for-signature — firma secuencial
// comprador (routingOrder 1) → vendedor (routingOrder 2), mismo patrón que
// el escrow agreement.
router.post('/deals/:id/contract/send-for-signature', requireRole('admin', 'lawyer'), rateLimitExpensive, async (req, res) => {
  const { id } = req.params;
  if (!canAccessDeal(req, id)) return res.status(403).json({ error: 'No autorizado.' });

  if (!docusignClient.isConfigured()) {
    return res.status(501).json({
      error: 'DocuSign no está configurado todavía en este servidor.',
      hint: 'Agrega las variables DOCUSIGN_* en .env (ver README) para activar el envío real.'
    });
  }

  const deal = loadDeal(id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });
  if (deal.contract_status !== 'generated') return res.status(400).json({ error: 'Genera el contrato antes de enviarlo a firma.' });

  // El contrato lo firman TODAS las partes (cada comprador y cada vendedor),
  // no solo los que ya tengan cuenta — si a alguna le falta, se bloquea el
  // envío en vez de mandar el sobre incompleto sin que nadie lo note.
  const missingParties = db.prepare(`
    SELECT name FROM deal_party_entities
    WHERE deal_id = ? AND side IN ('buyer','seller')
      AND id NOT IN (SELECT deal_party_entity_id FROM deal_parties WHERE deal_party_entity_id IS NOT NULL)
  `).all(id);
  if (missingParties.length) {
    return res.status(400).json({
      error: `Falta darles cuenta a: ${missingParties.map(p => p.name).join(', ')} — no pueden firmar sin una. Agrégales un correo (en su parte o en "Invitar") antes de mandar a firma.`
    });
  }

  const signers = withSideIndex(loadSigners(id));
  if (!signers.length) return res.status(400).json({ error: 'Esta operación no tiene comprador ni vendedor con cuenta ligada todavía.' });

  let localPdfPath;
  try {
    localPdfPath = await gcsStorage.downloadToTempFile(deal.contract_generated_file_url);
    const documentBase64 = fs.readFileSync(localPdfPath).toString('base64');

    // Cada hoja del contrato lleva las iniciales de todas las partes (uso
    // habitual en este tipo de documento) — se ubican por posición fija en
    // cada página (no por texto ancla en el footer, más frágil de mantener
    // si el machote cambia de formato), una fila por lado para que no se
    // encimen entre comprador(es) y vendedor(es).
    const pageCount = countPdfPages(localPdfPath);
    const INITIAL_Y_BY_SIDE = { buyer: 730, seller: 755 };

    const envelopeDefinition = {
      emailSubject: `Firma requerida: Contrato de Promesa — ${deal.property}`,
      documents: [{ documentBase64, name: 'Contrato de Promesa.pdf', fileExtension: 'pdf', documentId: '1' }],
      recipients: {
        // Sin clientUserId, DocuSign manda el correo de firma directo a cada
        // parte (igual que enviarlo desde su propia página) — no depende de
        // que tengan ni usen una cuenta del portal para firmar.
        signers: signers.map((p, i) => ({
          email: p.email,
          name: p.name,
          recipientId: String(i + 1),
          routingOrder: p.roleInDeal === 'buyer' ? '1' : '2',
          tabs: {
            signHereTabs: [{
              anchorString: anchorForSigner(p.roleInDeal, p.sideIndex),
              anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '0', optional: 'true'
            }],
            initialHereTabs: Array.from({ length: pageCount }, (_, pageIdx) => ({
              documentId: '1',
              pageNumber: String(pageIdx + 1),
              xPosition: String(470 - p.sideIndex * 45),
              yPosition: String(INITIAL_Y_BY_SIDE[p.roleInDeal]),
              optional: 'true'
            }))
          }
        }))
      },
      status: 'sent'
    };

    const apiClient = await docusignClient.getAuthorizedApiClient();
    const envelopesApi = new docusign.EnvelopesApi(apiClient);
    const result = await envelopesApi.createEnvelope(await docusignClient.getAccountId(), { envelopeDefinition });

    db.prepare("UPDATE deals SET contract_status = 'sent', contract_docusign_envelope_id = ?, contract_docusign_status = 'sent' WHERE id = ?")
      .run(result.envelopeId, id);

    res.json({ ok: true, envelopeId: result.envelopeId });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Error al enviar el contrato a firma.' });
  } finally {
    if (localPdfPath) fs.rmSync(localPdfPath, { force: true });
  }
});

// GET /api/deals/:id/contract/status — sincroniza estado del sobre.
router.get('/deals/:id/contract/status', requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!canAccessDeal(req, id)) return res.status(403).json({ error: 'No autorizado.' });

  const deal = loadDeal(id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });
  if (!deal.contract_docusign_envelope_id) return res.json({ docusignStatus: deal.contract_docusign_status });

  try {
    const apiClient = await docusignClient.getAuthorizedApiClient();
    const envelopesApi = new docusign.EnvelopesApi(apiClient);
    const envelope = await envelopesApi.getEnvelope(await docusignClient.getAccountId(), deal.contract_docusign_envelope_id);
    const newStatus = envelope.status === 'completed' ? 'signed' : deal.contract_status;

    if (envelope.status === 'completed' && deal.contract_status !== 'signed' && deal.contract_generated_file_url) {
      try {
        const signedBytes = await docusignClient.downloadEnvelopeDocument(deal.contract_docusign_envelope_id);
        await gcsStorage.uploadBuffer(deal.contract_generated_file_url, signedBytes, 'application/pdf');
      } catch (docErr) {
        // No bloquea la sincronización de estado — se puede reintentar en
        // la próxima llamada a /status.
      }
    }

    db.prepare('UPDATE deals SET contract_docusign_status = ?, contract_status = ? WHERE id = ?')
      .run(envelope.status, newStatus, id);

    res.json({ docusignStatus: envelope.status, status: newStatus });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Error al consultar el estado en DocuSign.' });
  }
});

module.exports = router;
