const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../db');
const { requireRole } = require('./auth');
const { canAccessDeal } = require('../lib/access');
const { createRateLimiter } = require('../lib/rateLimit');
const { resolveAgency } = require('./auth');
const mailer = require('../lib/email');

const router = express.Router();

const INVITE_TTL_DAYS = 7;

// Rate limiting simple en memoria para el endpoint público de aceptar
// invitación (crea cuentas sin autenticación previa).
const rateLimitAccept = createRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 10 });

// POST /api/invites — admin/agente/abogado genera una invitación. Para
// comprador/vendedor hace falta decir A QUÉ PARTE específica de la
// operación representa (dealPartyEntityId) — puede haber varios
// compradores/vendedores, cada uno necesita su propia invitación ligada a
// su propia parte. Para agente/abogado, sin dealId/partyEntityId es una
// invitación de equipo (se une a la firma en general).
router.post('/', requireRole('admin', 'agent', 'lawyer'), async (req, res) => {
  const { dealId, dealPartyEntityId, roleInDeal, name, email, representsSide } = req.body || {};
  if (!['buyer', 'seller', 'agent', 'lawyer'].includes(roleInDeal) || !name || !email) {
    return res.status(400).json({ error: 'Datos inválidos.' });
  }
  if (representsSide !== undefined && representsSide !== null && !['buyer', 'seller'].includes(representsSide)) {
    return res.status(400).json({ error: 'representsSide debe ser buyer o seller.' });
  }
  if (['buyer', 'seller'].includes(roleInDeal)) {
    if (!dealId || !dealPartyEntityId) {
      return res.status(400).json({ error: 'Falta la operación y la persona específica a invitar.' });
    }
    const party = db.prepare('SELECT * FROM deal_party_entities WHERE id = ? AND deal_id = ?').get(dealPartyEntityId, dealId);
    if (!party) return res.status(404).json({ error: 'Esa parte no existe en esta operación.' });
    if (party.side !== roleInDeal) return res.status(400).json({ error: 'El rol no coincide con el lado de esa parte.' });
    if (!canAccessDeal(req, dealId)) return res.status(403).json({ error: 'No autorizado.' });
    const alreadyLinked = db.prepare('SELECT 1 FROM deal_parties WHERE deal_party_entity_id = ?').get(dealPartyEntityId);
    if (alreadyLinked) return res.status(409).json({ error: 'Esa parte ya tiene una cuenta ligada.' });
  } else if (dealId) {
    const deal = db.prepare('SELECT id FROM deals WHERE id = ?').get(dealId);
    if (!deal) return res.status(404).json({ error: 'Operación no encontrada.' });
    if (!canAccessDeal(req, dealId)) return res.status(403).json({ error: 'No autorizado.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400000).toISOString();

  const normalizedEmail = email.toLowerCase().trim();
  db.prepare(`
    INSERT INTO invites (token, deal_id, deal_party_entity_id, role_in_deal, email, name, created_by, expires_at, represents_side)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(token, dealId || null, ['buyer', 'seller'].includes(roleInDeal) ? dealPartyEntityId : null,
         roleInDeal, normalizedEmail, name, req.session.userId, expiresAt,
         roleInDeal === 'agent' ? (representsSide || null) : null);

  const url = `/invite.html?token=${token}`;
  const dealProperty = dealId ? db.prepare('SELECT property FROM deals WHERE id = ?').get(dealId)?.property : null;
  const absoluteUrl = `${req.protocol}://${req.get('host')}${url}`;
  // El correo es "best effort": la invitación ya quedó creada y su link es
  // usable aunque el correo falle (ej. dominio de Resend sin verificar
  // todavía) — no bloqueamos ni le devolvemos error a quien invita por eso.
  let emailResult = { ok: false, error: 'Resend no está configurado.' };
  if (mailer.isConfigured()) {
    emailResult = await mailer.sendInviteEmail({ to: normalizedEmail, name, roleInDeal, dealProperty, url: absoluteUrl });
  }

  res.status(201).json({ token, url, emailSent: emailResult.ok, emailError: emailResult.ok ? null : emailResult.error });
});

// GET /api/invites/:token — público, solo lo necesario para prellenar el formulario.
router.get('/:token', (req, res) => {
  const invite = db.prepare(`
    SELECT i.*, d.property AS deal_property FROM invites i
    LEFT JOIN deals d ON d.id = i.deal_id
    WHERE i.token = ?
  `).get(req.params.token);

  if (!invite) return res.status(404).json({ error: 'Invitación no encontrada.' });
  if (invite.used_at) return res.status(410).json({ error: 'Esta invitación ya fue usada.' });
  if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'Esta invitación expiró.' });

  res.json({
    dealProperty: invite.deal_property || null,
    roleInDeal: invite.role_in_deal,
    name: invite.name,
    email: invite.email
  });
});

// POST /api/invites/:token/accept — público, crea la cuenta (o la reutiliza) y la liga a la parte correspondiente.
router.post('/:token/accept', rateLimitAccept, (req, res) => {
  const { password, agency, agencyOther } = req.body || {};
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
  }

  const invite = db.prepare('SELECT * FROM invites WHERE token = ?').get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'Invitación no encontrada.' });
  if (invite.used_at) return res.status(410).json({ error: 'Esta invitación ya fue usada.' });
  if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'Esta invitación expiró.' });

  let resolvedAgency = null;
  if (invite.role_in_deal === 'agent') {
    resolvedAgency = resolveAgency(agency, agencyOther);
    if (!resolvedAgency) return res.status(400).json({ error: 'Elige tu agencia (o escribe cuál si no está en la lista).' });
  }

  // Invitaciones viejas (de antes de que existiera deal_party_entity_id en
  // este flujo) pueden llegar aquí sin ese dato — se resuelve solo si hay
  // exactamente una parte de ese lado en la operación (con el modelo viejo
  // siempre era así). Si ya hay varias, no se puede adivinar cuál.
  let partyEntityId = invite.deal_party_entity_id;
  if (!partyEntityId && invite.deal_id && ['buyer', 'seller'].includes(invite.role_in_deal)) {
    const candidates = db.prepare('SELECT id FROM deal_party_entities WHERE deal_id = ? AND side = ?').all(invite.deal_id, invite.role_in_deal);
    if (candidates.length === 1) partyEntityId = candidates[0].id;
    else if (candidates.length > 1) {
      return res.status(409).json({ error: 'Esta invitación es de un formato viejo y esta operación ya tiene varias partes de ese lado — pide que generen una invitación nueva.' });
    }
  }

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
      const info = db.prepare('INSERT INTO users (name, email, password_hash, role, agency) VALUES (?,?,?,?,?)')
        .run(invite.name, invite.email, hash, invite.role_in_deal, resolvedAgency);
      user = { id: info.lastInsertRowid, name: invite.name, email: invite.email, role: invite.role_in_deal };
    }
    if (invite.deal_id) {
      db.prepare('INSERT OR IGNORE INTO deal_parties (deal_id, user_id, role_in_deal, deal_party_entity_id, represents_side) VALUES (?,?,?,?,?)')
        .run(invite.deal_id, user.id, invite.role_in_deal, partyEntityId || null, invite.represents_side || null);
    }
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
