const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const multer = require('multer');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, requireRole, resolveAgency } = require('./auth');
const { genFilename } = require('../lib/storage');
const { canAccessDeal, myRoleInDeal, myDealPartyEntityId, myRepresentsSide, UNRESTRICTED_ROLES, AGENT_LIKE_ROLES } = require('../lib/access');
const { isValidEmail } = require('../lib/validate');
const { validateBody, z } = require('../lib/validateBody');
const { rateLimitWrite, rateLimitEmail, rateLimitUpload, rateLimitExpensive } = require('../lib/apiRateLimits');

// Los campos de una parte (vendedor/comprador) varían según partyType y
// ownershipMode (individual vs. entidad, socios directos vs. entidad padre
// vs. trust directo) — el detalle de qué combinación es válida para cuál
// modo lo sigue resolviendo validateParty() más abajo (regla de negocio
// condicional, no le corresponde a un schema plano). Este schema solo
// cubre tipo/largo de cada campo y —vía .strict()— que no venga ningún
// campo que no se espera.
const ownerSchema = z.object({ name: z.string().trim().min(1).max(200) }).strict();
const partyFields = {
  name: z.string().trim().max(300).optional(),
  partyType: z.enum(['individual', 'corporation', 'llc']).optional(),
  ownershipMode: z.enum(['direct_owners', 'parent_entity', 'direct_trust']).optional(),
  owners: z.array(ownerSchema).max(2).optional(),
  parentEntityName: z.string().trim().max(300).optional(),
  parentEntityType: z.enum(['corporation', 'llc']).optional(),
  parentHasTrustAbove: z.boolean().optional(),
  parentTrustName: z.string().trim().max(300).optional(),
  directTrustName: z.string().trim().max(300).optional(),
  email: z.string().trim().max(254).optional(),
  // Apoderado — otra cuenta con las mismas facultades que el titular sobre
  // esta parte (ver registerPartyUserRaw). Solo aplica al editar una parte
  // ya creada (PATCH), no al crearla.
  attorneyName: z.string().trim().max(200).optional(),
  attorneyEmail: z.string().trim().max(254).optional(),
  removeAttorney: z.boolean().optional()
};
const partyInArraySchema = z.object({ ...partyFields, side: z.enum(['buyer', 'seller']) }).strict();
const createPartySchema = z.object({ ...partyFields, side: z.enum(['buyer', 'seller']) }).strict();
// `side` se acepta pero se IGNORA al editar: el formulario de la parte es
// el mismo para dar de alta y para editar, así que siempre lo manda, pero
// una parte no cambia de lado (el handler usa el suyo de la base). Sin esta
// llave, .strict() rechazaba cada edición con "Unrecognized key: side" —
// y con ella se caía justo el paso de ligarle su cuenta al cliente.
const updatePartySchema = z.object({ ...partyFields, side: z.enum(['buyer', 'seller']).optional() }).strict();

const createDealSchema = z.object({
  scenario: z.enum(['purchase', 'trust', 'transfer', 'trust_termination']),
  development: z.string().trim().max(100).optional(),
  property: z.string().trim().min(1, 'Falta el nombre de la operación.').max(300),
  price: z.number().optional(),
  furniturePrice: z.number().optional(),
  currency: z.string().trim().max(10).optional(),
  startDate: z.string().trim().max(30).optional(),
  parties: z.array(partyInArraySchema).min(1),
  escrowCompany: z.enum(['armour', 'tla']).optional()
}).strict();

const updateDealSchema = z.object({
  escrowCompany: z.enum(['armour', 'tla']).optional(),
  closingDate: z.string().trim().max(30).nullable().optional(),
  dueDiligenceEndDate: z.string().trim().max(30).nullable().optional(),
  property: z.string().trim().max(300).optional(),
  price: z.number().optional(),
  furniturePrice: z.number().optional(),
  currency: z.string().trim().max(10).optional(),
  startDate: z.string().trim().max(30).nullable().optional(),
  development: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'completed']).optional(),
  legalActs: z.string().trim().max(5000).nullable().optional()
}).strict();

const addAgentSchema = z.object({
  userId: z.number().int().positive(),
  representsSide: z.enum(['buyer', 'seller']).nullable().optional()
}).strict();

const registerAgentSchema = z.object({
  name: z.string().trim().min(1, 'Falta el nombre.').max(200),
  email: z.string().trim().toLowerCase().max(254).email('Ese correo no tiene un formato válido.'),
  role: z.enum(['agent', 'external_lawyer']).optional(),
  agency: z.string().trim().max(200).optional(),
  agencyOther: z.string().trim().max(200).optional(),
  representsSide: z.enum(['buyer', 'seller']).nullable().optional()
}).strict();

const updateAgentSchema = z.object({
  representsSide: z.enum(['buyer', 'seller']).nullable()
}).strict();

const addDocumentSchema = z.object({
  name: z.string().trim().min(1, 'Falta el nombre del documento.').max(300),
  dealPartyEntityId: z.number().int().positive().nullable().optional(),
  subLabel: z.string().trim().max(200).optional(),
  section: z.enum(['gestoria', 'banco']).optional()
}).strict();

const updateDocumentSchema = z.object({
  status: z.enum(['pending', 'done']).optional(),
  subChecks: z.record(z.string(), z.boolean()).optional()
}).strict();

const reviewDocumentSchema = z.object({
  reviewStatus: z.enum(['pending', 'approved', 'rejected']),
  reviewNote: z.string().trim().max(2000).optional()
}).strict();

const updateTaskSchema = z.object({
  status: z.enum(['pending', 'progress', 'done']).optional(),
  assignedTo: z.number().int().positive().nullable().optional(),
  // true = el documento se firmó FUERA de la plataforma (se subió ya
  // firmado) — se marca completada y deja de aparecerle al cliente como
  // firma pendiente; false = deshacer (solo si fue marcado a mano, nunca
  // sobre un sobre real de DocuSign).
  signedOffline: z.boolean().optional()
}).strict();

// Comprador/vendedor solo puede tocar documentos de su propia parte; un
// agente que ya eligió a qué lado representa solo los de ese lado; los de
// la Propiedad (deal_party_entity_id NULL) son de cualquiera con acceso a
// la operación; admin/abogado sin restricción. Los de Gestoría/Banco
// (doc.section) son solo de admin/abogados — GET /:id ya se los oculta a
// comprador/vendedor/agente, esto cierra el acceso directo por ID.
function canTouchDoc(req, dealId, doc) {
  if (doc.section) return ['admin', 'lawyer', 'external_lawyer'].includes(req.session.role);
  if (doc.deal_party_entity_id === null) return true;
  const role = myRoleInDeal(req, dealId);
  if (['admin', 'lawyer'].includes(role)) return true;
  if (AGENT_LIKE_ROLES.includes(role)) {
    const side = myRepresentsSide(req, dealId);
    if (!side) return true;
    const party = db.prepare('SELECT side FROM deal_party_entities WHERE id = ?').get(doc.deal_party_entity_id);
    return !!party && party.side === side;
  }
  return myDealPartyEntityId(req, dealId) === doc.deal_party_entity_id;
}
const mailer = require('../lib/email');
const driveClient = require('../lib/googleDriveClient');
const gcsStorage = require('../lib/gcsStorage');
const { logActivity } = require('../lib/activity');

const router = express.Router();

// Crea la estructura de carpetas de Drive para una operación, best-effort
// (no bloquea ni revienta la creación/consulta de la operación si Drive no
// está conectado o la llamada falla — se puede reintentar a mano con
// POST /:id/drive-folder). No se guarda ningún token acá, solo el resultado.
async function tryCreateDriveFolder(req, dealId, property) {
  if (!driveClient.isConfigured() || !driveClient.isConnected()) return;
  try {
    const { folderId, folderUrl } = await driveClient.createDealFolderStructure(req, property);
    db.prepare('UPDATE deals SET drive_folder_id = ?, drive_folder_url = ? WHERE id = ?').run(folderId, folderUrl, dealId);
  } catch (err) {
    console.error('[google-drive] no se pudo crear la carpeta de la operación', dealId, err.message);
  }
}

// Copia un documento ya subido a Cloud Storage también a la subcarpeta que
// le toca en Drive (Propiedad/Vendedor/Comprador) — best-effort, nunca
// bloquea ni revienta la subida real si Drive no está conectado o falla.
// (kyc.js/contracts.js/docusign.js tienen su propia versión chica de esta
// misma idea, no se comparte código entre archivos de rutas en este repo.)
async function syncDocumentToDrive(req, dealId, deal_party_entity_id, filename, buffer, mimeType, section) {
  if (!driveClient.isConfigured() || !driveClient.isConnected()) return;
  const deal = db.prepare('SELECT drive_folder_id FROM deals WHERE id = ?').get(dealId);
  if (!deal || !deal.drive_folder_id) return;
  // Gestoría/Banco tienen su propia subcarpeta en Drive (se crea sola la
  // primera vez, ver uploadFileToDealSubfolder) — igual que las secciones
  // originales Propiedad/Vendedor/Comprador.
  let subfolder = section === 'gestoria' ? 'Gestoría' : section === 'banco' ? 'Banco' : 'Propiedad';
  if (!section && deal_party_entity_id !== null && deal_party_entity_id !== undefined) {
    const party = db.prepare('SELECT side FROM deal_party_entities WHERE id = ?').get(deal_party_entity_id);
    if (party) subfolder = party.side === 'seller' ? 'Vendedor' : 'Comprador';
  }
  try {
    await driveClient.uploadFileToDealSubfolder(req, deal.drive_folder_id, subfolder, filename, buffer, mimeType);
  } catch (err) {
    console.error('[google-drive] no se pudo copiar el documento a Drive', dealId, filename, err.message);
  }
}

const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/heic']);
// memoryStorage: el archivo llega como buffer en req.file.buffer y cada
// handler decide la clave y lo sube a Cloud Storage — ya no toca disco local
// en ningún punto intermedio (ver lib/gcsStorage.js).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_MIME.has(file.mimetype))
});

// Plantillas de checklist de documentos y tareas por escenario.
const SCENARIO_DOCS = require('../data/scenario-docs.json');
const SCENARIO_TASKS = require('../data/scenario-tasks.json');

const MAX_PARTIES_PER_SIDE = 4;
const TRUST_DOCS = ['Trust Agreement', 'Certificate of Trust'];

// Estos 3 documentos societarios de la LLC normalmente llegan primero como
// copia escaneada simple, y después en su versión final — cada requisito
// (notarizado/apostillado/traducido) se marca por separado del "recibido"
// normal, porque llegan en momentos distintos y no todos aplican a los tres
// documentos (Good Standing no se notariza, por ejemplo).
const SUB_CHECKS_BY_DOC = {
  'Good Standing': ['Apostilled', 'Translated'],
  'Operating Agreement': ['Notarized', 'Apostilled', 'Translated'],
  'Articles of organization': ['Notarized', 'Apostilled', 'Translated']
};

// Arma el checklist de documentos de UNA parte (vendedor o comprador),
// según su tipo y — si es entidad (corporation/llc) — su estructura de
// propiedad. Los documentos de socios/trust no crean partes nuevas, se
// cuelgan de la entidad con un sub_label para poder agruparlos en la UI.
function buildDocsForParty(scenario, party) {
  const s = SCENARIO_DOCS[scenario];
  const side = party.side;
  const docs = [];
  const add = (names, subLabel = null) => names.forEach(name => docs.push({ name, subLabel }));

  // Los documentos personales (CURP, pasaporte, actas...) solo aplican a una
  // persona física real — antes se agregaban SIEMPRE, así que una LLC/
  // corporation terminaba con el checklist de una persona física pegado
  // encima del de la entidad, sin ninguna relación con quién los proveería.
  if (party.partyType === 'individual') {
    add(s[side + '_individual']);
    return docs;
  }

  add(party.partyType === 'llc' ? s.llc_entity : s.corporation_extra);

  if (party.ownershipMode === 'direct_owners') {
    // Los socios con nombre propio son quienes aportan sus documentos
    // personales — no hace falta pedirlos otra vez sin etiqueta a nombre
    // de "la entidad" o de un "representante" genérico.
    (party.owners || []).forEach(owner => add(s.llc_members, `Socio: ${owner.name}`));
  } else if (party.ownershipMode === 'parent_entity') {
    const parentDocs = party.parentEntityType === 'llc' ? s.llc_entity : s.corporation_extra;
    add(parentDocs, `Entidad padre: ${party.parentEntityName}`);
    if (party.parentHasTrustAbove) {
      add(TRUST_DOCS, `Trust arriba de ${party.parentEntityName}`);
    }
    // Sin un socio con nombre propio en esta estructura, alguien tiene que
    // firmar y aportar sus documentos personales a nombre de la entidad.
    add(party.partyType === 'llc' ? s.llc_manager : s.legal_rep, 'Representante legal');
  } else if (party.ownershipMode === 'direct_trust') {
    add(TRUST_DOCS, `Trust: ${party.directTrustName}`);
    add(party.partyType === 'llc' ? s.llc_manager : s.legal_rep, 'Representante legal');
  }
  // ownershipMode null/no especificado todavía: solo los documentos propios
  // de la entidad, sin nada de estructura — la UI debe marcarlo como
  // incompleto y ofrecer completarlo (dispara rebuild-checklist).

  return docs;
}

