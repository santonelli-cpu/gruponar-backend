// Pruebas de la integración portal → HubSpot (lib/hubspot.js +
// routes/hubspot.js). La API de HubSpot se simula con un fetch falso en
// memoria — ningún test habla con HubSpot real ni usa un token real.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { authenticator } = require('otplib');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gruponar-hubspot-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'unit.db');
delete process.env.DATA_DIR;
delete process.env.HUBSPOT_TOKEN;
const db = require('../db');
const hubspot = require('../lib/hubspot');

const FAKE_TOKEN = 'fake-token-for-tests-only';

// --- HubSpot falso -----------------------------------------------------------
function makeFakeHubSpot() {
  const state = { nextId: 1000, deals: new Map(), contacts: new Map(), companies: [], assoc: new Set(), calls: [], authHeaders: new Set(), fail: null, rateLimitOnce: false };
  state.companies.push({ id: '501', name: 'TLA LLC' }, { id: '502', name: 'LPR Luxury' });
  const json = (status, body, headers = {}) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  state.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    state.calls.push(`${method} ${u.pathname}`);
    state.authHeaders.add(opts.headers && opts.headers.Authorization);
    if (state.rateLimitOnce) { state.rateLimitOnce = false; return json(429, { message: 'slow down' }, { 'retry-after': '0' }); }
    if (state.fail) return json(state.fail, { message: 'boom' });
    let m;
    if ((m = u.pathname.match(/^\/crm\/v3\/objects\/deals\/([^/]+)$/))) {
      const key = decodeURIComponent(m[1]);
      let deal;
      if (u.searchParams.get('idProperty') === 'portal_deal_id') deal = [...state.deals.values()].find(d => d.properties.portal_deal_id === key);
      else deal = state.deals.get(key);
      if (!deal) return json(404, { message: 'not found' });
      if (method === 'GET') return json(200, deal);
      if (method === 'PATCH') { Object.assign(deal.properties, body.properties); return json(200, deal); }
    }
    if (u.pathname === '/crm/v3/objects/deals' && method === 'POST') {
      const id = String(state.nextId++);
      const deal = { id, properties: { ...body.properties } };
      state.deals.set(id, deal);
      return json(201, deal);
    }
    if ((m = u.pathname.match(/^\/crm\/v3\/objects\/contacts\/([^/]+)$/))) {
      const key = decodeURIComponent(m[1]);
      const contact = u.searchParams.get('idProperty') === 'email' ? state.contacts.get(key) : [...state.contacts.values()].find(c => c.id === key);
      if (!contact) return json(404, { message: 'not found' });
      if (method === 'GET') return json(200, contact);
      if (method === 'PATCH') { Object.assign(contact.properties, body.properties); return json(200, contact); }
    }
    if (u.pathname === '/crm/v3/objects/contacts' && method === 'POST') {
      const id = String(state.nextId++);
      const contact = { id, properties: { ...body.properties } };
      state.contacts.set(body.properties.email, contact);
      return json(201, contact);
    }
    if (u.pathname === '/crm/v3/objects/companies/search' && method === 'POST') {
      const wanted = body.filterGroups[0].filters[0].value;
      return json(200, { results: state.companies.filter(c => c.name === wanted).map(c => ({ id: c.id, properties: { name: c.name } })) });
    }
    if ((m = u.pathname.match(/^\/crm\/v4\/objects\/(\w+)\/(\d+)\/associations\/default\/(\w+)\/(\d+)$/)) && method === 'PUT') {
      state.assoc.add(`${m[1]}:${m[2]}->${m[3]}:${m[4]}`);
      return json(200, { status: 'COMPLETE' });
    }
    return json(400, { message: `ruta no simulada: ${method} ${u.pathname}` });
  };
  return state;
}

let fake;
let dealId;

function seedDeal(property, extra = {}) {
  const info = db.prepare(`INSERT INTO deals (scenario, development, property, price, furniture_price, currency, start_date, escrow_company, closing_date, status)
    VALUES ('purchase', ?, ?, ?, ?, 'USD', '2026-10-01', ?, ?, ?)`)
    .run(extra.development || 'punta_mita', property, extra.price ?? 900000, extra.furniture ?? 150000, extra.escrow || 'tla', extra.closing || '2026-11-12', extra.status || 'active');
  return info.lastInsertRowid;
}

function seedUser(name, email, role, agency) {
  return db.prepare("INSERT INTO users (name, email, password_hash, role, status, agency) VALUES (?,?,?,?, 'active', ?)")
    .run(name, email, 'x', role, agency || null).lastInsertRowid;
}

