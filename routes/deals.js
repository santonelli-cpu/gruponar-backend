const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const { requireAuth, requireRole } = require('./auth');
const { UPLOADS_ROOT, dealDir, genFilename } = require('../lib/storage');
const { canAccessDeal, myRoleInDeal, UNRESTRICTED_ROLES } = require('../lib/access');

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
// (Mismo contenido que ya definiste en el frontend — vive aquí también
// para que el servidor pueda generar el checklist al crear una operación,
// sin depender de que el navegador lo mande completo.)
const SCENARIO_DOCS = require('../data/scenario-docs.json');
const SCENARIO_TASKS = require('../data/scenario-tasks.json');

function buildDocsForDeal(scenario, sellerType, buyerType) {
  const s = SCENARIO_DOCS[scenario];
  let sellerDocs = [...s.seller_individual];
  if (sellerType === 'corporation') sellerDocs = sellerDocs.concat(s.corporation_extra, s.legal_rep);
  if (sellerType === 'llc') sellerDocs = sellerDocs.concat(s.llc_entity, s.llc_members, s.llc_manager);
  let buyerDocs = [...s.buyer_individual];
  if (buyerType === 'corporation') buyerDocs = buyerDocs.concat(s.corporation_extra, s.legal_rep);
  if (buyerType === 'llc') buyerDocs = buyerDocs.concat(s.llc_entity, s.llc_members, s.llc_manager);
  return { seller: sellerDocs, buyer: buyerDocs };
}

// Subqueries de conteo para poder mostrar % de avance en la lista sin tener
// que pedir el detalle completo (documentos+tareas) de cada operación.
const COUNTS_SQL = `,
  (SELECT COUNT(*) FROM documents WHERE deal_id = d.id) AS documents_total,
  (SELECT COUNT(*) FROM documents WHERE deal_id = d.id AND status = 'done') AS documents_done,
  (SELECT COUNT(*) FROM tasks WHERE deal_id = d.id) AS tasks_total,
  (SELECT COUNT(*) FROM tasks WHERE deal_id = d.id AND status = 'done') AS tasks_done
`;

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
  res.json(rows);
});

// POST /api/deals — admin/agente/abogado crean operaciones.
router.post('/', requireRole('admin', 'agent', 'lawyer'), (req, res) => {
  const { scenario, development, property, price, furniturePrice, currency, startDate, seller, buyer, escrowCompany } = req.body || {};
  if (!scenario || !property || !seller?.name || !buyer?.name) {
    return res.status(400).json({ error: 'Faltan campos requeridos.' });
  }
  if (escrowCompany && !['armour', 'tla'].includes(escrowCompany)) {
    return res.status(400).json({ error: 'Escrow company inválida.' });
  }

  const info = db.prepare(`
    INSERT INTO deals (scenario, development, property, price, furniture_price, currency, start_date, seller_name, seller_type, buyer_name, buyer_type, escrow_company, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(scenario, development || 'punta_mita', property, price || 0, furniturePrice || 0,
         currency || 'USD', startDate, seller.name, seller.type, buyer.name, buyer.type, escrowCompany || null, req.session.userId);

  const dealId = info.lastInsertRowid;

  const docs = buildDocsForDeal(scenario, seller.type, buyer.type);
  const insertDoc = db.prepare("INSERT INTO documents (deal_id, owner, name, created_at) VALUES (?,?,?,datetime('now'))");
  docs.seller.forEach(name => insertDoc.run(dealId, 'seller', name));
  docs.buyer.forEach(name => insertDoc.run(dealId, 'buyer', name));

  const tasks = SCENARIO_TASKS[scenario];
  const insertTask = db.prepare("INSERT INTO tasks (deal_id, label_en, label_es, requires_signature, sort_order, created_at) VALUES (?,?,?,?,?,datetime('now'))");
  tasks.forEach((t, i) => insertTask.run(dealId, t.en, t.es, t.sign ? 1 : 0, i));

  // Un agente ya no ve todas las operaciones (solo admin/lawyer) — se liga
  // automáticamente a la que acaba de crear, si no perdería de vista su
  // propio trabajo.
  if (req.session.role === 'agent') {
    db.prepare('INSERT OR IGNORE INTO deal_parties (deal_id, user_id, role_in_deal) VALUES (?,?,?)')
      .run(dealId, req.session.userId, 'agent');
  }

  res.status(201).json({ id: dealId });
});

// GET /api/deals/:id — detalle completo con docs y tareas.
router.get('/:id', requireAuth, (req, res) => {
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });

  if (!canAccessDeal(req, deal.id)) {
    return res.status(403).json({ error: 'No autorizado para ver esta operación.' });
  }

  const documents = db.prepare('SELECT * FROM documents WHERE deal_id = ?').all(deal.id);
  const tasks = db.prepare('SELECT * FROM tasks WHERE deal_id = ? ORDER BY sort_order').all(deal.id);
  res.json({ ...deal, documents, tasks });
});

// PATCH /api/deals/:id/documents/:docId — marcar documento recibido.
router.patch('/:id/documents/:docId', requireAuth, (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const { status } = req.body || {};
  if (!['pending', 'done'].includes(status)) return res.status(400).json({ error: 'Status inválido.' });
  db.prepare('UPDATE documents SET status = ?, uploaded_by = ?, uploaded_at = datetime(\'now\') WHERE id = ? AND deal_id = ?')
    .run(status, req.session.userId, req.params.docId, req.params.id);
  res.json({ ok: true });
});

// POST /api/deals/:id/documents/:docId/file — subir el archivo de un documento del checklist.
router.post('/:id/documents/:docId/file', requireAuth, (req, res, next) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND deal_id = ?').get(req.params.docId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'Documento no encontrado.' });
  // Comprador/vendedor solo puede subir documentos de su propio lado del
  // checklist (no el de la contraparte); admin/agente sin restricción.
  const role = myRoleInDeal(req, req.params.id);
  if (!['admin', 'agent', 'lawyer'].includes(role) && role !== doc.owner) {
    return res.status(403).json({ error: 'No puedes subir documentos de la otra parte.' });
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
  if (!['admin', 'agent', 'lawyer'].includes(role) && role !== doc.owner) {
    return res.status(403).json({ error: 'No puedes ver documentos de la otra parte.' });
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
// Los documentos/tareas/deal_parties se borran en cascada
// (foreign_keys=ON en db/index.js); los archivos subidos no viven en la
// base de datos, hay que borrarlos aparte.
router.delete('/:id', requireRole('admin', 'agent', 'lawyer'), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const info = db.prepare('DELETE FROM deals WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Operación no encontrada.' });
  fs.rm(path.join(UPLOADS_ROOT, String(req.params.id)), { recursive: true, force: true }, () => {});
  res.json({ ok: true });
});

// POST /api/deals/:id/parties — ligar un usuario (comprador/vendedor/agente) a la operación.
router.post('/:id/parties', requireRole('admin', 'agent', 'lawyer'), (req, res) => {
  if (!canAccessDeal(req, req.params.id)) return res.status(403).json({ error: 'No autorizado.' });
  const { userId, roleInDeal } = req.body || {};
  if (!userId || !['buyer', 'seller', 'agent'].includes(roleInDeal)) {
    return res.status(400).json({ error: 'Datos inválidos.' });
  }
  db.prepare('INSERT OR IGNORE INTO deal_parties (deal_id, user_id, role_in_deal) VALUES (?,?,?)')
    .run(req.params.id, userId, roleInDeal);
  res.json({ ok: true });
});

module.exports = router;