function validateParty(p) {
  if (!p || !p.name || !['individual', 'corporation', 'llc'].includes(p.partyType)) {
    return 'Cada parte necesita nombre y tipo válido.';
  }
  if (p.partyType === 'individual') return null;
  if (!['direct_owners', 'parent_entity', 'direct_trust'].includes(p.ownershipMode)) {
    return `Falta la estructura de propiedad de "${p.name}".`;
  }
  if (p.ownershipMode === 'direct_owners') {
    if (!Array.isArray(p.owners) || !p.owners.length || p.owners.length > 2 || p.owners.some(o => !o?.name)) {
      return `"${p.name}" necesita 1 o 2 socios con nombre.`;
    }
  } else if (p.ownershipMode === 'parent_entity') {
    if (!p.parentEntityName || !['corporation', 'llc'].includes(p.parentEntityType)) {
      return `"${p.name}" necesita el nombre y tipo de la entidad padre.`;
    }
    if (p.parentHasTrustAbove && !p.parentTrustName) {
      return `Falta el nombre del trust arriba de la entidad padre de "${p.name}".`;
    }
  } else if (p.ownershipMode === 'direct_trust') {
    if (!p.directTrustName) return `"${p.name}" necesita el nombre del trust.`;
  }
  return null;
}

// Documentos de LA PROPIEDAD (Escritura pública, Predial) — se piden UNA
// VEZ por operación, no una vez por cada vendedor. deal_party_entity_id
// queda NULL para marcarlos como "de operación" en vez de "de una parte".
function insertPropertyDocs(dealId, scenario) {
  const names = SCENARIO_DOCS[scenario].property || [];
  const insertDoc = db.prepare("INSERT INTO documents (deal_id, deal_party_entity_id, name, created_at) VALUES (?,NULL,?,datetime('now'))");
  names.forEach(name => insertDoc.run(dealId, name));
  // Secciones Gestoría y Banco — solo los escenarios con fideicomiso las
  // traen en scenario-docs.json; para compraventa directa estos arrays no
  // existen y no se inserta nada.
  const insertSectionDoc = db.prepare("INSERT INTO documents (deal_id, deal_party_entity_id, name, section, created_at) VALUES (?,NULL,?,?,datetime('now'))");
  ['gestoria', 'banco'].forEach(section => {
    (SCENARIO_DOCS[scenario][section] || []).forEach(name => insertSectionDoc.run(dealId, name, section));
  });
}

function insertPartyWithDocs(dealId, scenario, side, sortOrder, p) {
  const info = db.prepare(`
    INSERT INTO deal_party_entities (deal_id, side, sort_order, party_type, name, ownership_mode, parent_entity_name, parent_entity_type, parent_has_trust_above, parent_trust_name, direct_trust_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    dealId, side, sortOrder, p.partyType, p.name,
    p.partyType === 'individual' ? null : p.ownershipMode || null,
    p.ownershipMode === 'parent_entity' ? p.parentEntityName : null,
    p.ownershipMode === 'parent_entity' ? p.parentEntityType : null,
    p.ownershipMode === 'parent_entity' && p.parentHasTrustAbove ? 1 : 0,
    p.ownershipMode === 'parent_entity' && p.parentHasTrustAbove ? p.parentTrustName : null,
    p.ownershipMode === 'direct_trust' ? p.directTrustName : null
  );
  const partyId = info.lastInsertRowid;
  if (p.ownershipMode === 'direct_owners') {
    const insertOwner = db.prepare('INSERT INTO deal_party_owners (deal_party_entity_id, sort_order, name) VALUES (?,?,?)');
    p.owners.forEach((o, oi) => insertOwner.run(partyId, oi, o.name));
  }
  const insertDoc = db.prepare("INSERT INTO documents (deal_id, deal_party_entity_id, sub_label, name, created_at) VALUES (?,?,?,?,datetime('now'))");
  buildDocsForParty(scenario, { ...p, side }).forEach(d => insertDoc.run(dealId, partyId, d.subLabel, d.name));
  return partyId;
}

// Da de alta la cuenta de un comprador/vendedor y la liga a su parte, sin
// envolver en su propia transacción — para poder usarse DENTRO de la
// transacción de crear la operación, agregar una parte, o editar una parte
// (better-sqlite3 no soporta transacciones anidadas). Deja que el
// comprador/vendedor pueda firmar documentos sin tener que registrarse él
// mismo: el agente/admin comparte la contraseña temporal por el canal que
// prefiera (teléfono, WhatsApp, en persona), y además se le manda un correo
// de bienvenida con un link para poner su propia contraseña (ver
// sendPartyWelcomeEmail) — así no depende de que alguien le pase la
// temporal a mano si prefiere entrar por su cuenta.
//
// Si el correo ya es de una cuenta de cliente existente (puede ser de otra
// operación — el mismo comprador/vendedor con otra propiedad), se LIGA esa
// cuenta a esta parte en vez de fallar. Solo se bloquea si el correo es de
// una cuenta de equipo (admin/agente/abogado), que no debería quedar ligada
// como comprador/vendedor.
// `relationship`: 'titular' (default, el propio comprador/vendedor) o
// 'attorney_in_fact' (apoderado — ver ensureDealPartiesAllowAttorneyInFact
// en db/index.js). Ambos quedan con exactamente el mismo acceso a esta
// parte porque canAccessDeal/myDealPartyEntityId/canTouchDoc resuelven todo
// por fila de deal_parties, no por "la" cuenta de la parte.
function registerPartyUserRaw(dealId, party, name, email, relationship) {
  relationship = relationship || 'titular';
  if (!isValidEmail(email)) {
    const err = new Error('Ese correo no tiene un formato válido.');
    err.status = 400;
    throw err;
  }
  const normalizedEmail = email.toLowerCase().trim();
  const existing = db.prepare('SELECT id, role FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) {
    if (!['buyer', 'seller'].includes(existing.role)) {
      const err = new Error('Ya existe una cuenta de equipo (no de cliente) con ese correo — no se puede ligar como comprador/vendedor.');
      err.status = 409;
      throw err;
    }
    db.prepare('INSERT INTO deal_parties (deal_id, user_id, role_in_deal, deal_party_entity_id, relationship) VALUES (?,?,?,?,?)')
      .run(dealId, existing.id, party.side, party.id, relationship);
    return { userId: existing.id, temporaryPassword: null, linkedExisting: true };
  }
  const password = crypto.randomBytes(6).toString('base64url');
  const hash = bcrypt.hashSync(password, 12);
  const info = db.prepare("INSERT INTO users (name, email, password_hash, role, status) VALUES (?,?,?,?,'active')")
    .run(name.trim(), normalizedEmail, hash, party.side);
  db.prepare('INSERT INTO deal_parties (deal_id, user_id, role_in_deal, deal_party_entity_id, relationship) VALUES (?,?,?,?,?)')
    .run(dealId, info.lastInsertRowid, party.side, party.id, relationship);
  return { userId: info.lastInsertRowid, temporaryPassword: password, linkedExisting: false };
}

// Correo de bienvenida a un comprador/vendedor recién dado de alta directo
// (nunca a uno que ya tenía cuenta — linkedExisting=true solo se liga a la
// operación nueva, no necesita "bienvenida" otra vez). Reusa el mismo copy
// que la invitación por correo (mismo call-to-action: entrar y poner tu
// contraseña) — el link es de restablecer contraseña porque la cuenta y su
// contraseña temporal ya existen, a diferencia de la invitación de verdad.
// Nunca lanza — un correo que falla no debe tumbar el alta de la parte.
// `scenario` decide el idioma (mailer.resolveClientLang) — un comprador
// extranjero (ej. fideicomiso) no entiende un correo en español.
// Devuelve { sent, error } en vez de tragarse el resultado — sendInviteEmail
// nunca lanza en un error de Resend (dominio no verificado, etc.), lo
// devuelve en result.error y ahí se quedaba sin que nadie lo viera. Sigue
// sin lanzar ella misma (un correo que falla no debe tumbar el alta de la
// parte), pero ahora quien la llama puede avisarle al admin en vez de que
// parezca que todo salió bien cuando en realidad no llegó nada.
// `linkedExisting` — la cuenta ya existía (comprador/vendedor de otra
// operación) y solo se ligó a esta: no hace falta contraseña ni link de
// bienvenida, solo avisarle que ya puede ver esta operación también (antes
// no se le mandaba NADA en este caso, y quedaba dado de alta sin enterarse).
async function sendPartyWelcomeEmail(req, dealProperty, name, email, side, scenario, linkedExisting) {
  if (!mailer.isConfigured()) return { sent: false, error: 'Resend no está configurado (falta RESEND_API_KEY).' };
  try {
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
    if (!user) return { sent: false, error: 'Cuenta no encontrada.' };
    const lang = mailer.resolveClientLang(scenario, side);
    let result;
    if (linkedExisting) {
      const url = `${req.protocol}://${req.get('host')}/`;
      result = await mailer.sendAgentAddedToDealEmail({ to: email, name, dealProperty, url, lang });
    } else {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
      db.prepare('INSERT INTO password_resets (token, user_id, expires_at) VALUES (?,?,?)').run(token, user.id, expiresAt);
      const url = `${req.protocol}://${req.get('host')}/reset-password.html?token=${token}`;
      result = await mailer.sendInviteEmail({ to: email, name, roleInDeal: side, dealProperty, url, lang });
    }
    if (!result.ok) console.error('[welcome-email] no se pudo mandar a', email, '-', result.error);
    return { sent: result.ok, error: result.ok ? null : result.error };
  } catch (err) {
    console.error('[welcome-email] no se pudo mandar a', email, '-', err.message);
    return { sent: false, error: err.message };
  }
}

// Subqueries de conteo para poder mostrar % de avance en la lista sin tener
// que pedir el detalle completo (documentos+tareas) de cada operación.
const COUNTS_SQL = `,
  (SELECT COUNT(*) FROM documents WHERE deal_id = d.id) AS documents_total,
  (SELECT COUNT(*) FROM documents WHERE deal_id = d.id AND status = 'done') AS documents_done,
  (SELECT COUNT(*) FROM tasks WHERE deal_id = d.id) AS tasks_total,
  (SELECT COUNT(*) FROM tasks WHERE deal_id = d.id AND status = 'done') AS tasks_done
`;

function attachParties(rows) {
  if (!rows.length) return rows;
  const ids = rows.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const parties = db.prepare(`
    SELECT id, deal_id, side, sort_order, party_type, name, ownership_mode
    FROM deal_party_entities WHERE deal_id IN (${placeholders}) ORDER BY deal_id, side, sort_order
  `).all(...ids);
  const byDeal = {};
  parties.forEach(p => { (byDeal[p.deal_id] ||= []).push(p); });
  // linkedUser — el resumen (esta lista) también lo necesita: el Portal usa
  // la cuenta ligada de cada parte para saber si quien mira es comprador o
  // vendedor de esa operación (tarjeta BUYER/SELLER), sin tener que abrir
  // el detalle completo de cada una primero.
  const linkedRows = db.prepare(`
    SELECT dp.deal_party_entity_id AS partyId, dp.relationship, u.id AS userId, u.name, u.email
    FROM deal_parties dp JOIN users u ON u.id = dp.user_id
    WHERE dp.deal_id IN (${placeholders}) AND dp.deal_party_entity_id IS NOT NULL
  `).all(...ids);
  const { linkedByParty, attorneyByParty, userIdsByParty } = buildPartyLinkMaps(linkedRows);
  parties.forEach(p => {
    p.linkedUser = linkedByParty[p.id] || null;
    p.linkedAttorney = attorneyByParty[p.id] || null;
    p.linkedUserIds = userIdsByParty[p.id] || [];
  });
  rows.forEach(r => { r.parties = byDeal[r.id] || []; });
  return rows;
}

