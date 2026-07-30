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

// Si CUALQUIER agente de esta operación es de agencia LPR Luxury, TODAS las
// partes (comprador y vendedor, sin importar a cuál de los dos represente
// ese agente) además del expediente de la escrow company también necesitan
// el de LPR (ver getLatestSubmission/kind — es un expediente aparte, no lo
// reemplaza).
function dealAgentIsLprAgency(dealId) {
  const row = db.prepare(`
    SELECT 1 FROM deal_parties dp JOIN users u ON u.id = dp.user_id
    WHERE dp.deal_id = ? AND dp.role_in_deal = 'agent' AND u.agency = 'LPR Luxury' LIMIT 1
  `).get(dealId);
  return !!row;
}

// Nacionalidad típica de cada lado según el tipo de operación — ya estaba
// implícita en data/scenario-docs.json (CURP/RFC = mexicano, Pasaporte +
// Estatus migratorio = extranjero) pero nunca se usaba para el idioma del
// KYC, que por defecto siempre caía en español a menos que alguien eligiera
// inglés a mano. Compraventa directa: ambos mexicanos. Fideicomiso
// (constitución): vendedor mexicano, comprador extranjero (por eso necesita
// fideicomiso). Cesión de derechos: ambos extranjeros (se ceden derechos de
// fideicomiso entre extranjeros). Extinción de fideicomiso: vendedor
// extranjero (sale del fideicomiso), comprador mexicano (adquiere directo).
const DEFAULT_KYC_LANG_BY_SCENARIO_SIDE = {
  purchase: { seller: 'es', buyer: 'es' },
  trust: { seller: 'es', buyer: 'en' },
  transfer: { seller: 'en', buyer: 'en' },
  trust_termination: { seller: 'en', buyer: 'es' }
};

function defaultKycLang(deal, party) {
  const bySide = DEFAULT_KYC_LANG_BY_SCENARIO_SIDE[deal.scenario];
  return (bySide && bySide[party.side]) || 'es';
}

