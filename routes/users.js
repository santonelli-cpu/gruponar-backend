const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const gcsStorage = require('../lib/gcsStorage');
const { requireAuth, requireRole, resolveAgency, KNOWN_AGENCIES } = require('./auth');
const { validateBody, z } = require('../lib/validateBody');
const { rateLimitWrite, rateLimitEmail } = require('../lib/apiRateLimits');
const mailer = require('../lib/email');

const router = express.Router();

function tempPassword(){
  return crypto.randomBytes(6).toString('base64url'); // ej: "aB3xQ9"
}

const createUserSchema = z.object({
  name: z.string().trim().min(1, 'Escribe un nombre.').max(200, 'El nombre es demasiado largo.'),
  email: z.string().trim().toLowerCase().max(254).email('Ese correo no tiene un formato válido.'),
  role: z.enum(['admin', 'agent', 'lawyer', 'external_lawyer', 'buyer', 'seller'])
}).strict();

const agencySchema = z.object({
  agency: z.string().trim().max(200).optional(),
  agencyOther: z.string().trim().max(200).optional()
}).strict();

const phoneSchema = z.object({
  phone: z.string().trim().max(30).optional().default('')
}).strict();

const profileSchema = z.object({
  name: z.string().trim().min(1, 'Escribe un nombre.').max(200, 'El nombre es demasiado largo.'),
  email: z.string().trim().toLowerCase().max(254).email('Ese correo no tiene un formato válido.')
}).strict();

// POST /api/users — solo admin crea cuentas de equipo (agente, abogado, otro
// admin) o cuentas de cliente directas. Restringido a admin (antes cualquier
// agente podía crear una cuenta con role:'admin' — escalamiento de
// privilegios); el alta normal de comprador/vendedor es por invitación
// (routes/invites.js), esto queda para el roster interno.
// Devuelve una contraseña temporal para compartir por un canal seguro
// (no por el mismo correo que usarías para mandar el link, idealmente).
router.post('/', requireRole('admin'), rateLimitWrite, validateBody(createUserSchema), (req, res) => {
  const { name, email, role } = req.body;
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });

  const password = tempPassword();
  const hash = bcrypt.hashSync(password, 12);
  const info = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)')
    .run(name, email, hash, role);

  // TODO (Claude Code): en vez de regresar la contraseña en la respuesta,
  // lo correcto en producción es mandarla por correo (con un servicio como
  // Resend/SendGrid) o generar un link de "crea tu contraseña" de un solo uso.
  res.status(201).json({ id: info.lastInsertRowid, name, email, role, temporaryPassword: password });
});

router.get('/', requireRole('admin'), (req, res) => {
  const users = db.prepare('SELECT id, name, email, role, status, agency, phone, bio, avatar_url AS avatarUrl, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

// ── Mi perfil ────────────────────────────────────────────────────────────
// Cualquier usuario edita SU propia tarjeta: nombre, teléfono, agencia/
// empresa y una línea de presentación. Pensado sobre todo para agentes y
// abogados externos, que son la cara visible ante los clientes de la
// operación. El correo NO se cambia aquí (es el identificador de login;
// eso sigue siendo del admin vía PATCH /:id/profile).
// OJO: van ANTES que las rutas /:id/... para que ':id' no capture 'me'.
const myProfileSchema = z.object({
  name: z.string().trim().min(1, 'Escribe un nombre.').max(200).optional(),
  phone: z.string().trim().max(30).optional(),
  agency: z.string().trim().max(200).optional(),
  bio: z.string().trim().max(600).optional()
}).strict();

router.patch('/me/profile', requireAuth, rateLimitWrite, validateBody(myProfileSchema), (req, res) => {
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!me) return res.status(401).json({ error: 'No autenticado.' });
  const next = {
    name: req.body.name !== undefined ? req.body.name : me.name,
    phone: req.body.phone !== undefined ? req.body.phone : me.phone,
    agency: req.body.agency !== undefined ? req.body.agency : me.agency,
    bio: req.body.bio !== undefined ? req.body.bio : me.bio
  };
  db.prepare('UPDATE users SET name = ?, phone = ?, agency = ?, bio = ? WHERE id = ?')
    .run(next.name, next.phone || null, next.agency || null, next.bio || null, me.id);
  res.json({ ok: true, ...next });
});

// Foto de perfil o logo de la empresa — imagen chica a Cloud Storage bajo
// _avatars/ (prefijo propio, nunca choca con los archivos de operaciones).
// La clave lleva un sufijo aleatorio: además de evitar caché vieja tras un
// cambio, evita colisiones entre entornos que comparten bucket.
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype))
});

