const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const docusign = require('docusign-esign');
const db = require('../db');
const { requireAuth, requireRole } = require('./auth');
const { canAccessDeal, myDealPartyEntityId, myRepresentsSide, AGENT_LIKE_ROLES } = require('../lib/access');
const { dealDir, genFilename } = require('../lib/storage');
const gcsStorage = require('../lib/gcsStorage');
const driveClient = require('../lib/googleDriveClient');
const docusignClient = require('../lib/docusignClient');
const { fillArmourIndividualEs, SIGNATURE_ANCHOR: ARMOUR_INDIVIDUAL_ANCHOR } = require('../lib/kycFill/armourIndividualEs');
const { fillTlaIndividualEn, SIGNATURE_ANCHOR: TLA_IND_EN_ANCHOR } = require('../lib/kycFill/tlaIndividualEn');
const { fillTlaIndividualEs, SIGNATURE_ANCHOR: TLA_IND_ES_ANCHOR } = require('../lib/kycFill/tlaIndividualEs');
const { fillTlaEntityEn, SIGNATURE_ANCHOR: TLA_ENTITY_EN_ANCHOR } = require('../lib/kycFill/tlaEntityEn');
const { fillArmourMoralEs, SIGNATURE_ANCHOR: ARMOUR_MORAL_ES_ANCHOR } = require('../lib/kycFill/armourMoralEs');
const { fillArmourMoralEn, SIGNATURE_ANCHOR: ARMOUR_MORAL_EN_ANCHOR } = require('../lib/kycFill/armourMoralEn');
const { fillLprIndividualEs, SIGNATURE_ANCHOR: LPR_IND_ES_ANCHOR } = require('../lib/kycFill/lprIndividualEs');
const { fillLprIndividualEn, SIGNATURE_ANCHOR: LPR_IND_EN_ANCHOR } = require('../lib/kycFill/lprIndividualEn');
const { fillLprMoralEs, SIGNATURE_ANCHOR: LPR_MORAL_ES_ANCHOR } = require('../lib/kycFill/lprMoralEs');
const { fillLprMoralEn, SIGNATURE_ANCHOR: LPR_MORAL_EN_ANCHOR } = require('../lib/kycFill/lprMoralEn');
const { convertDocxToPdf } = require('../lib/kycFill/docxFillEngine');

const router = express.Router();

const uploadSigned = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf')
});

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
  },
  'lpr-individual-es': {
    definition: require('../data/kyc-templates/lpr-individual-es.json'),
    fill: fillLprIndividualEs,
    signatureAnchor: LPR_IND_ES_ANCHOR
  },
  'lpr-individual-en': {
    definition: require('../data/kyc-templates/lpr-individual-en.json'),
    fill: fillLprIndividualEn,
    signatureAnchor: LPR_IND_EN_ANCHOR
  },
  'lpr-moral-es': {
    definition: require('../data/kyc-templates/lpr-moral-es.json'),
    fill: fillLprMoralEs,
    signatureAnchor: LPR_MORAL_ES_ANCHOR
  },
  'lpr-moral-en': {
    definition: require('../data/kyc-templates/lpr-moral-en.json'),
    fill: fillLprMoralEn,
    signatureAnchor: LPR_MORAL_EN_ANCHOR
  }
};

// Si el agente que representa el lado de esta parte es de agencia LPR
// Luxury, esa parte ADEMÁS del expediente de la escrow company también
// necesita el de LPR (ver getLatestSubmission/kind — es un expediente
// aparte, no lo reemplaza). Puede haber un agente distinto por lado
// (comprador y vendedor), así que se busca primero el agente que
// específicamente representa ESE lado; si nadie ha elegido lado todavía
// (deals viejos, un solo agente sin representsSide), se usa ese como
// respaldo para no romper el comportamiento anterior.
function dealAgentIsLprAgency(dealId, side) {
  const row = db.prepare(`
    SELECT u.agency FROM deal_parties dp JOIN users u ON u.id = dp.user_id
    WHERE dp.deal_id = ? AND dp.role_in_deal = 'agent' AND (dp.represents_side = ? OR dp.represents_side IS NULL)
    ORDER BY (dp.represents_side IS NULL) ASC LIMIT 1
  `).get(dealId, side);
  return !!row && row.agency === 'LPR Luxury';
}

