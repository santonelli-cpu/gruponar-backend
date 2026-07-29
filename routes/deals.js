const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const { requireAuth, requireRole } = require('./auth');
const { UPLOADS_ROOT, dealDir, genFilename } = require('../lib/storage');
const { canAccessDeal, myRoleInDeal, myDealPartyEntityId, UNRESTRICTED_ROLES } = require('../lib/access');
const mailer = require('../lib/email');

const router = express.Router();

const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/heic']);
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, dealDir(req.params.id)),
    filename: (req, file, cb) => cb(null, genFilename(file.originalname))
  }),
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

  add(s[side + '_individual']);
  if (party.partyType === 'individual') return docs;

  if (party.partyType === 'llc') {
    add(s.llc_entity);
    add(s.llc_manager);
  } else {
    add(s.corporation_extra);
    add(s.legal_rep);
  }

  if (party.ownershipMode === 'direct_owners') {
    (party.owners || []).forEach(owner => add(s.llc_members, `Socio: ${owner.name}`));
  } else if (party.ownershipMode === 'parent_entity') {
    const parentDocs = party.parentEntityType === 'llc' ? s.llc_entity : s.corporation_extra;
    add(parentDocs, `Entidad padre: ${party.parentEntityName}`);
    if (party.parentHasTrustAbove) {
      add(TRUST_DOCS, `Trust arriba de ${party.parentEntityName}`);
    }
  } else if (party.ownershipMode === 'direct_trust') {
    add(TRUST_DOCS, `Trust: ${party.directTrustName}`);
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
router.post('/', requireRole('admin', 'agent', 'lawyer'), (req, res) => {
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
    const dealId = db.transaction(() => {
      const dealInfo = db.prepare(`
        INSERT INTO deals (scenario, development, property, price, furniture_price, currency, start_date, escrow_company, created_by)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(scenario, development || 'punta_mita', property, price || 0, furniturePrice || 0,
             currency || 'USD', startDate, escrowCompany || null, req.session.userId);
      const id = dealInfo.lastInsertRowid;

      insertPropertyDocs(id, scenario);
      ['seller', 'buyer'].forEach(side => {
        parties.filter(p => p.side === side).forEach((p, idx) => insertPartyWithDocs(id, scenario, side, idx, p));
      });

      const tasks = SCENARIO_TASKS[scenario];
      const insertTask = db.prepare("INSERT INTO tasks (deal_id, label_en, label_es, requires_signature, sort_order, created_at) VALUES (?,?,?,?,?,datetime('now'))");
      tasks.forEach((t, i) => insertTask.run(id, t.en, t.es, t.sign ? 1 : 0, i));

      // Un agente ya no ve todas las operaciones (solo admin/lawyer) — se
      // liga automáticamente a la que acaba de crear.
      if (req.session.role === 'agent') {
        db.prepare('INSERT OR IGNORE INTO deal_parties (deal_id, user_id, role_in_deal) VALUES (?,?,?)')
          .run(id, req.session.userId, 'agent');
      }
      return id;
    })();

    res.status(201).json({ id: dealId });
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
    SELECT dp.id AS dealPartyId, u.id AS userId, u.name, u.email, u.agency
    FROM deal_parties dp JOIN users u ON u.id = dp.user_id
    WHERE dp.deal_id = ? AND dp.role_in_deal = 'agent'
    ORDER BY u.name
  `).all(deal.id);

  const documents = db.prepare('SELECT * FROM documents WHERE deal_id = ?').all(deal.id);
  const tasks = db.prepare('SELECT * FROM tasks WHERE deal_id = ? ORDER BY sort_order').all(deal.id);
  res.json({ ...deal, parties, agents, documents, tasks });
});

// PATCH /api/deals/:id — cambia la escrow company y/o las fechas clave
// (cierre, fin de due diligence) de una operación ya creada. Ambos grupos
// de campos son independientes entre sí (solo se actualiza lo que venga en
// el body).
router.patch('/:id', requireRole('admin', 'agent', 'lawyer'), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const { escrowCompany, closingDate, dueDiligenceEndDate } = req.body || {};

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

  const info = db.prepare('SELECT id FROM deals WHERE id = ?').get(req.params.id);
  if (!info) return res.status(404).json({ error: 'Operación no encontrada.' });
  res.json({ ok: true });
});

// POST /api/deals/:id/parties — agrega una parte nueva (vendedor/comprador
// adicional) a una operación ya creada, con su propio checklist.
router.post('/:id/parties', requireRole('admin', 'agent', 'lawyer'), (req, res) => {
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
  res.status(201).json({ id: partyId });
});

// PATCH /api/deals/:id/parties/:partyId — editar nombre/estructura de una
// parte existente (ej. completar la estructura de propiedad de una
// operación migrada, o corregir un dato).
router.patch('/:id/parties/:partyId', requireRole('admin', 'agent', 'lawyer'), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const party = db.prepare('SELECT * FROM deal_party_entities WHERE id = ? AND deal_id = ?').get(req.params.partyId, req.params.id);
  if (!party) return res.status(404).json({ error: 'Parte no encontrada.' });
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id);

  const p = { ...req.body, side: party.side, partyType: req.body?.partyType || party.party_type, name: req.body?.name || party.name };
  const err = validateParty(p);
  if (err) return res.status(400).json({ error: err });

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
  })();

  res.json({ ok: true });
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
router.post('/:id/parties/:partyId/rebuild-checklist', requireRole('admin', 'agent', 'lawyer'), (req, res) => {
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

// DELETE /api/deals/:id/parties/:partyId — quitar una parte agregada de más
// (bloqueado si ya tiene trabajo real hecho, para no perderlo).
router.delete('/:id/parties/:partyId', requireRole('admin', 'agent', 'lawyer'), (req, res) => {
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
router.post('/:id/parties/:partyId/remind', requireRole('admin', 'agent', 'lawyer'), async (req, res) => {
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
    to: linked.email, name: linked.name, dealProperty: deal.property, pendingDocNames: pending.map(p => p.name), url
  });
  if (!result.ok) return res.status(502).json({ error: result.error });
  db.prepare(`
    INSERT INTO document_reminders_log (deal_party_entity_id, last_sent_at) VALUES (?, datetime('now'))
    ON CONFLICT(deal_party_entity_id) DO UPDATE SET last_sent_at = datetime('now')
  `).run(party.id);
  res.json({ ok: true, count: pending.length });
});

// GET /api/deals/:id/available-agents — agentes activos (ya con cuenta,
// aprobados) que todavía NO están ligados a esta operación — para el
// dropdown de "agregar agente" en el detalle de la operación, en vez de
// tener que generar una invitación nueva para alguien que ya es parte del
// equipo. Los abogados no aparecen acá: ya ven todas las operaciones
// (UNRESTRICTED_ROLES en lib/access.js), no hace falta ligarlos por deal.
router.get('/:id/available-agents', requireRole('admin', 'agent', 'lawyer'), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const agents = db.prepare(`
    SELECT id, name, email, agency FROM users
    WHERE role = 'agent' AND status = 'active'
      AND id NOT IN (SELECT user_id FROM deal_parties WHERE deal_id = ? AND role_in_deal = 'agent')
    ORDER BY name
  `).all(req.params.id);
  res.json(agents);
});

// POST /api/deals/:id/agents — liga a esta operación un agente que YA tiene
// cuenta (elegido del dropdown de available-agents), sin pasar por el flujo
// de invitación/contraseña — solo tiene sentido para alguien que ya inició
// sesión antes en la plataforma.
router.post('/:id/agents', requireRole('admin', 'agent', 'lawyer'), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const { userId } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'agent' AND status = 'active'").get(userId);
  if (!user) return res.status(400).json({ error: 'Ese usuario no existe o no es un agente activo.' });
  const already = db.prepare('SELECT 1 FROM deal_parties WHERE deal_id = ? AND user_id = ?').get(req.params.id, userId);
  if (already) return res.status(409).json({ error: 'Ese agente ya está en esta operación.' });
  db.prepare("INSERT INTO deal_parties (deal_id, user_id, role_in_deal) VALUES (?,?,'agent')").run(req.params.id, userId);
  res.status(201).json({ ok: true });
});