// A partir de filas deal_parties+users ligadas a partes (titular y/o
// apoderado — ver ensureDealPartiesAllowAttorneyInFact en db/index.js),
// arma tres mapas por deal_party_entity_id: linkedUser (titular),
// linkedAttorney (apoderado), y linkedUserIds (ambos juntos, para que el
// frontend reconozca "esta es mi parte" sin importar cuál de las dos
// cuentas inició sesión — canAccessDeal/myDealPartyEntityId ya les dan
// acceso idéntico a los documentos/KYC de la parte).
function buildPartyLinkMaps(linkedRows) {
  const linkedByParty = {};
  const attorneyByParty = {};
  const userIdsByParty = {};
  linkedRows.forEach(r => {
    const entry = { userId: r.userId, name: r.name, email: r.email };
    if (r.relationship === 'attorney_in_fact') attorneyByParty[r.partyId] = entry;
    else linkedByParty[r.partyId] = entry;
    (userIdsByParty[r.partyId] ||= []).push(r.userId);
  });
  return { linkedByParty, attorneyByParty, userIdsByParty };
}

// GET /api/deals — lista operaciones. Admin/abogado ven todas; agente/buyer/seller solo las suyas.
router.get('/', requireAuth, (req, res) => {
  let rows;
  if (UNRESTRICTED_ROLES.includes(req.session.role)) {
    rows = db.prepare(`SELECT d.*${COUNTS_SQL} FROM deals d WHERE d.deleted_at IS NULL ORDER BY d.created_at DESC`).all();
  } else if (req.session.role === 'lawyer') {
    // Ve lo que creó (sin necesitar una fila en deal_parties) más lo que un
    // admin le asignó explícitamente — ver lib/access.js canAccessDeal.
    rows = db.prepare(`
      SELECT DISTINCT d.*${COUNTS_SQL} FROM deals d
      LEFT JOIN deal_parties dp ON dp.deal_id = d.id AND dp.user_id = ?
      WHERE (dp.user_id = ? OR d.created_by = ?) AND d.deleted_at IS NULL
      ORDER BY d.created_at DESC
    `).all(req.session.userId, req.session.userId, req.session.userId);
  } else {
    rows = db.prepare(`
      SELECT d.*${COUNTS_SQL} FROM deals d
      JOIN deal_parties dp ON dp.deal_id = d.id
      WHERE dp.user_id = ? AND d.deleted_at IS NULL
      ORDER BY d.created_at DESC
    `).all(req.session.userId);
  }
  res.json(attachParties(rows));
});

