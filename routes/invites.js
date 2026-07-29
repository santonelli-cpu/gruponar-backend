const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../db');
const { requireRole } = require('./auth');
const { canAccessDeal } = require('../lib/access');
const { createRateLimiter } = require('../lib/rateLimit');

const router = express.Router();

const INVITE_TTL_DAYS = 7;

// Rate limiting simple en memoria para el endpoint público de aceptar
// invitación (crea cuentas sin autenticación previa).
const rateLimitAccept = createRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 10 });

// POST /api/invites — admin/agente/abogado genera una invitación ligada a una operación.
router.post('/', requireRole('admin', 'agent', 'lawyer'), (req, res) => {
  const { dealId, roleInDeal, name, email } = req.body || {};
  if (!dealId || !['buyer', 'seller', 'agent'].includes(roleInDeal) || !name || !email) {
    return res.status(400).json({ error: 'Datos inválidos.' });
  }
  const deal = db.prepare('SELECT id FROM deals WHERE id = ?').get(dealId);
  if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });
  if (!canAccessDeal(req, dealId)) return res.status(403).json({ error: 'No autorizado.' });

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400000).toISOString();

  db.prepare(`
    INSERT INTO invites (token, deal_id, role_in_deal, email, name, created_by, expires_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(token, dealId, roleInDeal, email.toLowerCase().trim(), name, req.session.userId, expiresAt);

  res.status(201).json({ token, url: `/invite.html?token=${token}` });
});

// GET /api/invites/:token — público, solo lo necesario para prellenar el formulario.
router.get('/:token', (req, res) => {
  const invite = db.prepare(`
    SELECT i.*, d.property AS deal_property FROM invites i
    JOIN deals d ON d.id = i.deal_id
    WHERE i.token = ?
  `).get(req.params.token);

  if (!invite) return res.status(404).json({ error: 'Invitación no encontrada.' });
  if (invite.used_at) return res.status(410).json({ error: 'Esta invitación ya fue usada.' });
  if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'Esta invitación expiró.' });

  res.json({
    dealProperty: invite.deal_property,
    roleInDeal: invite.role_in_deal,
    name: invite.name,
    email: invite.email
  });
});

// POST /api/invites/:token/accept — público, crea la cuenta (o la reutiliza) y la liga a la operación.
router.post('/:token/accept', rateLimitAccept, (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
  }

  const invite = db.prepare('SELECT * FROM invites WHERE token = ?').get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'Invitación no encontrada.' });
  if (invite.used_at) return res.status(410).json({ error: 'Esta invitación ya fue usada.' });
  if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'Esta invitación expiró.' });

  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(invite.email);
  if (existing) {
    // Ya hay una cuenta con ese correo — para no permitir que cualquiera con
    // el link se apropie de ella, exigimos la contraseña de esa cuenta en
    // vez de crear una nueva. Si no coincide, no revelamos más que un genérico.
    if (!bcrypt.compareSync(password, existing.password_hash)) {
      return res.status(409).json({
        error: 'Ya existe una cuenta con ese correo. Inicia sesión con tu contraseña existente en vez de aceptar la invitación, y pide que te liguen a esta operación.'
      });
    }
  }

  const acceptTx = db.transaction(() => {
    let user = existing;
    if (!user) {
      const hash = bcrypt.hashSync(password, 12);
      const info = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)')
        .run(invite.name, invite.email, hash, invite.role_in_deal);
      user = { id: info.lastInsertRowid, name: invite.name, email: invite.email, role: invite.role_in_deal };
    }
    db.prepare('INSERT OR IGNORE INTO deal_parties (deal_id, user_id, role_in_deal) VALUES (?,?,?)')
      .run(invite.deal_id, user.id, invite.role_in_deal);
    db.prepare('UPDATE invites SET used_at = datetime(\'now\'), used_by_user_id = ? WHERE id = ?')
      .run(user.id, invite.id);
    return user;
  });

  const user = acceptTx();

  req.session.userId = user.id;
  req.session.role = user.role;

  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

module.exports = router;
