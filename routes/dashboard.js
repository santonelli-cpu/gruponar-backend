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

// Mismo alcance que GET /api/deals: admin/abogado ven todo; el resto solo
// lo suyo vía deal_parties.
function visibleDealIdsSql(req) {
  if (UNRESTRICTED_ROLES.includes(req.session.role)) {
    return { sql: 'SELECT id FROM deals', params: [] };
  }
  return { sql: 'SELECT deal_id FROM deal_parties WHERE user_id = ?', params: [req.session.userId] };
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
    SELECT d.id AS documentId, d.name, d.owner, d.created_at, deals.id AS dealId, deals.property,
      (julianday('now') - julianday(d.created_at) > ${STALE_DAYS}) AS stale
    FROM documents d JOIN deals ON deals.id = d.deal_id
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

  const signaturesAwaiting = db.prepare(`
    SELECT t.id AS taskId, t.label_es, t.label_en, t.docusign_status, deals.id AS dealId, deals.property
    FROM tasks t JOIN deals ON deals.id = t.deal_id
    WHERE t.deal_id IN (${dealsSql}) AND t.requires_signature = 1
      AND t.docusign_status IN ('sent','delivered')
  `).all(...params);

  res.json({
    totalDeals,
    dealsByScenario,
    documentsPending,
    tasksPending,
    tasksInProgress,
    pendingDocuments,
    pendingTasks,
    signaturesAwaiting,
    staleDays: STALE_DAYS
  });
});

module.exports = router;
