const express = require('express');
const fs = require('fs');
const path = require('path');
const docusign = require('docusign-esign');
const db = require('../db');
const { requireAuth } = require('./auth');
const { canAccessDeal, myRoleInDeal } = require('../lib/access');
const { dealDir } = require('../lib/storage');
const docusignClient = require('../lib/docusignClient');
const { fillArmourIndividualEs, SIGNATURE_ANCHOR: ARMOUR_INDIVIDUAL_ANCHOR } = require('../lib/kycFill/armourIndividualEs');
const { fillTlaIndividualEn, SIGNATURE_ANCHOR: TLA_IND_EN_ANCHOR } = require('../lib/kycFill/tlaIndividualEn');
const { fillTlaIndividualEs, SIGNATURE_ANCHOR: TLA_IND_ES_ANCHOR } = require('../lib/kycFill/tlaIndividualEs');
const { fillTlaEntityEn, SIGNATURE_ANCHOR: TLA_ENTITY_EN_ANCHOR } = require('../lib/kycFill/tlaEntityEn');
const { fillArmourMoralEs, SIGNATURE_ANCHOR: ARMOUR_MORAL_ES_ANCHOR } = require('../lib/kycFill/armourMoralEs');
const { fillArmourMoralEn, SIGNATURE_ANCHOR: ARMOUR_MORAL_EN_ANCHOR } = require('../lib/kycFill/armourMoralEn');
const { convertDocxToPdf } = require('../lib/kycFill/docxFillEngine');

const router = express.Router();

// Registro de plantillas disponibles. Cada una: definición de campos +
// función de llenado + anchor de firma (mismo patrón para todas).
const TEMPLATES = {
  'armour-individual-es': {
    definition: require('../data/kyc-templates/armour-individual-es.json'),
    fill: fillArmourIndividualEs,
    signatureAnchor: ARMOUR_INDIVIDUAL_ANCHOR
  },
  'tla-individual-en': {
    definition: require('../data/kyc-templates/tla-individual-en.json'),
    fill: fillTlaIndividualEn,
    signatureAnchor: TLA_IND_EN_ANCHOR
  },
  'tla-individual-es': {
    definition: require('../data/kyc-templates/tla-individual-es.json'),
    fill: fillTlaIndividualEs,
    signatureAnchor: TLA_IND_ES_ANCHOR
  },
  'tla-entity-en': {
    definition: require('../data/kyc-templates/tla-entity-en.json'),
    fill: fillTlaEntityEn,
    signatureAnchor: TLA_ENTITY_EN_ANCHOR
  },
  'armour-moral-es': {
    definition: require('../data/kyc-templates/armour-moral-es.json'),
    fill: fillArmourMoralEs,
    signatureAnchor: ARMOUR_MORAL_ES_ANCHOR
  },
  'armour-moral-en': {
    definition: require('../data/kyc-templates/armour-moral-en.json'),
    fill: fillArmourMoralEn,
    signatureAnchor: ARMOUR_MORAL_EN_ANCHOR
  }
};

// Persona física de Armour en inglés todavía no está construida. TLA cubre
// física (EN/ES) y moral solo en EN. `deal.escrow_company` decide entre
// Armour/TLA (por defecto Armour, para operaciones creadas antes de que
// existiera el campo); `lang` lo elige quien abre el formulario.
function resolveTemplateKey(deal, role, lang) {
  const type = role === 'buyer' ? deal.buyer_type : deal.seller_type;
  const company = deal.escrow_company || 'armour';
  const isIndividual = type === 'individual';

  if (company === 'tla') {
    if (isIndividual) return lang === 'en' ? 'tla-individual-en' : 'tla-individual-es';
    return lang === 'es' ? null : 'tla-entity-en'; // persona moral de TLA solo existe en inglés todavía
  }
  // Armour
  if (isIndividual) return lang === 'en' ? null : 'armour-individual-es'; // Armour física solo en español todavía
  return lang === 'en' ? 'armour-moral-en' : 'armour-moral-es';
}

function loadDeal(dealId) {
  return db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId);
}