// DELETE /api/deals/:id/agents/:userId — quita a un agente de la operación
// (no de la plataforma, solo deja de verla). Restringido a role_in_deal
// 'agent' para no poder usar esta ruta contra un comprador/vendedor ligado.
router.delete('/:id/agents/:userId', requireRole('admin', 'agent', 'lawyer'), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const info = db.prepare("DELETE FROM deal_parties WHERE deal_id = ? AND user_id = ? AND role_in_deal = 'agent'").run(req.params.id, req.params.userId);
  if (!info.changes) return res.status(404).json({ error: 'Ese agente no está en esta operación.' });
  res.json({ ok: true });
});

// PATCH /api/deals/:id/documents/:docId — marcar documento recibido y/o
// (solo para los documentos de LLC que lo requieren) marcar cuáles de sus
// requisitos (notarizado/apostillado/traducido) ya llegaron.
router.patch('/:id/documents/:docId', requireAuth, (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const { status, subChecks } = req.body || {};
  if (status !== undefined) {
    if (!['pending', 'done'].includes(status)) return res.status(400).json({ error: 'Status inválido.' });
    db.prepare('UPDATE documents SET status = ?, uploaded_by = ?, uploaded_at = datetime(\'now\') WHERE id = ? AND deal_id = ?')
      .run(status, req.session.userId, req.params.docId, req.params.id);
  }
  if (subChecks !== undefined) {
    const doc = db.prepare('SELECT name, sub_checks_json FROM documents WHERE id = ? AND deal_id = ?').get(req.params.docId, req.params.id);
    if (!doc) return res.status(404).json({ error: 'Documento no encontrado.' });
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

// POST /api/deals/:id/documents/:docId/file — subir el archivo de un documento del checklist.
router.post('/:id/documents/:docId/file', requireAuth, (req, res, next) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND deal_id = ?').get(req.params.docId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'Documento no encontrado.' });
  // Comprador/vendedor solo puede subir documentos de su propia parte (no
  // la de otro comprador/vendedor del mismo lado); los de la Propiedad
  // (deal_party_entity_id NULL) no son de nadie en particular, cualquiera
  // con acceso a la operación puede subirlos; admin/agente/abogado sin
  // restricción.
  const role = myRoleInDeal(req, req.params.id);
  const myPartyId = myDealPartyEntityId(req, req.params.id);
  if (doc.deal_party_entity_id !== null && !['admin', 'agent', 'lawyer'].includes(role) && myPartyId !== doc.deal_party_entity_id) {
    return res.status(403).json({ error: 'No puedes subir documentos de otra parte.' });
  }
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Archivo inválido.' });
    if (!req.file) return res.status(400).json({ error: 'Tipo de archivo no permitido (solo PDF, JPG, PNG, HEIC) o falta el archivo.' });
    const relPath = path.join(String(req.params.id), req.file.filename);
    db.prepare(`
      UPDATE documents SET file_url=?, original_name=?, mime_type=?, size_bytes=?, status='done',
        uploaded_by=?, uploaded_at=datetime('now') WHERE id=? AND deal_id=?
    `).run(relPath, req.file.originalname, req.file.mimetype, req.file.size, req.session.userId, req.params.docId, req.params.id);
    res.json({ ok: true });
  });
});