before(() => {
  dealId = seedDeal('Punta Vista 1 - 401');
  const seller = seedUser('Bahri Bilir', 'bahri@example.com', 'seller');
  const buyer = seedUser('Jane Evans', 'jane@example.com', 'buyer');
  const agent = seedUser('Katia Robles', 'katia@example.com', 'agent', 'LPR Luxury');
  const internal = seedUser('Miguel Peña', 'miguel@gruponar.com', 'lawyer');
  const sellerEntity = db.prepare("INSERT INTO deal_party_entities (deal_id, side, party_type, name) VALUES (?, 'seller', 'individual', 'Bahri Bilir')").run(dealId).lastInsertRowid;
  const buyerEntity = db.prepare("INSERT INTO deal_party_entities (deal_id, side, party_type, name) VALUES (?, 'buyer', 'individual', 'Jane Evans')").run(dealId).lastInsertRowid;
  db.prepare("INSERT INTO deal_party_entities (deal_id, side, party_type, name) VALUES (?, 'buyer', 'individual', 'John Evans')").run(dealId); // sin cuenta → sin correo → no va
  db.prepare("INSERT INTO deal_parties (deal_id, user_id, role_in_deal, deal_party_entity_id) VALUES (?,?, 'seller', ?)").run(dealId, seller, sellerEntity);
  db.prepare("INSERT INTO deal_parties (deal_id, user_id, role_in_deal, deal_party_entity_id) VALUES (?,?, 'buyer', ?)").run(dealId, buyer, buyerEntity);
  db.prepare("INSERT INTO deal_parties (deal_id, user_id, role_in_deal) VALUES (?,?, 'agent')").run(dealId, agent);
  db.prepare("INSERT INTO deal_parties (deal_id, user_id, role_in_deal) VALUES (?,?, 'agent')").run(dealId, internal);
});

beforeEach(() => {
  fake = makeFakeHubSpot();
  hubspot._setFetchForTests(fake.fetch);
  hubspot._resetForTests();
  delete process.env.HUBSPOT_TOKEN;
  db.prepare('DELETE FROM hubspot_sync_log').run();
});

test('sin token no llama a HubSpot (ni sync ni cola)', async () => {
  const r = await hubspot.syncDeal(dealId);
  assert.equal(r.reason, 'not_configured');
  assert.equal(hubspot.queueDealSync(dealId), false);
  await new Promise(r => setImmediate(r));
  assert.equal(fake.calls.length, 0);
});

test('crea el deal en el pipeline GrupoNAR con contactos y asociaciones', async () => {
  process.env.HUBSPOT_TOKEN = FAKE_TOKEN;
  const r = await hubspot.syncDeal(dealId);
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.equal(r.dealCreated, true);
  const [deal] = [...fake.deals.values()];
  assert.equal(deal.properties.pipeline, '46373633');
  assert.equal(deal.properties.dealstage, '95364923');
  assert.equal(deal.properties.portal_deal_id, String(dealId));
  assert.equal(deal.properties.dealname, 'Punta Vista 1 - 401');
  assert.equal(deal.properties.closedate, '2026-11-12T18:00:00.000Z');
  assert.equal(deal.properties.precio_de_la_compraventa, '1050000');
  assert.equal(deal.properties.municipio, 'bahia_de_banderas');
  // Contactos: vendedor, compradora y agente — nunca el interno @gruponar.com.
  assert.deepEqual([...fake.contacts.keys()].sort(), ['bahri@example.com', 'jane@example.com', 'katia@example.com']);
  assert.equal(fake.contacts.get('bahri@example.com').properties.tipo_de_contacto, 'cliente_vendedor');
  assert.equal(fake.contacts.get('jane@example.com').properties.tipo_de_contacto, 'cliente_comprador');
  assert.equal(fake.contacts.get('katia@example.com').properties.tipo_de_contacto, 'agente_inmobiliario');
  for (const c of fake.contacts.values()) assert.equal(c.properties.consentimiento_comercial, 'sin_registrar');
  assert.ok(fake.assoc.has(`deals:${deal.id}->companies:501`), 'escrow TLA asociado');
  assert.ok(fake.assoc.has(`deals:${deal.id}->companies:502`), 'agencia LPR asociada');
  const katiaId = fake.contacts.get('katia@example.com').id;
  assert.ok(fake.assoc.has(`contacts:${katiaId}->companies:502`));
  const log = db.prepare('SELECT * FROM hubspot_sync_log WHERE deal_id = ?').get(dealId);
  assert.equal(log.status, 'ok');
  assert.equal(log.hubspot_deal_id, deal.id);
});