function getSubmission(dealId, role, templateKey) {
  return db.prepare('SELECT * FROM kyc_submissions WHERE deal_id = ? AND role_in_deal = ? AND template_key = ?')
    .get(dealId, role, templateKey);
}

// Para rutas posteriores al guardado inicial (generar, enviar a firma,
// firmar, verificar estado) — ya existe una fila con un template_key fijo,
// no hace falta volver a resolver por idioma/compañía.
function getLatestSubmission(dealId, role) {
  return db.prepare('SELECT * FROM kyc_submissions WHERE deal_id = ? AND role_in_deal = ? ORDER BY id DESC LIMIT 1')
    .get(dealId, role);
}

// Solo el propio comprador/vendedor de ese rol, o admin/agente/abogado con
// acceso a la operación, pueden ver/llenar ese expediente KYC.
function canWorkOnKyc(req, dealId, role) {
  if (!canAccessDeal(req, dealId)) return false;
  const myRole = myRoleInDeal(req, dealId);
  if (['admin', 'agent', 'lawyer'].includes(myRole)) return true;
  return myRole === role;
}

// GET /api/deals/:id/kyc/:role — definición de campos + borrador si existe.
router.get('/deals/:id/kyc/:role', requireAuth, (req, res) => {
  const { id, role } = req.params;
  if (!['buyer', 'seller'].includes(role)) return res.status(400).json({ error: 'Rol inválido.' });
  if (!canWorkOnKyc(req, id, role)) return res.status(403).json({ error: 'No autorizado.' });

  const deal = loadDeal(id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });

  // Si ya hay un borrador/expediente guardado, seguimos con ese idioma tal
  // cual (no lo cambia un ?lang= distinto a medio llenar); si no existe
  // todavía, ?lang= (o el idioma por defecto de la plantilla) decide cuál.
  const existing = getLatestSubmission(id, role);
  const templateKey = existing ? existing.template_key : resolveTemplateKey(deal, role, req.query.lang);
  if (!templateKey || !TEMPLATES[templateKey]) {
    return res.status(501).json({ error: 'Todavía no hay una plantilla KYC construida para esta combinación de compañía/tipo de persona/idioma.' });
  }
  const template = TEMPLATES[templateKey];
  const submission = existing && existing.template_key === templateKey ? existing : null;

  res.json({
    templateKey,
    label: template.definition.label,
    sections: template.definition.sections,
    answers: submission ? JSON.parse(submission.answers_json) : {},
    status: submission ? submission.status : 'draft',
    docusignStatus: submission ? submission.docusign_status : 'not_sent',
    generatedFileUrl: submission && submission.generated_file_url ? true : false,
    availableTemplates: Object.keys(TEMPLATES)
      .filter(k => resolveTemplateKey(deal, role, 'es') === k || resolveTemplateKey(deal, role, 'en') === k)
  });
});

// POST /api/deals/:id/kyc/:role — guarda respuestas como borrador.
router.post('/deals/:id/kyc/:role', requireAuth, (req, res) => {
  const { id, role } = req.params;
  if (!['buyer', 'seller'].includes(role)) return res.status(400).json({ error: 'Rol inválido.' });
  if (!canWorkOnKyc(req, id, role)) return res.status(403).json({ error: 'No autorizado.' });

  const deal = loadDeal(id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });
  const priorSubmission = getLatestSubmission(id, role);
  const templateKey = priorSubmission ? priorSubmission.template_key : resolveTemplateKey(deal, role, req.body?.lang);
  if (!templateKey || !TEMPLATES[templateKey]) return res.status(501).json({ error: 'Plantilla no disponible todavía.' });

  const { answers } = req.body || {};
  const existing = getSubmission(id, role, templateKey);
  if (existing) {
    db.prepare("UPDATE kyc_submissions SET answers_json = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(answers || {}), existing.id);
  } else {
    db.prepare('INSERT INTO kyc_submissions (deal_id, role_in_deal, template_key, answers_json, created_by) VALUES (?,?,?,?,?)')
      .run(id, role, templateKey, JSON.stringify(answers || {}), req.session.userId);
  }
  res.json({ ok: true });
});

