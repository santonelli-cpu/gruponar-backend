const express = require('express');
const fs = require('fs');
const path = require('path');
const docusign = require('docusign-esign');
const db = require('../db');
const { requireAuth, requireRole } = require('./auth');
const { canAccessDeal, myDealPartyEntityId } = require('../lib/access');
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
// Armour/TLA; `party.party_type` decide individual vs entidad (antes venía
// de deal.buyer_type/seller_type, ahora cada parte tiene el suyo propio);
// `lang` lo elige quien abre el formulario.
function resolveTemplateKey(deal, party, lang) {
  const company = deal.escrow_company || 'armour';
  const isIndividual = party.party_type === 'individual';

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

function loadParty(dealId, partyId) {
  return db.prepare('SELECT * FROM deal_party_entities WHERE id = ? AND deal_id = ?').get(partyId, dealId);
}

function getSubmission(partyId, templateKey) {
  return db.prepare('SELECT * FROM kyc_submissions WHERE deal_party_entity_id = ? AND template_key = ?')
    .get(partyId, templateKey);
}

// Para rutas posteriores al guardado inicial (generar, enviar a firma,
// firmar, verificar estado) — ya existe una fila con un template_key fijo,
// no hace falta volver a resolver por idioma/compañía.
function getLatestSubmission(partyId) {
  return db.prepare('SELECT * FROM kyc_submissions WHERE deal_party_entity_id = ? ORDER BY id DESC LIMIT 1')
    .get(partyId);
}

// Solo la propia persona (ligada a esa deal_party_entity_id vía
// deal_parties), o admin/agente/abogado con acceso a la operación, pueden
// ver/llenar ese expediente KYC — cada comprador/vendedor individual solo
// puede tocar el suyo, no el de otra persona del mismo lado.
function canWorkOnKyc(req, dealId, partyId) {
  if (!canAccessDeal(req, dealId)) return false;
  if (['admin', 'agent', 'lawyer'].includes(req.session.role)) return true;
  return myDealPartyEntityId(req, dealId) === Number(partyId);
}

// GET /api/deals/:id/kyc/:partyId — definición de campos + borrador si existe.
router.get('/deals/:id/kyc/:partyId', requireAuth, (req, res) => {
  const { id, partyId } = req.params;
  if (!canWorkOnKyc(req, id, partyId)) return res.status(403).json({ error: 'No autorizado.' });

  const deal = loadDeal(id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });
  const party = loadParty(id, partyId);
  if (!party) return res.status(404).json({ error: 'Parte no encontrada.' });

  // Si ya hay un borrador/expediente guardado, seguimos con ese idioma tal
  // cual (no lo cambia un ?lang= distinto a medio llenar); si no existe
  // todavía, ?lang= (o el idioma por defecto de la plantilla) decide cuál.
  const existing = getLatestSubmission(partyId);
  const templateKey = existing ? existing.template_key : resolveTemplateKey(deal, party, req.query.lang);
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
      .filter(k => resolveTemplateKey(deal, party, 'es') === k || resolveTemplateKey(deal, party, 'en') === k)
  });
});

// DELETE /api/deals/:id/kyc/:partyId — reinicia el expediente (ej. se llenó
// con el idioma/compañía equivocada). Solo staff, y solo si todavía no se
// envió a firma — una vez enviado, borrar la fila local no cancela el sobre
// de DocuSign, así que no se permite.
router.delete('/deals/:id/kyc/:partyId', requireRole('admin', 'agent', 'lawyer'), (req, res) => {
  const { id, partyId } = req.params;
  if (!canAccessDeal(req, id)) return res.status(403).json({ error: 'No autorizado.' });

  const submission = getLatestSubmission(partyId);
  if (!submission) return res.json({ ok: true });
  if (!['draft', 'generated'].includes(submission.status)) {
    return res.status(400).json({ error: 'Este expediente ya se envió a firma, no se puede reiniciar.' });
  }
  if (submission.generated_file_url) {
    const { UPLOADS_ROOT } = require('../lib/storage');
    const resolved = path.resolve(UPLOADS_ROOT, submission.generated_file_url);
    if (resolved.startsWith(path.resolve(UPLOADS_ROOT) + path.sep)) fs.rmSync(resolved, { force: true });
  }
  db.prepare('DELETE FROM kyc_submissions WHERE id = ?').run(submission.id);
  res.json({ ok: true });
});

