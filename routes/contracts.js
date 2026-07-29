const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const docusign = require('docusign-esign');
const db = require('../db');
const { requireAuth, requireRole } = require('./auth');
const { canAccessDeal, myRoleInDeal } = require('../lib/access');
const { UPLOADS_ROOT, genFilename } = require('../lib/storage');
const docusignClient = require('../lib/docusignClient');
const { extractPlaceholders, fillContractTemplate } = require('../lib/contractFill/mergeEngine');
const { convertDocxToPdf } = require('../lib/kycFill/docxFillEngine');

const router = express.Router();

const TEMPLATES_DIR = path.join(UPLOADS_ROOT, 'contract-templates');
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { fs.mkdirSync(TEMPLATES_DIR, { recursive: true }); cb(null, TEMPLATES_DIR); },
    filename: (req, file, cb) => cb(null, genFilename(file.originalname))
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
});

// Anchors de firma en el propio machote — el admin/abogado los escribe como
// texto literal dentro del .docx (igual que los placeholders {{CLAVE}}),
// donde quiere que caiga la firma de cada parte.
const SIGNATURE_ANCHOR_BUYER = '/sig1/';
const SIGNATURE_ANCHOR_SELLER = '/sig2/';

function loadDeal(dealId) {
  return db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId);
}

function dealContractDir(dealId) {
  const dir = path.join(UPLOADS_ROOT, String(dealId), 'contract');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// GET /api/contract-templates?scenario=purchase — machotes disponibles para
// ese tipo de operación. Solo admin/agente/abogado eligen machote.
router.get('/contract-templates', requireRole('admin', 'agent', 'lawyer'), (req, res) => {
  const { scenario } = req.query;
  const rows = scenario
    ? db.prepare('SELECT id, scenario, label, created_at FROM contract_templates WHERE scenario = ? ORDER BY created_at DESC').all(scenario)
    : db.prepare('SELECT id, scenario, label, created_at FROM contract_templates ORDER BY created_at DESC').all();
  res.json(rows);
});

// POST /api/contract-templates — sube un machote nuevo (.docx con {{CLAVE}}).
router.post('/contract-templates', requireRole('admin', 'agent', 'lawyer'), (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Archivo inválido.' });
    if (!req.file) return res.status(400).json({ error: 'Sube un archivo .docx.' });
    const { scenario, label } = req.body || {};
    if (!scenario || !['purchase', 'trust', 'transfer'].includes(scenario) || !label) {
      fs.rmSync(req.file.path, { force: true });
      return res.status(400).json({ error: 'Faltan campos requeridos (scenario, label).' });
    }
    const info = db.prepare('INSERT INTO contract_templates (scenario, label, docx_file, created_by) VALUES (?,?,?,?)')
      .run(scenario, label, req.file.filename, req.session.userId);
    res.json({ id: info.lastInsertRowid });
  });
});

// DELETE /api/contract-templates/:id — quita un machote de la lista (no
// afecta contratos ya generados con él, esos ya son archivos independientes).
router.delete('/contract-templates/:id', requireRole('admin', 'agent', 'lawyer'), (req, res) => {
  const tpl = db.prepare('SELECT * FROM contract_templates WHERE id = ?').get(req.params.id);
  if (!tpl) return res.status(404).json({ error: 'Machote no encontrado.' });
  db.prepare('DELETE FROM contract_templates WHERE id = ?').run(tpl.id);
  fs.rmSync(path.join(TEMPLATES_DIR, tpl.docx_file), { force: true });
  res.json({ ok: true });
});

// GET /api/deals/:id/contract — admin/agente/abogado: estado completo
// (machotes disponibles + campos detectados + valores guardados). Comprador
// /vendedor: solo lo necesario para ver el contrato ya preparado (nada de
// machotes en blanco).
router.get('/deals/:id/contract', requireAuth, (req, res) => {
  const { id } = req.params;
  if (!canAccessDeal(req, id)) return res.status(403).json({ error: 'No autorizado.' });
  const deal = loadDeal(id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });

  const myRole = myRoleInDeal(req, id);
  const isParty = ['buyer', 'seller'].includes(myRole);

  if (isParty) {
    return res.json({
      status: deal.contract_status,
      docusignStatus: deal.contract_docusign_status,
      hasDocument: !!deal.contract_generated_file_url
    });
  }

  const templates = db.prepare('SELECT id, scenario, label, created_at FROM contract_templates WHERE scenario = ? ORDER BY created_at DESC').all(deal.scenario);
  const template = deal.contract_template_id ? db.prepare('SELECT * FROM contract_templates WHERE id = ?').get(deal.contract_template_id) : null;
  const fields = template ? extractPlaceholders(path.join(TEMPLATES_DIR, template.docx_file)) : [];

  res.json({
    templates,
    selectedTemplateId: deal.contract_template_id,
    fields,
    values: JSON.parse(deal.contract_json || '{}'),
    status: deal.contract_status,
    docusignStatus: deal.contract_docusign_status,
    hasDocument: !!deal.contract_generated_file_url
  });
});

