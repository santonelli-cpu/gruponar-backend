const express = require('express');
const { requireRole } = require('./auth');
const { rateLimitExpensive } = require('../lib/apiRateLimits');
const snapshot = require('../lib/jarvisSnapshot');

// /api/admin/jarvis — reporte de solo lectura para Jarvis (lib/jarvisSnapshot.js).
// Solo admin.
const router = express.Router();
router.use(requireRole('admin'));

// GET /api/admin/jarvis/status — si está activo, si Drive está conectado,
// última publicación y último error.
router.get('/status', (req, res) => {
  res.json(snapshot.getStatus());
});

// GET /api/admin/jarvis/preview — el mismo JSON que se publica, para revisar
// exactamente qué ve Jarvis.
router.get('/preview', rateLimitExpensive, (req, res) => {
  res.json(snapshot.buildSnapshot());
});

// POST /api/admin/jarvis/publish — publica ya en Drive, sin esperar a que
// toque la publicación semanal.
router.post('/publish', rateLimitExpensive, async (req, res) => {
  try {
    const result = await snapshot.publishSnapshot();
    if (result.skipped) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: `No se pudo publicar en Drive: ${err.message}` });
  }
});

module.exports = router;
