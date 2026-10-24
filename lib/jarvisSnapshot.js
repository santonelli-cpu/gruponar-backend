// Reporte de solo lectura para Jarvis (el asistente de Stefano).
//
// Una vez por semana (configurable) el portal arma una foto de todas las operaciones vivas —partes,
// checklist de documentos, tareas, expedientes KYC y actividad reciente— y
// la deja en el Google Drive ya conectado (Equipo → Integraciones), en la
// carpeta "Jarvis (portal)": `portal-snapshot.json` (para leer por máquina) y
// `portal-snapshot.md` (para leer de corrido). Jarvis lo lee con su conector
// de Drive; no necesita sesión, 2FA ni ninguna llave nueva.
//
// Es de UNA sola vía: nada de lo que haga Jarvis vuelve al portal.
//
// Lo que NUNCA sale de aquí:
//   - Las respuestas de los formularios KYC (answers_json): ni números de
//     identificación, ni CURP/RFC, ni cuentas, ni domicilios. Solo cuántos
//     campos están llenos y, si existe, la fecha de vencimiento de la
//     identificación (sirve para alertar vencimientos).
//   - Ligas a archivos (file_url, generated_file_url), sobres de DocuSign,
//     contraseñas, secretos de 2FA ni teléfonos.
//
// Frecuencia: JARVIS_SNAPSHOT_EVERY_HOURS (por defecto 168 = una vez por
// semana; 24 = diario). El servidor revisa cada hora si ya toca, así que
// sobrevive a reinicios sin publicar de más.
// Apagar: variable de entorno JARVIS_SNAPSHOT_DISABLED=1.

const db = require('../db');
const drive = require('./googleDriveClient');

const FOLDER_NAME = 'Jarvis (portal)';
const JSON_NAME = 'portal-snapshot.json';
const MD_NAME = 'portal-snapshot.md';
const SNAPSHOT_VERSION = 1;

// Campos de los formularios KYC que traen la fecha de vencimiento de la
// identificación (TLA usa `expiration`, LPR/Armour `fechaVencimientoId`).
const ID_EXPIRY_FIELDS = ['expiration', 'fechaVencimientoId', 'idExpiration', 'expirationDate'];

const SCENARIO_ES = {
  purchase: 'Compraventa',
  trust: 'Fideicomiso',
  transfer: 'Cesión de derechos',
  trust_termination: 'Extinción de fideicomiso'
};

function parseJson(text, fallback) {
  try { return text ? JSON.parse(text) : fallback; } catch (e) { return fallback; }
}

function isFilled(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.values(value).some(isFilled);
  return true;
}

// Solo fechas con forma de fecha: si alguien escribió otra cosa en ese
// campo, no se copia.
function asDate(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/.test(v)) return v;
  return null;
}

function kycSummary(answersJson) {
  const answers = parseJson(answersJson, {});
  const keys = Object.keys(answers);
  const filled = keys.filter(k => isFilled(answers[k])).length;
  let idExpires = null;
  for (const f of ID_EXPIRY_FIELDS) {
    idExpires = asDate(answers[f]);
    if (idExpires) break;
  }
  return { campos_llenos: filled, campos_con_respuesta_posible: keys.length, identificacion_vence: idExpires };
}