test('segunda corrida actualiza (idempotente) y completada → Signed Deed', async () => {
  process.env.HUBSPOT_TOKEN = FAKE_TOKEN;
  await hubspot.syncDeal(dealId);
  // Sin la fila del log: debe encontrarlo por portal_deal_id, no duplicar.
  db.prepare('DELETE FROM hubspot_sync_log').run();
  db.prepare("UPDATE deals SET property = 'Punta Vista 1 - 401 (renombrada)' WHERE id = ?").run(dealId);
  const r2 = await hubspot.syncDeal(dealId);
  assert.equal(r2.status, 'ok');
  assert.equal(r2.dealCreated, false);
  assert.equal(r2.contactsCreated, 0);
  assert.equal(fake.deals.size, 1);
  assert.equal(fake.contacts.size, 3);
  const [deal] = [...fake.deals.values()];
  assert.equal(deal.properties.dealname, 'Punta Vista 1 - 401 (renombrada)');
  assert.equal(deal.properties.dealstage, '95364923', 'operación activa: no cambia la etapa');
  db.prepare("UPDATE deals SET status = 'completed' WHERE id = ?").run(dealId);
  await hubspot.syncDeal(dealId);
  assert.equal(deal.properties.dealstage, '95350189');
  // Ya entregada la escritura en HubSpot: el portal no la regresa a Signed Deed.
  deal.properties.dealstage = '95350190';
  await hubspot.syncDeal(dealId);
  assert.equal(deal.properties.dealstage, '95350190');
  db.prepare("UPDATE deals SET status = 'active', property = 'Punta Vista 1 - 401' WHERE id = ?").run(dealId);
});

test('no sobrescribe consentimiento ni datos capturados en HubSpot', async () => {
  process.env.HUBSPOT_TOKEN = FAKE_TOKEN;
  fake.contacts.set('jane@example.com', { id: '77', properties: { email: 'jane@example.com', firstname: 'Janet', lastname: '', consentimiento_comercial: 'si', tipo_de_contacto: 'cliente_anterior_x' } });
  await hubspot.syncDeal(dealId);
  const jane = fake.contacts.get('jane@example.com');
  assert.equal(jane.properties.consentimiento_comercial, 'si');
  assert.equal(jane.properties.firstname, 'Janet');
  assert.equal(jane.properties.lastname, 'Evans', 'solo llena lo vacío');
  assert.equal(jane.properties.tipo_de_contacto, 'cliente_anterior_x');
});

test('429 se reintenta respetando Retry-After', async () => {
  process.env.HUBSPOT_TOKEN = FAKE_TOKEN;
  fake.rateLimitOnce = true;
  const r = await hubspot.syncDeal(dealId);
  assert.equal(r.status, 'ok');
});

test('un error de HubSpot queda en el log sin el token y sin lanzar', async () => {
  process.env.HUBSPOT_TOKEN = FAKE_TOKEN;
  fake.fail = 500;
  const r = await hubspot.syncDeal(dealId);
  assert.equal(r.status, 'error');
  const log = db.prepare('SELECT * FROM hubspot_sync_log WHERE deal_id = ?').get(dealId);
  assert.equal(log.status, 'error');
  assert.ok(!log.detail.includes(FAKE_TOKEN));
  assert.deepEqual([...fake.authHeaders], [`Bearer ${FAKE_TOKEN}`]);
});

test('operaciones de prueba y en papelera no se mandan', async () => {
  process.env.HUBSPOT_TOKEN = FAKE_TOKEN;
  const testDeal = seedDeal('test-stefano');
  const trashed = seedDeal('Casa en papelera');
  db.prepare("UPDATE deals SET deleted_at = datetime('now') WHERE id = ?").run(trashed);
  assert.equal((await hubspot.syncDeal(testDeal)).reason, 'test_name');
  assert.equal((await hubspot.syncDeal(trashed)).reason, 'deleted');
  assert.equal(fake.deals.size, 0);
});