// POST /api/deals/:id/kyc/:partyId — guarda respuestas como borrador.
router.post('/deals/:id/kyc/:partyId', requireAuth, (req, res) => {
  const { id, partyId } = req.params;
  if (!canWorkOnKyc(req, id, partyId)) return res.status(403).json({ error: 'No autorizado.' });

  const deal = loadDeal(id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });
  const party = loadParty(id, partyId);
  if (!party) return res.status(404).json({ error: 'Parte no encontrada.' });

  const priorSubmission = getLatestSubmission(partyId);
  const templateKey = priorSubmission ? priorSubmission.template_key : resolveTemplateKey(deal, party, req.body?.lang);
  if (!templateKey || !TEMPLATES[templateKey]) return res.status(501).json({ error: 'Plantilla no disponible todavía.' });

  const { answers } = req.body || {};
  const existing = getSubmission(partyId, templateKey);
  if (existing) {
    db.prepare("UPDATE kyc_submissions SET answers_json = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(answers || {}), existing.id);
  } else {
    db.prepare('INSERT INTO kyc_submissions (deal_id, deal_party_entity_id, template_key, answers_json, created_by) VALUES (?,?,?,?,?)')
      .run(id, partyId, templateKey, JSON.stringify(answers || {}), req.session.userId);
  }
  res.json({ ok: true });
});

// Arma y manda el sobre de DocuSign para un expediente ya generado —
// compartido entre el auto-envío de /generate y el botón manual de
// /send-for-signature (que sigue existiendo como respaldo si el auto-envío
// falla, ej. DocuSign se configuró después, o la persona todavía no tenía
// cuenta ligada en el momento de generar). Como máximo hay 1 usuario por
// deal_party_entity_id (UNIQUE en deal_parties), así que el firmante nunca
// es ambiguo aunque haya varios compradores/vendedores en la operación.
async function sendKycEnvelope(deal, party, submission, template) {
  const signer = db.prepare(`
    SELECT u.id AS userId, u.name, u.email FROM deal_parties dp
    JOIN users u ON u.id = dp.user_id
    WHERE dp.deal_party_entity_id = ?
  `).get(party.id);
  if (!signer) {
    throw new Error(`Todavía no hay cuenta ligada a "${party.name}" para firmar este expediente.`);
  }

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

  return result.envelopeId;
}

// POST /api/deals/:id/kyc/:partyId/generate — arma el PDF final desde la
// plantilla y, si DocuSign ya está configurado y el firmante tiene cuenta
// ligada, lo manda a firma automáticamente en el mismo paso.
router.post('/deals/:id/kyc/:partyId/generate', requireAuth, async (req, res) => {
  const { id, partyId } = req.params;
  if (!canWorkOnKyc(req, id, partyId)) return res.status(403).json({ error: 'No autorizado.' });

  const deal = loadDeal(id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });
  const party = loadParty(id, partyId);
  if (!party) return res.status(404).json({ error: 'Parte no encontrada.' });

  const submission = getLatestSubmission(partyId);
  if (!submission) return res.status(400).json({ error: 'Guarda el formulario antes de generar el documento.' });
  const template = TEMPLATES[submission.template_key];
  if (!template) return res.status(500).json({ error: 'Plantilla desconocida para este expediente.' });

  try {
    const answers = JSON.parse(submission.answers_json);
    const fileBase = `kyc-${submission.template_key}-party${partyId}-${submission.id}`;
    const docxPath = path.join(dealDir(id), `${fileBase}.docx`);
    template.fill(answers, docxPath);
    const pdfPath = convertDocxToPdf(docxPath);
    const relPath = path.join(String(id), path.basename(pdfPath));

    db.prepare("UPDATE kyc_submissions SET status = 'generated', generated_file_url = ?, updated_at = datetime('now') WHERE id = ?")
      .run(relPath, submission.id);

    let sentForSignature = false;
    let autoSendError = null;
    if (docusignClient.isConfigured()) {
      try {
        const freshSubmission = db.prepare('SELECT * FROM kyc_submissions WHERE id = ?').get(submission.id);
        await sendKycEnvelope(deal, party, freshSubmission, template);
        sentForSignature = true;
      } catch (err) {
        autoSendError = err.message || 'No se pudo enviar a firma automáticamente.';
      }
    }

    res.json({ ok: true, sentForSignature, autoSendError });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error al generar el documento.' });
  }
});

// GET /api/deals/:id/kyc/:partyId/file — descarga autenticada del PDF generado.
router.get('/deals/:id/kyc/:partyId/file', requireAuth, (req, res) => {
  const { id, partyId } = req.params;
  if (!canWorkOnKyc(req, id, partyId)) return res.status(403).json({ error: 'No autorizado.' });

  const submission = getLatestSubmission(partyId);
  if (!submission || !submission.generated_file_url) return res.status(404).json({ error: 'Todavía no se ha generado el documento.' });

  const { UPLOADS_ROOT } = require('../lib/storage');
  const resolved = path.resolve(UPLOADS_ROOT, submission.generated_file_url);
  if (!resolved.startsWith(path.resolve(UPLOADS_ROOT) + path.sep)) return res.status(400).json({ error: 'Ruta inválida.' });
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Archivo no encontrado.' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="expediente-kyc.pdf"');
  res.sendFile(resolved);
});