// Persona física de Armour en inglés todavía no está construida. TLA cubre
// física (EN/ES) y moral solo en EN. `deal.escrow_company` decide entre
// Armour/TLA; `party.party_type` decide individual vs entidad (antes venía
// de deal.buyer_type/seller_type, ahora cada parte tiene el suyo propio);
// `lang` lo elige quien abre el formulario. Si el agente es de LPR Luxury,
// eso manda por encima de la escrow company (ver dealAgentIsLprAgency).
function resolveTemplateKey(deal, party, lang, isLprAgency) {
  const isIndividual = party.party_type === 'individual';

  if (isLprAgency) {
    if (isIndividual) return lang === 'en' ? 'lpr-individual-en' : 'lpr-individual-es';
    return lang === 'en' ? 'lpr-moral-en' : 'lpr-moral-es';
  }

  const company = deal.escrow_company || 'armour';
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

// Copia el expediente KYC generado también a la subcarpeta Vendedor/Comprador
// de Drive — best-effort, no bloquea la generación si Drive no está listo.
async function syncKycToDrive(req, dealId, party, filename, pdfPath, bufferOverride) {
  if (!driveClient.isConfigured() || !driveClient.isConnected()) return;
  const deal = db.prepare('SELECT drive_folder_id FROM deals WHERE id = ?').get(dealId);
  if (!deal || !deal.drive_folder_id) return;
  try {
    const buffer = bufferOverride || fs.readFileSync(pdfPath);
    const subfolder = party.side === 'seller' ? 'Vendedor' : 'Comprador';
    await driveClient.uploadFileToDealSubfolder(req, deal.drive_folder_id, subfolder, filename, buffer, 'application/pdf');
  } catch (err) {
    console.error('[google-drive] no se pudo copiar el KYC a Drive', dealId, filename, err.message);
  }
}

function getSubmission(partyId, templateKey) {
  return db.prepare('SELECT * FROM kyc_submissions WHERE deal_party_entity_id = ? AND template_key = ?')
    .get(partyId, templateKey);
}

// Para rutas posteriores al guardado inicial (generar, enviar a firma,
// firmar, verificar estado) — ya existe una fila con un template_key fijo,
// no hace falta volver a resolver por idioma/compañía.
//
// `kind` distingue entre el expediente de la escrow company ('escrow',
// default) y el de LPR Luxury ('lpr') — cuando el agente es de LPR, una
// misma parte necesita AMBOS expedientes por separado (cada quien pide el
// suyo, no es el mismo formulario reetiquetado), así que puede haber dos
// filas simultáneas en kyc_submissions para el mismo deal_party_entity_id:
// una con template_key tipo armour-.../tla-... y otra lpr-... . Filtrar por
// prefijo evita que "la más reciente" de una pise a la otra.
function getLatestSubmission(partyId, kind) {
  kind = kind || 'escrow';
  const op = kind === 'lpr' ? 'LIKE' : 'NOT LIKE';
  return db.prepare(`SELECT * FROM kyc_submissions WHERE deal_party_entity_id = ? AND template_key ${op} 'lpr-%' ORDER BY id DESC LIMIT 1`)
    .get(partyId);
}

// Solo la propia persona (ligada a esa deal_party_entity_id vía
// deal_parties), o admin/agente/abogado con acceso a la operación, pueden
// ver/llenar ese expediente KYC — cada comprador/vendedor individual solo
// puede tocar el suyo, no el de otra persona del mismo lado.
function canWorkOnKyc(req, dealId, partyId) {
  if (!canAccessDeal(req, dealId)) return false;
  if (['admin', 'lawyer'].includes(req.session.role)) return true;
  if (AGENT_LIKE_ROLES.includes(req.session.role)) {
    const side = myRepresentsSide(req, dealId);
    if (!side) return true; // todavía no eligió lado — no restringe (compatibilidad)
    const party = db.prepare('SELECT side FROM deal_party_entities WHERE id = ?').get(partyId);
    return !!party && party.side === side;
  }
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
  //
  // ?kind=lpr pide el expediente ADICIONAL de LPR Luxury (además del de la
  // escrow company, no en vez de) — ver getLatestSubmission. Solo existe
  // cuando el agente de la operación es de esa agencia.
  const isLprAgency = dealAgentIsLprAgency(id, party.side);
  const kind = req.query.kind === 'lpr' ? 'lpr' : 'escrow';
  if (kind === 'lpr' && !isLprAgency) return res.status(404).json({ error: 'Esta operación no tiene un agente de LPR Luxury.' });

  const existing = getLatestSubmission(partyId, kind);
  const templateKey = existing ? existing.template_key : resolveTemplateKey(deal, party, req.query.lang, kind === 'lpr');
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
      .filter(k => resolveTemplateKey(deal, party, 'es', kind === 'lpr') === k || resolveTemplateKey(deal, party, 'en', kind === 'lpr') === k),
    lprRequired: kind === 'escrow' ? isLprAgency : undefined
  });
});