// POST /api/deals — admin/agente/abogado crean operaciones.
router.post('/', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), rateLimitWrite, validateBody(createDealSchema), async (req, res) => {
  const { scenario, development, property, price, furniturePrice, currency, startDate, parties, escrowCompany } = req.body;
  const sellers = parties.filter(p => p.side === 'seller');
  const buyers = parties.filter(p => p.side === 'buyer');
  if (!sellers.length || !buyers.length) {
    return res.status(400).json({ error: 'Se necesita al menos 1 vendedor y 1 comprador.' });
  }
  if (sellers.length > MAX_PARTIES_PER_SIDE || buyers.length > MAX_PARTIES_PER_SIDE) {
    return res.status(400).json({ error: `Máximo ${MAX_PARTIES_PER_SIDE} personas por lado.` });
  }
  for (const p of parties) {
    const err = validateParty(p);
    if (err) return res.status(400).json({ error: err });
  }

  try {
    const result = db.transaction(() => {
      const dealInfo = db.prepare(`
        INSERT INTO deals (scenario, development, property, price, furniture_price, currency, start_date, escrow_company, created_by)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(scenario, development || 'punta_mita', property, price || 0, furniturePrice || 0,
             currency || 'USD', startDate, escrowCompany || null, req.session.userId);
      const id = dealInfo.lastInsertRowid;

      insertPropertyDocs(id, scenario);
      const partyResults = [];
      ['seller', 'buyer'].forEach(side => {
        parties.filter(p => p.side === side).forEach((p, idx) => {
          const partyId = insertPartyWithDocs(id, scenario, side, idx, p);
          // Correo opcional: da de alta la cuenta de una vez, para que se le
          // pueda mandar a firmar documentos aunque nunca se registre él
          // mismo (típico cuando el agente maneja todo por su cliente). Si
          // falla (ej. correo repetido), no se revierte la parte — solo
          // queda sin cuenta ligada, se puede invitar/registrar después.
          if (p.email && p.email.trim()) {
            try {
              const newParty = db.prepare('SELECT * FROM deal_party_entities WHERE id = ?').get(partyId);
              const { temporaryPassword, linkedExisting } = registerPartyUserRaw(id, newParty, p.name, p.email);
              partyResults.push({ partyName: p.name, email: p.email.toLowerCase().trim(), temporaryPassword, linkedExisting, side });
            } catch (err) {
              partyResults.push({ partyName: p.name, email: p.email, error: err.message });
            }
          }
        });
      });

      const tasks = SCENARIO_TASKS[scenario];
      const insertTask = db.prepare("INSERT INTO tasks (deal_id, label_en, label_es, requires_signature, doc_type, sort_order, created_at) VALUES (?,?,?,?,?,?,datetime('now'))");
      tasks.forEach((t, i) => insertTask.run(id, t.en, t.es, t.sign ? 1 : 0, t.docType || 'manual', i));

      // Un agente ya no ve todas las operaciones (solo admin/lawyer) — se
      // liga automáticamente a la que acaba de crear.
      if (AGENT_LIKE_ROLES.includes(req.session.role)) {
        db.prepare('INSERT OR IGNORE INTO deal_parties (deal_id, user_id, role_in_deal) VALUES (?,?,?)')
          .run(id, req.session.userId, 'agent');
      }
      return { id, partyResults };
    })();

    await Promise.all(result.partyResults.filter(r => !r.error).map(async r => {
      const { sent, error } = await sendPartyWelcomeEmail(req, property, r.partyName, r.email, r.side, scenario, r.linkedExisting);
      r.welcomeEmailSent = sent;
      r.welcomeEmailError = error;
    }));
    res.status(201).json({ id: result.id, partyResults: result.partyResults });
    logActivity(result.id, req.session.userId, 'deal_created', property);
    tryCreateDriveFolder(req, result.id, property);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error al crear la operación.' });
  }
});

// GET /api/deals/trash — solo admin, lista lo que está en la papelera.
// Declarada ANTES de GET /:id (mismo largo de path, "trash" no debe
// interpretarse como un :id) para que Express la reconozca primero.
router.get('/trash', requireRole('admin'), (req, res) => {
  const rows = db.prepare(`
    SELECT d.*, u.name AS deleted_by_name
    FROM deals d LEFT JOIN users u ON u.id = d.deleted_by
    WHERE d.deleted_at IS NOT NULL
    ORDER BY d.deleted_at DESC
  `).all();
  res.json(rows);
});

// GET /api/deals/:id — detalle completo con partes, docs y tareas.
router.get('/:id', requireAuth, (req, res) => {
  const deal = db.prepare('SELECT * FROM deals WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });

  if (!canAccessDeal(req, deal.id)) {
    return res.status(403).json({ error: 'No autorizado para ver esta operación.' });
  }

  const parties = db.prepare('SELECT * FROM deal_party_entities WHERE deal_id = ? ORDER BY side, sort_order').all(deal.id);

  const ownerRows = db.prepare(`
    SELECT o.* FROM deal_party_owners o JOIN deal_party_entities e ON e.id = o.deal_party_entity_id
    WHERE e.deal_id = ? ORDER BY o.deal_party_entity_id, o.sort_order
  `).all(deal.id);
  const ownersByParty = {};
  ownerRows.forEach(o => { (ownersByParty[o.deal_party_entity_id] ||= []).push(o); });

  const linkedRows = db.prepare(`
    SELECT dp.deal_party_entity_id AS partyId, dp.relationship, u.id AS userId, u.name, u.email
    FROM deal_parties dp JOIN users u ON u.id = dp.user_id
    WHERE dp.deal_id = ? AND dp.deal_party_entity_id IS NOT NULL
  `).all(deal.id);
  const { linkedByParty, attorneyByParty, userIdsByParty } = buildPartyLinkMaps(linkedRows);

  parties.forEach(p => {
    p.owners = ownersByParty[p.id] || [];
    p.linkedUser = linkedByParty[p.id] || null;
    p.linkedAttorney = attorneyByParty[p.id] || null;
    p.linkedUserIds = userIdsByParty[p.id] || [];
  });

  const agents = db.prepare(`
    SELECT dp.id AS dealPartyId, u.id AS userId, u.name, u.email, u.agency, u.status, u.role, u.bio, u.avatar_url AS avatarUrl, dp.represents_side AS representsSide
    FROM deal_parties dp JOIN users u ON u.id = dp.user_id
    WHERE dp.deal_id = ? AND dp.role_in_deal = 'agent'
    ORDER BY u.name
  `).all(deal.id);

  // El abogado interno que creó la operación tiene acceso vía
  // deals.created_by (ver lib/access.js), sin necesitar una fila en
  // deal_parties — pero para que la nueva sección unificada de "personas en
  // esta operación" lo muestre (el usuario lo pidió explícitamente:
  // "admin puede ver quién la creó"), se agrega como fila sintética
  // (dealPartyId null) si todavía no está también en deal_parties.
  if (deal.created_by && !agents.some(a => a.userId === deal.created_by)) {
    const creator = db.prepare('SELECT id AS userId, name, email, agency, status, role FROM users WHERE id = ?').get(deal.created_by);
    if (creator) agents.unshift({ ...creator, dealPartyId: null, representsSide: null, isCreator: true });
  }

  const documents = db.prepare('SELECT * FROM documents WHERE deal_id = ?').all(deal.id);
  // assigned_to_name para mostrar "Asignada a X" sin otro fetch — el
  // frontend de un abogado no tiene la lista completa de usuarios.
  const tasks = db.prepare(`
    SELECT t.*, u.name AS assigned_to_name
    FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to
    WHERE t.deal_id = ? ORDER BY t.sort_order
  `).all(deal.id);

  // Un agente que ya eligió a qué lado representa solo ve las partes (y sus
  // documentos) de ese lado — el otro lado puede tener su propio agente y no
  // deben verse entre sí. Los documentos de la Propiedad (deal_party_entity_id
  // NULL) no son de nadie en particular, siguen visibles para cualquiera con
  // acceso a la operación.
  let visibleParties = parties;
  let visibleDocuments = documents;
  const side = myRepresentsSide(req, deal.id);
  if (side) {
    const visiblePartyIds = new Set(parties.filter(p => p.side === side).map(p => p.id));
    visibleParties = parties.filter(p => visiblePartyIds.has(p.id));
    visibleDocuments = documents.filter(d => d.deal_party_entity_id === null || visiblePartyIds.has(d.deal_party_entity_id));
  }
  // Gestoría/Banco son trabajo interno de los abogados (CLG, avalúo,
  // formatos del banco...) — comprador/vendedor/agente no las ven.
  if (!['admin', 'lawyer', 'external_lawyer'].includes(req.session.role)) {
    visibleDocuments = visibleDocuments.filter(d => !d.section);
  }

  res.json({ ...deal, parties: visibleParties, agents, documents: visibleDocuments, tasks });
});

// PATCH /api/deals/:id — cambia la escrow company y/o las fechas clave
// (cierre, fin de due diligence) de una operación ya creada. Ambos grupos
// de campos son independientes entre sí (solo se actualiza lo que venga en
// el body).
router.patch('/:id', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), rateLimitWrite, validateBody(updateDealSchema), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const { escrowCompany, closingDate, dueDiligenceEndDate, property, price, furniturePrice, currency, startDate, development, status, legalActs } = req.body;
  if (legalActs !== undefined && !['admin', 'lawyer'].includes(req.session.role)) {
    return res.status(403).json({ error: 'Solo admin/abogado interno puede editar los actos jurídicos.' });
  }

  if (status !== undefined) {
    db.prepare("UPDATE deals SET status = ?, closed_at = ? WHERE id = ?")
      .run(status, status === 'completed' ? new Date().toISOString() : null, req.params.id);
  }
  if (escrowCompany !== undefined) {
    db.prepare('UPDATE deals SET escrow_company = ? WHERE id = ?').run(escrowCompany, req.params.id);
  }
  if (closingDate !== undefined) {
    db.prepare('UPDATE deals SET closing_date = ? WHERE id = ?').run(closingDate || null, req.params.id);
  }
  if (dueDiligenceEndDate !== undefined) {
    db.prepare('UPDATE deals SET due_diligence_end_date = ? WHERE id = ?').run(dueDiligenceEndDate || null, req.params.id);
  }
  // Edición de los datos básicos de la operación — no se toca `scenario`
  // acá: cambiarlo invalidaría el checklist/tracker ya construidos, eso
  // requeriría rearmarlos desde cero, fuera de lo que pide un simple editar.
  if (property !== undefined) {
    if (!property || !property.trim()) return res.status(400).json({ error: 'El nombre de la operación no puede quedar vacío.' });
    db.prepare('UPDATE deals SET property = ? WHERE id = ?').run(property.trim(), req.params.id);
  }
  if (price !== undefined) db.prepare('UPDATE deals SET price = ? WHERE id = ?').run(Number(price) || 0, req.params.id);
  if (furniturePrice !== undefined) db.prepare('UPDATE deals SET furniture_price = ? WHERE id = ?').run(Number(furniturePrice) || 0, req.params.id);
  if (currency !== undefined) db.prepare('UPDATE deals SET currency = ? WHERE id = ?').run(currency || 'USD', req.params.id);
  if (startDate !== undefined) db.prepare('UPDATE deals SET start_date = ? WHERE id = ?').run(startDate || null, req.params.id);
  if (development !== undefined) db.prepare('UPDATE deals SET development = ? WHERE id = ?').run(development || 'punta_mita', req.params.id);
  if (legalActs !== undefined) db.prepare('UPDATE deals SET legal_acts = ? WHERE id = ?').run(legalActs || null, req.params.id);

  const info = db.prepare('SELECT id FROM deals WHERE id = ?').get(req.params.id);
  if (!info) return res.status(404).json({ error: 'Operación no encontrada.' });
  res.json({ ok: true });
});

// POST /api/deals/:id/parties — agrega una parte nueva (vendedor/comprador
// adicional) a una operación ya creada, con su propio checklist.
router.post('/:id/parties', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), rateLimitWrite, validateBody(createPartySchema), async (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });

  const p = req.body;
  const err = validateParty(p);
  if (err) return res.status(400).json({ error: err });

  const count = db.prepare('SELECT COUNT(*) c FROM deal_party_entities WHERE deal_id = ? AND side = ?').get(req.params.id, p.side).c;
  if (count >= MAX_PARTIES_PER_SIDE) return res.status(400).json({ error: `Máximo ${MAX_PARTIES_PER_SIDE} personas por lado.` });

  const partyId = insertPartyWithDocs(req.params.id, deal.scenario, p.side, count, p);
  logActivity(req.params.id, req.session.userId, 'person_added', p.name);

  // Correo opcional: da de alta la cuenta de una vez, para poder mandar a
  // firmar documentos sin que la parte tenga que registrarse ella misma.
  let temporaryPassword, emailError, linkedExisting, welcomeEmailSent, welcomeEmailError;
  if (p.email && p.email.trim()) {
    try {
      const newParty = db.prepare('SELECT * FROM deal_party_entities WHERE id = ?').get(partyId);
      ({ temporaryPassword, linkedExisting } = db.transaction(() => registerPartyUserRaw(req.params.id, newParty, p.name, p.email))());
      ({ sent: welcomeEmailSent, error: welcomeEmailError } = await sendPartyWelcomeEmail(req, deal.property, p.name, p.email, p.side, deal.scenario, linkedExisting));
    } catch (err) {
      emailError = err.message;
    }
  }

  res.status(201).json({ id: partyId, temporaryPassword, emailError, welcomeEmailSent, welcomeEmailError });
});

// PATCH /api/deals/:id/parties/:partyId — editar nombre/estructura de una
// parte existente (ej. completar la estructura de propiedad de una
// operación migrada, o corregir un dato). Este es también EL lugar donde se
// liga/da de alta la cuenta del comprador/vendedor: basta con poner su
// correo aquí y guardar — antes existía una sección aparte ("Invite to this
// deal") para esto y resultaba confuso, así que esa sección ahora es solo
// para agentes/abogados externos (ver buildInviteForm en el frontend) y
// esta es la ÚNICA forma de ligar/crear la cuenta de una parte. También es
// donde se liga (o quita) el apoderado de la parte — attorneyName/
// attorneyEmail para agregarlo, removeAttorney para quitarlo — con las
// mismas facultades que el titular sobre esta misma parte (ver
// registerPartyUserRaw).
router.patch('/:id/parties/:partyId', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), rateLimitWrite, validateBody(updatePartySchema), async (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const party = db.prepare('SELECT * FROM deal_party_entities WHERE id = ? AND deal_id = ?').get(req.params.partyId, req.params.id);
  if (!party) return res.status(404).json({ error: 'Parte no encontrada.' });
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id);

  const p = { ...req.body, side: party.side, partyType: req.body.partyType || party.party_type, name: req.body.name || party.name };
  const err = validateParty(p);
  if (err) return res.status(400).json({ error: err });

  // Ya ligada — no se vuelve a intentar registrar/ligar con el correo que
  // venga en el body (cambiar la cuenta ligada de una parte no es un caso
  // que se pida hoy; el campo de correo en el frontend se deshabilita una
  // vez ligada, esto es un respaldo del lado del servidor). El apoderado es
  // una fila aparte (relationship='attorney_in_fact'), con su propio check.
  const alreadyLinked = db.prepare("SELECT 1 FROM deal_parties WHERE deal_party_entity_id = ? AND relationship = 'titular'").get(party.id);
  const alreadyHasAttorney = db.prepare("SELECT 1 FROM deal_parties WHERE deal_party_entity_id = ? AND relationship = 'attorney_in_fact'").get(party.id);

  let temporaryPassword, linkedExisting, emailError;
  let attorneyTemporaryPassword, attorneyLinkedExisting, attorneyError;
  db.transaction(() => {
    db.prepare(`
      UPDATE deal_party_entities SET name=?, party_type=?, ownership_mode=?, parent_entity_name=?, parent_entity_type=?, parent_has_trust_above=?, parent_trust_name=?, direct_trust_name=?
      WHERE id = ?
    `).run(
      p.name, p.partyType,
      p.partyType === 'individual' ? null : p.ownershipMode || null,
      p.ownershipMode === 'parent_entity' ? p.parentEntityName : null,
      p.ownershipMode === 'parent_entity' ? p.parentEntityType : null,
      p.ownershipMode === 'parent_entity' && p.parentHasTrustAbove ? 1 : 0,
      p.ownershipMode === 'parent_entity' && p.parentHasTrustAbove ? p.parentTrustName : null,
      p.ownershipMode === 'direct_trust' ? p.directTrustName : null,
      party.id
    );
    db.prepare('DELETE FROM deal_party_owners WHERE deal_party_entity_id = ?').run(party.id);
    if (p.ownershipMode === 'direct_owners') {
      const insertOwner = db.prepare('INSERT INTO deal_party_owners (deal_party_entity_id, sort_order, name) VALUES (?,?,?)');
      p.owners.forEach((o, oi) => insertOwner.run(party.id, oi, o.name));
    }
    rebuildChecklistForParty(deal, party.id, p);

    if (!alreadyLinked && p.email && p.email.trim()) {
      try {
        ({ temporaryPassword, linkedExisting } = registerPartyUserRaw(req.params.id, party, p.name, p.email));
      } catch (regErr) {
        emailError = regErr.message;
      }
    }

    if (p.removeAttorney && alreadyHasAttorney) {
      db.prepare("DELETE FROM deal_parties WHERE deal_party_entity_id = ? AND relationship = 'attorney_in_fact'").run(party.id);
    } else if (!alreadyHasAttorney && p.attorneyName && p.attorneyName.trim() && p.attorneyEmail && p.attorneyEmail.trim()) {
      try {
        ({ temporaryPassword: attorneyTemporaryPassword, linkedExisting: attorneyLinkedExisting } =
          registerPartyUserRaw(req.params.id, party, p.attorneyName, p.attorneyEmail, 'attorney_in_fact'));
      } catch (regErr) {
        attorneyError = regErr.message;
      }
    }
  })();

  let welcomeEmailSent, welcomeEmailError;
  if (!alreadyLinked && p.email && p.email.trim() && !emailError) {
    ({ sent: welcomeEmailSent, error: welcomeEmailError } = await sendPartyWelcomeEmail(req, deal.property, p.name, p.email, p.side, deal.scenario, linkedExisting));
  }
  let attorneyWelcomeEmailSent, attorneyWelcomeEmailError;
  if (!alreadyHasAttorney && p.attorneyName && p.attorneyEmail && !attorneyError) {
    ({ sent: attorneyWelcomeEmailSent, error: attorneyWelcomeEmailError } = await sendPartyWelcomeEmail(req, deal.property, p.attorneyName, p.attorneyEmail, p.side, deal.scenario, attorneyLinkedExisting));
  }
  res.json({
    ok: true, temporaryPassword, emailError, welcomeEmailSent, welcomeEmailError,
    attorneyTemporaryPassword, attorneyError, attorneyWelcomeEmailSent, attorneyWelcomeEmailError
  });
});

// Inserta solo los documentos que falten según la estructura ACTUAL de la
// parte, sin duplicar ni borrar lo que ya existe (ni lo ya subido/marcado).
function rebuildChecklistForParty(deal, partyId, p) {
  const existing = db.prepare('SELECT name, sub_label FROM documents WHERE deal_party_entity_id = ?').all(partyId);
  const existingKeys = new Set(existing.map(d => `${d.name}\u0000${d.sub_label || ''}`));
  const wanted = buildDocsForParty(deal.scenario, p);
  const insertDoc = db.prepare("INSERT INTO documents (deal_id, deal_party_entity_id, sub_label, name, created_at) VALUES (?,?,?,?,datetime('now'))");
  wanted.forEach(d => {
    const key = `${d.name}\u0000${d.subLabel || ''}`;
    if (!existingKeys.has(key)) insertDoc.run(deal.id, partyId, d.subLabel, d.name);
  });
}

// POST /api/deals/:id/parties/:partyId/rebuild-checklist — recalcula el
// checklist de una parte con su estructura de propiedad actual (ya guardada
// en la base), agregando lo que falte.
router.post('/:id/parties/:partyId/rebuild-checklist', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), rateLimitWrite, (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const party = db.prepare('SELECT * FROM deal_party_entities WHERE id = ? AND deal_id = ?').get(req.params.partyId, req.params.id);
  if (!party) return res.status(404).json({ error: 'Parte no encontrada.' });
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id);
  const owners = db.prepare('SELECT name FROM deal_party_owners WHERE deal_party_entity_id = ? ORDER BY sort_order').all(party.id);

  rebuildChecklistForParty(deal, party.id, {
    side: party.side, partyType: party.party_type, ownershipMode: party.ownership_mode,
    owners, parentEntityName: party.parent_entity_name, parentEntityType: party.parent_entity_type,
    parentHasTrustAbove: !!party.parent_has_trust_above, parentTrustName: party.parent_trust_name,
    directTrustName: party.direct_trust_name
  });
  res.json({ ok: true });
});

// POST /api/deals/:id/parties/:partyId/fix-entity-checklist — versión en
// vivo del script scripts/cleanup-llc-entity-checklist.js, para operaciones
// creadas ANTES de corregir el bug de "Corrige checklist duplicado de
// LLC/corporation": una parte LLC/corporation tenía pegado también el set
// de documentos de persona física, sin ninguna etiqueta que lo distinguiera
// del checklist real de la entidad. rebuild-checklist arriba solo AGREGA lo
// que falte — nunca quita lo que sobra — así que esas operaciones viejas
// necesitan este endpoint para borrar lo que sobra.
//
// Nunca borra un documento que ya tenga archivo subido (status='done') — se
// devuelve en "flagged" para que el admin lo revise a mano (puede que en
// realidad sea de un socio y haya que reasignarlo, no perderlo).
router.post('/:id/parties/:partyId/fix-entity-checklist', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), rateLimitWrite, (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const party = db.prepare('SELECT * FROM deal_party_entities WHERE id = ? AND deal_id = ?').get(req.params.partyId, req.params.id);
  if (!party) return res.status(404).json({ error: 'Parte no encontrada.' });
  if (!['llc', 'corporation'].includes(party.party_type)) {
    return res.status(400).json({ error: 'Esto solo aplica a partes tipo LLC/corporation.' });
  }
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id);
  const s = SCENARIO_DOCS[deal.scenario];
  const correctNames = new Set(party.party_type === 'llc' ? s.llc_entity : s.corporation_extra);

  const unlabeledDocs = db.prepare('SELECT id, name, status FROM documents WHERE deal_party_entity_id = ? AND sub_label IS NULL').all(party.id);
  const wrongDocs = unlabeledDocs.filter(d => !correctNames.has(d.name));

  const deleted = [];
  const flagged = [];
  wrongDocs.forEach(d => {
    if (d.status === 'done') {
      flagged.push(d.name);
    } else {
      db.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
      deleted.push(d.name);
    }
  });

  res.json({ ok: true, deleted, flagged });
});

// DELETE /api/deals/:id/parties/:partyId — quitar una parte agregada de más
// (bloqueado si ya tiene trabajo real hecho, para no perderlo).
router.delete('/:id/parties/:partyId', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), rateLimitWrite, (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const party = db.prepare('SELECT * FROM deal_party_entities WHERE id = ? AND deal_id = ?').get(req.params.partyId, req.params.id);
  if (!party) return res.status(404).json({ error: 'Parte no encontrada.' });

  const sideCount = db.prepare('SELECT COUNT(*) c FROM deal_party_entities WHERE deal_id = ? AND side = ?').get(req.params.id, party.side).c;
  if (sideCount <= 1) return res.status(400).json({ error: 'No puedes quitar la única parte de este lado.' });

  const doneDocs = db.prepare("SELECT COUNT(*) c FROM documents WHERE deal_party_entity_id = ? AND status = 'done'").get(party.id).c;
  const activeKyc = db.prepare("SELECT COUNT(*) c FROM kyc_submissions WHERE deal_party_entity_id = ? AND status != 'draft'").get(party.id).c;
  if (doneDocs > 0 || activeKyc > 0) {
    return res.status(400).json({ error: 'Esta parte ya tiene documentos marcados o un expediente KYC en proceso — no se puede quitar.' });
  }

  db.prepare('DELETE FROM deal_party_entities WHERE id = ?').run(party.id);
  res.json({ ok: true });
});

// POST /api/deals/:id/parties/:partyId/remind — manda un correo (Resend) a
// la(s) persona(s) ligada(s) a esta parte listando sus documentos
// pendientes — al titular y, si tiene, también a su apoderado (ambos suben
// documentos con las mismas facultades, ver ensureDealPartiesAllowAttorneyInFact
// en db/index.js). Los documentos de Propiedad (deal_party_entity_id NULL)
// se incluyen solo si esta parte es del lado vendedor, que es quien
// realísticamente los provee.
router.post('/:id/parties/:partyId/remind', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), rateLimitEmail, async (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const party = db.prepare('SELECT * FROM deal_party_entities WHERE id = ? AND deal_id = ?').get(req.params.partyId, req.params.id);
  if (!party) return res.status(404).json({ error: 'Parte no encontrada.' });
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id);

  const linkedRecipients = db.prepare(`
    SELECT u.name, u.email FROM deal_parties dp JOIN users u ON u.id = dp.user_id WHERE dp.deal_party_entity_id = ?
  `).all(party.id);
  if (!linkedRecipients.length) return res.status(400).json({ error: 'Esta parte todavía no tiene una cuenta ligada — invítala primero.' });

  const pending = party.side === 'seller'
    ? db.prepare("SELECT name FROM documents WHERE status = 'pending' AND deal_id = ? AND (deal_party_entity_id = ? OR deal_party_entity_id IS NULL)").all(req.params.id, party.id)
    : db.prepare("SELECT name FROM documents WHERE status = 'pending' AND deal_party_entity_id = ?").all(party.id);
  if (!pending.length) return res.status(400).json({ error: 'Esta parte ya no tiene documentos pendientes.' });

  if (!mailer.isConfigured()) return res.status(501).json({ error: 'Resend no está configurado todavía (falta RESEND_API_KEY).' });
  const url = `${req.protocol}://${req.get('host')}/`;
  const lang = mailer.resolveClientLang(deal.scenario, party.side);
  const results = await Promise.all(linkedRecipients.map(linked => mailer.sendDocumentReminderEmail({
    to: linked.email, name: linked.name, dealProperty: deal.property, pendingDocNames: pending.map(p => p.name), url, lang
  })));
  const failed = results.find(r => !r.ok);
  if (failed) return res.status(502).json({ error: failed.error });
  db.prepare(`
    INSERT INTO document_reminders_log (deal_party_entity_id, last_sent_at) VALUES (?, datetime('now'))
    ON CONFLICT(deal_party_entity_id) DO UPDATE SET last_sent_at = datetime('now')
  `).run(party.id);
  res.json({ ok: true, count: pending.length });
});

// ── Clientes que se repiten ─────────────────────────────────────────────
// El mismo comprador/vendedor vuelve con otra propiedad. En vez de teclear
// otra vez su nombre y su correo exacto (y de que le vuelvan a pedir los
// mismos documentos), aquí se lista a los clientes de operaciones
// anteriores para engancharlos a esta con un clic — el mismo patrón que
// "agregar agente" (GET available-agents + POST agents).
//
// Alcance: admin y abogado interno ven a todos los clientes de las
// operaciones que ya pueden ver; agente y abogado externo, solo a los de
// SUS operaciones — la lista de clientes del despacho no es de todos.
router.get('/:id/past-clients', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const side = req.query.side === 'seller' ? 'seller' : 'buyer';

  const restricted = !UNRESTRICTED_ROLES.includes(req.session.role);
  const visibleDealsSql = restricted
    ? `AND (d.created_by = @userId OR d.id IN (SELECT deal_id FROM deal_parties WHERE user_id = @userId))`
    : '';

  const rows = db.prepare(`
    SELECT u.id AS userId, u.name AS accountName, u.email,
      dpe.id AS lastPartyId, dpe.name AS partyName, dpe.party_type AS partyType,
      dpe.ownership_mode AS ownershipMode, dpe.parent_entity_name AS parentEntityName,
      dpe.parent_entity_type AS parentEntityType, dpe.parent_has_trust_above AS parentHasTrustAbove,
      dpe.parent_trust_name AS parentTrustName, dpe.direct_trust_name AS directTrustName,
      d.id AS lastDealId, d.property AS lastDealProperty, d.start_date AS lastDealDate,
      (SELECT COUNT(*) FROM documents doc WHERE doc.deal_party_entity_id = dpe.id AND doc.file_url IS NOT NULL) AS reusableDocs
    FROM users u
    JOIN deal_parties dp ON dp.user_id = u.id AND dp.relationship = 'titular'
    JOIN deal_party_entities dpe ON dpe.id = dp.deal_party_entity_id
    JOIN deals d ON d.id = dp.deal_id
    WHERE u.role IN ('buyer', 'seller') AND u.status = 'active'
      AND d.id != @dealId AND d.deleted_at IS NULL
      AND u.id NOT IN (SELECT user_id FROM deal_parties WHERE deal_id = @dealId)
      ${visibleDealsSql}
    ORDER BY u.name COLLATE NOCASE, d.id DESC
  `).all({ dealId: Number(req.params.id), userId: req.session.userId });

  // Una fila por cliente: la de su operación más reciente (la consulta ya
  // viene ordenada por deal.id descendente dentro de cada persona).
  const seen = new Set();
  const clients = rows.filter(r => (seen.has(r.userId) ? false : seen.add(r.userId)));
  res.json({ side, clients });
});

// POST /api/deals/:id/parties/from-client { side, userId, copyDocuments }
// — crea la parte con los mismos datos que traía en su operación anterior,
// le liga su cuenta de siempre y, si se pide, le trae los documentos que ya
// había entregado para que solo tenga que actualizar los que caducaron.
const fromClientSchema = z.object({
  side: z.enum(['buyer', 'seller']),
  userId: z.number().int().positive(),
  copyDocuments: z.boolean().optional()
}).strict();

router.post('/:id/parties/from-client', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), rateLimitWrite, validateBody(fromClientSchema), async (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const deal = db.prepare('SELECT * FROM deals WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });
  const { side, userId, copyDocuments } = req.body;

  const user = db.prepare("SELECT id, name, email, role FROM users WHERE id = ? AND role IN ('buyer','seller') AND status = 'active'").get(userId);
  if (!user) return res.status(404).json({ error: 'Ese cliente ya no existe o no es una cuenta de comprador/vendedor.' });
  if (db.prepare('SELECT 1 FROM deal_parties WHERE deal_id = ? AND user_id = ?').get(deal.id, userId)) {
    return res.status(409).json({ error: 'Esa persona ya está en esta operación.' });
  }
  if (db.prepare('SELECT COUNT(*) c FROM deal_party_entities WHERE deal_id = ? AND side = ?').get(deal.id, side).c >= MAX_PARTIES_PER_SIDE) {
    return res.status(400).json({ error: `Máximo ${MAX_PARTIES_PER_SIDE} por lado.` });
  }

  // Su parte más reciente, de donde se copian forma y documentos.
  const prior = db.prepare(`
    SELECT dpe.* FROM deal_parties dp
    JOIN deal_party_entities dpe ON dpe.id = dp.deal_party_entity_id
    JOIN deals d ON d.id = dp.deal_id
    WHERE dp.user_id = ? AND dp.relationship = 'titular' AND d.id != ? AND d.deleted_at IS NULL
    ORDER BY d.id DESC LIMIT 1
  `).get(userId, deal.id);
  if (!prior) return res.status(404).json({ error: 'Ese cliente no tiene una operación anterior de dónde copiar.' });

  const p = {
    name: prior.name,
    partyType: prior.party_type,
    ownershipMode: prior.ownership_mode || undefined,
    parentEntityName: prior.parent_entity_name || undefined,
    parentEntityType: prior.parent_entity_type || undefined,
    parentHasTrustAbove: !!prior.parent_has_trust_above,
    parentTrustName: prior.parent_trust_name || undefined,
    directTrustName: prior.direct_trust_name || undefined,
    owners: db.prepare('SELECT name FROM deal_party_owners WHERE deal_party_entity_id = ? ORDER BY sort_order').all(prior.id)
  };
  // Se valida igual que un alta normal (misma función que POST /parties) en
  // vez de confiar en que lo copiado de la operación anterior sigue siendo
  // una parte bien formada.
  const invalid = validateParty({ ...p, side });
  if (invalid) return res.status(400).json({ error: invalid });

  let partyId;
  db.transaction(() => {
    const nextOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM deal_party_entities WHERE deal_id = ? AND side = ?').get(deal.id, side).n;
    partyId = insertPartyWithDocs(deal.id, deal.scenario, side, nextOrder, p);
    db.prepare('INSERT INTO deal_parties (deal_id, user_id, role_in_deal, deal_party_entity_id, relationship) VALUES (?,?,?,?,?)')
      .run(deal.id, userId, side, partyId, 'titular');
  })();

  let documentsCopied = 0;
  let copyError = null;
  if (copyDocuments) {
    try {
      documentsCopied = await copyPartyDocuments(deal.id, prior.id, partyId, req.session.userId);
    } catch (err) {
      copyError = err.message || 'No se pudieron copiar los documentos.';
      console.error('[from-client] copia de documentos', err.message);
    }
  }
  logActivity(deal.id, req.session.userId, 'person_added', p.name);
  res.json({ ok: true, partyId, documentsCopied, copyError });
});

// Trae a la parte nueva los archivos que esta misma persona ya había
// entregado antes, emparejando por nombre de documento. Se COPIA el objeto
// en Cloud Storage (no se comparte: borrar la operación vieja borra todo su
// prefijo) y llega como "por revisar", nunca como aprobado: una constancia
// de domicilio de hace dos años ya no sirve, y el punto es que el equipo
// vea rápido cuáles siguen vigentes y cuáles hay que actualizar.
async function copyPartyDocuments(dealId, fromPartyId, toPartyId, userId) {
  if (!gcsStorage.isConfigured()) return 0;
  const oldDocs = db.prepare('SELECT * FROM documents WHERE deal_party_entity_id = ? AND file_url IS NOT NULL').all(fromPartyId);
  const newDocs = db.prepare('SELECT * FROM documents WHERE deal_party_entity_id = ?').all(toPartyId);
  let copied = 0;
  for (const old of oldDocs) {
    const target = newDocs.find(n => n.name === old.name && (n.sub_label || '') === (old.sub_label || ''));
    if (!target || target.file_url) continue;
    try {
      if (!await gcsStorage.existsFile(old.file_url)) continue;
      const destKey = path.join(String(dealId), genFilename(old.original_name || `${old.name}.pdf`));
      await gcsStorage.copyFile(old.file_url, destKey);
      db.prepare(`
        UPDATE documents SET status = 'done', file_url = ?, original_name = ?, mime_type = ?, size_bytes = ?,
          uploaded_by = ?, uploaded_at = datetime('now'), review_status = 'pending', review_note = NULL,
          reviewed_by = NULL, reviewed_at = NULL
        WHERE id = ?
      `).run(destKey, old.original_name, old.mime_type, old.size_bytes, userId, target.id);
      copied++;
    } catch (err) {
      console.error('[from-client] no se pudo copiar', old.file_url, err.message);
    }
  }
  if (copied) logActivity(dealId, userId, 'docs_copied_from_past_deal', String(copied));
  return copied;
}

// GET /api/deals/:id/available-agents — agentes/abogados externos/abogados
// internos (con cuenta, activos O pendientes de aprobación) que todavía NO
// están ligados a esta operación — para el dropdown de "agregar" en el
// detalle de la operación, en vez de tener que generar una invitación
// nueva para alguien que ya es parte del equipo. Se incluyen los
// pendientes porque a veces hay que asignar a la operación antes de que un
// admin le apruebe la cuenta (no puede iniciar sesión mientras siga
// pendiente, pero sí queda asignado desde ya) — status se manda para que
// la UI lo marque como "pendiente".
// Un abogado interno YA NO ve todas las operaciones automáticamente (ver
// lib/access.js) — por eso ahora también aparece aquí, para que un admin
// pueda asignarlo a una operación específica (o para que el que la creó
// aparezca ya excluido, si se agregó a mano de más).
router.get('/:id/available-agents', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const agents = db.prepare(`
    SELECT id, name, email, agency, status, role, avatar_url AS avatarUrl FROM users
    WHERE role IN ('agent', 'external_lawyer', 'lawyer') AND status IN ('active', 'pending')
      AND id NOT IN (SELECT user_id FROM deal_parties WHERE deal_id = ? AND role_in_deal = 'agent')
      AND id != COALESCE((SELECT created_by FROM deals WHERE id = ?), 0)
    ORDER BY status = 'pending', name
  `).all(req.params.id, req.params.id);
  res.json(agents);
});

// POST /api/deals/:id/agents — liga a esta operación un agente/abogado
// externo/abogado interno que YA tiene cuenta (elegido del dropdown de
// available-agents), sin pasar por el flujo de invitación/contraseña —
// solo tiene sentido para alguien que ya se registró antes en la
// plataforma. Se permite aunque su cuenta siga 'pending' de aprobación
// (queda asignado desde ya; solo puede iniciar sesión una vez que un admin
// lo apruebe, esa regla no cambia).
router.post('/:id/agents', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), rateLimitWrite, validateBody(addAgentSchema), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const { userId, representsSide } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND role IN ('agent', 'external_lawyer', 'lawyer') AND status IN ('active', 'pending')").get(userId);
  if (!user) return res.status(400).json({ error: 'Ese usuario no existe o no es un agente/abogado.' });
  const already = db.prepare('SELECT 1 FROM deal_parties WHERE deal_id = ? AND user_id = ?').get(req.params.id, userId);
  if (already) return res.status(409).json({ error: 'Ese agente ya está en esta operación.' });
  db.prepare("INSERT INTO deal_parties (deal_id, user_id, role_in_deal, represents_side) VALUES (?,?,'agent',?)").run(req.params.id, userId, representsSide || null);
  res.status(201).json({ ok: true });
  logActivity(req.params.id, req.session.userId, 'person_added', user.name);

  // Aviso por correo (best-effort, no bloquea la respuesta) — el agente ya
  // tiene cuenta, solo le avisamos que esta operación se agregó a la suya.
  if (mailer.isConfigured()) {
    const deal = db.prepare('SELECT property FROM deals WHERE id = ?').get(req.params.id);
    const url = `${req.protocol}://${req.get('host')}/?dealId=${req.params.id}`;
    mailer.sendAgentAddedToDealEmail({ to: user.email, name: user.name, dealProperty: deal.property, url })
      .then(result => { if (!result.ok) console.error('[resend] no se pudo avisar al agente agregado', req.params.id, result.error); });
  }
});

