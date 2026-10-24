// Reporte para Jarvis (lib/jarvisSnapshot.js): arma la foto correcta y,
// sobre todo, nunca deja salir datos sensibles de los formularios KYC ni
// ligas a archivos.
//
// Correr con:  npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpDir;
let db;
let snapshot;

const SECRET_ID = 'G12345678';
const SECRET_CURP = 'AAAA800101HJCLRN09';
const SECRET_FILE_URL = 'gs://gruponar-documentos/secret/passport.pdf';
const SECRET_KYC_URL = 'gs://gruponar-documentos/secret/kyc.pdf';

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gruponar-jarvis-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  db = require('../db');
  snapshot = require('../lib/jarvisSnapshot');

  const user = (name, email, role) => db.prepare(
    "INSERT INTO users (name, email, password_hash, role, status) VALUES (?,?,?,?, 'active')"
  ).run(name, email, 'x', role).lastInsertRowid;

  const sellerUser = user('Vendedor Uno', 'vendedor@example.com', 'seller');
  const agentUser = user('Agente LPR', 'agente@example.com', 'agent');
  db.prepare("UPDATE users SET phone = '+52 322 000 0000', totp_secret = 'TOTPSECRET' WHERE id = ?").run(sellerUser);

  const dealId = db.prepare(`
    INSERT INTO deals (scenario, development, property, price, currency, start_date, escrow_company, closing_date, contract_generated_file_url)
    VALUES ('trust', 'punta_mita', 'Villa Prueba 1', 2500000, 'USD', '2026-10-01', 'TLA', '2026-11-15', ?)
  `).run(SECRET_FILE_URL).lastInsertRowid;

  const sellerEntity = db.prepare(`
    INSERT INTO deal_party_entities (deal_id, side, party_type, name) VALUES (?, 'seller', 'individual', 'Vendedor Uno')
  `).run(dealId).lastInsertRowid;
  const buyerEntity = db.prepare(`
    INSERT INTO deal_party_entities (deal_id, side, party_type, name, ownership_mode) VALUES (?, 'buyer', 'llc', 'Comprador LLC', 'direct_owners')
  `).run(dealId).lastInsertRowid;
  db.prepare('INSERT INTO deal_party_owners (deal_party_entity_id, name) VALUES (?, ?)').run(buyerEntity, 'Socio Uno');

  db.prepare("INSERT INTO deal_parties (deal_id, user_id, role_in_deal, deal_party_entity_id) VALUES (?,?, 'seller', ?)").run(dealId, sellerUser, sellerEntity);
  db.prepare("INSERT INTO deal_parties (deal_id, user_id, role_in_deal) VALUES (?,?, 'agent')").run(dealId, agentUser);

  db.prepare(`INSERT INTO documents (deal_id, deal_party_entity_id, name, status, file_url, uploaded_at) VALUES (?,?, 'Pasaporte', 'done', ?, '2026-10-05')`).run(dealId, sellerEntity, SECRET_FILE_URL);
  db.prepare(`INSERT INTO documents (deal_id, deal_party_entity_id, name, status) VALUES (?,?, 'Comprobante de domicilio', 'pending')`).run(dealId, sellerEntity);
  db.prepare(`INSERT INTO documents (deal_id, deal_party_entity_id, name, status) VALUES (?, NULL, 'Escritura pública', 'pending')`).run(dealId);

  db.prepare(`INSERT INTO tasks (deal_id, label_en, label_es, status, requires_signature, sort_order) VALUES (?, 'Trust permit', 'Permiso SRE', 'pending', 0, 1)`).run(dealId);

  db.prepare(`
    INSERT INTO kyc_submissions (deal_id, deal_party_entity_id, template_key, answers_json, status, generated_file_url)
    VALUES (?,?, 'tla_individual', ?, 'generated', ?)
  `).run(dealId, sellerEntity, JSON.stringify({
    fullLegalName: 'Vendedor Uno', documentNumber: SECRET_ID, curp: SECRET_CURP,
    expiration: '2027-03-31', occupation: '', mobilePhone: '+52 322 111 1111'
  }), SECRET_KYC_URL);

  db.prepare("INSERT INTO deal_activity (deal_id, user_id, action, detail) VALUES (?,?, 'document_uploaded', 'Pasaporte')").run(dealId, sellerUser);

  // Operación en la papelera: no debe salir.
  db.prepare(`INSERT INTO deals (scenario, property, start_date, deleted_at) VALUES ('purchase', 'Borrada 9', '2026-01-01', '2026-02-01')`).run();
});

