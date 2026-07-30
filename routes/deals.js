const express = require('express');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, requireRole, resolveAgency } = require('./auth');
const { genFilename } = require('../lib/storage');
const { canAccessDeal, myRoleInDeal, myDealPartyEntityId, myRepresentsSide, UNRESTRICTED_ROLES, AGENT_LIKE_ROLES } = require('../lib/access');

// Comprador/vendedor solo puede tocar documentos de su propia parte; un
// agente que ya eligió a qué lado representa solo los de ese lado; los de
// la Propiedad (deal_party_entity_id NULL) son de cualquiera con acceso a
// la operación; admin/abogado sin restricción.
function canTouchDoc(req, dealId, doc) {
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
async function syncDocumentToDrive(req, dealId, deal_party_entity_id, filename, buffer, mimeType) {
  if (!driveClient.isConfigured() || !driveClient.isConnected()) return;
  const deal = db.prepare('SELECT drive_folder_id FROM deals WHERE id = ?').get(dealId);
  if (!deal || !deal.drive_folder_id) return;
  let subfolder = 'Propiedad';
  if (deal_party_entity_id !== null && deal_party_entity_id !== undefined) {
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
function registerPartyUserRaw(dealId, party, name, email) {
  const normalizedEmail = email.toLowerCase().trim();
  const existing = db.prepare('SELECT id, role FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) {
    if (!['buyer', 'seller'].includes(existing.role)) {
      const err = new Error('Ya existe una cuenta de equipo (no de cliente) con ese correo — no se puede ligar como comprador/vendedor.');
      err.status = 409;
      throw err;
    }
    db.prepare('INSERT INTO deal_parties (deal_id, user_id, role_in_deal, deal_party_entity_id) VALUES (?,?,?,?)')
      .run(dealId, existing.id, party.side, party.id);
    return { userId: existing.id, temporaryPassword: null, linkedExisting: true };
  }
  const password = crypto.randomBytes(6).toString('base64url');
  const hash = bcrypt.hashSync(password, 12);
  const info = db.prepare("INSERT INTO users (name, email, password_hash, role, status) VALUES (?,?,?,?,'active')")
    .run(name.trim(), normalizedEmail, hash, party.side);
  db.prepare('INSERT INTO deal_parties (deal_id, user_id, role_in_deal, deal_party_entity_id) VALUES (?,?,?,?)')
    .run(dealId, info.lastInsertRowid, party.side, party.id);
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
async function sendPartyWelcomeEmail(req, dealProperty, name, email, side, scenario) {
  if (!mailer.isConfigured()) return { sent: false, error: 'Resend no está configurado (falta RESEND_API_KEY).' };
  try {
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
    if (!user) return { sent: false, error: 'Cuenta no encontrada.' };
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
    db.prepare('INSERT INTO password_resets (token, user_id, expires_at) VALUES (?,?,?)').run(token, user.id, expiresAt);
    const url = `${req.protocol}://${req.get('host')}/reset-password.html?token=${token}`;
    const lang = mailer.resolveClientLang(scenario, side);
    const result = await mailer.sendInviteEmail({ to: email, name, roleInDeal: side, dealProperty, url, lang });
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
  rows.forEach(r => { r.parties = byDeal[r.id] || []; });
  return rows;
}

// GET /api/deals — lista operaciones. Admin/abogado ven todas; agente/buyer/seller solo las suyas.
router.get('/', requireAuth, (req, res) => {
  let rows;
  if (UNRESTRICTED_ROLES.includes(req.session.role)) {
    rows = db.prepare(`SELECT d.*${COUNTS_SQL} FROM deals d ORDER BY d.created_at DESC`).all();
  } else {
    rows = db.prepare(`
      SELECT d.*${COUNTS_SQL} FROM deals d
      JOIN deal_parties dp ON dp.deal_id = d.id
      WHERE dp.user_id = ?
      ORDER BY d.created_at DESC
    `).all(req.session.userId);
  }
  res.json(attachParties(rows));
});

// POST /api/deals — admin/agente/abogado crean operaciones.
router.post('/', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), async (req, res) => {
  const { scenario, development, property, price, furniturePrice, currency, startDate, parties, escrowCompany } = req.body || {};
  if (!scenario || !property || !Array.isArray(parties)) {
    return res.status(400).json({ error: 'Faltan campos requeridos.' });
  }
  if (escrowCompany && !['armour', 'tla'].includes(escrowCompany)) {
    return res.status(400).json({ error: 'Escrow company inválida.' });
  }
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

    await Promise.all(result.partyResults.filter(r => !r.error && !r.linkedExisting).map(async r => {
      const { sent, error } = await sendPartyWelcomeEmail(req, property, r.partyName, r.email, r.side, scenario);
      r.welcomeEmailSent = sent;
      r.welcomeEmailError = error;
    }));
    res.status(201).json({ id: result.id, partyResults: result.partyResults });
    tryCreateDriveFolder(req, result.id, property);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error al crear la operación.' });
  }
});

// GET /api/deals/:id — detalle completo con partes, docs y tareas.
router.get('/:id', requireAuth, (req, res) => {
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id);
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
    SELECT dp.deal_party_entity_id AS partyId, u.id AS userId, u.name, u.email
    FROM deal_parties dp JOIN users u ON u.id = dp.user_id
    WHERE dp.deal_id = ? AND dp.deal_party_entity_id IS NOT NULL
  `).all(deal.id);
  const linkedByParty = {};
  linkedRows.forEach(r => { linkedByParty[r.partyId] = { userId: r.userId, name: r.name, email: r.email }; });

  parties.forEach(p => {
    p.owners = ownersByParty[p.id] || [];
    p.linkedUser = linkedByParty[p.id] || null;
  });

  const agents = db.prepare(`
    SELECT dp.id AS dealPartyId, u.id AS userId, u.name, u.email, u.agency, u.status, u.role, dp.represents_side AS representsSide
    FROM deal_parties dp JOIN users u ON u.id = dp.user_id
    WHERE dp.deal_id = ? AND dp.role_in_deal = 'agent'
    ORDER BY u.name
  `).all(deal.id);

  const documents = db.prepare('SELECT * FROM documents WHERE deal_id = ?').all(deal.id);
  const tasks = db.prepare('SELECT * FROM tasks WHERE deal_id = ? ORDER BY sort_order').all(deal.id);

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

  res.json({ ...deal, parties: visibleParties, agents, documents: visibleDocuments, tasks });
});

// PATCH /api/deals/:id — cambia la escrow company y/o las fechas clave
// (cierre, fin de due diligence) de una operación ya creada. Ambos grupos
// de campos son independientes entre sí (solo se actualiza lo que venga en
// el body).
router.patch('/:id', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const { escrowCompany, closingDate, dueDiligenceEndDate, property, price, furniturePrice, currency, startDate, development, status } = req.body || {};

  if (status !== undefined) {
    if (!['active', 'completed'].includes(status)) return res.status(400).json({ error: 'status debe ser active o completed.' });
    db.prepare("UPDATE deals SET status = ?, closed_at = ? WHERE id = ?")
      .run(status, status === 'completed' ? new Date().toISOString() : null, req.params.id);
  }
  if (escrowCompany !== undefined) {
    if (!['armour', 'tla'].includes(escrowCompany)) {
      return res.status(400).json({ error: 'Escrow company inválida.' });
    }
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

  const info = db.prepare('SELECT id FROM deals WHERE id = ?').get(req.params.id);
  if (!info) return res.status(404).json({ error: 'Operación no encontrada.' });
  res.json({ ok: true });
});

// POST /api/deals/:id/parties — agrega una parte nueva (vendedor/comprador
// adicional) a una operación ya creada, con su propio checklist.
router.post('/:id/parties', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), async (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });

  const p = req.body || {};
  if (!['seller', 'buyer'].includes(p.side)) return res.status(400).json({ error: 'Falta el lado (seller/buyer).' });
  const err = validateParty(p);
  if (err) return res.status(400).json({ error: err });

  const count = db.prepare('SELECT COUNT(*) c FROM deal_party_entities WHERE deal_id = ? AND side = ?').get(req.params.id, p.side).c;
  if (count >= MAX_PARTIES_PER_SIDE) return res.status(400).json({ error: `Máximo ${MAX_PARTIES_PER_SIDE} personas por lado.` });

  const partyId = insertPartyWithDocs(req.params.id, deal.scenario, p.side, count, p);

  // Correo opcional: da de alta la cuenta de una vez, para poder mandar a
  // firmar documentos sin que la parte tenga que registrarse ella misma.
  let temporaryPassword, emailError, linkedExisting, welcomeEmailSent, welcomeEmailError;
  if (p.email && p.email.trim()) {
    try {
      const newParty = db.prepare('SELECT * FROM deal_party_entities WHERE id = ?').get(partyId);
      ({ temporaryPassword, linkedExisting } = db.transaction(() => registerPartyUserRaw(req.params.id, newParty, p.name, p.email))());
      if (!linkedExisting) {
        ({ sent: welcomeEmailSent, error: welcomeEmailError } = await sendPartyWelcomeEmail(req, deal.property, p.name, p.email, p.side, deal.scenario));
      }
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
// esta es la ÚNICA forma de ligar/crear la cuenta de una parte.
router.patch('/:id/parties/:partyId', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), async (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const party = db.prepare('SELECT * FROM deal_party_entities WHERE id = ? AND deal_id = ?').get(req.params.partyId, req.params.id);
  if (!party) return res.status(404).json({ error: 'Parte no encontrada.' });
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id);

  const p = { ...req.body, side: party.side, partyType: req.body?.partyType || party.party_type, name: req.body?.name || party.name };
  const err = validateParty(p);
  if (err) return res.status(400).json({ error: err });

  // Ya ligada — no se vuelve a intentar registrar/ligar con el correo que
  // venga en el body (cambiar la cuenta ligada de una parte no es un caso
  // que se pida hoy; el campo de correo en el frontend se deshabilita una
  // vez ligada, esto es un respaldo del lado del servidor).
  const alreadyLinked = db.prepare('SELECT 1 FROM deal_parties WHERE deal_party_entity_id = ?').get(party.id);

  let temporaryPassword, linkedExisting, emailError;
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
  })();

  let welcomeEmailSent, welcomeEmailError;
  if (!alreadyLinked && p.email && p.email.trim() && !emailError && !linkedExisting) {
    ({ sent: welcomeEmailSent, error: welcomeEmailError } = await sendPartyWelcomeEmail(req, deal.property, p.name, p.email, p.side, deal.scenario));
  }
  res.json({ ok: true, temporaryPassword, emailError, welcomeEmailSent, welcomeEmailError });
});

// Inserta solo los documentos que falten según la estructura ACTUAL de la
// parte, sin duplicar ni borrar lo que ya existe (ni lo ya subido/marcado).
function rebuildChecklistForParty(deal, partyId, p) {
  const existing = db.prepare('SELECT name, sub_label FROM documents WHERE deal_party_entity_id = ?').all(partyId);
  const existingKeys = new Set(existing.map(d => `${d.name} ${d.sub_label || ''}`));
  const wanted = buildDocsForParty(deal.scenario, p);
  const insertDoc = db.prepare("INSERT INTO documents (deal_id, deal_party_entity_id, sub_label, name, created_at) VALUES (?,?,?,?,datetime('now'))");
  wanted.forEach(d => {
    const key = `${d.name} ${d.subLabel || ''}`;
    if (!existingKeys.has(key)) insertDoc.run(deal.id, partyId, d.subLabel, d.name);
  });
}

// POST /api/deals/:id/parties/:partyId/rebuild-checklist — recalcula el
// checklist de una parte con su estructura de propiedad actual (ya guardada
// en la base), agregando lo que falte.
router.post('/:id/parties/:partyId/rebuild-checklist', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), (req, res) => {
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
router.post('/:id/parties/:partyId/fix-entity-checklist', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), (req, res) => {
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
router.delete('/:id/parties/:partyId', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), (req, res) => {
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
// la persona ligada a esta parte listando sus documentos pendientes. Los
// documentos de Propiedad (deal_party_entity_id NULL) se incluyen solo si
// esta parte es del lado vendedor, que es quien realísticamente los provee.
router.post('/:id/parties/:partyId/remind', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), async (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const party = db.prepare('SELECT * FROM deal_party_entities WHERE id = ? AND deal_id = ?').get(req.params.partyId, req.params.id);
  if (!party) return res.status(404).json({ error: 'Parte no encontrada.' });
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id);

  const linked = db.prepare(`
    SELECT u.name, u.email FROM deal_parties dp JOIN users u ON u.id = dp.user_id WHERE dp.deal_party_entity_id = ?
  `).get(party.id);
  if (!linked) return res.status(400).json({ error: 'Esta parte todavía no tiene una cuenta ligada — invítala primero.' });

  const pending = party.side === 'seller'
    ? db.prepare("SELECT name FROM documents WHERE status = 'pending' AND deal_id = ? AND (deal_party_entity_id = ? OR deal_party_entity_id IS NULL)").all(req.params.id, party.id)
    : db.prepare("SELECT name FROM documents WHERE status = 'pending' AND deal_party_entity_id = ?").all(party.id);
  if (!pending.length) return res.status(400).json({ error: 'Esta parte ya no tiene documentos pendientes.' });

  if (!mailer.isConfigured()) return res.status(501).json({ error: 'Resend no está configurado todavía (falta RESEND_API_KEY).' });
  const url = `${req.protocol}://${req.get('host')}/`;
  const result = await mailer.sendDocumentReminderEmail({
    to: linked.email, name: linked.name, dealProperty: deal.property, pendingDocNames: pending.map(p => p.name), url,
    lang: mailer.resolveClientLang(deal.scenario, party.side)
  });
  if (!result.ok) return res.status(502).json({ error: result.error });
  db.prepare(`
    INSERT INTO document_reminders_log (deal_party_entity_id, last_sent_at) VALUES (?, datetime('now'))
    ON CONFLICT(deal_party_entity_id) DO UPDATE SET last_sent_at = datetime('now')
  `).run(party.id);
  res.json({ ok: true, count: pending.length });
});

// GET /api/deals/:id/available-agents — agentes (con cuenta, activos O
// pendientes de aprobación) que todavía NO están ligados a esta operación —
// para el dropdown de "agregar agente" en el detalle de la operación, en vez
// de tener que generar una invitación nueva para alguien que ya es parte del
// equipo. Se incluyen los pendientes porque a veces hay que asignar al
// agente a la operación antes de que un admin le apruebe la cuenta (no
// pueden iniciar sesión mientras siga pendiente, pero sí quedar asignados
// desde ya) — status se manda para que la UI lo marque como "pendiente".
// Los abogados no aparecen acá: ya ven todas las operaciones
// (UNRESTRICTED_ROLES en lib/access.js), no hace falta ligarlos por deal.
router.get('/:id/available-agents', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const agents = db.prepare(`
    SELECT id, name, email, agency, status, role FROM users
    WHERE role IN ('agent', 'external_lawyer') AND status IN ('active', 'pending')
      AND id NOT IN (SELECT user_id FROM deal_parties WHERE deal_id = ? AND role_in_deal = 'agent')
    ORDER BY status = 'pending', name
  `).all(req.params.id);
  res.json(agents);
});

// POST /api/deals/:id/agents — liga a esta operación un agente que YA tiene
// cuenta (elegido del dropdown de available-agents), sin pasar por el flujo
// de invitación/contraseña — solo tiene sentido para alguien que ya se
// registró antes en la plataforma. Se permite aunque su cuenta siga
// 'pending' de aprobación (queda asignado desde ya; solo puede iniciar
// sesión una vez que un admin lo apruebe, esa regla no cambia).
router.post('/:id/agents', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const { userId, representsSide } = req.body || {};
  if (representsSide !== undefined && representsSide !== null && !['buyer', 'seller'].includes(representsSide)) {
    return res.status(400).json({ error: 'representsSide debe ser buyer o seller.' });
  }
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND role IN ('agent', 'external_lawyer') AND status IN ('active', 'pending')").get(userId);
  if (!user) return res.status(400).json({ error: 'Ese usuario no existe o no es un agente/abogado externo.' });
  const already = db.prepare('SELECT 1 FROM deal_parties WHERE deal_id = ? AND user_id = ?').get(req.params.id, userId);
  if (already) return res.status(409).json({ error: 'Ese agente ya está en esta operación.' });
  db.prepare("INSERT INTO deal_parties (deal_id, user_id, role_in_deal, represents_side) VALUES (?,?,'agent',?)").run(req.params.id, userId, representsSide || null);
  res.status(201).json({ ok: true });

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
router.post('/:id/agents/register', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const { name, email, role, agency, agencyOther, representsSide } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'Falta el nombre o el correo.' });
  const collaboratorRole = role === 'external_lawyer' ? 'external_lawyer' : 'agent';
  if (representsSide !== undefined && representsSide !== null && !['buyer', 'seller'].includes(representsSide)) {
    return res.status(400).json({ error: 'representsSide debe ser buyer o seller.' });
  }
  // La agencia (LPR Luxury, etc.) solo aplica a agentes de venta — un
  // abogado externo no tiene una, es de su propio despacho.
  let resolvedAgency = null;
  if (collaboratorRole === 'agent') {
    resolvedAgency = resolveAgency(agency, agencyOther);
    if (!resolvedAgency) return res.status(400).json({ error: 'Elige la agencia del agente (o escribe cuál si no está en la lista).' });
  }

  const normalizedEmail = email.toLowerCase().trim();
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
  res.status(201).json({ id: userId, name: name.trim(), email: normalizedEmail, role: collaboratorRole, agency: resolvedAgency, temporaryPassword: password });
});

