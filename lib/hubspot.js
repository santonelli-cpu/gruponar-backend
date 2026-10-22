const db = require('../db');

// Integración de UNA VÍA portal → HubSpot.
//
// El portal sigue siendo la fuente de verdad de cada cierre; HubSpot es el
// CRM donde Stefano ve todo junto (contactos, empresas, pipeline). Cada vez
// que una operación o sus partes cambian en el portal, la operación se
// encola y se manda a HubSpot en segundo plano:
//   - operación → deal en el pipeline GrupoNAR (llave estable: propiedad
//     única `portal_deal_id`, que crea scripts/hubspot-setup.js)
//   - compradores / vendedores con cuenta y correo → contactos
//   - agentes y abogados externos ligados → contactos
//   - escrow (TLA / Armour) y agencia del agente → se asocian SOLO si la
//     empresa ya existe en HubSpot (nunca se crean empresas desde aquí)
//
// Reglas:
//   - Sin HUBSPOT_TOKEN no hace nada (y lo dice una sola vez en el log).
//   - Nunca tumba una petición del portal: todo corre después de responder
//     y los errores se guardan en hubspot_sync_log.
//   - Nunca escribe el token en logs ni en hubspot_sync_log.
//   - Lo que se captura a mano en HubSpot no se pisa: en contactos solo se
//     llenan campos vacíos y `consentimiento_comercial` se pone únicamente
//     al crear; en deals la etapa solo se fija al crear o al pasar a
//     "Signed Deed" cuando la operación se marca como completada.
//   - Operaciones en papelera o con nombre de prueba ("test…", "prueba…")
//     no se mandan. Borrar en el portal no borra nada en HubSpot.

const API_BASE = 'https://api.hubapi.com';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_429_RETRIES = 3;

// IDs del portal de HubSpot de Grupo NAR (no son secretos). Se pueden
// cambiar por variable de entorno si el pipeline se rehace.
const PIPELINE_ID = process.env.HUBSPOT_PIPELINE_ID || '46373633'; // GrupoNAR pipeline
const STAGE_NEW = process.env.HUBSPOT_STAGE_NEW || '95364923'; // Purchase Agreement Signed
const STAGE_SIGNED = process.env.HUBSPOT_STAGE_SIGNED || '95350189'; // Signed Deed
const STAGE_AFTER_SIGNED = ['95350189', '95350190']; // Signed Deed, Deed Ready for Pick Up

const ESCROW_COMPANY_NAMES = { tla: 'TLA LLC', armour: 'Armour Secure' };
const MUNICIPIO_BY_DEVELOPMENT = {
  punta_mita: 'bahia_de_banderas',
  puerto_vallarta: 'puerto_vallarta',
  boca_tomatlan: 'puerto_vallarta',
  compostela: 'compostela',
  las_varas: 'compostela'
};
const TEST_NAME_RE = /^\s*(test|prueba)\b/i;
const INTERNAL_EMAIL_RE = /@gruponar\.com$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let fetchImpl = (...args) => fetch(...args);
let warnedNotConfigured = false;