function truncate(text, max) {
  if (!text) return null;
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function buildSnapshot(now = new Date()) {
  const deals = db.prepare(`
    SELECT id, scenario, development, property, price, furniture_price, currency,
           start_date, closing_date, due_diligence_end_date, escrow_company,
           status, closed_at, contract_status, contract_docusign_status,
           legal_acts, drive_folder_url, created_at
    FROM deals
    WHERE deleted_at IS NULL
    ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, COALESCE(closing_date, '9999-12-31'), id
  `).all();

  const entitiesStmt = db.prepare(`
    SELECT id, side, party_type, name, ownership_mode, parent_entity_name, parent_entity_type,
           parent_has_trust_above, parent_trust_name, direct_trust_name
    FROM deal_party_entities WHERE deal_id = ? ORDER BY side, sort_order, id`);
  const ownersStmt = db.prepare('SELECT name FROM deal_party_owners WHERE deal_party_entity_id = ? ORDER BY sort_order, id');
  const peopleStmt = db.prepare(`
    SELECT dp.role_in_deal, dp.deal_party_entity_id, dp.represents_side, dp.relationship,
           u.name, u.email, u.role, u.status, u.agency
    FROM deal_parties dp JOIN users u ON u.id = dp.user_id
    WHERE dp.deal_id = ? ORDER BY dp.role_in_deal, u.name`);
  const docsStmt = db.prepare(`
    SELECT deal_party_entity_id, section, sub_label, name, status, review_status, review_note,
           apostille_done, uploaded_at
    FROM documents WHERE deal_id = ? ORDER BY deal_party_entity_id, id`);
  const tasksStmt = db.prepare(`
    SELECT t.label_es, t.status, t.requires_signature, t.docusign_status, t.completed_at, t.sign_side,
           u.name AS assigned_to
    FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to
    WHERE t.deal_id = ? ORDER BY t.sort_order, t.id`);
  const kycStmt = db.prepare(`
    SELECT deal_party_entity_id, template_key, status, docusign_status, answers_json, updated_at, created_at
    FROM kyc_submissions WHERE deal_id = ? ORDER BY deal_party_entity_id, template_key`);
  const activityStmt = db.prepare(`
    SELECT a.action, a.detail, a.created_at, u.name AS user_name
    FROM deal_activity a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.deal_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 10`);

  const operaciones = deals.map(deal => {
    const entities = entitiesStmt.all(deal.id);
    const people = peopleStmt.all(deal.id);
    const docs = docsStmt.all(deal.id);
    const kycs = kycStmt.all(deal.id);

    const partes = entities.map(e => {
      const own = docs.filter(d => d.deal_party_entity_id === e.id);
      return {
        lado: e.side === 'seller' ? 'vendedor' : 'comprador',
        tipo: e.party_type,
        nombre: e.name,
        estructura: e.party_type === 'individual' ? null : {
          modo: e.ownership_mode,
          socios: ownersStmt.all(e.id).map(o => o.name),
          entidad_padre: e.parent_entity_name ? { nombre: e.parent_entity_name, tipo: e.parent_entity_type } : null,
          trust: e.direct_trust_name || (e.parent_has_trust_above ? e.parent_trust_name : null)
        },
        usuarios: people.filter(p => p.deal_party_entity_id === e.id).map(p => ({ nombre: p.name, correo: p.email, cuenta: p.status })),
        documentos_pendientes: own.filter(d => d.status !== 'done').map(d => d.sub_label ? `${d.name} (${d.sub_label})` : d.name),
        documentos: own.map(d => ({
          nombre: d.name,
          detalle: d.sub_label || null,
          seccion: d.section || null,
          estado: d.status,
          revision: d.review_status || null,
          nota_revision: truncate(d.review_note, 200),
          apostillado: !!d.apostille_done,
          subido: d.uploaded_at || null
        })),
        kyc: kycs.filter(k => k.deal_party_entity_id === e.id).map(k => ({
          formato: k.template_key,
          estado: k.status,
          firma_docusign: k.docusign_status,
          actualizado: k.updated_at || k.created_at,
          // "pdf_firmado": se subió ya firmado (botón "Subir PDF firmado"), sin
          // llenar el formulario en el portal; "portal": se llenó aquí.
          origen: k.status === 'signed' && kycSummary(k.answers_json).campos_llenos === 0 ? 'pdf_firmado' : 'portal',
          ...kycSummary(k.answers_json)
        }))
      };
    });

    const propertyDocs = docs.filter(d => d.deal_party_entity_id === null);

    return {
      id: deal.id,
      inmueble: deal.property,
      desarrollo: deal.development,
      tipo: SCENARIO_ES[deal.scenario] || deal.scenario,
      estado: deal.status,
      cerrada_el: deal.closed_at || null,
      precio: { monto: deal.price, mobiliario: deal.furniture_price, moneda: deal.currency },
      fechas: {
        inicio: deal.start_date,
        fin_due_diligence: deal.due_diligence_end_date || null,
        cierre: deal.closing_date || null
      },
      escrow: deal.escrow_company || null,
      contrato: { estado: deal.contract_status, firma_docusign: deal.contract_docusign_status },
      actos: parseJson(deal.legal_acts, null),
      carpeta_drive: deal.drive_folder_url || null,
      agentes_y_abogados: people.filter(p => !p.deal_party_entity_id).map(p => ({
        nombre: p.name, correo: p.email, rol: p.role_in_deal === 'agent' ? (p.role === 'external_lawyer' ? 'abogado externo' : 'agente') : p.role_in_deal,
        agencia: p.agency || null, representa: p.represents_side || null, relacion: p.relationship || null
      })),
      partes,
      documentos_del_inmueble: propertyDocs.map(d => ({ nombre: d.name, detalle: d.sub_label || null, estado: d.status, subido: d.uploaded_at || null })),
      tareas: tasksStmt.all(deal.id).map(t => ({
        tarea: t.label_es, estado: t.status, requiere_firma: !!t.requires_signature,
        firma_docusign: t.requires_signature ? t.docusign_status : null,
        lado_que_firma: t.sign_side || null, asignada_a: t.assigned_to || null, terminada: t.completed_at || null
      })),
      actividad_reciente: activityStmt.all(deal.id).map(a => ({
        fecha: a.created_at, quien: a.user_name || 'sistema', accion: a.action, detalle: truncate(a.detail, 160)
      }))
    };
  });

  return {
    version: SNAPSHOT_VERSION,
    generado_en: now.toISOString(),
    fuente: 'portal.gruponar.com',
    nota: 'Reporte de solo lectura para Jarvis. No incluye respuestas de formularios KYC, números de identificación, cuentas, ligas a archivos ni teléfonos.',
    totales: {
      operaciones: operaciones.length,
      activas: operaciones.filter(o => o.estado === 'active').length
    },
    operaciones
  };
}

function toMarkdown(snap) {
  const lines = [];
  lines.push(`# Portal de cierres: foto para Jarvis`);
  lines.push('');
  lines.push(`Generado: ${snap.generado_en} · ${snap.totales.operaciones} operaciones (${snap.totales.activas} activas). Solo lectura.`);
  for (const op of snap.operaciones) {
    lines.push('');
    lines.push(`## ${op.inmueble} (#${op.id})`);
    lines.push(`${op.tipo} · ${op.estado}${op.cerrada_el ? ` (cerrada ${op.cerrada_el})` : ''} · cierre ${op.fechas.cierre || 'sin fecha'} · due diligence ${op.fechas.fin_due_diligence || '—'} · escrow ${op.escrow || '—'} · contrato ${op.contrato.estado}`);
    if (op.agentes_y_abogados.length) {
      lines.push(`Agentes/abogados: ${op.agentes_y_abogados.map(a => `${a.nombre} (${a.rol}${a.agencia ? ', ' + a.agencia : ''})`).join('; ')}`);
    }
    for (const p of op.partes) {
      const kyc = p.kyc.length
        ? p.kyc.map(k => k.origen === 'pdf_firmado'
          ? `${k.formato}: firmado (PDF subido)`
          : `${k.formato}: ${k.estado}/${k.firma_docusign}, ${k.campos_llenos} campos${k.identificacion_vence ? `, ID vence ${k.identificacion_vence}` : ''}`).join(' · ')
        : 'sin KYC en el portal';
      lines.push(`- **${p.lado}: ${p.nombre}** (${p.tipo}) · KYC ${kyc}`);
      if (p.documentos_pendientes.length) lines.push(`  - Pendientes (${p.documentos_pendientes.length}): ${p.documentos_pendientes.join(', ')}`);
    }
    const pendingProp = op.documentos_del_inmueble.filter(d => d.estado !== 'done');
    if (pendingProp.length) lines.push(`- Inmueble, pendientes: ${pendingProp.map(d => d.nombre).join(', ')}`);
    const openTasks = op.tareas.filter(t => t.estado !== 'done');
    if (openTasks.length) lines.push(`- Tareas abiertas (${openTasks.length}): ${openTasks.map(t => t.tarea + (t.asignada_a ? ` [${t.asignada_a}]` : '')).join('; ')}`);
    if (op.actividad_reciente[0]) {
      const a = op.actividad_reciente[0];
      lines.push(`- Último movimiento: ${a.fecha} · ${a.quien} · ${a.accion}${a.detalle ? ' · ' + a.detalle : ''}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

const DEFAULT_EVERY_HOURS = 168;

function everyHours() {
  const n = Number(process.env.JARVIS_SNAPSHOT_EVERY_HOURS);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_EVERY_HOURS;
}

// ¿Ya pasó el intervalo desde la última publicación buena?
function isDue(lastOkIso, hours, now = new Date()) {
  if (!lastOkIso) return true;
  const last = Date.parse(lastOkIso);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= hours * 60 * 60 * 1000;
}

let running = false;

async function publishSnapshot() {
  if (process.env.JARVIS_SNAPSHOT_DISABLED === '1') return { skipped: 'disabled' };
  if (!drive.isConfigured() || !drive.isConnected()) return { skipped: 'drive_not_connected' };
  if (running) return { skipped: 'already_running' };
  running = true;
  try {
    const snap = buildSnapshot();
    const json = Buffer.from(JSON.stringify(snap, null, 2), 'utf8');
    const md = Buffer.from(toMarkdown(snap), 'utf8');
    const folderUrl = await drive.uploadFileToRootFolder(FOLDER_NAME, JSON_NAME, json, 'application/json');
    await drive.uploadFileToRootFolder(FOLDER_NAME, MD_NAME, md, 'text/markdown');
    setSetting('jarvis_snapshot_last_ok', snap.generado_en);
    setSetting('jarvis_snapshot_last_error', '');
    return { ok: true, generado_en: snap.generado_en, operaciones: snap.totales.operaciones, carpeta: folderUrl };
  } catch (err) {
    setSetting('jarvis_snapshot_last_error', `${new Date().toISOString()} ${err.message}`.slice(0, 500));
    throw err;
  } finally {
    running = false;
  }
}

// La llama el servidor cada hora: solo publica si ya toca.
async function publishIfDue(now = new Date()) {
  if (!isDue(getSetting('jarvis_snapshot_last_ok'), everyHours(), now)) return { skipped: 'not_due' };
  return publishSnapshot();
}

function getStatus() {
  return {
    activo: process.env.JARVIS_SNAPSHOT_DISABLED !== '1',
    drive_conectado: drive.isConfigured() && drive.isConnected(),
    carpeta: FOLDER_NAME,
    cada_horas: everyHours(),
    ultimo_ok: getSetting('jarvis_snapshot_last_ok'),
    ultimo_error: getSetting('jarvis_snapshot_last_error') || null
  };
}

module.exports = { buildSnapshot, toMarkdown, publishSnapshot, publishIfDue, isDue, getStatus, kycSummary, FOLDER_NAME, JSON_NAME, MD_NAME };