router.post('/me/avatar', requireAuth, rateLimitWrite, avatarUpload.single('avatar'), async (req, res) => {
  if (!gcsStorage.isConfigured()) return res.status(501).json({ error: 'Cloud Storage no está configurado.' });
  if (!req.file) return res.status(400).json({ error: 'Sube una imagen PNG, JPG o WebP de máximo 5 MB.' });
  const me = db.prepare('SELECT id, avatar_url FROM users WHERE id = ?').get(req.session.userId);
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[req.file.mimetype];
  const key = `_avatars/u${me.id}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  try {
    await gcsStorage.uploadBuffer(key, req.file.buffer, req.file.mimetype);
    if (me.avatar_url) gcsStorage.deleteFile(me.avatar_url).catch(() => {});
    db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(key, me.id);
    res.json({ ok: true, avatarUrl: key });
  } catch (err) {
    console.error('[avatar]', err.message);
    res.status(500).json({ error: 'No se pudo guardar la imagen.' });
  }
});

router.delete('/me/avatar', requireAuth, rateLimitWrite, async (req, res) => {
  const me = db.prepare('SELECT id, avatar_url FROM users WHERE id = ?').get(req.session.userId);
  if (me && me.avatar_url) {
    gcsStorage.deleteFile(me.avatar_url).catch(() => {});
    db.prepare('UPDATE users SET avatar_url = NULL WHERE id = ?').run(me.id);
  }
  res.json({ ok: true });
});

// La foto de cualquier usuario, para mostrarla junto a su nombre (equipo,
// agentes de una operación). Solo usuarios autenticados; una foto de perfil
// no es un documento sensible, no hace falta scoping por operación.
router.get('/:id/avatar', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(req.params.id);
  if (!user || !user.avatar_url || !gcsStorage.isConfigured()) return res.status(404).json({ error: 'Sin foto.' });
  const contentType = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' }[user.avatar_url.slice(user.avatar_url.lastIndexOf('.'))];
  try {
    await gcsStorage.streamToResponse(user.avatar_url, res, { inline: true, contentType });
  } catch (err) {
    if (!res.headersSent) res.status(404).json({ error: 'Sin foto.' });
  }
});

// PATCH /api/users/:id/approve — activa una cuenta autoregistrada
// (routes/auth.js POST /register la crea en status='pending'). Le avisamos
// por correo a la persona misma — antes no se enteraba de que ya podía
// entrar hasta que lo intentaba por su cuenta.
router.patch('/:id/approve', requireRole('admin'), rateLimitEmail, (req, res) => {
  const user = db.prepare("SELECT id, name, email FROM users WHERE id = ? AND status = 'pending'").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'No hay una cuenta pendiente con ese id.' });
  db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(user.id);
  res.json({ ok: true });

  if (mailer.isConfigured()) {
    mailer.sendAccountApprovedEmail({ to: user.email, name: user.name, url: `${req.protocol}://${req.get('host')}/` });
  }
});

