const express = require('express');
const { requireRole } = require('./auth');
const driveClient = require('../lib/googleDriveClient');
const { rateLimitWrite } = require('../lib/apiRateLimits');

const router = express.Router();

// GET /api/google-drive/status
router.get('/status', requireRole('admin'), (req, res) => {
  res.json({ configured: driveClient.isConfigured(), connected: driveClient.isConnected() });
});

// GET /api/google-drive/connect — redirige a la pantalla de consentimiento
// de Google. No es una llamada fetch normal: el frontend navega el
// navegador entero a esta URL (window.location.href), porque Google no
// permite que el flujo de consentimiento corra dentro de un fetch/XHR.
router.get('/connect', requireRole('admin'), (req, res) => {
  if (!driveClient.isConfigured()) {
    return res.status(501).send('Google Drive no está configurado todavía (faltan GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET).');
  }
  res.redirect(driveClient.getAuthUrl(req));
});

// GET /api/google-drive/oauth/callback — a donde Google redirige después
// del consentimiento. Guarda el refresh token y regresa al admin.
router.get('/oauth/callback', requireRole('admin'), async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?driveConnect=error');
  try {
    await driveClient.exchangeCodeForTokens(req, code);
    res.redirect('/?driveConnect=ok');
  } catch (err) {
    res.redirect('/?driveConnect=error');
  }
});

// POST /api/google-drive/disconnect
router.post('/disconnect', requireRole('admin'), rateLimitWrite, (req, res) => {
  driveClient.disconnect();
  res.json({ ok: true });
});

module.exports = router;