// DELETE /api/deals/:id/kyc/:partyId — reinicia el expediente (ej. se llenó
// con el idioma/compañía equivocada). Solo staff, y solo si todavía no se
// envió a firma — una vez enviado, borrar la fila local no cancela el sobre
// de DocuSign, así que no se permite.
router.delete('/deals/:id/kyc/:partyId', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), async (req, res) => {
  const { id, partyId } = req.params;
  if (!canAccessDeal(req, id)) return res.status(403).json({ error: 'No autorizado.' });

  const kind = req.query.kind === 'lpr' ? 'lpr' : 'escrow';
  const submission = getLatestSubmission(partyId, kind);
  if (!submission) return res.json({ ok: true });
  if (!['draft', 'generated'].includes(submission.status)) {
    return res.status(400).json({ error: 'Este expediente ya se envió a firma, no se puede reiniciar.' });
  }
  if (submission.generated_file_url) {
    await gcsStorage.deleteFile(submission.generated_file_url);
  }
  db.prepare('DELETE FROM kyc_submissions WHERE id = ?').run(submission.id);
  res.json({ ok: true });
});

// POST /api/deals/:id/kyc/:partyId/upload-signed — a veces el KYC de TLA se
// llena y firma por fuera del portal (en persona, o con otro sistema) — acá
// se sube ya firmado en vez de pasar por el flujo de generar + DocuSign.
// Solo staff, porque es un registro administrativo de algo que ya pasó
// afuera, no algo que la propia parte reporte de sí misma.
router.post('/deals/:id/kyc/:partyId/upload-signed', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), (req, res) => {
  const { id, partyId } = req.params;
  if (!canAccessDeal(req, id)) return res.status(403).json({ error: 'No autorizado.' });

  const deal = loadDeal(id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });
  const party = loadParty(id, partyId);
  if (!party) return res.status(404).json({ error: 'Parte no encontrada.' });

  uploadSigned.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Archivo inválido.' });
    if (!req.file) return res.status(400).json({ error: 'Sube un PDF.' });
    try {
      const kind = req.query.kind === 'lpr' ? 'lpr' : 'escrow';
      const priorSubmission = getLatestSubmission(partyId, kind);
      const templateKey = priorSubmission ? priorSubmission.template_key : resolveTemplateKey(deal, party, req.query.lang, kind === 'lpr');
      if (!templateKey) return res.status(400).json({ error: 'No se pudo determinar qué plantilla KYC le corresponde a esta parte.' });

      const key = path.join(String(id), genFilename(`kyc-${templateKey}-party${partyId}-firmado.pdf`));
      await gcsStorage.uploadBuffer(key, req.file.buffer, 'application/pdf');

      const existing = getSubmission(partyId, templateKey);
      if (existing) {
        db.prepare("UPDATE kyc_submissions SET status = 'signed', generated_file_url = ?, updated_at = datetime('now') WHERE id = ?")
          .run(key, existing.id);
      } else {
        db.prepare(`
          INSERT INTO kyc_submissions (deal_id, deal_party_entity_id, template_key, answers_json, status, generated_file_url, created_by)
          VALUES (?,?,?,'{}','signed',?,?)
        `).run(id, partyId, templateKey, key, req.session.userId);
      }

      res.json({ ok: true });
      const template = TEMPLATES[templateKey];
      syncKycToDrive(req, id, party, `KYC ${(template && template.definition.label) || templateKey} - ${party.name} (firmado).pdf`, null, req.file.buffer);
    } catch (uploadErr) {
      res.status(502).json({ error: uploadErr.message || 'Error al subir el archivo.' });
    }
  });
});