// POST /api/deals/:id/agents/register — alternativa a la invitación por
// correo para un agente que TODAVÍA NO tiene ninguna cuenta (ni pendiente):
// lo da de alta ya activo (no pasa por aprobación, quien lo está agregando
// ya es staff) y lo liga a esta operación de una vez, con una contraseña
// temporal que se comparte por el canal que prefieras.
router.post('/:id/agents/register', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), rateLimitEmail, validateBody(registerAgentSchema), async (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const { name, email: normalizedEmail, role, agency, agencyOther, representsSide } = req.body;
  const collaboratorRole = role === 'external_lawyer' ? 'external_lawyer' : 'agent';
  // La agencia (LPR Luxury, etc.) solo aplica a agentes de venta — un
  // abogado externo no tiene una, es de su propio despacho.
  let resolvedAgency = null;
  if (collaboratorRole === 'agent') {
    resolvedAgency = resolveAgency(agency, agencyOther);
    if (!resolvedAgency) return res.status(400).json({ error: 'Elige la agencia del agente (o escribe cuál si no está en la lista).' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) {
    return res.status(409).json({ error: 'Ya existe una cuenta con ese correo — agrégalo desde el dropdown de "Agentes disponibles" en vez de darlo de alta otra vez.' });
  }

  const password = crypto.randomBytes(6).toString('base64url');
  const hash = bcrypt.hashSync(password, 12);

  const registerTx = db.transaction(() => {
    const info = db.prepare("INSERT INTO users (name, email, password_hash, role, status, agency) VALUES (?,?,?,?,'active',?)")
      .run(name.trim(), normalizedEmail, hash, collaboratorRole, resolvedAgency);
    // role_in_deal se queda como 'agent' funcionalmente para ambos — lo que
    // distingue a un abogado externo de un agente es users.role, no su
    // función dentro de la operación (facilitador, no parte transaccional).
    db.prepare("INSERT INTO deal_parties (deal_id, user_id, role_in_deal, represents_side) VALUES (?,?,'agent',?)")
      .run(req.params.id, info.lastInsertRowid, representsSide || null);
    return info.lastInsertRowid;
  });

  const userId = registerTx();

  // Correo de bienvenida (best-effort, ANTES de responder para poder avisar
  // si no salió) — mismo criterio que sendPartyWelcomeEmail: da de alta
  // directo con contraseña temporal para compartir a mano, pero igual le
  // llega un link para poner su propia contraseña si prefiere entrar por
  // su cuenta.
  let welcomeEmailSent, welcomeEmailError;
  if (mailer.isConfigured()) {
    const deal = db.prepare('SELECT property FROM deals WHERE id = ?').get(req.params.id);
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
    db.prepare('INSERT INTO password_resets (token, user_id, expires_at) VALUES (?,?,?)').run(token, userId, expiresAt);
    const url = `${req.protocol}://${req.get('host')}/reset-password.html?token=${token}`;
    try {
      const result = await mailer.sendInviteEmail({ to: normalizedEmail, name: name.trim(), roleInDeal: collaboratorRole, dealProperty: deal.property, url });
      welcomeEmailSent = result.ok; welcomeEmailError = result.ok ? null : result.error;
      if (!result.ok) console.error('[welcome-email] no se pudo mandar a', normalizedEmail, '-', result.error);
    } catch (err) {
      welcomeEmailSent = false; welcomeEmailError = err.message;
    }
  }

  res.status(201).json({ id: userId, name: name.trim(), email: normalizedEmail, role: collaboratorRole, agency: resolvedAgency, temporaryPassword: password, welcomeEmailSent, welcomeEmailError });
});

// PATCH /api/deals/:id/agents/:userId — cambia a quién representa un agente
// ya agregado (ej. se les olvidó elegirlo, o cambió de cliente).
router.patch('/:id/agents/:userId', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), rateLimitWrite, validateBody(updateAgentSchema), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const { representsSide } = req.body;
  const info = db.prepare("UPDATE deal_parties SET represents_side = ? WHERE deal_id = ? AND user_id = ? AND role_in_deal = 'agent'")
    .run(representsSide, req.params.id, req.params.userId);
  if (!info.changes) return res.status(404).json({ error: 'Ese agente no está en esta operación.' });
  res.json({ ok: true });
});