// POST /api/deals/:id/contract — elige machote y/o guarda valores de campos.
router.post('/deals/:id/contract', requireRole('admin', 'agent', 'lawyer'), (req, res) => {
  const { id } = req.params;
  if (!canAccessDeal(req, id)) return res.status(403).json({ error: 'No autorizado.' });
  const deal = loadDeal(id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });

  const { templateId, values } = req.body || {};
  if (templateId !== undefined) {
    const tpl = db.prepare('SELECT * FROM contract_templates WHERE id = ? AND scenario = ?').get(templateId, deal.scenario);
    if (!tpl) return res.status(400).json({ error: 'Machote inválido para el tipo de operación de esta venta.' });
  }

  db.prepare('UPDATE deals SET contract_template_id = COALESCE(?, contract_template_id), contract_json = ? WHERE id = ?')
    .run(templateId ?? null, JSON.stringify(values || JSON.parse(deal.contract_json || '{}')), id);

  res.json({ ok: true });
});

// POST /api/deals/:id/contract/generate — mail-merge del machote elegido +
// conversión a PDF. Un solo botón produce ambos formatos: el .docx (para que
// el admin lo descargue) y el .pdf (para verlo en el portal y mandarlo a
// firma).
router.post('/deals/:id/contract/generate', requireRole('admin', 'agent', 'lawyer'), (req, res) => {
  const { id } = req.params;
  if (!canAccessDeal(req, id)) return res.status(403).json({ error: 'No autorizado.' });
  const deal = loadDeal(id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });
  if (!deal.contract_template_id) return res.status(400).json({ error: 'Elige un machote antes de generar el contrato.' });

  const tpl = db.prepare('SELECT * FROM contract_templates WHERE id = ?').get(deal.contract_template_id);
  if (!tpl) return res.status(500).json({ error: 'El machote elegido ya no existe.' });

  try {
    const values = JSON.parse(deal.contract_json || '{}');
    const dir = dealContractDir(id);
    const stamp = Date.now();
    const docxPath = path.join(dir, `contrato-${stamp}.docx`);
    fillContractTemplate(path.join(TEMPLATES_DIR, tpl.docx_file), values, docxPath);
    const pdfPath = convertDocxToPdf(docxPath);

    const relDocx = path.join(String(id), 'contract', path.basename(docxPath));
    const relPdf = path.join(String(id), 'contract', path.basename(pdfPath));

    db.prepare("UPDATE deals SET contract_status = 'generated', contract_generated_file_url = ? WHERE id = ?")
      .run(relPdf, id);

    res.json({ ok: true, docxFile: relDocx });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error al generar el contrato.' });
  }
});

// GET /api/deals/:id/contract/file?format=pdf|docx — pdf: cualquiera con
// acceso a la operación (para ver el contrato ya preparado); docx: solo
// admin/agente/abogado (descarga de trabajo, no es lo que firman las partes).
router.get('/deals/:id/contract/file', requireAuth, (req, res) => {
  const { id } = req.params;
  if (!canAccessDeal(req, id)) return res.status(403).json({ error: 'No autorizado.' });
  const format = req.query.format === 'docx' ? 'docx' : 'pdf';
  if (format === 'docx' && !['admin', 'agent', 'lawyer'].includes(myRoleInDeal(req, id))) {
    return res.status(403).json({ error: 'Solo tu coordinador puede descargar el .docx de trabajo.' });
  }

  const deal = loadDeal(id);
  if (!deal || !deal.contract_generated_file_url) return res.status(404).json({ error: 'Todavía no se ha generado el contrato.' });

  const pdfRel = deal.contract_generated_file_url;
  const targetRel = format === 'docx' ? pdfRel.replace(/\.pdf$/, '.docx') : pdfRel;
  const resolved = path.resolve(UPLOADS_ROOT, targetRel);
  if (!resolved.startsWith(path.resolve(UPLOADS_ROOT) + path.sep)) return res.status(400).json({ error: 'Ruta inválida.' });
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Archivo no encontrado.' });

  if (format === 'docx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="Contrato de Promesa.docx"');
  } else {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Contrato de Promesa.pdf"');
  }
  res.sendFile(resolved);
});

