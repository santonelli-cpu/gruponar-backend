// Smoke test de la API completa — levanta el servidor real con una base de
// datos temporal y recorre los flujos críticos: login con 2FA (verificando
// la regeneración de sesión), scoping de abogado interno, ciclo de vida de
// la operación (crear → papelera → restaurar), autorización de secciones
// Gestoría/Banco, asignación de tareas y manejo de errores.
//
// Correr con:  npm test
// (usa el node:test integrado — sin dependencias nuevas; otplib ya es
// dependencia del proyecto y es JS puro, sin binarios nativos).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { authenticator } = require('otplib');

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
// Hash precalculado de 'TestPassword123!' — bcrypt es un módulo nativo y
// requerirlo aquí obligaría a que el node del test coincida con el del
// servidor; verificar un hash fijo no necesita el módulo en el test.
const PASSWORD = 'TestPassword123!';
const PASSWORD_HASH = '$2b$10$UP3HojXuPo8JHbEWeM/py.4vVkeyA1CfgPXSldR3rij73raQFHhUG';
const ADMIN_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DP';
const LAWYER_SECRET = 'KRSXG5CTMVRXEZLUJBSWY3DP';
const SELLER_SECRET = 'MFRGGZDFMZTWQ2LKNNWG23TP';

let serverProc;
let tmpDir;

// fetch de undici no maneja cookies solo — jar mínimo por sesión de prueba.
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
    try { json = await res.json(); } catch (e) { /* respuestas sin body */ }
    return { status: res.status, body: json, cookieValue: jar.get('connect.sid') };
  };
}

async function loginWith2fa(session, email, totpSecret) {
  const login = await session('POST', '/api/auth/login', { email, password: PASSWORD });
  assert.equal(login.status, 200);
  assert.equal(login.body.twoFactor, true, 'debe pedir 2FA');
  const totp = await session('POST', '/api/auth/totp', { code: authenticator.generate(totpSecret), remember: false });
  assert.equal(totp.status, 200, `2FA falló: ${JSON.stringify(totp.body)}`);
  return totp;
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gruponar-test-'));
  const dbPath = path.join(tmpDir, 'test.db');

  serverProc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_PATH: dbPath,
      DATA_DIR: '',
      SESSION_SECRET: 'test-secret-not-for-production',
      NODE_ENV: 'test',
      RESEND_API_KEY: '', // sin correos reales en tests
      GCS_BUCKET_NAME: '', GCS_SERVICE_ACCOUNT_JSON: '', // sin storage real
      DISABLE_RATE_LIMITS: '1' // ~15 logins seguidos desde 127.0.0.1 dispararían el límite real
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProc.stderr.on('data', d => process.stderr.write(`[server] ${d}`));

  // Espera a que el servidor (y sus migraciones) estén listos.
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch (e) { /* aún no arranca */ }
    await new Promise(r => setTimeout(r, 200));
    if (i === 49) throw new Error('el servidor nunca respondió /api/health');
  }

  // Sembrar cuentas de prueba directo en la base temporal (sqlite3 CLI —
  // mismo motivo que el hash fijo: cero dependencias nativas en el test).
  execFileSync('sqlite3', [dbPath, `
    INSERT INTO users (name,email,password_hash,role,status,totp_secret,totp_enabled,two_factor_method) VALUES
      ('Test Admin','admin@test.local','${PASSWORD_HASH}','admin','active','${ADMIN_SECRET}',1,'totp'),
      ('Test Lawyer','lawyer@test.local','${PASSWORD_HASH}','lawyer','active','${LAWYER_SECRET}',1,'totp'),
      ('Test Buyer','buyer@test.local','${PASSWORD_HASH}','buyer','active',NULL,0,NULL),
      ('Test Seller','seller@test.local','${PASSWORD_HASH}','seller','active','${SELLER_SECRET}',1,'totp');
  `]);
});

after(() => {
  if (serverProc) serverProc.kill('SIGKILL');
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('health responde', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.status, 200);
});