// Persona física de Armour en inglés todavía no está construida. TLA cubre
// física (EN/ES) y moral solo en EN. `deal.escrow_company` decide entre
// Armour/TLA; `party.party_type` decide individual vs entidad (antes venía
// de deal.buyer_type/seller_type, ahora cada parte tiene el suyo propio);
// `lang`, si no lo manda quien llama, se resuelve solo según el tipo de
// operación y el lado (ver defaultKycLang arriba) en vez de caer siempre en
// español. Si el agente es de LPR Luxury, eso manda por encima de la
// escrow company (ver dealAgentIsLprAgency).
function resolveTemplateKey(deal, party, lang, isLprAgency) {
  lang = lang || defaultKycLang(deal, party);
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
  const isLprAgency = dealAgentIsLprAgency(id);
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
  // No queda nada que revisar si el expediente mismo se borró.
  db.prepare("DELETE FROM tasks WHERE kyc_submission_id = ? AND status != 'done'").run(submission.id);
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
//
// `embedUserId`: si quien está generando/mandando el expediente ES el mismo
// firmante (el propio comprador/vendedor llenó su formulario y le dio
// "Guardar, generar y enviar" en su propia sesión), se manda como firma
// EMBEBIDA — ya está autenticado y adentro del portal en ese momento, así
// que firmar ahí mismo es mejor que mandarlo a buscar un correo. Si en
// cambio lo llenó/generó staff (agente/abogado) A NOMBRE del cliente, va
// por correo normal de DocuSign (embedUserId null/undefined) — el cliente
// nunca estuvo en el portal, no hay sesión suya que reusar.
async function sendKycEnvelope(deal, party, submission, template, embedUserId) {
  // Nunca crear un segundo sobre para el mismo expediente — antes esta
  // función se volvía a llamar completa en cada reintento de /generate
  // (ej. después de un 502 aunque el envío original sí hubiera funcionado),
  // y cada llamada mandaba un sobre de DocuSign NUEVO al cliente. Los
  // llamadores (POST /generate, POST /send-for-signature) ya revisan esto
  // antes de llegar aquí — este chequeo es el respaldo final para que sea
  // imposible mandarlo dos veces sin importar desde dónde se llame.
  if (submission.docusign_envelope_id) {
    throw new Error('Este expediente ya se mandó a firma.');
  }
  const signer = db.prepare(`
    SELECT u.id AS userId, u.name, u.email FROM deal_parties dp
    JOIN users u ON u.id = dp.user_id
    WHERE dp.deal_party_entity_id = ?
  `).get(party.id);
  if (!signer) {
    throw new Error(`Todavía no hay cuenta ligada a "${party.name}" para firmar este expediente.`);
  }

  const documentBase64 = (await gcsStorage.downloadToBuffer(submission.generated_file_url)).toString('base64');
  const embed = embedUserId && embedUserId === signer.userId;

  const envelopeDefinition = {
    emailSubject: `Firma requerida: ${template.definition.label || 'Expediente KYC'} — ${deal.property}`,
    documents: [{ documentBase64, name: 'Expediente KYC.pdf', fileExtension: 'pdf', documentId: '1' }],
    recipients: {
      signers: [{
        email: signer.email,
        name: signer.name,
        recipientId: '1',
        ...(embed ? { clientUserId: String(signer.userId) } : {}),
        tabs: {
          signHereTabs: [{ anchorString: template.signatureAnchor, anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '-20', optional: 'false' }]
        }
      }]
    },
    status: 'sent'
  };

  const apiClient = await docusignClient.getAuthorizedApiClient();
  const envelopesApi = new docusign.EnvelopesApi(apiClient);
  const result = await envelopesApi.createEnvelope(await docusignClient.getAccountId(), { envelopeDefinition });

  db.prepare("UPDATE kyc_submissions SET status = 'sent', docusign_envelope_id = ?, docusign_status = 'sent', updated_at = datetime('now') WHERE id = ?")
    .run(result.envelopeId, submission.id);

  return result.envelopeId;
}

// Agente/abogado externo puede llenar y generar el KYC, pero ya no lo manda
// a firma directo (ver AGENT_LIKE_ROLES en POST /generate) — esto deja un
// aviso en el Seguimiento del cierre para que admin/abogado interno lo
// revise, además del estado "Generado, sin enviar" que ya se ve en la
// propia sección de KYC. requires_signature=0: lo que falta no es firmar un
// PDF adjunto a la tarea, sino ir a la sección de KYC y darle "Enviar a
// firma" ahí. No duplica la tarea si ya hay una pendiente para este mismo
// expediente (ej. el agente le da "generar" dos veces).
function ensureKycReviewTask(dealId, party, kycSubmissionId, kind) {
  const existing = db.prepare("SELECT id FROM tasks WHERE kyc_submission_id = ? AND status != 'done'").get(kycSubmissionId);
  if (existing) return;
  const suffix = kind === 'lpr' ? ' (LPR Luxury)' : '';
  const labelEs = `Revisar y enviar a firma el KYC de ${party.name}${suffix}`;
  const labelEn = `Review and send for signature: KYC for ${party.name}${suffix}`;
  const nextOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM tasks WHERE deal_id = ?').get(dealId).n;
  db.prepare(`
    INSERT INTO tasks (deal_id, label_en, label_es, requires_signature, doc_type, kyc_submission_id, sort_order, created_at)
    VALUES (?, ?, ?, 0, 'kyc_review', ?, ?, datetime('now'))
  `).run(dealId, labelEn, labelEs, kycSubmissionId, nextOrder);
}

// Se llama al mandar de verdad a firma (desde /generate cuando quien genera
// sí puede auto-enviar, o desde /send-for-signature) — cierra cualquier
// tarea de revisión pendiente que hubiera quedado de un intento anterior de
// un agente, para que no se quede colgada en el tracker una vez que ya se
// mandó.
function completeKycReviewTask(kycSubmissionId) {
  db.prepare("UPDATE tasks SET status = 'done' WHERE kyc_submission_id = ? AND status != 'done'").run(kycSubmissionId);
}

// POST /api/deals/:id/kyc/:partyId/generate — arma el PDF final desde la
// plantilla y, si DocuSign ya está configurado, lo manda a firma
// automáticamente en el mismo paso — EXCEPTO si quien genera es agente o
// abogado externo (AGENT_LIKE_ROLES): en ese caso queda "generado, sin
// enviar" y se crea una tarea para que admin/abogado interno lo revise y lo
// mande él mismo (ver ensureKycReviewTask). Antes cualquiera de los cuatro
// roles podía mandarlo directo, y un reintento de este mismo endpoint
// después de un error (ej. 502) volvía a mandar un sobre de DocuSign nuevo
// cada vez — por eso, si el expediente ya se había mandado antes
// (docusign_envelope_id ya puesto), este endpoint solo regenera el PDF y
// nunca vuelve a intentar el envío.
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
  const alreadySent = !!submission.docusign_envelope_id;

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
    let embedded = false;
    let pendingReview = false;
    if (alreadySent) {
      // Ya se había mandado antes (esto es un reintento, o alguien editó y
      // regeneró el PDF después de enviado) — no se vuelve a mandar el
      // sobre, solo se refleja que sigue "afuera".
      sentForSignature = true;
      embedded = ['buyer', 'seller'].includes(req.session.role);
    } else if (AGENT_LIKE_ROLES.includes(req.session.role)) {
      pendingReview = true;
      ensureKycReviewTask(id, party, submission.id, kind);
    } else if (docusignClient.isConfigured()) {
      try {
        const freshSubmission = db.prepare('SELECT * FROM kyc_submissions WHERE id = ?').get(submission.id);
        // Solo se embebe si quien llama es comprador/vendedor en sesión
        // (llenando lo suyo) — staff generando a nombre del cliente siempre
        // manda por correo normal, sin importar qué diga el frontend.
        const embedUserId = ['buyer', 'seller'].includes(req.session.role) ? req.session.userId : null;
        await sendKycEnvelope(deal, party, freshSubmission, template, embedUserId);
        sentForSignature = true;
        embedded = !!embedUserId;
        completeKycReviewTask(submission.id);
      } catch (err) {
        autoSendError = err.message || 'No se pudo enviar a firma automáticamente.';
      }
    }

    res.json({ ok: true, sentForSignature, autoSendError, embedded, pendingReview });
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

// POST /api/deals/:id/kyc/:partyId/send-for-signature — respaldo manual
// para cuando el auto-envío de /generate no aplicó (agente/abogado externo
// generó y quedó pendiente de revisión) o falló. Solo admin/abogado
// interno — un agente ya no puede mandar un KYC a firma directo, tiene que
// pasar por esta revisión (ver AGENT_LIKE_ROLES en /generate).
router.post('/deals/:id/kyc/:partyId/send-for-signature', requireRole('admin', 'lawyer'), async (req, res) => {
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
    completeKycReviewTask(submission.id);
    res.json({ ok: true, envelopeId });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Error al enviar el expediente a firma.' });
  }
});

// POST /api/deals/:id/kyc/:partyId/signing-url — el firmante en sesión pide
// su propia URL de firma embebida. Solo funciona si el sobre se mandó
// embebido (ver embedUserId en sendKycEnvelope) — si se mandó por correo
// normal (staff lo llenó a nombre del cliente), esto falla porque DocuSign
// nunca registró un clientUserId para ese firmante; en ese caso el cliente
// firma desde el correo que le llegó, no desde aquí.
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
    const result = await envelopesApi.createRecipientView(await docusignClient.getAccountId(), submission.docusign_envelope_id, {
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
    res.status(502).json({ error: err.message || 'Error al generar la URL de firma. Si este expediente se mandó por correo (no lo llenaste tú), fírmalo desde el correo que llegó, no desde aquí.' });
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
    const envelope = await envelopesApi.getEnvelope(await docusignClient.getAccountId(), submission.docusign_envelope_id);
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