// PATCH /api/deals/:id/agents/:userId — cambia a quién representa un agente
// ya agregado (ej. se les olvidó elegirlo, o cambió de cliente).
router.patch('/:id/agents/:userId', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const { representsSide } = req.body || {};
  if (representsSide !== null && !['buyer', 'seller'].includes(representsSide)) {
    return res.status(400).json({ error: 'representsSide debe ser buyer, seller, o null.' });
  }
  const info = db.prepare("UPDATE deal_parties SET represents_side = ? WHERE deal_id = ? AND user_id = ? AND role_in_deal = 'agent'")
    .run(representsSide, req.params.id, req.params.userId);
  if (!info.changes) return res.status(404).json({ error: 'Ese agente no está en esta operación.' });
  res.json({ ok: true });
});

// DELETE /api/deals/:id/agents/:userId — quita a un agente de la operación
// (no de la plataforma, solo deja de verla). Restringido a role_in_deal
// 'agent' para no poder usar esta ruta contra un comprador/vendedor ligado.
router.delete('/:id/agents/:userId', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const info = db.prepare("DELETE FROM deal_parties WHERE deal_id = ? AND user_id = ? AND role_in_deal = 'agent'").run(req.params.id, req.params.userId);
  if (!info.changes) return res.status(404).json({ error: 'Ese agente no está en esta operación.' });
  res.json({ ok: true });
});