// POST /api/deals/:id/kyc/:partyId/send-for-signature — solo admin/agente/
// abogado envían; firma únicamente la persona ligada a esa parte.
router.post('/deals/:id/kyc/:partyId/send-for-signature', requireRole('admin', 'agent', 'lawyer'), async (req, res) => {
  const { id, partyId } = req.params;
  if (!canAccessDeal(req, id)) return res.status(403).json({ error: 'No autorizado.' });

  if (!docusignClient.isConfigured()) {
    return res.status(501).json({
      error: 'DocuSign no está configurado todavía en este servidor.',
      hint: 'Agrega las variables DOCUSIGN_* en .env (ver README) para activar el envío real.'
    });
  }

  const deal = loadDeal(id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });
  const party = loadParty(id, partyId);
  if (!party) return res.status(404).json({ error: 'Parte no encontrada.' });

  const submission = getLatestSubmission(partyId);
  if (!submission || submission.status !== 'generated') {
    return res.status(400).json({ error: 'Genera el documento antes de enviarlo a firma.' });
  }
  const template = TEMPLATES[submission.template_key];
  if (!template) return res.status(500).json({ error: 'Plantilla desconocida para este expediente.' });

  try {
    const envelopeId = await sendKycEnvelope(deal, party, submission, template);
    res.json({ ok: true, envelopeId });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Error al enviar el expediente a firma.' });
  }
});

// POST /api/deals/:id/kyc/:partyId/signing-url — el firmante en sesión pide
// su propia URL de firma embebida.
router.post('/deals/:id/kyc/:partyId/signing-url', requireAuth, async (req, res) => {
  const { id, partyId } = req.params;
  if (!canAccessDeal(req, id)) return res.status(403).json({ error: 'No autorizado.' });
  if (myDealPartyEntityId(req, id) !== Number(partyId)) {
    return res.status(403).json({ error: 'Solo puedes firmar tu propio expediente.' });
  }

  const submission = getLatestSubmission(partyId);
  if (!submission || !submission.docusign_envelope_id) return res.status(400).json({ error: 'Este expediente todavía no se ha enviado a firma.' });

  const me = db.prepare('SELECT name, email FROM users WHERE id = ?').get(req.session.userId);

  try {
    const apiClient = await docusignClient.getAuthorizedApiClient();
    const envelopesApi = new docusign.EnvelopesApi(apiClient);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const result = await envelopesApi.createRecipientView(process.env.DOCUSIGN_ACCOUNT_ID, submission.docusign_envelope_id, {
      recipientViewRequest: {
        returnUrl: `${baseUrl}/sign-return.html?dealId=${id}&kycPartyId=${partyId}`,
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

// GET /api/deals/:id/kyc/:partyId/status — sincroniza estado del sobre.
router.get('/deals/:id/kyc/:partyId/status', requireAuth, async (req, res) => {
  const { id, partyId } = req.params;
  if (!canAccessDeal(req, id)) return res.status(403).json({ error: 'No autorizado.' });

  const submission = getLatestSubmission(partyId);
  if (!submission || !submission.docusign_envelope_id) {
    return res.json({ docusignStatus: submission ? submission.docusign_status : 'not_sent' });
  }

  try {
    const apiClient = await docusignClient.getAuthorizedApiClient();
    const envelopesApi = new docusign.EnvelopesApi(apiClient);
    const envelope = await envelopesApi.getEnvelope(process.env.DOCUSIGN_ACCOUNT_ID, submission.docusign_envelope_id);
    const newStatus = envelope.status === 'completed' ? 'signed' : submission.status;

    // Recién completado — hay que traer el PDF YA FIRMADO y reemplazar el
    // que se mandó a firmar, o "Ver documento" seguiría mostrando el
    // borrador sin firma.
    if (envelope.status === 'completed' && submission.status !== 'signed' && submission.generated_file_url) {
      try {
        const signedBytes = await docusignClient.downloadEnvelopeDocument(submission.docusign_envelope_id);
        const { UPLOADS_ROOT } = require('../lib/storage');
        const resolved = path.resolve(UPLOADS_ROOT, submission.generated_file_url);
        if (resolved.startsWith(path.resolve(UPLOADS_ROOT) + path.sep)) fs.writeFileSync(resolved, signedBytes);
      } catch (docErr) {
        // No bloquea la sincronización de estado si esto falla — se puede
        // reintentar en la próxima llamada a /status.
      }
    }

    db.prepare("UPDATE kyc_submissions SET docusign_status = ?, status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(envelope.status, newStatus, submission.id);

    res.json({ docusignStatus: envelope.status, status: newStatus });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Error al consultar el estado en DocuSign.' });
  }
});

module.exports = router;
