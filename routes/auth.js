const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { authenticator } = require('otplib');
const qrcode = require('qrcode');
const db = require('../db');
const { createRateLimiter } = require('../lib/rateLimit');
const { validateBody, z } = require('../lib/validateBody');
const { getClientIp } = require('../lib/clientIp');
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
// Mandar códigos por correo sin límite sería spamear la bandeja de alguien
// (o, si alguien más conoce el correo, molestarlo) cada vez que le den a
// "reenviar" — más laxo que rateLimitTotp porque esto no es adivinar nada.
const rateLimitEmailOtp = createRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 5 });
const PASSWORD_RESET_TTL_HOURS = 1;
// "Recuérdame en este dispositivo" (ver /totp {remember:true}) — cuánto
// dura sin volver a pedir 2FA en el mismo navegador. Se anula por completo
// si un admin resetea el 2FA de la cuenta (routes/users.js).
const REMEMBER_DEVICE_COOKIE = 'nar_remember';
const REMEMBER_DEVICE_TTL_DAYS = 30;

const EMAIL_MSG = 'Ese correo no tiene un formato válido.';
// bcrypt solo usa los primeros 72 bytes de la contraseña — sin el tope
// máximo, una contraseña más larga se recorta en silencio (queda "menos
// segura" de lo que la persona cree) y cualquiera podría mandar un string
// enorme solo para hacer trabajar de más al servidor al hashearlo.
const PASSWORD_MSG_MIN = 'La contraseña debe tener al menos 8 caracteres.';
const PASSWORD_MSG_MAX = 'La contraseña no puede tener más de 72 caracteres.';
const emailField = () => z.string().trim().toLowerCase().max(254).email(EMAIL_MSG);
const newPasswordField = () => z.string().min(8, PASSWORD_MSG_MIN).max(72, PASSWORD_MSG_MAX);

const registerSchema = z.object({
  name: z.string().trim().min(1, 'Escribe tu nombre.').max(200, 'El nombre es demasiado largo.'),
  email: emailField(),
  password: newPasswordField(),
  role: z.enum(['agent', 'lawyer', 'external_lawyer']),
  agency: z.string().trim().max(200).optional(),
  agencyOther: z.string().trim().max(200).optional()
}).strict();

const loginSchema = z.object({
  email: emailField(),
  password: z.string().min(1, 'Falta la contraseña.').max(72),
  lang: z.enum(['es', 'en']).optional()
}).strict();

const emailOtpSchema = z.object({
  lang: z.enum(['es', 'en']).optional()
}).strict();

const totpSchema = z.object({
  code: z.string().trim().min(1, 'Falta el código.').max(20),
  method: z.enum(['totp', 'email']).optional(),
  remember: z.boolean().optional()
}).strict();

// Sin .email() a propósito: este endpoint responde el mismo mensaje
// genérico sin importar si el correo existe, está mal escrito o viene
// vacío (para no filtrar qué correos tienen cuenta) — solo se valida tipo
// y largo, el "¿tiene forma de correo?" lo resuelve solo el SELECT de abajo
// (uno mal formado simplemente no hace match con ningún usuario).
const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).optional()
}).strict();

const resetPasswordSchema = z.object({
  password: newPasswordField()
}).strict();

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
    .run(userId, action, getClientIp(req));
}