// POST /api/deals/:id/drive-folder — crea (o reintenta crear) la estructura
// de carpetas en Drive para una operación que no la tiene todavía (ej. se
// creó antes de conectar Drive, o la primera vez falló).
router.post('/:id/drive-folder', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), async (req, res) => {
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
router.post('/:id/documents', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const { name, dealPartyEntityId, subLabel } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Falta el nombre del documento.' });

  let partyId = null;
  if (dealPartyEntityId !== undefined && dealPartyEntityId !== null) {
    const party = db.prepare('SELECT * FROM deal_party_entities WHERE id = ? AND deal_id = ?').get(dealPartyEntityId, req.params.id);
    if (!party) return res.status(404).json({ error: 'Parte no encontrada.' });
    if (AGENT_LIKE_ROLES.includes(req.session.role)) {
      const side = myRepresentsSide(req, req.params.id);
      if (side && party.side !== side) return res.status(403).json({ error: 'No puedes agregar documentos del otro lado.' });
    }
    partyId = party.id;
  }

  const info = db.prepare("INSERT INTO documents (deal_id, deal_party_entity_id, sub_label, name, created_at) VALUES (?,?,?,?,datetime('now'))")
    .run(req.params.id, partyId, (subLabel || '').trim() || null, name.trim());
  res.status(201).json({ id: info.lastInsertRowid });
});