after(() => {
  try { db.close(); } catch (e) { /* ya cerrada */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('incluye las operaciones vivas con partes, pendientes, tareas y KYC', () => {
  const snap = snapshot.buildSnapshot(new Date('2026-10-24T13:00:00Z'));
  assert.equal(snap.version, 1);
  assert.equal(snap.totales.operaciones, 1);
  const op = snap.operaciones[0];
  assert.equal(op.inmueble, 'Villa Prueba 1');
  assert.equal(op.tipo, 'Fideicomiso');
  assert.equal(op.fechas.cierre, '2026-11-15');
  assert.equal(op.escrow, 'TLA');

  const vendedor = op.partes.find(p => p.lado === 'vendedor');
  assert.deepEqual(vendedor.documentos_pendientes, ['Comprobante de domicilio']);
  assert.equal(vendedor.usuarios[0].correo, 'vendedor@example.com');
  assert.equal(vendedor.kyc[0].estado, 'generated');
  assert.equal(vendedor.kyc[0].campos_llenos, 5);
  assert.equal(vendedor.kyc[0].identificacion_vence, '2027-03-31');

  const comprador = op.partes.find(p => p.lado === 'comprador');
  assert.deepEqual(comprador.estructura.socios, ['Socio Uno']);
  assert.equal(comprador.kyc.length, 0);

  assert.equal(op.agentes_y_abogados[0].nombre, 'Agente LPR');
  assert.equal(op.documentos_del_inmueble[0].nombre, 'Escritura pública');
  assert.equal(op.tareas[0].tarea, 'Permiso SRE');
  assert.equal(op.actividad_reciente[0].quien, 'Vendedor Uno');
});

test('no deja salir datos sensibles ni ligas a archivos', () => {
  const snap = snapshot.buildSnapshot();
  const text = JSON.stringify(snap) + snapshot.toMarkdown(snap);
  for (const secret of [SECRET_ID, SECRET_CURP, SECRET_FILE_URL, SECRET_KYC_URL, 'TOTPSECRET', '+52 322 000 0000', '+52 322 111 1111', 'gs://']) {
    assert.ok(!text.includes(secret), `se coló: ${secret}`);
  }
  assert.ok(!text.includes('Borrada 9'), 'no debe incluir operaciones en la papelera');
});

test('la fecha de vencimiento solo se copia si tiene forma de fecha', () => {
  assert.equal(snapshot.kycSummary(JSON.stringify({ expiration: 'G999 no es fecha' })).identificacion_vence, null);
  assert.equal(snapshot.kycSummary(JSON.stringify({ fechaVencimientoId: '31/03/2027' })).identificacion_vence, '31/03/2027');
  assert.equal(snapshot.kycSummary('no es json').campos_llenos, 0);
});

test('el markdown resume pendientes y KYC', () => {
  const md = snapshot.toMarkdown(snapshot.buildSnapshot());
  assert.match(md, /## Villa Prueba 1/);
  assert.match(md, /Pendientes \(1\): Comprobante de domicilio/);
  assert.match(md, /ID vence 2027-03-31/);
});

test('sin Drive conectado no publica y no truena', async () => {
  const result = await snapshot.publishSnapshot();
  assert.equal(result.skipped, 'drive_not_connected');
  assert.equal(snapshot.getStatus().drive_conectado, false);
});

test('frecuencia: por defecto semanal; solo publica cuando ya toca', async () => {
  const now = new Date('2026-10-26T13:00:00Z');
  assert.equal(snapshot.isDue(null, 168, now), true);
  assert.equal(snapshot.isDue('2026-10-20T13:00:00Z', 168, now), false);
  assert.equal(snapshot.isDue('2026-10-19T13:00:00Z', 168, now), true);
  assert.equal(snapshot.isDue('2026-10-25T12:00:00Z', 24, now), true);
  assert.equal(snapshot.isDue('basura', 168, now), true);
  assert.equal(snapshot.getStatus().cada_horas, 168);
  // Sin Drive conectado, aunque ya toque, se salta sin tronar.
  assert.equal((await snapshot.publishIfDue(now)).skipped, 'drive_not_connected');
});
