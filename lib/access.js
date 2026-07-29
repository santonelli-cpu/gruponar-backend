const db = require('../db');

// Admin/abogado ven cualquier operación (visibilidad total, como corresponde
// a supervisión legal/administrativa). Agente/comprador/vendedor solo ven
// las suyas (ligadas vía deal_parties) — un agente de ventas ve solo sus
// propias operaciones, no las de otros agentes. Compartido entre
// routes/deals.js, routes/invites.js y routes/docusign.js para no mantener
// copias distintas de la misma regla.
const UNRESTRICTED_ROLES = ['admin', 'lawyer'];

function canAccessDeal(req, dealId) {
  if (UNRESTRICTED_ROLES.includes(req.session.role)) return true;
  return !!db.prepare('SELECT 1 FROM deal_parties WHERE deal_id = ? AND user_id = ?')
    .get(dealId, req.session.userId);
}

// El rol de este usuario específicamente en esta operación (no el rol global
// de la cuenta) — comprador/vendedor/agente puede tener roles distintos en
// distintas operaciones; admin/abogado no tiene "owner" propio, devuelve su
// rol de sesión.
function myRoleInDeal(req, dealId) {
  if (UNRESTRICTED_ROLES.includes(req.session.role)) return req.session.role;
  const row = db.prepare('SELECT role_in_deal FROM deal_parties WHERE deal_id = ? AND user_id = ?')
    .get(dealId, req.session.userId);
  return row ? row.role_in_deal : null;
}

module.exports = { canAccessDeal, myRoleInDeal, UNRESTRICTED_ROLES };