// DELETE /api/deals/:id/documents/:docId — quita un requisito del checklist
// POR COMPLETO (no solo el archivo que tuviera subido — ver DELETE .../file
// arriba para eso) — para cuando algo de la lista fija no aplica a esta
// operación. Solo staff, mismo motivo que agregar.
router.delete('/:id/documents/:docId', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), async (req, res) => {
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
router.patch('/:id/documents/:docId', requireAuth, (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND deal_id = ?').get(req.params.docId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'Documento no encontrado.' });
  if (!canTouchDoc(req, req.params.id, doc)) return res.status(403).json({ error: 'No puedes modificar documentos de otra parte.' });
  const { status, subChecks } = req.body || {};
  if (status !== undefined) {
    if (!['pending', 'done'].includes(status)) return res.status(400).json({ error: 'Status inválido.' });
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
router.patch('/:id/documents/:docId/review', requireRole('admin', 'lawyer'), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND deal_id = ?').get(req.params.docId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'Documento no encontrado.' });
  if (!doc.file_url) return res.status(400).json({ error: 'Este documento todavía no tiene archivo subido.' });
  const { reviewStatus, reviewNote } = req.body || {};
  if (!['pending', 'approved', 'rejected'].includes(reviewStatus)) {
    return res.status(400).json({ error: 'reviewStatus inválido.' });
  }
  db.prepare(`
    UPDATE documents SET review_status = ?, review_note = ?, reviewed_by = ?, reviewed_at = datetime('now')
    WHERE id = ? AND deal_id = ?
  `).run(reviewStatus, reviewStatus === 'rejected' ? (reviewNote || null) : null, req.session.userId, req.params.docId, req.params.id);
  res.json({ ok: true });
});

// POST /api/deals/:id/documents/:docId/file — subir el archivo de un documento del checklist.
router.post('/:id/documents/:docId/file', requireAuth, (req, res, next) => {
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
      db.prepare(`
        UPDATE documents SET file_url=?, original_name=?, mime_type=?, size_bytes=?, status='done',
          uploaded_by=?, uploaded_at=datetime('now'),
          review_status='pending', review_note=NULL, reviewed_by=NULL, reviewed_at=NULL
        WHERE id=? AND deal_id=?
      `).run(key, req.file.originalname, req.file.mimetype, req.file.size, req.session.userId, req.params.docId, req.params.id);
      res.json({ ok: true });
      syncDocumentToDrive(req, req.params.id, doc.deal_party_entity_id, `${doc.name}${doc.sub_label ? ' - ' + doc.sub_label : ''} - ${req.file.originalname}`, req.file.buffer, req.file.mimetype);
    } catch (uploadErr) {
      res.status(502).json({ error: uploadErr.message || 'Error al subir el archivo.' });
    }
  });
});

