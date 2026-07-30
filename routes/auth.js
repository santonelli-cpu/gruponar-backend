const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { authenticator } = require('otplib');
const qrcode = require('qrcode');
const db = require('../db');
const { createRateLimiter } = require('../lib/rateLimit');
const mailer = require('../lib/email');

const router = express.Router();

const rateLimitRegister = createRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 10 });
const rateLimitForgotPassword = createRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 10 });
// Sin esto, /login no tenía ningún límite — alguien podía probar
// contraseñas sin parar contra cualquier correo conocido. Por IP, no por
// cuenta, igual que los otros rateLimit* de este archivo: más simple y no
// depende de si el correo existe o no.
const rateLimitLogin = createRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 10 });
// Un código TOTP son 6 dígitos (1,000,000 combinaciones) válidos 30s — sin
// límite, alguien que ya se robó la contraseña podría automatizar probarlos
// todos en minutos. Más estricto que los de arriba a propósito.
const rateLimitTotp = createRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 8 });
const PASSWORD_RESET_TTL_HOURS = 1;

// Agencias con las que trabaja Grupo Nar — un agente que no es de ninguna de
// estas elige "Otro" y escribe la suya. Solo aplica a role='agent' (un
// abogado/empleado interno no tiene agencia). Ver también APOSTILLE... no,
// ver public/index.html (mismo listado, duplicado a propósito: no hay un
// endpoint público de "catálogos" en esta app todavía).
const KNOWN_AGENCIES = ['LPR Luxury', 'Applegate Realtors', 'JPM Real Estate', 'Interamerican'];

function resolveAgency(agency, agencyOther) {
  if (agency === 'Otro') {
    const other = (agencyOther || '').trim();
    return other || null;
  }
  return KNOWN_AGENCIES.includes(agency) ? agency : null;
}

function logAccess(userId, action, req) {
  db.prepare('INSERT INTO access_log (user_id, action, ip) VALUES (?, ?, ?)')
    .run(userId, action, req.ip);
}

// POST /api/auth/register — agente/abogado se autoregistran. Queda en
// status='pending' hasta que un admin lo apruebe (PATCH /api/users/:id/approve)
// — 'lawyer' ve TODAS las operaciones sin restricción, así que no puede
// entrar de inmediato sin que alguien lo revise primero.
router.post('/register', rateLimitRegister, (req, res) => {
  const { name, email, password, role, agency, agencyOther } = req.body || {};
  if (!name || !email || !password || !['agent', 'lawyer', 'external_lawyer'].includes(role)) {
    return res.status(400).json({ error: 'Datos inválidos.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
  }
  let resolvedAgency = null;
  if (role === 'agent') {
    resolvedAgency = resolveAgency(agency, agencyOther);
    if (!resolvedAgency) return res.status(400).json({ error: 'Elige tu agencia (o escribe cuál si no está en la lista).' });
  }
  const normalizedEmail = email.toLowerCase().trim();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });

  const hash = bcrypt.hashSync(password, 12);
  db.prepare("INSERT INTO users (name, email, password_hash, role, status, agency) VALUES (?,?,?,?,'pending',?)")
    .run(name, normalizedEmail, hash, role, resolvedAgency);

  res.status(201).json({ ok: true, message: 'Cuenta creada. Un administrador debe aprobarla antes de que puedas iniciar sesión.' });

  // Best-effort — un correo que falla no debe tumbar el registro, que ya
  // quedó guardado. Se manda a TODOS los admins activos, no a uno fijo.
  if (mailer.isConfigured()) {
    const admins = db.prepare("SELECT email FROM users WHERE role = 'admin' AND status = 'active'").all();
    const url = `${req.protocol}://${req.get('host')}/`;
    admins.forEach(a => {
      mailer.sendPendingApprovalEmail({
        to: a.email, applicantName: name, applicantEmail: normalizedEmail,
        applicantRole: role, applicantAgency: resolvedAgency, url
      });
    });
  }
});

// Deja pendingUserId listo en la sesión y responde el reto de 2FA que le
// toca a esta cuenta — nunca abre sesión de una vez. La usan tanto /login
// como POST /invites/:token/accept (routes/invites.js): cualquier forma de
// "quedar identificado" en esta app pasa por aquí antes de tener sesión de
// verdad, no solo el login normal con correo/contraseña.
function beginTotpChallenge(req, res, user) {
  req.session.pendingUserId = user.id;
  delete req.session.userId;

  if (user.totp_enabled && user.totp_secret) {
    logAccess(user.id, 'login_password_ok_awaiting_totp', req);
    return res.json({ twoFactor: true, setup: false });
  }

  // Primera vez (cuenta recién creada, o se le reseteó el 2FA) — nuevo
  // secreto, sin activar todavía hasta que confirme un código real en
  // POST /totp.
  const secret = authenticator.generateSecret();
  db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret, user.id);
  const otpauth = authenticator.keyuri(user.email, 'Grupo Nar', secret);
  qrcode.toDataURL(otpauth, (err, qrDataUrl) => {
    if (err) return res.status(500).json({ error: 'No se pudo generar el código QR.' });
    logAccess(user.id, 'login_password_ok_awaiting_totp_setup', req);
    res.json({ twoFactor: true, setup: true, qrCode: qrDataUrl, secret });
  });
}

