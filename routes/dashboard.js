const express = require('express');
const db = require('../db');
const { requireAuth } = require('./auth');
const { UNRESTRICTED_ROLES } = require('../lib/access');

const router = express.Router();

// "Recordatorio automático" simple: nada con más de este umbral pendiente
// se marca como que necesita atención. No hay fecha límite real en el
// producto todavía (ni tasks ni documents tienen due_date) — es un
// heurístico basado en cuánto tiempo lleva creado, no una fecha de cierre.
const STALE_DAYS = 7;

// Mismo alcance que GET /api/deals: admin ve todo; abogado interno lo que
// creó o a lo que lo asignaron; el resto solo lo suyo vía deal_parties.
// Solo operaciones activas — una ya cerrada no debe seguir apareciendo
// como pendiente de atención aquí (para eso está la sección de
// "Completadas" en Operaciones).
function visibleDealIdsSql(req) {
  if (UNRESTRICTED_ROLES.includes(req.session.role)) {
    return { sql: "SELECT id FROM deals WHERE status = 'active' AND deleted_at IS NULL", params: [] };
  }
  if (req.session.role === 'lawyer') {
    return {
      sql: `SELECT id FROM deals WHERE status = 'active' AND deleted_at IS NULL AND (
        created_by = ? OR id IN (SELECT deal_id FROM deal_parties WHERE user_id = ?)
      )`,
      params: [req.session.userId, req.session.userId]
    };
  }
  return {
    sql: "SELECT deal_id FROM deal_parties WHERE user_id = ? AND deal_id IN (SELECT id FROM deals WHERE status = 'active' AND deleted_at IS NULL)",
    params: [req.session.userId]
  };
}