// DELETE /api/deals/:id/agents/:userId — quita a un agente de la operación
// (no de la plataforma, solo deja de verla). Restringido a role_in_deal
// 'agent' para no poder usar esta ruta contra un comprador/vendedor ligado.
router.delete('/:id/agents/:userId', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), rateLimitWrite, (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const info = db.prepare("DELETE FROM deal_parties WHERE deal_id = ? AND user_id = ? AND role_in_deal = 'agent'").run(req.params.id, req.params.userId);
  if (!info.changes) return res.status(404).json({ error: 'Ese agente no está en esta operación.' });
  res.json({ ok: true });
});

// POST /api/deals/:id/drive-folder — crea (o reintenta crear) la estructura
// de carpetas en Drive para una operación que no la tiene todavía (ej. se
// creó antes de conectar Drive, o la primera vez falló).
router.post('/:id/drive-folder', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), rateLimitWrite, async (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  if (!driveClient.isConfigured()) return res.status(501).json({ error: 'Google Drive no está configurado todavía.' });
  if (!driveClient.isConnected()) return res.status(501).json({ error: 'Google Drive no está conectado — ve a Equipo → Integraciones.' });
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });
  try {
    const { folderId, folderUrl } = await driveClient.createDealFolderStructure(req, deal.property);
    db.prepare('UPDATE deals SET drive_folder_id = ?, drive_folder_url = ? WHERE id = ?').run(folderId, folderUrl, deal.id);
    res.json({ ok: true, folderUrl });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Error al crear la carpeta en Drive.' });
  }
});

// POST /api/deals/:id/documents — agrega un requisito de documento nuevo al
// checklist, fuera de lo que trae la plantilla del escenario (data/
// scenario-docs.json) — para cuando esta operación en particular necesita
// algo especial que la lista fija no contempla. Solo staff: agregar
// requisitos al checklist es curaduría, no algo que un comprador/vendedor
// haga sobre sí mismo. Sin dealPartyEntityId es un documento de Propiedad.
// Comprador/vendedor también puede agregar un requisito extra a su propio
// checklist (ej. un comprobante más de los que ya se sabe que siempre hay
// más de uno) — antes solo staff podía, y el cliente tenía que pedírselo a
// un admin/agente para algo tan simple como "necesito otra fila".
router.post('/:id/documents', requireRole('admin', 'agent', 'lawyer', 'external_lawyer', 'buyer', 'seller'), rateLimitWrite, validateBody(addDocumentSchema), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const { name, dealPartyEntityId, subLabel, section } = req.body;

  // Gestoría/Banco son secciones de trabajo de los abogados — un
  // comprador/vendedor/agente ni siquiera las ve (GET /:id se las filtra).
  if (section && !['admin', 'lawyer', 'external_lawyer'].includes(req.session.role)) {
    return res.status(403).json({ error: 'No autorizado para agregar documentos en esta sección.' });
  }
  if (section && dealPartyEntityId) {
    return res.status(400).json({ error: 'Un documento de Gestoría/Banco es de la operación, no de una parte.' });
  }

  let partyId = null;
  if (dealPartyEntityId !== undefined && dealPartyEntityId !== null) {
    const party = db.prepare('SELECT * FROM deal_party_entities WHERE id = ? AND deal_id = ?').get(dealPartyEntityId, req.params.id);
    if (!party) return res.status(404).json({ error: 'Parte no encontrada.' });
    if (AGENT_LIKE_ROLES.includes(req.session.role)) {
      const side = myRepresentsSide(req, req.params.id);
      if (side && party.side !== side) return res.status(403).json({ error: 'No puedes agregar documentos del otro lado.' });
    }
    // Un comprador/vendedor real solo puede agregar a SU PROPIA parte, nunca
    // a la de alguien más del mismo o del otro lado.
    if (['buyer', 'seller'].includes(req.session.role) && party.id !== myDealPartyEntityId(req, req.params.id)) {
      return res.status(403).json({ error: 'No puedes agregar documentos de otra parte.' });
    }
    partyId = party.id;
  }

  const info = db.prepare("INSERT INTO documents (deal_id, deal_party_entity_id, sub_label, name, section, created_at) VALUES (?,?,?,?,?,datetime('now'))")
    .run(req.params.id, partyId, (subLabel || '').trim() || null, name.trim(), section || null);
  res.status(201).json({ id: info.lastInsertRowid });
});

// DELETE /api/deals/:id/documents/:docId — quita un requisito del checklist
// POR COMPLETO (no solo el archivo que tuviera subido — ver DELETE .../file
// arriba para eso) — para cuando algo de la lista fija no aplica a esta
// operación. Solo staff, mismo motivo que agregar.
router.delete('/:id/documents/:docId', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), rateLimitWrite, async (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND deal_id = ?').get(req.params.docId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'Documento no encontrado.' });
  if (AGENT_LIKE_ROLES.includes(req.session.role) && doc.deal_party_entity_id !== null) {
    const side = myRepresentsSide(req, req.params.id);
    if (side) {
      const party = db.prepare('SELECT side FROM deal_party_entities WHERE id = ?').get(doc.deal_party_entity_id);
      if (!party || party.side !== side) return res.status(403).json({ error: 'No puedes borrar documentos del otro lado.' });
    }
  }
  db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
  res.json({ ok: true });
  if (doc.file_url) gcsStorage.deleteFile(doc.file_url).catch(err => console.error('[gcs] no se pudo borrar el archivo', doc.file_url, err.message));
});

