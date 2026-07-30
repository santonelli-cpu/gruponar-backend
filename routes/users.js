const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const db = require('../db');
const { requireRole, resolveAgency, KNOWN_AGENCIES } = require('./auth');

const router = express.Router();

function tempPassword(){
  return crypto.randomBytes(6).toString('base64url'); // ej: "aB3xQ9"
}

// POST /api/users — solo admin crea cuentas de equipo (agente, abogado, otro
// admin) o cuentas de cliente directas. Restringido a admin (antes cualquier
// agente podía crear una cuenta con role:'admin' — escalamiento de
// privilegios); el alta normal de comprador/vendedor es por invitación
// (routes/invites.js), esto queda para el roster interno.
// Devuelve una contraseña temporal para compartir por un canal seguro
// (no por el mismo correo que usarías para mandar el link, idealmente).
router.post('/', requireRole('admin'), (req, res) => {
  const { name, email, role } = req.body || {};
  if (!name || !email || !['admin', 'agent', 'lawyer', 'buyer', 'seller'].includes(role)) {
    return res.status(400).json({ error: 'Datos inválidos.' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (existing) return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });

  const password = tempPassword();
  const hash = bcrypt.hashSync(password, 12);
  const info = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)')
    .run(name, email.toLowerCase().trim(), hash, role);

  // TODO (Claude Code): en vez de regresar la contraseña en la respuesta,
  // lo correcto en producción es mandarla por correo (con un servicio como
  // Resend/SendGrid) o generar un link de "crea tu contraseña" de un solo uso.
  res.status(201).json({ id: info.lastInsertRowid, name, email, role, temporaryPassword: password });
});

router.get('/', requireRole('admin'), (req, res) => {
  const users = db.prepare('SELECT id, name, email, role, status, agency, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

// PATCH /api/users/:id/approve — activa una cuenta autoregistrada
// (routes/auth.js POST /register la crea en status='pending').
router.patch('/:id/approve', requireRole('admin'), (req, res) => {
  const info = db.prepare("UPDATE users SET status = 'active' WHERE id = ? AND status = 'pending'").run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'No hay una cuenta pendiente con ese id.' });
  res.json({ ok: true });
});

// PATCH /api/users/:id/agency — la agencia normalmente la elige el agente al
// registrarse/aceptar su invitación, pero no había forma de corregirla
// después (ej. si se equivocó, cambió de agencia, o quedó en NULL porque se
// dio de alta directo con POST /api/users de arriba). Reusa el mismo
// catálogo/lógica de "Otro" que el registro, para no tener dos fuentes de
// verdad de qué cuenta como agencia conocida — importa que quede bien
// puesta porque de esto depende que el KYC de LPR salga automático
// (routes/kyc.js dealAgentIsLprAgency).
router.patch('/:id/agency', requireRole('admin'), (req, res) => {
  const user = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'agent'").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'No hay un agente con ese id.' });
  const { agency, agencyOther } = req.body || {};
  const resolved = resolveAgency(agency, agencyOther);
  if (!resolved) return res.status(400).json({ error: 'Elige una agencia (o escribe cuál si no está en la lista).' });
  db.prepare('UPDATE users SET agency = ? WHERE id = ?').run(resolved, req.params.id);
  res.json({ ok: true, agency: resolved });
});

router.get('/known-agencies', requireRole('admin'), (req, res) => {
  res.json(KNOWN_AGENCIES);
});

module.exports = router;