function isConfigured() {
  return Boolean(process.env.HUBSPOT_TOKEN && process.env.HUBSPOT_TOKEN.trim());
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class HubSpotError extends Error {
  constructor(status, message) {
    super(`HubSpot ${status}: ${message}`);
    this.status = status;
  }
}

// Petición a la API. Devuelve { status, body } para 2xx y 404 (el 404 es
// una respuesta esperada al buscar); cualquier otro error lanza
// HubSpotError con un mensaje sin el token.
async function hsRequest(method, path, body) {
  if (!isConfigured()) throw new HubSpotError(0, 'HUBSPOT_TOKEN no configurado');
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(API_BASE + path, {
        method,
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_TOKEN.trim()}`,
          'Content-Type': 'application/json'
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (err) {
      throw new HubSpotError(0, err.name === 'TimeoutError' ? 'sin respuesta (timeout)' : 'error de red');
    }
    if (res.status === 429 && attempt < MAX_429_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) ? Math.min(retryAfter, 10) * 1000 : 1000 * (attempt + 1));
      continue;
    }
    let json = null;
    const text = await res.text();
    if (text) { try { json = JSON.parse(text); } catch (e) { json = null; } }
    if (res.ok || res.status === 404) return { status: res.status, body: json };
    const message = (json && json.message) ? String(json.message).slice(0, 300) : res.statusText || 'error';
    throw new HubSpotError(res.status, message);
  }
}

function writeLog(dealId, status, hubspotDealId, detail) {
  try {
    db.prepare(`INSERT INTO hubspot_sync_log (deal_id, hubspot_deal_id, status, detail, synced_at)
      VALUES (?,?,?,?,datetime('now'))
      ON CONFLICT(deal_id) DO UPDATE SET
        hubspot_deal_id = COALESCE(excluded.hubspot_deal_id, hubspot_sync_log.hubspot_deal_id),
        status = excluded.status, detail = excluded.detail, synced_at = excluded.synced_at`)
      .run(dealId, hubspotDealId || null, status, detail ? String(detail).slice(0, 2000) : null);
  } catch (err) {
    console.error('[hubspot] no se pudo escribir hubspot_sync_log', dealId, err.message);
  }
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstname: '', lastname: '' };
  return { firstname: parts[0], lastname: parts.slice(1).join(' ') };
}

function dealProperties(deal) {
  const props = { dealname: deal.property, portal_deal_id: String(deal.id) };
  const date = String(deal.closing_date || '').slice(0, 10);
  // Mediodía en Bahía de Banderas (UTC-6) — a medianoche UTC HubSpot lo
  // mostraba un día antes.
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) props.closedate = `${date}T18:00:00.000Z`;
  const total = (Number(deal.price) || 0) + (Number(deal.furniture_price) || 0);
  if ((deal.currency || 'USD').toUpperCase() === 'USD' && total > 0) props.precio_de_la_compraventa = String(total);
  const municipio = MUNICIPIO_BY_DEVELOPMENT[deal.development];
  if (municipio) props.municipio = municipio;
  return props;
}

// Contactos externos de una operación: partes con cuenta ligada (correo) y
// agentes / abogados externos. Nunca personal interno.
function collectContacts(dealId) {
  const out = new Map();
  const add = (c) => {
    const email = String(c.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || INTERNAL_EMAIL_RE.test(email)) return;
    if (['admin', 'lawyer'].includes(c.userRole)) return;
    if (!out.has(email)) out.set(email, { ...c, email });
  };
  db.prepare(`SELECT dpe.side, dpe.party_type, dpe.name AS party_name, u.name, u.email, u.phone, u.role
    FROM deal_party_entities dpe
    JOIN deal_parties dp ON dp.deal_party_entity_id = dpe.id
    JOIN users u ON u.id = dp.user_id
    WHERE dpe.deal_id = ? ORDER BY dpe.side, dpe.sort_order`).all(dealId).forEach(p => {
    add({
      name: p.party_type === 'individual' ? (p.party_name || p.name) : p.name,
      email: p.email, phone: p.phone, userRole: p.role,
      tipo: p.side === 'seller' ? 'cliente_vendedor' : 'cliente_comprador'
    });
  });
  db.prepare(`SELECT u.name, u.email, u.phone, u.role, u.agency
    FROM deal_parties dp JOIN users u ON u.id = dp.user_id
    WHERE dp.deal_id = ? AND dp.role_in_deal = 'agent'`).all(dealId).forEach(a => {
    add({
      name: a.name, email: a.email, phone: a.phone, userRole: a.role, agency: a.agency,
      tipo: a.role === 'external_lawyer' ? 'abogado_externo' : 'agente_inmobiliario'
    });
  });
  return [...out.values()];
}

async function upsertContact(c) {
  const path = `/crm/v3/objects/contacts/${encodeURIComponent(c.email)}?idProperty=email&properties=firstname,lastname,phone,tipo_de_contacto`;
  const found = await hsRequest('GET', path);
  const { firstname, lastname } = splitName(c.name);
  if (found.status === 200 && found.body) {
    const current = found.body.properties || {};
    const patch = {};
    if (!current.firstname && firstname) patch.firstname = firstname;
    if (!current.lastname && lastname) patch.lastname = lastname;
    if (!current.phone && c.phone) patch.phone = c.phone;
    if (!current.tipo_de_contacto && c.tipo) patch.tipo_de_contacto = c.tipo;
    if (Object.keys(patch).length) {
      await hsRequest('PATCH', `/crm/v3/objects/contacts/${found.body.id}`, { properties: patch });
    }
    return { id: String(found.body.id), created: false };
  }
  const properties = {
    email: c.email, firstname, lastname, tipo_de_contacto: c.tipo,
    consentimiento_comercial: 'sin_registrar'
  };
  if (c.phone) properties.phone = c.phone;
  const created = await hsRequest('POST', '/crm/v3/objects/contacts', { properties });
  return { id: String(created.body.id), created: true };
}

async function associate(fromType, fromId, toType, toId) {
  await hsRequest('PUT', `/crm/v4/objects/${fromType}/${fromId}/associations/default/${toType}/${toId}`);
}

async function findCompanyId(name, cache) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);
  const res = await hsRequest('POST', '/crm/v3/objects/companies/search', {
    filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: String(name).trim() }] }],
    properties: ['name'], limit: 1
  });
  const id = res.body && res.body.results && res.body.results[0] ? String(res.body.results[0].id) : null;
  cache.set(key, id);
  return id;
}

async function findDeal(deal) {
  const logged = db.prepare('SELECT hubspot_deal_id FROM hubspot_sync_log WHERE deal_id = ?').get(deal.id);
  if (logged && logged.hubspot_deal_id) {
    const r = await hsRequest('GET', `/crm/v3/objects/deals/${logged.hubspot_deal_id}?properties=dealstage`);
    if (r.status === 200 && r.body) return r.body;
  }
  const r = await hsRequest('GET', `/crm/v3/objects/deals/${deal.id}?idProperty=portal_deal_id&properties=dealstage`);
  return r.status === 200 && r.body ? r.body : null;
}

// Sincroniza una operación. Nunca lanza: devuelve el resultado y lo deja
// en hubspot_sync_log.
async function syncDeal(dealId, companyCache = new Map()) {
  if (!isConfigured()) return { status: 'skipped', reason: 'not_configured' };
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId);
  if (!deal) return { status: 'skipped', reason: 'not_found' };
  if (deal.deleted_at) { writeLog(deal.id, 'skipped', null, 'Operación en papelera'); return { status: 'skipped', reason: 'deleted' }; }
  if (TEST_NAME_RE.test(deal.property || '')) { writeLog(deal.id, 'skipped', null, 'Nombre de prueba'); return { status: 'skipped', reason: 'test_name' }; }

  let hubspotDealId = null;
  try {
    const props = dealProperties(deal);
    const completed = deal.status === 'completed';
    const existing = await findDeal(deal);
    let dealCreated = false;
    if (existing) {
      hubspotDealId = String(existing.id);
      const stage = existing.properties && existing.properties.dealstage;
      if (completed && !STAGE_AFTER_SIGNED.includes(stage)) props.dealstage = STAGE_SIGNED;
      await hsRequest('PATCH', `/crm/v3/objects/deals/${hubspotDealId}`, { properties: props });
    } else {
      const createProps = {
        ...props, pipeline: PIPELINE_ID,
        dealstage: completed ? STAGE_SIGNED : STAGE_NEW,
        tipo_de_servicio: 'coordinacion_de_cierre'
      };
      if (process.env.HUBSPOT_OWNER_ID) createProps.hubspot_owner_id = process.env.HUBSPOT_OWNER_ID;
      const created = await hsRequest('POST', '/crm/v3/objects/deals', { properties: createProps });
      hubspotDealId = String(created.body.id);
      dealCreated = true;
    }

    const counts = { dealCreated, contactsCreated: 0, contactsLinked: 0, companiesLinked: 0 };
    for (const c of collectContacts(deal.id)) {
      const contact = await upsertContact(c);
      if (contact.created) counts.contactsCreated++;
      await associate('deals', hubspotDealId, 'contacts', contact.id);
      counts.contactsLinked++;
      if (c.agency) {
        const agencyId = await findCompanyId(c.agency, companyCache);
        if (agencyId) {
          await associate('contacts', contact.id, 'companies', agencyId);
          await associate('deals', hubspotDealId, 'companies', agencyId);
          counts.companiesLinked++;
        }
      }
    }
    const escrowName = ESCROW_COMPANY_NAMES[deal.escrow_company];
    if (escrowName) {
      const escrowId = await findCompanyId(escrowName, companyCache);
      if (escrowId) { await associate('deals', hubspotDealId, 'companies', escrowId); counts.companiesLinked++; }
    }
    writeLog(deal.id, 'ok', hubspotDealId, JSON.stringify(counts));
    return { status: 'ok', hubspotDealId, ...counts };
  } catch (err) {
    writeLog(deal.id, 'error', hubspotDealId, err.message);
    console.error('[hubspot] sync falló para la operación', deal.id, err.message);
    return { status: 'error', error: err.message };
  }
}

// --- Cola en segundo plano --------------------------------------------------
const pending = new Set();
let draining = false;

function queueDealSync(dealId) {
  if (!isConfigured()) {
    if (!warnedNotConfigured) {
      console.log('[hubspot] HUBSPOT_TOKEN no configurado — la sincronización con HubSpot está apagada.');
      warnedNotConfigured = true;
    }
    return false;
  }
  const id = Number(dealId);
  if (!Number.isInteger(id) || id <= 0) return false;
  pending.add(id);
  if (!draining) {
    draining = true;
    setImmediate(drain);
  }
  return true;
}

async function drain() {
  try {
    const cache = new Map();
    while (pending.size) {
      const [id] = pending;
      pending.delete(id);
      await syncDeal(id, cache);
    }
  } catch (err) {
    console.error('[hubspot] la cola se detuvo', err.message);
  } finally {
    draining = false;
    if (pending.size) { draining = true; setImmediate(drain); }
  }
}

// Sync completo manual (botón de admin). Un solo proceso a la vez.
let fullSync = { running: false, startedAt: null, finishedAt: null, summary: null };

async function syncAll() {
  if (!isConfigured()) return { status: 'skipped', reason: 'not_configured' };
  const ids = db.prepare('SELECT id FROM deals WHERE deleted_at IS NULL ORDER BY id').all().map(r => r.id);
  const summary = { total: ids.length, ok: 0, error: 0, skipped: 0 };
  const cache = new Map();
  for (const id of ids) {
    const r = await syncDeal(id, cache);
    summary[r.status] = (summary[r.status] || 0) + 1;
  }
  return summary;
}

function startFullSync() {
  if (fullSync.running) return false;
  fullSync = { running: true, startedAt: new Date().toISOString(), finishedAt: null, summary: null };
  setImmediate(async () => {
    let summary;
    try { summary = await syncAll(); } catch (err) { summary = { error: err.message }; }
    fullSync = { ...fullSync, running: false, finishedAt: new Date().toISOString(), summary };
  });
  return true;
}

function getStatus() {
  const counts = db.prepare('SELECT status, COUNT(*) AS n FROM hubspot_sync_log GROUP BY status').all()
    .reduce((acc, r) => { acc[r.status] = r.n; return acc; }, {});
  const recent = db.prepare(`SELECT l.deal_id, d.property, l.hubspot_deal_id, l.status, l.detail, l.synced_at
    FROM hubspot_sync_log l LEFT JOIN deals d ON d.id = l.deal_id
    ORDER BY l.synced_at DESC, l.deal_id DESC LIMIT 20`).all();
  return {
    configured: isConfigured(), pipelineId: PIPELINE_ID,
    queued: pending.size, draining, fullSync, counts, recent
  };
}

// Middleware para /api/deals: después de una escritura exitosa sobre una
// operación, sus partes o sus agentes, encola esa operación. No toca la
// respuesta ni la retrasa.
const HOOK_PATH_RE = /^\/(\d+)(?:\/(?:parties|agents|restore)(?:\/.*)?)?\/?$/;
function dealSyncHook(req, res, next) {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) || !isConfigured()) return next();
  const match = req.path.match(HOOK_PATH_RE);
  const isCreate = req.method === 'POST' && (req.path === '/' || req.path === '');
  if (!match && !isCreate) return next();
  let responseBody;
  const originalJson = res.json.bind(res);
  res.json = (body) => { responseBody = body; return originalJson(body); };
  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    const id = match ? match[1] : (responseBody && responseBody.id);
    if (id) queueDealSync(id);
  });
  next();
}

function _setFetchForTests(fn) { fetchImpl = fn; }
function _resetForTests() { pending.clear(); draining = false; warnedNotConfigured = false; fullSync = { running: false, startedAt: null, finishedAt: null, summary: null }; }

module.exports = {
  isConfigured, hsRequest, syncDeal, syncAll, queueDealSync, startFullSync, getStatus, dealSyncHook,
  dealProperties, collectContacts,
  PIPELINE_ID, STAGE_NEW, STAGE_SIGNED,
  _setFetchForTests, _resetForTests
};