// GET /api/deals/:id/documents/:docId/file — descarga autenticada del archivo subido.
router.get('/:id/documents/:docId/file', requireAuth, (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND deal_id = ?').get(req.params.docId, req.params.id);
  if (!doc || !doc.file_url) return res.status(404).json({ error: 'Archivo no encontrado.' });

  const role = myRoleInDeal(req, req.params.id);
  const myPartyId = myDealPartyEntityId(req, req.params.id);
  if (doc.deal_party_entity_id !== null && !['admin', 'agent', 'lawyer'].includes(role) && myPartyId !== doc.deal_party_entity_id) {
    return res.status(403).json({ error: 'No puedes ver documentos de otra parte.' });
  }

  const resolved = path.resolve(UPLOADS_ROOT, doc.file_url);
  if (!resolved.startsWith(path.resolve(UPLOADS_ROOT) + path.sep)) {
    return res.status(400).json({ error: 'Ruta de archivo inválida.' });
  }
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Archivo no encontrado.' });

  res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.original_name || 'documento')}"`);
  res.sendFile(resolved);
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
router.delete('/:id', requireRole('admin', 'agent', 'lawyer'), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const info = db.prepare('DELETE FROM deals WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Operación no encontrada.' });
  fs.rm(path.join(UPLOADS_ROOT, String(req.params.id)), { recursive: true, force: true }, () => {});
  res.json({ ok: true });
});

module.exports = router;
