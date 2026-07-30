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

// A qué parte (deal_party_entities.id) representa este usuario en esta
// operación — null si es staff (no "es" una parte) o si es agente (no tiene
// parte transaccional propia). Es lo que permite que cada comprador/vendedor
// individual solo vea/llene/firme lo suyo cuando hay varias personas del
// mismo lado.
function myDealPartyEntityId(req, dealId) {
  if (UNRESTRICTED_ROLES.includes(req.session.role)) return null;
  const row = db.prepare('SELECT deal_party_entity_id FROM deal_parties WHERE deal_id = ? AND user_id = ?')
    .get(dealId, req.session.userId);
  return row ? row.deal_party_entity_id : null;
}

// A qué lado (buyer/seller) representa este agente en esta operación — null
// si no es agente aquí, o si todavía no eligió lado (represents_side sin
// llenar, ej. agentes agregados antes de que este campo existiera — en ese
// caso no se restringe nada, por compatibilidad). Un agente solo debe ver
// las partes/documentos/KYC del lado que representa, nunca el otro lado.
function myRepresentsSide(req, dealId) {
  if (req.session.role !== 'agent') return null;
  const row = db.prepare("SELECT represents_side FROM deal_parties WHERE deal_id = ? AND user_id = ? AND role_in_deal = 'agent'")
    .get(dealId, req.session.userId);
  return row ? row.represents_side : null;
}

module.exports = { canAccessDeal, myRoleInDeal, myDealPartyEntityId, myRepresentsSide, UNRESTRICTED_ROLES };
