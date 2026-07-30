const express = require('express');
const db = require('../db');
const { requireRole } = require('./auth');

const router = express.Router();

// Configuración simple de la firma, sin ligarla a una operación específica
// (a diferencia de casi todo lo demás en este backend). Por ahora solo hay
// una: la nota de a qué cuenta se transfieren los costos de cierre del
// notario — es SIEMPRE la misma cuenta sin importar la operación, así que
// no tiene sentido volver a escribirla en cada deal. Queda como texto libre
// en vez de campos estructurados (banco/CLABE/beneficiario) porque el
// formato exacto que el notario pide varía y no vale la pena una tabla para
// un solo dato de referencia.
const NOTARY_PAYMENT_NOTE_KEY = 'notary_payment_note';

router.get('/notary-payment-note', requireRole('admin', 'agent', 'lawyer', 'external_lawyer'), (req, res) => {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(NOTARY_PAYMENT_NOTE_KEY);
  res.json({ note: row ? row.value : '' });
});

router.put('/notary-payment-note', requireRole('admin'), (req, res) => {
  const { note } = req.body || {};
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(NOTARY_PAYMENT_NOTE_KEY, note || '');
  res.json({ ok: true });
});

module.exports = router;
