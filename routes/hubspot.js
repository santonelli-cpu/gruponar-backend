const express = require('express');
const { requireRole } = require('./auth');
const { rateLimitExpensive } = require('../lib/apiRateLimits');
const hubspot = require('../lib/hubspot');

// /api/admin/hubspot — estado y sync completo manual de la integración
// portal → HubSpot (lib/hubspot.js). Solo admin.
const router = express.Router();
router.use(requireRole('admin'));

// GET /api/admin/hubspot/status — si hay token, cola, último sync completo
// y los últimos 20 resultados por operación.
router.get('/status', (req, res) => {
  res.json(hubspot.getStatus());
});

// POST /api/admin/hubspot/sync — manda todas las operaciones (no borradas)
// a HubSpot en segundo plano. Responde de inmediato; el avance se ve en
// /status.
router.post('/sync', rateLimitExpensive, (req, res) => {
  if (!hubspot.isConfigured()) {
    return res.status(409).json({ error: 'HubSpot no está configurado (falta la variable HUBSPOT_TOKEN en el servidor).' });
  }
  if (!hubspot.startFullSync()) {
    return res.status(409).json({ error: 'Ya hay una sincronización completa en curso.' });
  }
  res.status(202).json({ started: true });
});

module.exports = router;
