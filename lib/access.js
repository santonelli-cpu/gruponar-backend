const db = require('../db');

// Solo admin ve/toca cualquier operación sin restricción. 'lawyer' (abogado
// interno) YA NO tiene visibilidad total automática — antes cualquier
// abogado interno veía y podía borrar CUALQUIER operación de la firma,
// incluso una que nunca había tocado; después de que uno borró por error
// una operación ajena, se acotó a solo las que creó o a las que un admin lo
// asignó explícitamente (ver canAccessDeal). Comprador/vendedor/agente
// siguen viendo solo las suyas (ligadas vía deal_parties).
const UNRESTRICTED_ROLES = ['admin'];

// Roles que, una vez que SÍ tienen acceso a una operación (ver
// canAccessDeal), la ven completa sin restricción de lado — a diferencia de
// un agente, que solo ve el lado que representa. Admin siempre; abogado
// interno solo en las operaciones a las que tiene acceso.
const FULL_ACCESS_WITHIN_DEAL_ROLES = ['admin', 'lawyer'];

// 'external_lawyer' (abogado externo, del despacho del comprador/vendedor)
// se comporta exactamente como 'agent' en todos lados: se liga por
// deal_parties a operaciones específicas (role_in_deal sigue siendo 'agent'
// ahí, es el rol GLOBAL de la cuenta el que los distingue), puede elegir a
// qué lado representa, y tiene el mismo nivel de acceso a documentos/KYC.
const AGENT_LIKE_ROLES = ['agent', 'external_lawyer'];

function canAccessDeal(req, dealId) {
  if (UNRESTRICTED_ROLES.includes(req.session.role)) return true;
  // Una operación en la papelera (deals.deleted_at, ver DELETE /api/deals/:id
  // en routes/deals.js) es invisible para todos menos admin — sin esto, una
  // pestaña que ya tenía cargada una operación antes de que se borrara
  // podía seguir usando sus sub-rutas (documentos, KYC, tareas...) como si
  // siguiera activa.
  const deal = db.prepare('SELECT created_by, deleted_at FROM deals WHERE id = ?').get(dealId);
  if (!deal || deal.deleted_at) return false;
  // Un abogado interno siempre puede ver la operación que él mismo creó
  // (deals.created_by) aunque nadie lo haya "agregado" aparte — de ahí en
  // fuera, igual que cualquier otro rol, necesita estar en deal_parties
  // (un admin lo agrega/quita desde la operación, mismo mecanismo que
  // agregar un agente).
  if (req.session.role === 'lawyer' && deal.created_by === req.session.userId) return true;
  return !!db.prepare('SELECT 1 FROM deal_parties WHERE deal_id = ? AND user_id = ?')
    .get(dealId, req.session.userId);
}

// El rol de este usuario específicamente en esta operación (no el rol global
// de la cuenta) — comprador/vendedor/agente puede tener roles distintos en
// distintas operaciones; admin/abogado no tiene "owner" propio, devuelve su
// rol de sesión. Se asume que ya se llamó canAccessDeal antes (todas las
// rutas lo hacen) — un abogado interno que llegó hasta aquí ya tiene acceso
// a esta operación específica, así que sigue viéndola completa como antes.
function myRoleInDeal(req, dealId) {
  if (FULL_ACCESS_WITHIN_DEAL_ROLES.includes(req.session.role)) return req.session.role;
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
  if (FULL_ACCESS_WITHIN_DEAL_ROLES.includes(req.session.role)) return null;
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
  if (!AGENT_LIKE_ROLES.includes(req.session.role)) return null;
  const row = db.prepare("SELECT represents_side FROM deal_parties WHERE deal_id = ? AND user_id = ? AND role_in_deal = 'agent'")
    .get(dealId, req.session.userId);
  return row ? row.represents_side : null;
}

module.exports = { canAccessDeal, myRoleInDeal, myDealPartyEntityId, myRepresentsSide, UNRESTRICTED_ROLES, FULL_ACCESS_WITHIN_DEAL_ROLES, AGENT_LIKE_ROLES };
