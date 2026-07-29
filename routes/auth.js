const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const { createRateLimiter } = require('../lib/rateLimit');

const router = express.Router();

const rateLimitRegister = createRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 10 });

function logAccess(userId, action, req) {
  db.prepare('INSERT INTO access_log (user_id, action, ip) VALUES (?, ?, ?)')
    .run(userId, action, req.ip);
}

// POST /api/auth/register — agente/abogado se autoregistran. Queda en
// status='pending' hasta que un admin lo apruebe (PATCH /api/users/:id/approve)
// — 'lawyer' ve TODAS las operaciones sin restricción, así que no puede
// entrar de inmediato sin que alguien lo revise primero.
router.post('/register', rateLimitRegister, (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password || !['agent', 'lawyer'].includes(role)) {
    return res.status(400).json({ error: 'Datos inválidos.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
  }
  const normalizedEmail = email.toLowerCase().trim();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });

  const hash = bcrypt.hashSync(password, 12);
  db.prepare("INSERT INTO users (name, email, password_hash, role, status) VALUES (?,?,?,?,'pending')")
    .run(name, normalizedEmail, hash, role);

  res.status(201).json({ ok: true, message: 'Cuenta creada. Un administrador debe aprobarla antes de que puedas iniciar sesión.' });
});

// POST /api/auth/login  { email, password }
router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Falta correo o contraseña.' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user) return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) {
    logAccess(user.id, 'login_failed', req);
    return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  }
  if (user.status !== 'active') {
    logAccess(user.id, 'login_blocked_pending', req);
    return res.status(403).json({ error: 'Tu cuenta está pendiente de aprobación por un administrador.' });
  }

  req.session.userId = user.id;
  req.session.role = user.role;
  logAccess(user.id, 'login_success', req);

  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

router.post('/logout', (req, res) => {
  const userId = req.session.userId;
  if (userId) logAccess(userId, 'logout', req);
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado.' });
  const user = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'No autenticado.' });
  res.json(user);
});

// Middleware para proteger rutas
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado.' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'No autenticado.' });
    if (!roles.includes(req.session.role)) return res.status(403).json({ error: 'No autorizado.' });
    next();
  };
}

module.exports = { router, requireAuth, requireRole };