// POST /api/deals/:id/contract/send-for-signature — firma secuencial
// comprador (routingOrder 1) → vendedor (routingOrder 2), mismo patrón que
// el escrow agreement.
router.post('/deals/:id/contract/send-for-signature', requireRole('admin', 'agent', 'lawyer'), async (req, res) => {
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

  const signers = db.prepare(`
    SELECT u.id AS userId, u.name, u.email, dp.role_in_deal AS roleInDeal
    FROM deal_parties dp JOIN users u ON u.id = dp.user_id
    WHERE dp.deal_id = ? AND dp.role_in_deal IN ('buyer','seller')
    ORDER BY CASE dp.role_in_deal WHEN 'buyer' THEN 0 ELSE 1 END
  `).all(id);
  if (!signers.length) return res.status(400).json({ error: 'Esta operación no tiene comprador ni vendedor con cuenta ligada todavía.' });

  try {
    const absPath = path.resolve(UPLOADS_ROOT, deal.contract_generated_file_url);
    const documentBase64 = fs.readFileSync(absPath).toString('base64');

    const envelopeDefinition = {
      emailSubject: `Firma requerida: Contrato de Promesa — ${deal.property}`,
      documents: [{ documentBase64, name: 'Contrato de Promesa.pdf', fileExtension: 'pdf', documentId: '1' }],
      recipients: {
        signers: signers.map((p, i) => ({
          email: p.email,
          name: p.name,
          recipientId: String(i + 1),
          routingOrder: p.roleInDeal === 'buyer' ? '1' : '2',
          clientUserId: String(p.userId),
          tabs: {
            signHereTabs: [{
              anchorString: p.roleInDeal === 'buyer' ? SIGNATURE_ANCHOR_BUYER : SIGNATURE_ANCHOR_SELLER,
              anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '0', optional: 'true'
            }]
          }
        }))
      },
      status: 'sent'
    };

    const apiClient = await docusignClient.getAuthorizedApiClient();
    const envelopesApi = new docusign.EnvelopesApi(apiClient);
    const result = await envelopesApi.createEnvelope(process.env.DOCUSIGN_ACCOUNT_ID, { envelopeDefinition });

    db.prepare("UPDATE deals SET contract_status = 'sent', contract_docusign_envelope_id = ?, contract_docusign_status = 'sent' WHERE id = ?")
      .run(result.envelopeId, id);

    res.json({ ok: true, envelopeId: result.envelopeId });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Error al enviar el contrato a firma.' });
  }
});

// POST /api/deals/:id/contract/signing-url — el firmante EN SESIÓN pide su
// propia URL de firma embebida.
router.post('/deals/:id/contract/signing-url', requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!canAccessDeal(req, id)) return res.status(403).json({ error: 'No autorizado.' });
  const myRole = myRoleInDeal(req, id);
  if (!['buyer', 'seller'].includes(myRole)) return res.status(403).json({ error: 'Solo el comprador o vendedor pueden firmar.' });

  const deal = loadDeal(id);
  if (!deal || !deal.contract_docusign_envelope_id) return res.status(400).json({ error: 'Este contrato todavía no se ha enviado a firma.' });

  const me = db.prepare('SELECT name, email FROM users WHERE id = ?').get(req.session.userId);

  try {
    const apiClient = await docusignClient.getAuthorizedApiClient();
    const envelopesApi = new docusign.EnvelopesApi(apiClient);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const result = await envelopesApi.createRecipientView(process.env.DOCUSIGN_ACCOUNT_ID, deal.contract_docusign_envelope_id, {
      recipientViewRequest: {
        returnUrl: `${baseUrl}/sign-return.html?dealId=${id}&contract=1`,
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
    const envelope = await envelopesApi.getEnvelope(process.env.DOCUSIGN_ACCOUNT_ID, deal.contract_docusign_envelope_id);
    const newStatus = envelope.status === 'completed' ? 'signed' : deal.contract_status;

    db.prepare('UPDATE deals SET contract_docusign_status = ?, contract_status = ? WHERE id = ?')
      .run(envelope.status, newStatus, id);

    res.json({ docusignStatus: envelope.status, status: newStatus });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Error al consultar el estado en DocuSign.' });
  }
});

module.exports = router;