// POST /api/users/:id/reset-2fa — para cuando alguien pierde el teléfono
// donde tenía la app de autenticación (o cambió de equipo/correo). Borra el
// método elegido y el secreto guardado; en su siguiente login, POST
// /auth/login vuelve a tratar la cuenta como si nunca hubiera tenido 2FA
// (le ofrece elegir de nuevo). También borra cualquier dispositivo
// recordado de esta cuenta — si el motivo del reset es que alguien más
// pudo haber tenido acceso, un "recuérdame" viejo no debe seguir sirviendo.
router.post('/:id/reset-2fa', requireRole('admin'), rateLimitWrite, (req, res) => {
  const info = db.prepare("UPDATE users SET totp_enabled = 0, totp_secret = NULL, two_factor_method = NULL WHERE id = ?").run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Usuario no encontrado.' });
  db.prepare('DELETE FROM remembered_devices WHERE user_id = ?').run(req.params.id);
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
router.patch('/:id/agency', requireRole('admin'), rateLimitWrite, validateBody(agencySchema), (req, res) => {
  const user = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'agent'").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'No hay un agente con ese id.' });
  const { agency, agencyOther } = req.body;
  const resolved = resolveAgency(agency, agencyOther);
  if (!resolved) return res.status(400).json({ error: 'Elige una agencia (o escribe cuál si no está en la lista).' });
  db.prepare('UPDATE users SET agency = ? WHERE id = ?').run(resolved, req.params.id);
  res.json({ ok: true, agency: resolved });
});

// PATCH /api/users/:id/profile — admin corrige el nombre/correo de una
// cuenta ya registrada (agente, abogado interno/externo, comprador,
// vendedor — cualquier rol), por ejemplo cuando alguien se equivocó al
// registrarse o cambió de correo. No aplica a admin (para no poder
// editarse/editar a otro admin por aquí sin querer) ni cambia la
// contraseña — solo nombre y correo.
router.patch('/:id/profile', requireRole('admin'), rateLimitWrite, validateBody(profileSchema), (req, res) => {
  const user = db.prepare("SELECT id FROM users WHERE id = ? AND role != 'admin'").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Cuenta no encontrada.' });
  const { name, email } = req.body;
  const emailTaken = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.params.id);
  if (emailTaken) return res.status(409).json({ error: 'Ya existe otra cuenta con ese correo.' });
  db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(name, email, req.params.id);
  res.json({ ok: true, name, email });
});

router.get('/known-agencies', requireRole('admin'), (req, res) => {
  res.json(KNOWN_AGENCIES);
});

// GET /api/users/clients — base de contactos de comprador/vendedor (nombre,
// correo, teléfono, y en qué operación(es) están) para que admin siempre
// tenga cómo volver a contactarlos, incluso después de que la operación
// cierre. El teléfono no tiene su propio campo de captura todavía: si
// users.phone está vacío, se usa el que hayan puesto al llenar su KYC
// (answers.mobilePhone) como respaldo de solo lectura.
router.get('/clients', requireRole('admin'), (req, res) => {
  const clients = db.prepare(`
    SELECT id, name, email, phone, role FROM users WHERE role IN ('buyer','seller') ORDER BY name COLLATE NOCASE
  `).all();
  const dealsStmt = db.prepare(`
    SELECT d.id AS dealId, d.property AS property, dp.deal_party_entity_id AS partyEntityId
    FROM deal_parties dp JOIN deals d ON d.id = dp.deal_id
    WHERE dp.user_id = ? AND dp.role_in_deal IN ('buyer','seller')
  `);
  const kycAnswersStmt = db.prepare(`
    SELECT answers_json FROM kyc_submissions
    WHERE deal_party_entity_id = ? AND answers_json IS NOT NULL
    ORDER BY id DESC
  `);
  const result = clients.map(c => {
    const dealRows = dealsStmt.all(c.id);
    let phone = c.phone || null;
    if (!phone) {
      outer: for (const row of dealRows) {
        for (const sub of kycAnswersStmt.all(row.partyEntityId)) {
          try {
            const answers = JSON.parse(sub.answers_json);
            if (answers.mobilePhone) { phone = answers.mobilePhone; break outer; }
          } catch { /* respuesta corrupta, se ignora */ }
        }
      }
    }
    return {
      id: c.id, name: c.name, email: c.email, phone, role: c.role,
      deals: dealRows.map(r => ({ id: r.dealId, property: r.property }))
    };
  });
  res.json(result);
});

// PATCH /api/users/:id/phone — admin corrige/agrega el teléfono a mano
// cuando no vino del KYC (o vino mal).
router.patch('/:id/phone', requireRole('admin'), rateLimitWrite, validateBody(phoneSchema), (req, res) => {
  const user = db.prepare("SELECT id FROM users WHERE id = ? AND role IN ('buyer','seller')").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'No hay un cliente con ese id.' });
  const phone = req.body.phone;
  db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone || null, req.params.id);
  res.json({ ok: true });
});

module.exports = router;