// PATCH /api/deals/:id/documents/:docId — marcar documento recibido y/o
// (solo para los documentos de LLC que lo requieren) marcar cuáles de sus
// requisitos (notarizado/apostillado/traducido) ya llegaron.
router.patch('/:id/documents/:docId', requireAuth, rateLimitWrite, validateBody(updateDocumentSchema), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND deal_id = ?').get(req.params.docId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'Documento no encontrado.' });
  if (!canTouchDoc(req, req.params.id, doc)) return res.status(403).json({ error: 'No puedes modificar documentos de otra parte.' });
  const { status, subChecks } = req.body;
  if (status !== undefined) {
    db.prepare('UPDATE documents SET status = ?, uploaded_by = ?, uploaded_at = datetime(\'now\') WHERE id = ? AND deal_id = ?')
      .run(status, req.session.userId, req.params.docId, req.params.id);
  }
  if (subChecks !== undefined) {
    const allowed = SUB_CHECKS_BY_DOC[doc.name];
    if (!allowed) return res.status(400).json({ error: 'Este documento no lleva casillas de notarizado/apostillado/traducido.' });
    if (Object.keys(subChecks).some(k => !allowed.includes(k))) {
      return res.status(400).json({ error: `Este documento solo acepta: ${allowed.join(', ')}.` });
    }
    const current = doc.sub_checks_json ? JSON.parse(doc.sub_checks_json) : {};
    const merged = { ...current, ...subChecks };
    db.prepare('UPDATE documents SET sub_checks_json = ? WHERE id = ? AND deal_id = ?').run(JSON.stringify(merged), req.params.docId, req.params.id);
  }
  res.json({ ok: true });
});

// PATCH /api/deals/:id/documents/:docId/review — admin/abogado interno
// aprueba o rechaza el archivo ya subido (por si se subió mal o no es
// válido). Solo admin/lawyer, nunca agente/abogado externo — son quienes
// suben/gestionan documentos por el cliente, no quienes los validan.
router.patch('/:id/documents/:docId/review', requireRole('admin', 'lawyer'), rateLimitWrite, validateBody(reviewDocumentSchema), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND deal_id = ?').get(req.params.docId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'Documento no encontrado.' });
  if (!doc.file_url) return res.status(400).json({ error: 'Este documento todavía no tiene archivo subido.' });
  const { reviewStatus, reviewNote } = req.body;
  db.prepare(`
    UPDATE documents SET review_status = ?, review_note = ?, reviewed_by = ?, reviewed_at = datetime('now')
    WHERE id = ? AND deal_id = ?
  `).run(reviewStatus, reviewStatus === 'rejected' ? (reviewNote || null) : null, req.session.userId, req.params.docId, req.params.id);
  logActivity(req.params.id, req.session.userId, reviewStatus === 'approved' ? 'doc_approved' : 'doc_rejected', doc.name);
  res.json({ ok: true });
});

// POST /api/deals/:id/documents/:docId/file — subir el archivo de un documento del checklist.
router.post('/:id/documents/:docId/file', requireAuth, rateLimitUpload, (req, res, next) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND deal_id = ?').get(req.params.docId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'Documento no encontrado.' });
  if (!canTouchDoc(req, req.params.id, doc)) {
    return res.status(403).json({ error: 'No puedes subir documentos de otra parte.' });
  }
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Archivo inválido.' });
    if (!req.file) return res.status(400).json({ error: 'Tipo de archivo no permitido (solo PDF, JPG, PNG, HEIC) o falta el archivo.' });
    try {
      const key = path.join(String(req.params.id), genFilename(req.file.originalname));
      await gcsStorage.uploadBuffer(key, req.file.buffer, req.file.mimetype);
      // Si ya había un archivo, se archiva como versión ANTES de
      // reemplazarlo — el objeto en Cloud Storage se conserva (mismo
      // prefijo <dealId>/, así el borrado permanente de la operación
      // también lo limpia). Ver document_versions en db/schema.sql.
      archiveCurrentFileVersion(doc);
      db.prepare(`
        UPDATE documents SET file_url=?, original_name=?, mime_type=?, size_bytes=?, status='done',
          uploaded_by=?, uploaded_at=datetime('now'),
          review_status='pending', review_note=NULL, reviewed_by=NULL, reviewed_at=NULL
        WHERE id=? AND deal_id=?
      `).run(key, req.file.originalname, req.file.mimetype, req.file.size, req.session.userId, req.params.docId, req.params.id);
      res.json({ ok: true });
      logActivity(req.params.id, req.session.userId, doc.file_url ? 'doc_replaced' : 'doc_uploaded', doc.name);
      syncDocumentToDrive(req, req.params.id, doc.deal_party_entity_id, `${doc.name}${doc.sub_label ? ' - ' + doc.sub_label : ''} - ${req.file.originalname}`, req.file.buffer, req.file.mimetype, doc.section);
    } catch (uploadErr) {
      res.status(502).json({ error: uploadErr.message || 'Error al subir el archivo.' });
    }
  });
});

// Archiva el archivo ACTUAL de un documento como versión histórica (si
// tiene) — compartido entre re-subir y quitar. No borra nada de Cloud
// Storage: el punto es exactamente que la versión anterior siga existiendo.
function archiveCurrentFileVersion(doc) {
  if (!doc.file_url) return;
  db.prepare(`
    INSERT INTO document_versions (document_id, file_url, original_name, mime_type, size_bytes, uploaded_by, uploaded_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(doc.id, doc.file_url, doc.original_name, doc.mime_type, doc.size_bytes, doc.uploaded_by, doc.uploaded_at);
}

// DELETE /api/deals/:id/documents/:docId/file — quita el archivo subido y
// regresa el documento a 'pending' (en vez de solo poder reemplazarlo). Usa
// la misma regla de acceso que subirlo: comprador/vendedor solo el de su
// propia parte, staff sin restricción. El archivo NO se borra de Cloud
// Storage: se archiva como versión histórica (document_versions) — en una
// plataforma legal "quitar" significa "ya no es el actual", nunca "no
// existió"; el borrado real solo pasa con el borrado permanente de la
// operación (deletePrefix).
router.delete('/:id/documents/:docId/file', requireAuth, rateLimitWrite, async (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND deal_id = ?').get(req.params.docId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'Documento no encontrado.' });
  if (!canTouchDoc(req, req.params.id, doc)) {
    return res.status(403).json({ error: 'No puedes borrar documentos de otra parte.' });
  }
  if (!doc.file_url) return res.status(400).json({ error: 'Este documento no tiene archivo subido.' });
  archiveCurrentFileVersion(doc);
  db.prepare(`
    UPDATE documents SET file_url=NULL, original_name=NULL, mime_type=NULL, size_bytes=NULL, status='pending',
      uploaded_by=NULL, uploaded_at=NULL,
      review_status='pending', review_note=NULL, reviewed_by=NULL, reviewed_at=NULL
    WHERE id=? AND deal_id=?
  `).run(req.params.docId, req.params.id);
  logActivity(req.params.id, req.session.userId, 'doc_file_removed', doc.name);
  res.json({ ok: true });
});

// GET /api/deals/:id/documents/:docId/versions — historial de versiones del
// documento (quién subió qué y cuándo, más recientes primero). Mismo
// permiso que ver el archivo actual.
router.get('/:id/documents/:docId/versions', requireAuth, (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND deal_id = ?').get(req.params.docId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'Documento no encontrado.' });
  if (!canTouchDoc(req, req.params.id, doc)) {
    return res.status(403).json({ error: 'No puedes ver documentos de otra parte.' });
  }
  const rows = db.prepare(`
    SELECT v.id, v.original_name, v.mime_type, v.size_bytes, v.uploaded_at, v.archived_at, u.name AS uploadedByName
    FROM document_versions v LEFT JOIN users u ON u.id = v.uploaded_by
    WHERE v.document_id = ?
    ORDER BY v.id DESC
  `).all(req.params.docId);
  res.json(rows);
});

// GET /api/deals/:id/documents/:docId/versions/:versionId/file — descarga
// de una versión archivada, con la misma autorización que el archivo actual.
router.get('/:id/documents/:docId/versions/:versionId/file', requireAuth, async (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND deal_id = ?').get(req.params.docId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'Documento no encontrado.' });
  if (!canTouchDoc(req, req.params.id, doc)) {
    return res.status(403).json({ error: 'No puedes ver documentos de otra parte.' });
  }
  const version = db.prepare('SELECT * FROM document_versions WHERE id = ? AND document_id = ?').get(req.params.versionId, req.params.docId);
  if (!version) return res.status(404).json({ error: 'Versión no encontrada.' });
  if (!await gcsStorage.existsFile(version.file_url)) return res.status(404).json({ error: 'Archivo no encontrado.' });
  try {
    await gcsStorage.streamToResponse(version.file_url, res, {
      contentType: version.mime_type || 'application/octet-stream',
      downloadName: version.original_name || 'documento',
      inline: true
    });
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: 'Error al leer el archivo.' });
  }
});

// GET /api/deals/:id/documents/:docId/file — descarga autenticada del archivo subido.
router.get('/:id/documents/:docId/file', requireAuth, async (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND deal_id = ?').get(req.params.docId, req.params.id);
  if (!doc || !doc.file_url) return res.status(404).json({ error: 'Archivo no encontrado.' });

  if (!canTouchDoc(req, req.params.id, doc)) {
    return res.status(403).json({ error: 'No puedes ver documentos de otra parte.' });
  }

  if (!await gcsStorage.existsFile(doc.file_url)) return res.status(404).json({ error: 'Archivo no encontrado.' });
  try {
    await gcsStorage.streamToResponse(doc.file_url, res, {
      contentType: doc.mime_type || 'application/octet-stream',
      downloadName: doc.original_name || 'documento',
      inline: true
    });
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: 'Error al leer el archivo.' });
  }
});

// PATCH /api/deals/:id/tasks/:taskId — actualizar estado del tracker.
// Confirmar que un paso del tracker de cierre ya se hizo es solo de
// admin/abogado interno — antes cualquiera con acceso a la operación
// (agente, comprador, vendedor) podía ir marcándolo, cuando en realidad es
// quien coordina el cierre quien sabe si ese paso de verdad se completó.
router.patch('/:id/tasks/:taskId', requireRole('admin', 'lawyer'), rateLimitWrite, validateBody(updateTaskSchema), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const { status, assignedTo, signedOffline } = req.body;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND deal_id = ?').get(req.params.taskId, req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada.' });

  // "Firmado fuera de la plataforma" — el escrow (o cualquier tarea de
  // firma) a veces se firma en papel/por correo y se sube ya firmado; con
  // esto deja de aparecerle al cliente como firma pendiente. Solo aplica a
  // tareas de firma, exige que el documento firmado YA esté subido, y nunca
  // pisa un sobre real de DocuSign (para eso está "Verificar estado").
  if (signedOffline !== undefined) {
    if (!task.requires_signature) return res.status(400).json({ error: 'Esta tarea no es de firma.' });
    if (task.docusign_envelope_id) {
      return res.status(400).json({ error: 'Este documento se mandó por DocuSign — usa "Verificar estado" para sincronizar su firma.' });
    }
    if (signedOffline) {
      if (!task.document_url) return res.status(400).json({ error: 'Sube primero el documento ya firmado.' });
      db.prepare("UPDATE tasks SET docusign_status = 'completed', status = 'done', completed_at = datetime('now') WHERE id = ? AND deal_id = ?")
        .run(req.params.taskId, req.params.id);
      logActivity(req.params.id, req.session.userId, 'task_signed_offline', task.label_es);
    } else {
      if (task.docusign_status !== 'completed') return res.status(400).json({ error: 'Esta tarea no está marcada como firmada.' });
      db.prepare("UPDATE tasks SET docusign_status = 'not_sent', status = 'pending', completed_at = NULL WHERE id = ? AND deal_id = ?")
        .run(req.params.taskId, req.params.id);
      logActivity(req.params.id, req.session.userId, 'task_reopened', task.label_es);
    }
    return res.json({ ok: true });
  }

  if (status !== undefined) {
    // completed_at: la fecha real en que se completó el paso — alimenta la
    // línea de tiempo y el resumen de avance; se limpia si se reabre.
    db.prepare("UPDATE tasks SET status = ?, completed_at = CASE WHEN ? = 'done' THEN datetime('now') ELSE NULL END WHERE id = ? AND deal_id = ?")
      .run(status, status, req.params.taskId, req.params.id);
    if (status === 'done' && task.status !== 'done') {
      logActivity(req.params.id, req.session.userId, 'task_done', task.label_es);
    } else if (status !== 'done' && task.status === 'done') {
      logActivity(req.params.id, req.session.userId, 'task_reopened', task.label_es);
    }
  }

  // Asignar la tarea a un abogado interno (o a un admin, o a nadie con
  // null) — solo admin decide quién lleva cada paso.
  let assignee = null;
  if (assignedTo !== undefined) {
    if (req.session.role !== 'admin') {
      return res.status(403).json({ error: 'Solo un administrador puede asignar tareas.' });
    }
    if (assignedTo !== null) {
      assignee = db.prepare("SELECT id, name, email FROM users WHERE id = ? AND role IN ('lawyer', 'admin') AND status = 'active'").get(assignedTo);
      if (!assignee) return res.status(400).json({ error: 'Solo se puede asignar a un abogado interno o admin activo.' });
      logActivity(req.params.id, req.session.userId, 'task_assigned', `${task.label_es} → ${assignee.name}`);
    }
    db.prepare('UPDATE tasks SET assigned_to = ? WHERE id = ? AND deal_id = ?')
      .run(assignedTo, req.params.taskId, req.params.id);
  }

  res.json({ ok: true });

  // Aviso por correo al asignado (best-effort, después de responder) — que
  // se entere de que le toca sin tener que entrar a revisar. No se avisa si
  // se asigna a sí mismo ni al des-asignar.
  if (assignee && assignee.id !== req.session.userId && task.assigned_to !== assignee.id && mailer.isConfigured()) {
    const deal = db.prepare('SELECT property FROM deals WHERE id = ?').get(req.params.id);
    const assigner = db.prepare('SELECT name FROM users WHERE id = ?').get(req.session.userId);
    mailer.sendTaskAssignedEmail({
      to: assignee.email, name: assignee.name, dealProperty: deal.property,
      taskLabel: task.label_es, assignedByName: assigner ? assigner.name : 'Un administrador',
      url: `${req.protocol}://${req.get('host')}/?dealId=${req.params.id}`
    }).then(r => { if (!r.ok) console.error('[resend] no se pudo avisar la tarea asignada', req.params.id, r.error); });
  }
});