// POST /api/deals/:id/kyc/:partyId — guarda respuestas como borrador.
router.post('/deals/:id/kyc/:partyId', requireAuth, (req, res) => {
  const { id, partyId } = req.params;
  if (!canWorkOnKyc(req, id, partyId)) return res.status(403).json({ error: 'No autorizado.' });

  const deal = loadDeal(id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });
  const party = loadParty(id, partyId);
  if (!party) return res.status(404).json({ error: 'Parte no encontrada.' });

  const kind = req.query.kind === 'lpr' ? 'lpr' : 'escrow';
  const priorSubmission = getLatestSubmission(partyId, kind);
  const templateKey = priorSubmission ? priorSubmission.template_key : resolveTemplateKey(deal, party, req.body?.lang, kind === 'lpr');
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

  const documentBase64 = (await gcsStorage.downloadToBuffer(submission.generated_file_url)).toString('base64');

  const envelopeDefinition = {
    emailSubject: `Firma requerida: ${template.definition.label || 'Expediente KYC'} — ${deal.property}`,
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

  const kind = req.query.kind === 'lpr' ? 'lpr' : 'escrow';
  const submission = getLatestSubmission(partyId, kind);
  if (!submission) return res.status(400).json({ error: 'Guarda el formulario antes de generar el documento.' });
  const template = TEMPLATES[submission.template_key];
  if (!template) return res.status(500).json({ error: 'Plantilla desconocida para este expediente.' });

  try {
    const answers = JSON.parse(submission.answers_json);
    const fileBase = `kyc-${submission.template_key}-party${partyId}-${submission.id}`;
    const docxPath = path.join(dealDir(id), `${fileBase}.docx`);
    template.fill(answers, docxPath);
    const pdfPath = convertDocxToPdf(docxPath);
    const key = path.join(String(id), path.basename(pdfPath));
    await gcsStorage.uploadLocalFile(key, pdfPath, 'application/pdf');
    syncKycToDrive(req, id, party, `KYC ${template.definition.label || submission.template_key} - ${party.name}.pdf`, pdfPath);
    fs.rmSync(docxPath, { force: true });
    fs.rmSync(pdfPath, { force: true });

    db.prepare("UPDATE kyc_submissions SET status = 'generated', generated_file_url = ?, updated_at = datetime('now') WHERE id = ?")
      .run(key, submission.id);

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
router.get('/deals/:id/kyc/:partyId/file', requireAuth, async (req, res) => {
  const { id, partyId } = req.params;
  if (!canWorkOnKyc(req, id, partyId)) return res.status(403).json({ error: 'No autorizado.' });

  const kind = req.query.kind === 'lpr' ? 'lpr' : 'escrow';
  const submission = getLatestSubmission(partyId, kind);
  if (!submission || !submission.generated_file_url) return res.status(404).json({ error: 'Todavía no se ha generado el documento.' });

  if (!await gcsStorage.existsFile(submission.generated_file_url)) return res.status(404).json({ error: 'Archivo no encontrado.' });
  try {
    await gcsStorage.streamToResponse(submission.generated_file_url, res, {
      contentType: 'application/pdf', downloadName: 'expediente-kyc.pdf', inline: true
    });
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: 'Error al leer el archivo.' });
  }
});

// POST /api/deals/:id/kyc/:partyId/send-for-signature — solo admin/agente/
// abogado envían; firma únicamente la persona ligada a esa parte.
router.post('/deals/:id/kyc/:partyId/send-for-signature', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), async (req, res) => {
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

  const kind = req.query.kind === 'lpr' ? 'lpr' : 'escrow';
  const submission = getLatestSubmission(partyId, kind);
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

  const kind = req.query.kind === 'lpr' ? 'lpr' : 'escrow';
  const submission = getLatestSubmission(partyId, kind);
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

  const kind = req.query.kind === 'lpr' ? 'lpr' : 'escrow';
  const submission = getLatestSubmission(partyId, kind);
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
        await gcsStorage.uploadBuffer(submission.generated_file_url, signedBytes, 'application/pdf');
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