// POST /api/auth/register — agente/abogado se autoregistran. Queda en
// status='pending' hasta que un admin lo apruebe (PATCH /api/users/:id/approve)
// — 'lawyer' ve TODAS las operaciones sin restricción, así que no puede
// entrar de inmediato sin que alguien lo revise primero.
router.post('/register', rateLimitRegister, validateBody(registerSchema), (req, res) => {
  const { name, email, password, role, agency, agencyOther } = req.body;
  let resolvedAgency = null;
  if (role === 'agent') {
    resolvedAgency = resolveAgency(agency, agencyOther);
    if (!resolvedAgency) return res.status(400).json({ error: 'Elige tu agencia (o escribe cuál si no está en la lista).' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });

  const hash = bcrypt.hashSync(password, 12);
  db.prepare("INSERT INTO users (name, email, password_hash, role, status, agency) VALUES (?,?,?,?,'pending',?)")
    .run(name, email, hash, role, resolvedAgency);

  res.status(201).json({ ok: true, message: 'Cuenta creada. Un administrador debe aprobarla antes de que puedas iniciar sesión.' });

  // Best-effort — un correo que falla no debe tumbar el registro, que ya
  // quedó guardado. Se manda a TODOS los admins activos, no a uno fijo.
  if (mailer.isConfigured()) {
    const admins = db.prepare("SELECT email FROM users WHERE role = 'admin' AND status = 'active'").all();
    const url = `${req.protocol}://${req.get('host')}/`;
    admins.forEach(a => {
      mailer.sendPendingApprovalEmail({
        to: a.email, applicantName: name, applicantEmail: email,
        applicantRole: role, applicantAgency: resolvedAgency, url
      });
    });
  }
});

// --- Segundo factor: helpers compartidos ---

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Lee una cookie suelta del header Cookie sin depender de cookie-parser —
// es la única que hace falta leer (nar_remember), no vale la pena la
// dependencia completa por un solo valor.
function readRawCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (decodeURIComponent(part.slice(0, idx).trim()) === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

// true si este navegador ya tiene un dispositivo recordado válido para esta
// cuenta — de ser así, /login se salta el 2FA por completo (nunca la
// contraseña, esto solo se consulta DESPUÉS de que la contraseña ya validó).
function checkRememberedDevice(req, user) {
  const raw = readRawCookie(req, REMEMBER_DEVICE_COOKIE);
  if (!raw) return false;
  const dot = raw.indexOf('.');
  if (dot === -1) return false;
  const uid = Number(raw.slice(0, dot));
  const token = raw.slice(dot + 1);
  if (uid !== user.id || !token) return false;
  const row = db.prepare('SELECT * FROM remembered_devices WHERE user_id = ? AND token_hash = ?').get(user.id, hashToken(token));
  if (!row || new Date(row.expires_at) < new Date()) return false;
  db.prepare("UPDATE remembered_devices SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  return true;
}

function setRememberDeviceCookie(req, res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + REMEMBER_DEVICE_TTL_DAYS * 86400000);
  db.prepare('INSERT INTO remembered_devices (user_id, token_hash, expires_at) VALUES (?,?,?)')
    .run(user.id, hashToken(token), expiresAt.toISOString());
  res.cookie(REMEMBER_DEVICE_COOKIE, `${user.id}.${token}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: REMEMBER_DEVICE_TTL_DAYS * 86400000,
    path: '/'
  });
}

// Genera y manda un código de 6 dígitos por correo — reemplaza cualquier
// código sin usar que le quedara pendiente a esta cuenta (que quede claro
// cuál es el vigente si pide "reenviar" más de una vez).
async function sendEmailOtp(req, user) {
  if (!mailer.isConfigured()) throw new Error('Resend no está configurado (falta RESEND_API_KEY).');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const expiresAt = new Date(Date.now() + 10 * 60000).toISOString();
  db.prepare('DELETE FROM email_otp_codes WHERE user_id = ? AND used_at IS NULL').run(user.id);
  db.prepare('INSERT INTO email_otp_codes (user_id, code_hash, expires_at) VALUES (?,?,?)').run(user.id, hashToken(code), expiresAt);
  await mailer.sendTwoFactorCodeEmail({ to: user.email, name: user.name, code, lang: req.body?.lang });
}

function verifyEmailOtp(userId, code) {
  const row = db.prepare(`
    SELECT * FROM email_otp_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(userId, hashToken(code));
  if (!row || new Date(row.expires_at) < new Date()) return false;
  db.prepare("UPDATE email_otp_codes SET used_at = datetime('now') WHERE id = ?").run(row.id);
  return true;
}

// Deja pendingUserId listo en la sesión y responde el reto de 2FA que le
// toca a esta cuenta — nunca abre sesión de una vez (salvo dispositivo ya
// recordado, ver checkRememberedDevice). La usan tanto /login como POST
// /invites/:token/accept (routes/invites.js): cualquier forma de "quedar
// identificado" en esta app pasa por aquí antes de tener sesión de verdad.
function beginTwoFactorChallenge(req, res, user) {
  if (checkRememberedDevice(req, user)) {
    req.session.userId = user.id;
    req.session.role = user.role;
    logAccess(user.id, 'login_success_remembered_device', req);
    return res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
  }

  req.session.pendingUserId = user.id;
  delete req.session.userId;

  if (user.two_factor_method === 'email') {
    sendEmailOtp(req, user).then(() => {
      logAccess(user.id, 'login_password_ok_awaiting_email_otp', req);
      res.json({ twoFactor: true, method: 'email' });
    }).catch(err => res.status(500).json({ error: err.message }));
    return;
  }
  if (user.two_factor_method === 'totp' && user.totp_secret) {
    logAccess(user.id, 'login_password_ok_awaiting_totp', req);
    return res.json({ twoFactor: true, method: 'totp' });
  }

  // Todavía no eligió método (cuenta nueva, o se le reseteó el 2FA) — se
  // genera el QR por si prefiere la app (queda guardado sin activar), y el
  // frontend ofrece "mándamelo por correo" como alternativa en la misma
  // pantalla (POST /email-otp), sin otro viaje de ida y vuelta a /login.
  const secret = authenticator.generateSecret();
  db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret, user.id);
  const otpauth = authenticator.keyuri(user.email, 'Grupo Nar', secret);
  qrcode.toDataURL(otpauth, (err, qrDataUrl) => {
    if (err) return res.status(500).json({ error: 'No se pudo generar el código QR.' });
    logAccess(user.id, 'login_password_ok_awaiting_totp_setup', req);
    res.json({ twoFactor: true, method: 'choose', qrCode: qrDataUrl, secret });
  });
}

// POST /api/auth/login  { email, password, lang } — segundo paso obligatorio
// (app o correo, ver POST /totp abajo) para TODOS los roles. Una contraseña
// correcta nunca abre sesión por sí sola: solo deja a req.session.pendingUserId
// listo para que /totp la confirme (o abre de una vez si el dispositivo ya
// estaba recordado).
router.post('/login', rateLimitLogin, validateBody(loginSchema), (req, res) => {
  const { email, password } = req.body;

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
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

  beginTwoFactorChallenge(req, res, user);
});

// POST /api/auth/email-otp {} — (re)manda el código por correo. Sirve tanto
// para elegir "correo" como método la primera vez (desde la pantalla de
// "choose") como para pedir uno nuevo si el anterior ya venció.
router.post('/email-otp', rateLimitEmailOtp, validateBody(emailOtpSchema), async (req, res) => {
  const pendingUserId = req.session.pendingUserId;
  if (!pendingUserId) return res.status(401).json({ error: 'Tu sesión de login expiró, entra tu correo y contraseña de nuevo.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(pendingUserId);
  if (!user) return res.status(401).json({ error: 'Tu sesión de login expiró, entra tu correo y contraseña de nuevo.' });
  try {
    await sendEmailOtp(req, user);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/totp  { code, method, remember } — segundo paso del login
// de arriba. Requiere haber pasado ya la contraseña (pendingUserId en la
// sesión); confirma el código (de la app o del correo, según `method`)
// y recién ahí abre la sesión de verdad. Si la cuenta seguía sin 2FA
// activado, este es el momento en que ese método queda fijo para siempre
// (ya demostró que sí lo tiene funcionando). `remember` deja este
// navegador sin pedir 2FA por REMEMBER_DEVICE_TTL_DAYS (ver arriba).
router.post('/totp', rateLimitTotp, validateBody(totpSchema), (req, res) => {
  const pendingUserId = req.session.pendingUserId;
  if (!pendingUserId) return res.status(401).json({ error: 'Tu sesión de login expiró, entra tu correo y contraseña de nuevo.' });
  const { code, method, remember } = req.body;

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(pendingUserId);
  if (!user) return res.status(401).json({ error: 'Tu sesión de login expiró, entra tu correo y contraseña de nuevo.' });

  const useMethod = method === 'email' ? 'email' : 'totp';
  let valid = false;
  if (useMethod === 'email') {
    valid = verifyEmailOtp(user.id, String(code).trim());
  } else if (user.totp_secret) {
    try { valid = authenticator.check(String(code).trim(), user.totp_secret); } catch (e) { valid = false; }
  }
  if (!valid) {
    logAccess(user.id, 'totp_failed', req);
    return res.status(401).json({
      error: useMethod === 'email'
        ? 'Código incorrecto o vencido — pide uno nuevo.'
        : 'Código incorrecto. Revisa la hora de tu teléfono e intenta de nuevo.'
    });
  }

  if (!user.two_factor_method) {
    db.prepare('UPDATE users SET two_factor_method = ?, totp_enabled = 1 WHERE id = ?').run(useMethod, user.id);
  }
  delete req.session.pendingUserId;
  req.session.userId = user.id;
  req.session.role = user.role;
  logAccess(user.id, 'login_success', req);
  if (remember) setRememberDeviceCookie(req, res, user);

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
router.post('/forgot-password', rateLimitForgotPassword, validateBody(forgotPasswordSchema), async (req, res) => {
  const { email } = req.body;
  const generic = { ok: true, message: 'Si ese correo tiene una cuenta, te mandamos un link para restablecer tu contraseña.' };
  if (!email) return res.json(generic);

  const user = db.prepare("SELECT * FROM users WHERE email = ? AND status = 'active'").get(email);
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
router.post('/reset-password/:token', validateBody(resetPasswordSchema), (req, res) => {
  const { password } = req.body;
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

module.exports = { router, requireAuth, requireRole, resolveAgency, KNOWN_AGENCIES, beginTwoFactorChallenge };