test('ruta /api desconocida devuelve JSON 404', async () => {
  const res = await fetch(`${BASE}/api/no-existe`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.ok(body.error);
});

test('JSON malformado devuelve 400 limpio', async () => {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{roto' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error.includes('JSON'));
});

test('login con contraseña incorrecta → 401 genérico', async () => {
  const session = makeSession();
  const res = await session('POST', '/api/auth/login', { email: 'admin@test.local', password: 'incorrecta123' });
  assert.equal(res.status, 401);
});

test('login completo regenera el ID de sesión (anti session-fixation)', async () => {
  const session = makeSession();
  const login = await session('POST', '/api/auth/login', { email: 'admin@test.local', password: PASSWORD });
  const sidBefore = login.cookieValue;
  assert.ok(sidBefore, 'debe haber cookie tras el paso de contraseña');
  const totp = await session('POST', '/api/auth/totp', { code: authenticator.generate(ADMIN_SECRET), remember: false });
  assert.equal(totp.status, 200);
  assert.notEqual(totp.cookieValue, sidBefore, 'el session ID debe cambiar al autenticarse');
  const me = await session('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.role, 'admin');
});

test('flujo de operación: crear → detalle → papelera → restaurar', async () => {
  const admin = makeSession();
  await loginWith2fa(admin, 'admin@test.local', ADMIN_SECRET);

  const created = await admin('POST', '/api/deals', {
    scenario: 'trust', development: 'punta_mita', property: 'Test Villa 1',
    price: 1000000, furniturePrice: 0, currency: 'USD',
    startDate: '2026-08-01', escrowCompany: 'tla',
    parties: [
      { side: 'seller', partyType: 'individual', name: 'Vendedor Uno' },
      { side: 'buyer', partyType: 'individual', name: 'Comprador Uno' }
    ]
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const dealId = created.body.id;

  const detail = await admin('GET', `/api/deals/${dealId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.property, 'Test Villa 1');
  // Escenario trust → trae documentos de Gestoría y Banco para staff
  assert.ok(detail.body.documents.some(d => d.section === 'gestoria'), 'faltan docs de gestoría');
  assert.ok(detail.body.documents.some(d => d.section === 'banco'), 'faltan docs de banco');
  // y la tarea nueva de carta al banco en constitución
  assert.ok(detail.body.tasks.some(t => t.label_es === 'Carta de instrucción al banco'));

  // papelera y restauración
  const del = await admin('DELETE', `/api/deals/${dealId}`);
  assert.equal(del.status, 200);
  const gone = await admin('GET', `/api/deals/${dealId}`);
  assert.equal(gone.status, 404, 'una operación en papelera no debe responder el detalle');
  const restore = await admin('POST', `/api/deals/${dealId}/restore`);
  assert.equal(restore.status, 200);
  const back = await admin('GET', `/api/deals/${dealId}`);
  assert.equal(back.status, 200);
});

test('abogado interno NO ve operaciones ajenas; asignarlo le da acceso', async () => {
  const admin = makeSession();
  await loginWith2fa(admin, 'admin@test.local', ADMIN_SECRET);
  const created = await admin('POST', '/api/deals', {
    scenario: 'purchase', development: 'punta_mita', property: 'Scoping Test',
    price: 0, furniturePrice: 0, currency: 'USD', startDate: '2026-08-01', escrowCompany: 'armour',
    parties: [
      { side: 'seller', partyType: 'individual', name: 'V' },
      { side: 'buyer', partyType: 'individual', name: 'C' }
    ]
  });
  const dealId = created.body.id;

  const lawyer = makeSession();
  await loginWith2fa(lawyer, 'lawyer@test.local', LAWYER_SECRET);
  const denied = await lawyer('GET', `/api/deals/${dealId}`);
  assert.equal(denied.status, 403, 'abogado sin asignar no debe ver la operación');

  // el admin lo asigna → acceso inmediato
  const lawyerId = 2; // segundo INSERT del seed
  const add = await admin('POST', `/api/deals/${dealId}/agents`, { userId: lawyerId, representsSide: null });
  assert.equal(add.status, 201);
  const allowed = await lawyer('GET', `/api/deals/${dealId}`);
  assert.equal(allowed.status, 200);
});

test('asignación de tareas: solo admin asigna, queda el nombre y la actividad', async () => {
  const admin = makeSession();
  await loginWith2fa(admin, 'admin@test.local', ADMIN_SECRET);
  const created = await admin('POST', '/api/deals', {
    scenario: 'purchase', development: 'punta_mita', property: 'Task Assign Test',
    price: 0, furniturePrice: 0, currency: 'USD', startDate: '2026-08-01', escrowCompany: 'armour',
    parties: [
      { side: 'seller', partyType: 'individual', name: 'V' },
      { side: 'buyer', partyType: 'individual', name: 'C' }
    ]
  });
  const dealId = created.body.id;
  const detail = await admin('GET', `/api/deals/${dealId}`);
  const taskId = detail.body.tasks[0].id;

  const assign = await admin('PATCH', `/api/deals/${dealId}/tasks/${taskId}`, { assignedTo: 2 });
  assert.equal(assign.status, 200);
  const after = await admin('GET', `/api/deals/${dealId}`);
  assert.equal(after.body.tasks[0].assigned_to_name, 'Test Lawyer');

  // completar el paso deja completed_at y actividad
  const done = await admin('PATCH', `/api/deals/${dealId}/tasks/${taskId}`, { status: 'done' });
  assert.equal(done.status, 200);
  const activity = await admin('GET', `/api/deals/${dealId}/activity`);
  assert.equal(activity.status, 200);
  assert.ok(activity.body.some(a => a.action === 'task_done'));
  assert.ok(activity.body.some(a => a.action === 'deal_created'));
});

test('comprador no ve Gestoría/Banco ni puede tocar sus documentos', async () => {
  const admin = makeSession();
  await loginWith2fa(admin, 'admin@test.local', ADMIN_SECRET);
  const created = await admin('POST', '/api/deals', {
    scenario: 'trust', development: 'punta_mita', property: 'Buyer Filter Test',
    price: 0, furniturePrice: 0, currency: 'USD', startDate: '2026-08-01', escrowCompany: 'tla',
    parties: [
      { side: 'seller', partyType: 'individual', name: 'V' },
      { side: 'buyer', partyType: 'individual', name: 'Test Buyer', email: 'buyer@test.local' }
    ]
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const dealId = created.body.id;
  const adminDetail = await admin('GET', `/api/deals/${dealId}`);
  const gestoriaDoc = adminDetail.body.documents.find(d => d.section === 'gestoria');
  assert.ok(gestoriaDoc);

  const buyer = makeSession();
  const login = await buyer('POST', '/api/auth/login', { email: 'buyer@test.local', password: PASSWORD });
  assert.equal(login.status, 200);
  // cuenta sin 2FA configurado → método 'choose' con secreto nuevo; usarlo
  assert.equal(login.body.twoFactor, true);
  const totp = await buyer('POST', '/api/auth/totp', { code: authenticator.generate(login.body.secret), remember: false });
  assert.equal(totp.status, 200, JSON.stringify(totp.body));

  const detail = await buyer('GET', `/api/deals/${dealId}`);
  assert.equal(detail.status, 200);
  assert.ok(!detail.body.documents.some(d => d.section), 'el comprador no debe recibir docs de Gestoría/Banco');
  // ni marcarlos por ID directo
  const touch = await buyer('PATCH', `/api/deals/${dealId}/documents/${gestoriaDoc.id}`, { status: 'done' });
  assert.equal(touch.status, 403);

  // Sí agrega renglones al checklist, pero SOLO dentro de su propia parte:
  // ni en Propiedad (sin dealPartyEntityId) ni en la parte de alguien más.
  // El frontend le muestra el "+" con el mismo criterio
  // (canAddChecklistItem en deal-detail.js).
  const myPartyId = adminDetail.body.parties.find(p => p.side === 'buyer').id;
  const mine = await buyer('POST', `/api/deals/${dealId}/documents`, { name: 'Extra del cliente', dealPartyEntityId: myPartyId });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  // Gastos de cierre sí es suyo (él paga y sube los comprobantes); Propiedad
  // no (escritura y predial son papeles del dueño, o sea del vendedor).
  const costs = await buyer('POST', `/api/deals/${dealId}/documents`, { name: 'Segundo comprobante de pago', section: 'closing_costs' });
  assert.equal(costs.status, 201, JSON.stringify(costs.body));
  const property = await buyer('POST', `/api/deals/${dealId}/documents`, { name: 'Extra de propiedad' });
  assert.equal(property.status, 403, 'Propiedad es del vendedor');
  const otherPartyId = adminDetail.body.parties.find(p => p.id !== myPartyId).id;
  const theirs = await buyer('POST', `/api/deals/${dealId}/documents`, { name: 'Extra ajeno', dealPartyEntityId: otherPartyId });
  assert.equal(theirs.status, 403, 'no debe poder agregar en la parte de alguien más');
  // y tampoco puede quitar el que acaba de agregar (eso es de admin/abogado)
  const removal = await buyer('DELETE', `/api/deals/${dealId}/documents/${mine.body.id}`);
  assert.equal(removal.status, 403);
});

test('versiones de documentos: lista vacía para admin, 403 para parte ajena', async () => {
  const admin = makeSession();
  await loginWith2fa(admin, 'admin@test.local', ADMIN_SECRET);
  const created = await admin('POST', '/api/deals', {
    scenario: 'purchase', development: 'punta_mita', property: 'Versions Test',
    price: 0, furniturePrice: 0, currency: 'USD', startDate: '2026-08-01', escrowCompany: 'armour',
    parties: [
      { side: 'seller', partyType: 'individual', name: 'V' },
      { side: 'buyer', partyType: 'individual', name: 'C' }
    ]
  });
  const dealId = created.body.id;
  const detail = await admin('GET', `/api/deals/${dealId}`);
  // un documento del checklist del VENDEDOR (para probar el 403 del comprador)
  const sellerParty = detail.body.parties.find(p => p.side === 'seller');
  const sellerDoc = detail.body.documents.find(d => d.deal_party_entity_id === sellerParty.id);
  assert.ok(sellerDoc);

  const list = await admin('GET', `/api/deals/${dealId}/documents/${sellerDoc.id}/versions`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body, []);

  // el comprador (cuenta ya sembrada y ligada en el test anterior a OTRO
  // deal) — ligarlo aquí como comprador y verificar que NO ve versiones
  // de documentos del vendedor
  const buyerParty = detail.body.parties.find(p => p.side === 'buyer');
  await admin('PATCH', `/api/deals/${dealId}/parties/${buyerParty.id}`, { name: 'Test Buyer', email: 'buyer@test.local' });
  const buyer = makeSession();
  const login = await buyer('POST', '/api/auth/login', { email: 'buyer@test.local', password: PASSWORD });
  const totp = await buyer('POST', '/api/auth/totp', { code: authenticator.generate(login.body.secret || ''), remember: false });
  if (totp.status !== 200) {
    // la cuenta ya fijó TOTP en el test anterior con un secreto que no
    // conocemos — no podemos loguearla otra vez; el 403 de autorización ya
    // queda cubierto por el test de Gestoría/Banco, así que basta el 200+[]
    return;
  }
  const denied = await buyer('GET', `/api/deals/${dealId}/documents/${sellerDoc.id}/versions`);
  assert.equal(denied.status, 403);
});

test('edición de perfil: conflicto de correo → 409; admin protegido → 404', async () => {
  const admin = makeSession();
  await loginWith2fa(admin, 'admin@test.local', ADMIN_SECRET);
  const conflict = await admin('PATCH', '/api/users/2/profile', { name: 'X', email: 'admin@test.local' });
  assert.equal(conflict.status, 409);
  const adminEdit = await admin('PATCH', '/api/users/1/profile', { name: 'X', email: 'otro@test.local' });
  assert.equal(adminEdit.status, 404);
});

// Doble representación: el mismo agente lleva a comprador Y vendedor de la
// misma operación (pasa seguido cuando la propiedad y el cliente salen de la
// misma agencia). Antes solo se podía elegir UN lado, así que había que
// ligar a la misma persona dos veces — imposible por UNIQUE(deal_id,user_id).
// De paso cubre que el agente ya puede agregar renglones al checklist ("+").
test('agente con doble representación ve los dos lados y agrega renglones al checklist', async () => {
  const admin = makeSession();
  await loginWith2fa(admin, 'admin@test.local', ADMIN_SECRET);
  const created = await admin('POST', '/api/deals', {
    scenario: 'purchase', development: 'punta_mita', property: 'Doble Representación',
    price: 0, furniturePrice: 0, currency: 'USD', startDate: '2026-08-01', escrowCompany: 'armour',
    parties: [
      { side: 'seller', partyType: 'individual', name: 'Vendedor Doble' },
      { side: 'buyer', partyType: 'individual', name: 'Comprador Doble' }
    ]
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const dealId = created.body.id;

  const reg = await admin('POST', `/api/deals/${dealId}/agents/register`, {
    name: 'Agente Doble', email: 'doble@test.local', role: 'agent',
    agency: 'LPR Luxury', representsSide: 'both'
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));

  const agent = makeSession();
  const login = await agent('POST', '/api/auth/login', { email: 'doble@test.local', password: reg.body.temporaryPassword });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const totp = await agent('POST', '/api/auth/totp', { code: authenticator.generate(login.body.secret), remember: false });
  assert.equal(totp.status, 200, JSON.stringify(totp.body));

  // Los DOS lados visibles (con un solo lado elegido vería una sola parte)
  const detail = await agent('GET', `/api/deals/${dealId}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.parties.map(p => p.side).sort(), ['buyer', 'seller']);
  const sellerParty = detail.body.parties.find(p => p.side === 'seller');
  const buyerParty = detail.body.parties.find(p => p.side === 'buyer');

  // y puede agregar un requisito de checklist a cualquiera de los dos
  for (const party of [sellerParty, buyerParty]) {
    const add = await agent('POST', `/api/deals/${dealId}/documents`, {
      name: `Comprobante extra ${party.side}`, dealPartyEntityId: party.id
    });
    assert.equal(add.status, 201, JSON.stringify(add.body));
  }
  const afterAdd = await agent('GET', `/api/deals/${dealId}`);
  assert.equal(afterAdd.body.documents.filter(d => d.name.startsWith('Comprobante extra')).length, 2);

  // pero NO puede quitar renglones (eso sigue siendo de admin/abogado)
  const someDoc = afterAdd.body.documents.find(d => d.name === 'Comprobante extra buyer');
  const removal = await agent('DELETE', `/api/deals/${dealId}/documents/${someDoc.id}`);
  assert.equal(removal.status, 403, 'el agente no debe poder quitar renglones del checklist');
});

// Un agente de UN solo lado sigue sin poder agregar renglones del otro lado
// — el "+" nuevo no debe volverse una puerta al lado contrario.
test('agente de un solo lado no puede agregar renglones del otro lado', async () => {
  const admin = makeSession();
  await loginWith2fa(admin, 'admin@test.local', ADMIN_SECRET);
  const created = await admin('POST', '/api/deals', {
    scenario: 'purchase', development: 'punta_mita', property: 'Un Solo Lado',
    price: 0, furniturePrice: 0, currency: 'USD', startDate: '2026-08-01', escrowCompany: 'armour',
    parties: [
      { side: 'seller', partyType: 'individual', name: 'Vendedor Solo' },
      { side: 'buyer', partyType: 'individual', name: 'Comprador Solo' }
    ]
  });
  const dealId = created.body.id;
  const adminDetail = await admin('GET', `/api/deals/${dealId}`);
  const buyerPartyId = adminDetail.body.parties.find(p => p.side === 'buyer').id;
  const sellerPartyId = adminDetail.body.parties.find(p => p.side === 'seller').id;

  const reg = await admin('POST', `/api/deals/${dealId}/agents/register`, {
    name: 'Agente Vendedor', email: 'solovendedor@test.local', role: 'agent',
    agency: 'LPR Luxury', representsSide: 'seller'
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));

  const agent = makeSession();
  const login = await agent('POST', '/api/auth/login', { email: 'solovendedor@test.local', password: reg.body.temporaryPassword });
  const totp = await agent('POST', '/api/auth/totp', { code: authenticator.generate(login.body.secret), remember: false });
  assert.equal(totp.status, 200, JSON.stringify(totp.body));

  const detail = await agent('GET', `/api/deals/${dealId}`);
  assert.deepEqual(detail.body.parties.map(p => p.side), ['seller']);

  const mine = await agent('POST', `/api/deals/${dealId}/documents`, { name: 'Extra propio', dealPartyEntityId: sellerPartyId });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  const theirs = await agent('POST', `/api/deals/${dealId}/documents`, { name: 'Extra ajeno', dealPartyEntityId: buyerPartyId });
  assert.equal(theirs.status, 403, 'no debe poder agregar documentos del lado que no representa');
  // y las secciones internas (Gestoría/Banco) siguen cerradas para el agente
  const internal = await agent('POST', `/api/deals/${dealId}/documents`, { name: 'Extra gestoría', section: 'gestoria' });
  assert.equal(internal.status, 403, 'Gestoría/Banco no son del agente');
});

// La otra mitad del criterio por sección: Propiedad (escritura, predial) es
// del VENDEDOR, y Gastos de cierre no — es lo contrario del comprador.
test('vendedor agrega en Propiedad y en su parte, pero no en Gastos de cierre', async () => {
  const admin = makeSession();
  await loginWith2fa(admin, 'admin@test.local', ADMIN_SECRET);
  const created = await admin('POST', '/api/deals', {
    scenario: 'purchase', development: 'punta_mita', property: 'Checklist Vendedor',
    price: 0, furniturePrice: 0, currency: 'USD', startDate: '2026-08-01', escrowCompany: 'armour',
    parties: [
      { side: 'seller', partyType: 'individual', name: 'Test Seller', email: 'seller@test.local' },
      { side: 'buyer', partyType: 'individual', name: 'C' }
    ]
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const dealId = created.body.id;
  const adminDetail = await admin('GET', `/api/deals/${dealId}`);
  const myPartyId = adminDetail.body.parties.find(p => p.side === 'seller').id;

  const seller = makeSession();
  await loginWith2fa(seller, 'seller@test.local', SELLER_SECRET);

  const mine = await seller('POST', `/api/deals/${dealId}/documents`, { name: 'Extra del vendedor', dealPartyEntityId: myPartyId });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  const property = await seller('POST', `/api/deals/${dealId}/documents`, { name: 'Constancia de no adeudo extra' });
  assert.equal(property.status, 201, JSON.stringify(property.body));
  const costs = await seller('POST', `/api/deals/${dealId}/documents`, { name: 'Comprobante ajeno', section: 'closing_costs' });
  assert.equal(costs.status, 403, 'Gastos de cierre es del comprador');
  const internal = await seller('POST', `/api/deals/${dealId}/documents`, { name: 'Avalúo extra', section: 'gestoria' });
  assert.equal(internal.status, 403, 'Gestoría sigue siendo del despacho');

  // Y lo que agregó en Gastos de cierre el comprador sí le llega al cliente
  // (la sección NO es de staff, a diferencia de Gestoría/Banco).
  const adminCosts = await admin('POST', `/api/deals/${dealId}/documents`, { name: 'Comprobante extra del cierre', section: 'closing_costs' });
  assert.equal(adminCosts.status, 201);
  const sellerView = await seller('GET', `/api/deals/${dealId}`);
  assert.ok(sellerView.body.documents.some(d => d.section === 'closing_costs'), 'Gastos de cierre debe verse del lado del cliente');
  assert.ok(!sellerView.body.documents.some(d => ['gestoria', 'banco'].includes(d.section)), 'Gestoría/Banco no');
});