// POST /api/auth/login  { email, password } — segundo paso obligatorio con
// TOTP para TODOS los roles (ver POST /totp abajo). Una contraseña correcta
// nunca abre sesión por sí sola: solo deja a req.session.pendingUserId
// listo para que /totp la confirme.
router.post('/login', rateLimitLogin, (req, res) => {
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

  beginTotpChallenge(req, res, user);
});

// POST /api/auth/totp  { code } — segundo paso del login de arriba. Requiere
// haber pasado ya la contraseña (pendingUserId en la sesión); confirma el
// código de 6 dígitos contra el secreto guardado y recién ahí abre la
// sesión de verdad. Si la cuenta seguía sin 2FA activado, este es el
// momento en que queda activado para siempre (ya demostró que sí escaneó
// el QR y tiene la app configurada).
router.post('/totp', rateLimitTotp, (req, res) => {
  const pendingUserId = req.session.pendingUserId;
  if (!pendingUserId) return res.status(401).json({ error: 'Tu sesión de login expiró, entra tu correo y contraseña de nuevo.' });
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Falta el código.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(pendingUserId);
  if (!user || !user.totp_secret) return res.status(401).json({ error: 'Tu sesión de login expiró, entra tu correo y contraseña de nuevo.' });

  let valid = false;
  try { valid = authenticator.check(String(code).trim(), user.totp_secret); } catch (e) { valid = false; }
  if (!valid) {
    logAccess(user.id, 'totp_failed', req);
    return res.status(401).json({ error: 'Código incorrecto. Revisa la hora de tu teléfono e intenta de nuevo.' });
  }

  if (!user.totp_enabled) {
    db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(user.id);
  }
  delete req.session.pendingUserId;
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
  const user = db.prepare('SELECT id, name, email, role, agency FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'No autenticado.' });
  res.json(user);
});

// POST /api/auth/forgot-password { email } — siempre responde genérico
// (nunca revela si el correo existe o no, para no filtrar quién tiene
// cuenta) — si existe y está activa, manda el correo con el link de un
// solo uso vía Resend.
router.post('/forgot-password', rateLimitForgotPassword, async (req, res) => {
  const { email } = req.body || {};
  const generic = { ok: true, message: 'Si ese correo tiene una cuenta, te mandamos un link para restablecer tu contraseña.' };
  if (!email) return res.json(generic);

  const user = db.prepare("SELECT * FROM users WHERE email = ? AND status = 'active'").get(email.toLowerCase().trim());
  if (!user) return res.json(generic);
  if (!mailer.isConfigured()) return res.json(generic);

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_HOURS * 3600000).toISOString();
  db.prepare('INSERT INTO password_resets (token, user_id, expires_at) VALUES (?,?,?)').run(token, user.id, expiresAt);

  const url = `${req.protocol}://${req.get('host')}/reset-password.html?token=${token}`;
  await mailer.sendPasswordResetEmail({ to: user.email, name: user.name, url });
  res.json(generic);
});

// GET /api/auth/reset-password/:token — público, solo valida que el token
// sirva todavía (para que la página muestre el formulario o un error).
router.get('/reset-password/:token', (req, res) => {
  const reset = db.prepare('SELECT * FROM password_resets WHERE token = ?').get(req.params.token);
  if (!reset) return res.status(404).json({ error: 'Este link no es válido.', code: 'invalid' });
  if (reset.used_at) return res.status(410).json({ error: 'Este link ya fue usado.', code: 'used' });
  if (new Date(reset.expires_at) < new Date()) return res.status(410).json({ error: 'Este link expiró — pide uno nuevo.', code: 'expired' });
  res.json({ ok: true });
});

// POST /api/auth/reset-password/:token { password }
router.post('/reset-password/:token', (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
  }
  const reset = db.prepare('SELECT * FROM password_resets WHERE token = ?').get(req.params.token);
  if (!reset) return res.status(404).json({ error: 'Este link no es válido.', code: 'invalid' });
  if (reset.used_at) return res.status(410).json({ error: 'Este link ya fue usado.', code: 'used' });
  if (new Date(reset.expires_at) < new Date()) return res.status(410).json({ error: 'Este link expiró — pide uno nuevo.', code: 'expired' });

  const hash = bcrypt.hashSync(password, 12);
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, reset.user_id);
    db.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE id = ?").run(reset.id);
  })();
  logAccess(reset.user_id, 'password_reset', req);
  res.json({ ok: true });
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

module.exports = { router, requireAuth, requireRole, resolveAgency, KNOWN_AGENCIES, beginTotpChallenge };