// GET /api/dashboard — totales, desglose por escenario, y lista de
// documentos/tareas estancados o esperando firma.
router.get('/', requireAuth, (req, res) => {
  const { sql: dealsSql, params } = visibleDealIdsSql(req);

  const totalDeals = db.prepare(`SELECT COUNT(*) AS c FROM deals WHERE id IN (${dealsSql})`).get(...params).c;

  const dealsByScenario = db.prepare(`
    SELECT scenario, COUNT(*) AS count FROM deals WHERE id IN (${dealsSql}) GROUP BY scenario
  `).all(...params);

  const documentsPending = db.prepare(`
    SELECT COUNT(*) AS c FROM documents WHERE deal_id IN (${dealsSql}) AND status = 'pending'
  `).get(...params).c;

  const tasksPending = db.prepare(`
    SELECT COUNT(*) AS c FROM tasks WHERE deal_id IN (${dealsSql}) AND status = 'pending'
  `).get(...params).c;

  const tasksInProgress = db.prepare(`
    SELECT COUNT(*) AS c FROM tasks WHERE deal_id IN (${dealsSql}) AND status = 'progress'
  `).get(...params).c;

  // Todos los pendientes (no solo los atrasados) — el dashboard los agrupa
  // por operación para poder completarlos ahí mismo, sin abrir cada
  // operación una por una. `stale` marca los que llevan más de STALE_DAYS
  // para resaltarlos, pero ya no son la única razón para aparecer aquí.
  const pendingDocuments = db.prepare(`
    SELECT d.id AS documentId, d.name, dpe.name AS partyName, dpe.side, d.created_at, deals.id AS dealId, deals.property,
      (julianday('now') - julianday(d.created_at) > ${STALE_DAYS}) AS stale
    FROM documents d
    JOIN deals ON deals.id = d.deal_id
    LEFT JOIN deal_party_entities dpe ON dpe.id = d.deal_party_entity_id
    WHERE d.deal_id IN (${dealsSql}) AND d.status = 'pending'
    ORDER BY deals.property ASC, d.created_at ASC
  `).all(...params);

  const pendingTasks = db.prepare(`
    SELECT t.id AS taskId, t.label_es, t.label_en, t.status, t.created_at, deals.id AS dealId, deals.property,
      (julianday('now') - julianday(t.created_at) > ${STALE_DAYS}) AS stale
    FROM tasks t JOIN deals ON deals.id = t.deal_id
    WHERE t.deal_id IN (${dealsSql}) AND t.status != 'done'
    ORDER BY deals.property ASC, t.sort_order ASC
  `).all(...params);

  // Tareas del tracker asignadas A MÍ (ver tasks.assigned_to) y sin
  // terminar — el bloque "Mis tareas" arriba del Dashboard: un abogado
  // entra y ve directo qué le toca, sin abrir operación por operación.
  const myTasks = db.prepare(`
    SELECT t.id AS taskId, t.label_es, t.label_en, t.status, deals.id AS dealId, deals.property
    FROM tasks t JOIN deals ON deals.id = t.deal_id
    WHERE t.assigned_to = ? AND t.status != 'done'
      AND deals.status = 'active' AND deals.deleted_at IS NULL
    ORDER BY deals.property ASC, t.sort_order ASC
  `).all(req.session.userId);

  const signaturesAwaiting = db.prepare(`
    SELECT t.id AS taskId, t.label_es, t.label_en, t.docusign_status, deals.id AS dealId, deals.property
    FROM tasks t JOIN deals ON deals.id = t.deal_id
    WHERE t.deal_id IN (${dealsSql}) AND t.requires_signature = 1
      AND t.docusign_status IN ('sent','delivered')
  `).all(...params);

  // "Cierres próximos" — solo operaciones con fecha de cierre capturada
  // (deals.closing_date, ver PATCH /api/deals/:id), ordenadas por la más
  // próxima primero. El % combina documentos y tareas en un solo avance
  // general (no son dos indicadores separados como en el detalle de la
  // operación, aquí es un solo anillo por tarjeta).
  const upcomingClosings = db.prepare(`
    SELECT deals.id AS dealId, deals.property, deals.closing_date AS closingDate,
      CAST(julianday(deals.closing_date) - julianday('now') AS INTEGER) AS daysToClose,
      (SELECT COUNT(*) FROM documents WHERE deal_id = deals.id) AS documentsTotal,
      (SELECT COUNT(*) FROM documents WHERE deal_id = deals.id AND status = 'done') AS documentsDone,
      (SELECT COUNT(*) FROM tasks WHERE deal_id = deals.id) AS tasksTotal,
      (SELECT COUNT(*) FROM tasks WHERE deal_id = deals.id AND status = 'done') AS tasksDone
    FROM deals
    WHERE deals.id IN (${dealsSql}) AND deals.closing_date IS NOT NULL AND deals.closing_date >= date('now')
    ORDER BY deals.closing_date ASC
    LIMIT 6
  `).all(...params).map(d => {
    const total = d.documentsTotal + d.tasksTotal;
    const done = d.documentsDone + d.tasksDone;
    return {
      dealId: d.dealId, property: d.property, closingDate: d.closingDate, daysToClose: d.daysToClose,
      percent: total ? Math.round(done / total * 100) : 0
    };
  });

  res.json({
    totalDeals,
    dealsByScenario,
    documentsPending,
    tasksPending,
    tasksInProgress,
    pendingDocuments,
    pendingTasks,
    myTasks,
    signaturesAwaiting,
    upcomingClosings,
    staleDays: STALE_DAYS
  });
});