test('la cola procesa en segundo plano', async () => {
  process.env.HUBSPOT_TOKEN = FAKE_TOKEN;
  assert.equal(hubspot.queueDealSync(dealId), true);
  assert.equal(fake.calls.length, 0, 'no bloquea al encolar');
  for (let i = 0; i < 50 && hubspot.getStatus().draining; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(fake.deals.size, 1);
});

test('el hook encola solo escrituras exitosas de operación/partes/agentes', async () => {
  process.env.HUBSPOT_TOKEN = FAKE_TOKEN;
  const { EventEmitter } = require('node:events');
  const run = (method, p, statusCode, body) => {
    const res = new EventEmitter();
    res.json = (b) => b;
    const req = { method, path: p };
    let nextCalled = false;
    hubspot.dealSyncHook(req, res, () => { nextCalled = true; });
    assert.ok(nextCalled);
    res.statusCode = statusCode;
    if (body !== undefined) res.json(body);
    res.emit('finish');
  };
  run('PATCH', `/${dealId}`, 200, { ok: true });
  run('POST', `/${dealId}/parties`, 201, { id: 999 }); // el id del body es la parte, no la operación
  run('POST', `/${dealId}/documents`, 201, { id: 5 }); // documentos: no
  run('PATCH', `/${dealId}`, 400, { error: 'x' }); // fallida: no
  run('GET', `/${dealId}`, 200, {}); // lectura: no
  assert.equal(hubspot.getStatus().queued, 1);
  run('POST', '/', 201, { id: 424242 }); // crear operación: usa el id de la respuesta
  assert.equal(hubspot.getStatus().queued, 2);
  for (let i = 0; i < 50 && hubspot.getStatus().draining; i++) await new Promise(r => setTimeout(r, 20));
});

// --- Endpoints admin (servidor real, sin token) -----------------------------
const PORT = 3997;
const BASE = `http://localhost:${PORT}`;
const PASSWORD = 'TestPassword123!';
const PASSWORD_HASH = '$2b$10$UP3HojXuPo8JHbEWeM/py.4vVkeyA1CfgPXSldR3rij73raQFHhUG';
const ADMIN_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DP';
const LAWYER_SECRET = 'KRSXG5CTMVRXEZLUJBSWY3DP';
let serverProc;

function makeSession() {
  const jar = new Map();
  return async function request(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (jar.size) headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    for (const setCookie of res.headers.getSetCookie?.() || []) {
      const [pair] = setCookie.split(';');
      const eq = pair.indexOf('=');
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    let json = null;
    try { json = await res.json(); } catch (e) { /* sin body */ }
    return { status: res.status, body: json };
  };
}

async function login(email, secret) {
  const session = makeSession();
  const res = await session('POST', '/api/auth/login', { email, password: PASSWORD });
  assert.equal(res.status, 200);
  const totp = await session('POST', '/api/auth/totp', { code: authenticator.generate(secret), remember: false });
  assert.equal(totp.status, 200, `2FA falló: ${JSON.stringify(totp.body)}`);
  return session;
}

test('endpoints /api/admin/hubspot: solo admin', async (t) => {
  const serverDb = path.join(tmpDir, 'server.db');
  const env = { ...process.env, PORT: String(PORT), DATABASE_PATH: serverDb, DATA_DIR: '', SESSION_SECRET: 'test-secret-not-for-production', NODE_ENV: 'test', RESEND_API_KEY: '', GCS_BUCKET_NAME: '', GCS_SERVICE_ACCOUNT_JSON: '', DISABLE_RATE_LIMITS: '1' };
  delete env.HUBSPOT_TOKEN;
  serverProc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  serverProc.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch (e) { /* aún no arranca */ }
    await new Promise(r => setTimeout(r, 200));
    if (i === 49) throw new Error('el servidor nunca respondió /api/health');
  }
  execFileSync('sqlite3', [serverDb, `
    INSERT INTO users (name,email,password_hash,role,status,totp_secret,totp_enabled,two_factor_method) VALUES
      ('HS Admin','hs-admin@test.local','${PASSWORD_HASH}','admin','active','${ADMIN_SECRET}',1,'totp'),
      ('HS Lawyer','hs-lawyer@test.local','${PASSWORD_HASH}','lawyer','active','${LAWYER_SECRET}',1,'totp');
  `]);

  const anon = makeSession();
  assert.equal((await anon('GET', '/api/admin/hubspot/status')).status, 401);
  assert.equal((await anon('POST', '/api/admin/hubspot/sync')).status, 401);

  const lawyer = await login('hs-lawyer@test.local', LAWYER_SECRET);
  assert.equal((await lawyer('GET', '/api/admin/hubspot/status')).status, 403);
  assert.equal((await lawyer('POST', '/api/admin/hubspot/sync')).status, 403);

  const admin = await login('hs-admin@test.local', ADMIN_SECRET);
  const status = await admin('GET', '/api/admin/hubspot/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.configured, false);
  assert.equal(status.body.pipelineId, '46373633');
  const sync = await admin('POST', '/api/admin/hubspot/sync');
  assert.equal(sync.status, 409, 'sin token no arranca');

  // Sin token, crear/editar operaciones sigue funcionando igual.
  const patched = await admin('PATCH', '/api/deals/999999', { closingDate: '2026-12-01' });
  assert.ok([403, 404].includes(patched.status));
});

after(() => {
  if (serverProc) serverProc.kill('SIGKILL');
  try { db.close(); } catch (e) { /* ya cerrada */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