// GET /api/deals/:id/team-assignees — admins y abogados internos activos, a
// quienes se les puede asignar una tarea del tracker. Visible para
// admin/abogado (los que ven la sección de asignación) — /api/users
// completo es solo de admin, esto expone únicamente id/nombre.
router.get('/:id/team-assignees', requireRole('admin', 'lawyer'), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const rows = db.prepare("SELECT id, name, role FROM users WHERE role IN ('lawyer', 'admin') AND status = 'active' ORDER BY name").all();
  res.json(rows);
});

// DELETE /api/deals/:id — a la papelera, no se borra de una vez. Antes un
// solo clic + el confirm() del navegador bastaban para perder una
// operación real para siempre (borraba la fila, sus partes/documentos/
// tareas/KYC en cascada, Y los archivos en Cloud Storage, todo sin
// respaldo) — ahora solo se marca deleted_at y se esconde de la lista
// normal; un admin la puede restaurar desde la Papelera, o borrarla de
// verdad aparte (DELETE .../permanent) cuando esté seguro.
router.delete('/:id', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), rateLimitWrite, (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const info = db.prepare("UPDATE deals SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ? AND deleted_at IS NULL")
    .run(req.session.userId, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Operación no encontrada.' });
  logActivity(req.params.id, req.session.userId, 'deal_trashed', null);
  res.json({ ok: true });
});

// POST /api/deals/:id/restore — solo admin, saca una operación de la
// papelera (limpia deleted_at, vuelve a aparecer normal en todos lados).
router.post('/:id/restore', requireRole('admin'), rateLimitWrite, (req, res) => {
  const info = db.prepare("UPDATE deals SET deleted_at = NULL, deleted_by = NULL WHERE id = ? AND deleted_at IS NOT NULL")
    .run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'No hay ninguna operación borrada con ese id.' });
  logActivity(req.params.id, req.session.userId, 'deal_restored', null);
  res.json({ ok: true });
});

// Nombre seguro para archivos/carpetas dentro del ZIP del expediente —
// sin separadores de ruta ni caracteres de control, largo acotado.
function safeName(s) {
  return String(s || '').replace(/[\/\\:*?"<>|\x00-\x1f]/g, '-').trim().slice(0, 120) || 'archivo';
}

// GET /api/deals/:id/export — descarga TODO el expediente de la operación
// en un solo ZIP organizado por carpetas (Propiedad / Vendedor / Comprador /
// Gestoría / Banco / KYC / Contrato / Firmas): documentos del checklist,
// expedientes KYC generados, contrato de promesa y documentos de las tareas
// de firma. Para el archivo muerto del despacho y para entregarle al
// cliente su copia al cierre. Solo admin/abogado interno.
router.get('/:id/export', requireRole('admin', 'lawyer'), rateLimitExpensive, async (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const deal = db.prepare('SELECT * FROM deals WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });
  if (!gcsStorage.isConfigured()) return res.status(501).json({ error: 'Cloud Storage no está configurado.' });

  // Recolectar todo lo que tiene archivo, con su carpeta destino.
  const entries = [];
  db.prepare(`
    SELECT d.*, dpe.side, dpe.name AS partyName FROM documents d
    LEFT JOIN deal_party_entities dpe ON dpe.id = d.deal_party_entity_id
    WHERE d.deal_id = ? AND d.file_url IS NOT NULL
  `).all(deal.id).forEach(d => {
    let dir = 'Propiedad';
    if (d.section === 'gestoria') dir = 'Gestoría';
    else if (d.section === 'banco') dir = 'Banco';
    else if (d.deal_party_entity_id) dir = path.join(d.side === 'seller' ? 'Vendedor' : 'Comprador', safeName(d.partyName));
    entries.push({ key: d.file_url, dir, filename: safeName(`${d.name}${d.sub_label ? ' - ' + d.sub_label : ''} - ${d.original_name || 'archivo'}`) });
  });
  db.prepare(`
    SELECT k.*, dpe.name AS partyName FROM kyc_submissions k
    JOIN deal_party_entities dpe ON dpe.id = k.deal_party_entity_id
    WHERE k.deal_id = ? AND k.generated_file_url IS NOT NULL
  `).all(deal.id).forEach(k => {
    entries.push({ key: k.generated_file_url, dir: 'KYC', filename: safeName(`KYC ${k.partyName} (${k.template_key})`) + path.extname(k.generated_file_url) });
  });
  if (deal.contract_generated_file_url) {
    entries.push({ key: deal.contract_generated_file_url, dir: 'Contrato', filename: safeName(`Contrato de Promesa - ${deal.property}`) + path.extname(deal.contract_generated_file_url) });
  }
  db.prepare('SELECT * FROM tasks WHERE deal_id = ? AND document_url IS NOT NULL').all(deal.id).forEach(tk => {
    entries.push({ key: tk.document_url, dir: 'Firmas', filename: safeName(`${tk.label_es} - ${tk.document_original_name || 'documento'}`) });
  });

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'expediente-'));
  const rootName = safeName(deal.property);
  let added = 0;
  try {
    for (const e of entries) {
      try {
        if (!await gcsStorage.existsFile(e.key)) continue;
        const buf = await gcsStorage.downloadToBuffer(e.key);
        const dir = path.join(tmpRoot, rootName, e.dir);
        fs.mkdirSync(dir, { recursive: true });
        // sin pisarse: si dos archivos quedan con el mismo nombre, numerar
        let dest = path.join(dir, e.filename);
        const ext = path.extname(e.filename);
        const base = e.filename.slice(0, e.filename.length - ext.length);
        for (let n = 2; fs.existsSync(dest); n++) dest = path.join(dir, `${base} (${n})${ext}`);
        fs.writeFileSync(dest, buf);
        added++;
      } catch (err) {
        console.error('[export] no se pudo incluir', e.key, err.message);
      }
    }
    if (!added) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      return res.status(400).json({ error: 'Esta operación todavía no tiene archivos subidos.' });
    }
    const zipPath = path.join(tmpRoot, 'expediente.zip');
    execFileSync('zip', ['-r', '-q', zipPath, rootName], { cwd: tmpRoot, timeout: 120000 });
    logActivity(deal.id, req.session.userId, 'expediente_exported', `${added} archivo(s)`);

    const downloadName = `Expediente - ${rootName}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
    res.on('close', () => fs.rmSync(tmpRoot, { recursive: true, force: true }));
    fs.createReadStream(zipPath).pipe(res);
  } catch (err) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (!res.headersSent) res.status(500).json({ error: 'No se pudo armar el expediente.' });
    console.error('[export]', deal.id, err.message);
  }
});

// GET /api/deals/:id/activity — línea de tiempo de la operación (quién
// subió/aprobó/completó qué y cuándo). Solo staff: el detalle de actividad
// entre partes (ej. qué subió el vendedor) no le corresponde al comprador.
// Solo admin/abogado interno: la bitácora nombra a las partes ("agregó a
// jimena", "mandó a firma el KYC de jimena") y los documentos de AMBOS
// lados. Un agente representa a un solo lado y no debe enterarse de lo del
// otro, así que aquí no entra — ve el avance de su lado en su propia
// sección de documentos.
router.get('/:id/activity', requireRole('admin', 'lawyer'), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const rows = db.prepare(`
    SELECT a.id, a.action, a.detail, a.created_at, u.name AS userName
    FROM deal_activity a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.deal_id = ?
    ORDER BY a.id DESC
    LIMIT 60
  `).all(req.params.id);
  res.json(rows);
});

// POST /api/deals/:id/send-progress-summary — manda a las partes ligadas
// (titular y apoderado de cada lado) el resumen del tracker: pasos ya
// completados y cuál sigue. Lo dispara admin/abogado interno a mano
// ("mandar resumen de esta semana") — deliberadamente no es automático:
// quien coordina decide cuándo hay avance que valga la pena comunicar.
router.post('/:id/send-progress-summary', requireRole('admin', 'lawyer'), rateLimitEmail, async (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const deal = db.prepare('SELECT * FROM deals WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });
  if (!mailer.isConfigured()) return res.status(501).json({ error: 'Resend no está configurado todavía (falta RESEND_API_KEY).' });

  const tasks = db.prepare('SELECT * FROM tasks WHERE deal_id = ? ORDER BY sort_order').all(req.params.id);
  const recipients = db.prepare(`
    SELECT u.name, u.email, dpe.side FROM deal_parties dp
    JOIN users u ON u.id = dp.user_id
    JOIN deal_party_entities dpe ON dpe.id = dp.deal_party_entity_id
    WHERE dp.deal_id = ? AND dp.role_in_deal IN ('buyer','seller')
  `).all(req.params.id);
  if (!recipients.length) return res.status(400).json({ error: 'Ninguna parte tiene cuenta ligada todavía — no hay a quién mandarle el resumen.' });

  const url = `${req.protocol}://${req.get('host')}/`;
  const results = await Promise.all(recipients.map(r => {
    const lang = mailer.resolveClientLang(deal.scenario, r.side);
    const isEn = lang === 'en';
    const completedSteps = tasks.filter(t => t.status === 'done').map(t => isEn ? t.label_en : t.label_es);
    const next = tasks.find(t => t.status !== 'done');
    return mailer.sendProgressSummaryEmail({
      to: r.email, name: r.name, dealProperty: deal.property,
      completedSteps, nextStep: next ? (isEn ? next.label_en : next.label_es) : null,
      url, lang
    });
  }));
  const failed = results.find(r => !r.ok);
  if (failed) return res.status(502).json({ error: failed.error });

  db.prepare("UPDATE deals SET last_progress_email_at = datetime('now') WHERE id = ?").run(req.params.id);
  logActivity(req.params.id, req.session.userId, 'progress_summary_sent', `${recipients.length} destinatario(s)`);
  res.json({ ok: true, count: recipients.length });
});

// DELETE /api/deals/:id/permanent — solo admin, el borrado de verdad (lo
// que antes hacía DELETE /:id): borra la fila en cascada y los archivos en
// Cloud Storage. Solo funciona sobre algo que YA está en la papelera —
// no se puede saltar directo de "activa" a "borrada para siempre" sin
// pasar por ahí primero.
router.delete('/:id/permanent', requireRole('admin'), rateLimitWrite, (req, res) => {
  const info = db.prepare('DELETE FROM deals WHERE id = ? AND deleted_at IS NOT NULL').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Esa operación no está en la papelera (bórrala primero para poder eliminarla para siempre).' });
  gcsStorage.deletePrefix(String(req.params.id) + '/').catch(err => {
    console.error('[gcs] no se pudieron borrar los archivos de la operación', req.params.id, err.message);
  });
  res.json({ ok: true });
});

module.exports = router;