// POST /api/deals/:id/kyc/:role/generate — arma el PDF final desde la plantilla.
router.post('/deals/:id/kyc/:role/generate', requireAuth, (req, res) => {
  const { id, role } = req.params;
  if (!['buyer', 'seller'].includes(role)) return res.status(400).json({ error: 'Rol inválido.' });
  if (!canWorkOnKyc(req, id, role)) return res.status(403).json({ error: 'No autorizado.' });

  const deal = loadDeal(id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });

  const submission = getLatestSubmission(id, role);
  if (!submission) return res.status(400).json({ error: 'Guarda el formulario antes de generar el documento.' });
  const template = TEMPLATES[submission.template_key];
  if (!template) return res.status(500).json({ error: 'Plantilla desconocida para este expediente.' });

  try {
    const answers = JSON.parse(submission.answers_json);
    const fileBase = `kyc-${submission.template_key}-${role}-${submission.id}`;
    const docxPath = path.join(dealDir(id), `${fileBase}.docx`);
    template.fill(answers, docxPath);
    const pdfPath = convertDocxToPdf(docxPath);
    const relPath = path.join(String(id), path.basename(pdfPath));

    db.prepare("UPDATE kyc_submissions SET status = 'generated', generated_file_url = ?, updated_at = datetime('now') WHERE id = ?")
      .run(relPath, submission.id);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error al generar el documento.' });
  }
});

// GET /api/deals/:id/kyc/:role/file — descarga autenticada del PDF generado.
router.get('/deals/:id/kyc/:role/file', requireAuth, (req, res) => {
  const { id, role } = req.params;
  if (!['buyer', 'seller'].includes(role)) return res.status(400).json({ error: 'Rol inválido.' });
  if (!canWorkOnKyc(req, id, role)) return res.status(403).json({ error: 'No autorizado.' });

  const submission = getLatestSubmission(id, role);
  if (!submission || !submission.generated_file_url) return res.status(404).json({ error: 'Todavía no se ha generado el documento.' });

  const { UPLOADS_ROOT } = require('../lib/storage');
  const resolved = path.resolve(UPLOADS_ROOT, submission.generated_file_url);
  if (!resolved.startsWith(path.resolve(UPLOADS_ROOT) + path.sep)) return res.status(400).json({ error: 'Ruta inválida.' });
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Archivo no encontrado.' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="expediente-kyc.pdf"');
  res.sendFile(resolved);
});