// DELETE /api/deals/:id/documents/:docId/file — quita el archivo subido y
// regresa el documento a 'pending' (en vez de solo poder reemplazarlo). Usa
// la misma regla de acceso que subirlo: comprador/vendedor solo el de su
// propia parte, staff sin restricción.
router.delete('/:id/documents/:docId/file', requireAuth, async (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND deal_id = ?').get(req.params.docId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'Documento no encontrado.' });
  if (!canTouchDoc(req, req.params.id, doc)) {
    return res.status(403).json({ error: 'No puedes borrar documentos de otra parte.' });
  }
  if (!doc.file_url) return res.status(400).json({ error: 'Este documento no tiene archivo subido.' });
  db.prepare(`
    UPDATE documents SET file_url=NULL, original_name=NULL, mime_type=NULL, size_bytes=NULL, status='pending',
      uploaded_by=NULL, uploaded_at=NULL,
      review_status='pending', review_note=NULL, reviewed_by=NULL, reviewed_at=NULL
    WHERE id=? AND deal_id=?
  `).run(req.params.docId, req.params.id);
  res.json({ ok: true });
  gcsStorage.deleteFile(doc.file_url).catch(err => console.error('[gcs] no se pudo borrar el archivo', doc.file_url, err.message));
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
router.patch('/:id/tasks/:taskId', requireAuth, (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const { status } = req.body || {};
  if (!['pending', 'progress', 'done'].includes(status)) return res.status(400).json({ error: 'Status inválido.' });
  db.prepare('UPDATE tasks SET status = ? WHERE id = ? AND deal_id = ?')
    .run(status, req.params.taskId, req.params.id);
  res.json({ ok: true });
});

// DELETE /api/deals/:id — admin/abogado cualquiera; agente solo las suyas.
router.delete('/:id', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const info = db.prepare('DELETE FROM deals WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Operación no encontrada.' });
  gcsStorage.deletePrefix(String(req.params.id) + '/').catch(err => {
    console.error('[gcs] no se pudieron borrar los archivos de la operación', req.params.id, err.message);
  });
  res.json({ ok: true });
});

module.exports = router;