// GET /api/dashboard/notifications — alimenta la campana del navbar
// (estilo Stripe: "Acción requerida" y "Actualizaciones"). Todo se deriva
// de datos que ya existen — cero infraestructura nueva, cero estado por
// notificación: se recalcula al abrir.
router.get('/notifications', requireAuth, (req, res) => {
  const { sql: dealsSql, params } = visibleDealIdsSql(req);
  const role = req.session.role;
  const actionRequired = [];
  let updates = [];

  if (['admin', 'lawyer'].includes(role)) {
    // Tareas del tracker asignadas a mí, sin terminar.
    db.prepare(`
      SELECT 'task_assigned' AS type, t.label_es AS labelEs, t.label_en AS labelEn,
        deals.id AS dealId, deals.property, COALESCE(t.created_at, '') AS at
      FROM tasks t JOIN deals ON deals.id = t.deal_id
      WHERE t.assigned_to = ? AND t.status != 'done'
        AND deals.status = 'active' AND deals.deleted_at IS NULL
    `).all(req.session.userId).forEach(r => actionRequired.push(r));
    // Documentos ya subidos que esperan revisión (aprobar/rechazar).
    db.prepare(`
      SELECT 'doc_review' AS type, d.name AS labelEs, d.name AS labelEn, dpe.name AS partyName,
        deals.id AS dealId, deals.property, COALESCE(d.uploaded_at, '') AS at
      FROM documents d JOIN deals ON deals.id = d.deal_id
      LEFT JOIN deal_party_entities dpe ON dpe.id = d.deal_party_entity_id
      WHERE d.deal_id IN (${dealsSql}) AND d.file_url IS NOT NULL AND d.review_status = 'pending'
      ORDER BY d.uploaded_at DESC LIMIT 30
    `).all(...params).forEach(r => actionRequired.push(r));
  }

  if (['buyer', 'seller'].includes(role)) {
    // Mis documentos por subir (de la parte ligada a mi cuenta).
    db.prepare(`
      SELECT 'doc_upload' AS type, d.name AS labelEs, d.name AS labelEn,
        deals.id AS dealId, deals.property, COALESCE(d.created_at, '') AS at
      FROM documents d
      JOIN deal_parties dp ON dp.deal_party_entity_id = d.deal_party_entity_id
      JOIN deals ON deals.id = d.deal_id
      WHERE dp.user_id = ? AND d.status = 'pending' AND d.file_url IS NULL
        AND deals.status = 'active' AND deals.deleted_at IS NULL
      LIMIT 30
    `).all(req.session.userId).forEach(r => actionRequired.push(r));
    // Firmas que ya me llegaron por DocuSign y siguen abiertas.
    db.prepare(`
      SELECT 'sign_pending' AS type, t.label_es AS labelEs, t.label_en AS labelEn,
        deals.id AS dealId, deals.property, COALESCE(t.created_at, '') AS at
      FROM tasks t JOIN deals ON deals.id = t.deal_id
      WHERE t.deal_id IN (SELECT deal_id FROM deal_parties WHERE user_id = ?)
        AND t.requires_signature = 1 AND t.docusign_status IN ('sent','delivered')
        AND deals.status = 'active' AND deals.deleted_at IS NULL
    `).all(req.session.userId).forEach(r => actionRequired.push(r));
    // Actualizaciones para el cliente: sus documentos revisados hace poco.
    updates = db.prepare(`
      SELECT 'doc_reviewed' AS type, d.name AS labelEs, d.name AS labelEn, d.review_status AS reviewStatus,
        deals.id AS dealId, deals.property, COALESCE(d.reviewed_at, '') AS at
      FROM documents d
      JOIN deal_parties dp ON dp.deal_party_entity_id = d.deal_party_entity_id
      JOIN deals ON deals.id = d.deal_id
      WHERE dp.user_id = ? AND d.review_status IN ('approved','rejected')
        AND d.reviewed_at > datetime('now', '-14 days')
      ORDER BY d.reviewed_at DESC LIMIT 20
    `).all(req.session.userId);
  } else {
    // Staff y facilitadores: la línea de tiempo reciente de sus operaciones.
    updates = db.prepare(`
      SELECT 'activity' AS type, a.action, a.detail, u.name AS userName,
        deals.id AS dealId, deals.property, a.created_at AS at
      FROM deal_activity a
      JOIN deals ON deals.id = a.deal_id
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.deal_id IN (${dealsSql}) AND a.created_at > datetime('now', '-14 days')
      ORDER BY a.id DESC LIMIT 20
    `).all(...params);
  }

  actionRequired.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  res.json({ actionRequired, updates });
});

module.exports = router;