// POST /api/deals/:id/kyc/:role/send-for-signature — solo admin/agente/abogado
// envían; firma únicamente quien llenó el KYC (comprador o vendedor, no ambos).
router.post('/deals/:id/kyc/:role/send-for-signature', requireAuth, async (req, res) => {
  const { id, role } = req.params;
  if (!['buyer', 'seller'].includes(role)) return res.status(400).json({ error: 'Rol inválido.' });
  if (!canAccessDeal(req, id)) return res.status(403).json({ error: 'No autorizado.' });
  const myRole = myRoleInDeal(req, id);
  if (!['admin', 'agent', 'lawyer'].includes(myRole)) return res.status(403).json({ error: 'Solo tu coordinador puede enviar el expediente a firma.' });

  if (!docusignClient.isConfigured()) {
    return res.status(501).json({
      error: 'DocuSign no está configurado todavía en este servidor.',
      hint: 'Agrega las variables DOCUSIGN_* en .env (ver README) para activar el envío real.'
    });
  }

  const deal = loadDeal(id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });

  const submission = getLatestSubmission(id, role);
  if (!submission || submission.status !== 'generated') {
    return res.status(400).json({ error: 'Genera el documento antes de enviarlo a firma.' });
  }
  const template = TEMPLATES[submission.template_key];
  if (!template) return res.status(500).json({ error: 'Plantilla desconocida para este expediente.' });

  const signer = db.prepare(`
    SELECT u.id AS userId, u.name, u.email FROM deal_parties dp
    JOIN users u ON u.id = dp.user_id
    WHERE dp.deal_id = ? AND dp.role_in_deal = ?
  `).get(id, role);
  if (!signer) return res.status(400).json({ error: `No hay ${role === 'buyer' ? 'comprador' : 'vendedor'} con cuenta ligada a esta operación todavía.` });

  try {
    const { UPLOADS_ROOT } = require('../lib/storage');
    const absPath = path.resolve(UPLOADS_ROOT, submission.generated_file_url);
    const documentBase64 = fs.readFileSync(absPath).toString('base64');

    const envelopeDefinition = {
      emailSubject: `Firma requerida: Expediente KYC — ${deal.property}`,
      documents: [{ documentBase64, name: 'Expediente KYC.pdf', fileExtension: 'pdf', documentId: '1' }],
      recipients: {
        signers: [{
          email: signer.email,
          name: signer.name,
          recipientId: '1',
          clientUserId: String(signer.userId),
          tabs: {
            signHereTabs: [{ anchorString: template.signatureAnchor, anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '-20', optional: 'false' }]
          }
        }]
      },
      status: 'sent'
    };

    const apiClient = await docusignClient.getAuthorizedApiClient();
    const envelopesApi = new docusign.EnvelopesApi(apiClient);
    const result = await envelopesApi.createEnvelope(process.env.DOCUSIGN_ACCOUNT_ID, { envelopeDefinition });

    db.prepare("UPDATE kyc_submissions SET status = 'sent', docusign_envelope_id = ?, docusign_status = 'sent', updated_at = datetime('now') WHERE id = ?")
      .run(result.envelopeId, submission.id);

    res.json({ ok: true, envelopeId: result.envelopeId });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Error al enviar el expediente a firma.' });
  }
});

// POST /api/deals/:id/kyc/:role/signing-url — el firmante en sesión pide su
// propia URL de firma embebida.
router.post('/deals/:id/kyc/:role/signing-url', requireAuth, async (req, res) => {
  const { id, role } = req.params;
  if (!canAccessDeal(req, id)) return res.status(403).json({ error: 'No autorizado.' });
  const myRole = myRoleInDeal(req, id);
  if (myRole !== role) return res.status(403).json({ error: 'Solo puedes firmar tu propio expediente.' });

  const submission = getLatestSubmission(id, role);
  if (!submission || !submission.docusign_envelope_id) return res.status(400).json({ error: 'Este expediente todavía no se ha enviado a firma.' });

  const me = db.prepare('SELECT name, email FROM users WHERE id = ?').get(req.session.userId);

  try {
    const apiClient = await docusignClient.getAuthorizedApiClient();
    const envelopesApi = new docusign.EnvelopesApi(apiClient);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const result = await envelopesApi.createRecipientView(process.env.DOCUSIGN_ACCOUNT_ID, submission.docusign_envelope_id, {
      recipientViewRequest: {
        returnUrl: `${baseUrl}/sign-return.html?dealId=${id}&kycRole=${role}`,
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

// GET /api/deals/:id/kyc/:role/status — sincroniza estado del sobre.
router.get('/deals/:id/kyc/:role/status', requireAuth, async (req, res) => {
  const { id, role } = req.params;
  if (!canAccessDeal(req, id)) return res.status(403).json({ error: 'No autorizado.' });

  const submission = getLatestSubmission(id, role);
  if (!submission || !submission.docusign_envelope_id) {
    return res.json({ docusignStatus: submission ? submission.docusign_status : 'not_sent' });
  }

  try {
    const apiClient = await docusignClient.getAuthorizedApiClient();
    const envelopesApi = new docusign.EnvelopesApi(apiClient);
    const envelope = await envelopesApi.getEnvelope(process.env.DOCUSIGN_ACCOUNT_ID, submission.docusign_envelope_id);
    const newStatus = envelope.status === 'completed' ? 'signed' : submission.status;

    db.prepare("UPDATE kyc_submissions SET docusign_status = ?, status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(envelope.status, newStatus, submission.id);

    res.json({ docusignStatus: envelope.status, status: newStatus });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Error al consultar el estado en DocuSign.' });
  }
});

module.exports = router;
