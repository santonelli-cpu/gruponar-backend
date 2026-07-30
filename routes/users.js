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
  if (!name || !email || !['admin', 'agent', 'lawyer', 'external_lawyer', 'buyer', 'seller'].includes(role)) {
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

// GET /api/users/clients — base de contactos de comprador/vendedor (nombre,
// correo, teléfono, y en qué operación(es) están) para que admin siempre
// tenga cómo volver a contactarlos, incluso después de que la operación
// cierre. El teléfono no tiene su propio campo de captura todavía: si
// users.phone está vacío, se usa el que hayan puesto al llenar su KYC
// (answers.mobilePhone) como respaldo de solo lectura.
router.get('/clients', requireRole('admin'), (req, res) => {
  const clients = db.prepare(`
    SELECT id, name, email, phone FROM users WHERE role IN ('buyer','seller') ORDER BY name COLLATE NOCASE
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
      id: c.id, name: c.name, email: c.email, phone,
      deals: dealRows.map(r => ({ id: r.dealId, property: r.property }))
    };
  });
  res.json(result);
});

// PATCH /api/users/:id/phone — admin corrige/agrega el teléfono a mano
// cuando no vino del KYC (o vino mal).
router.patch('/:id/phone', requireRole('admin'), (req, res) => {
  const user = db.prepare("SELECT id FROM users WHERE id = ? AND role IN ('buyer','seller')").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'No hay un cliente con ese id.' });
  const phone = (req.body && req.body.phone || '').trim();
  db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone || null, req.params.id);
  res.json({ ok: true });
});

module.exports = router;
