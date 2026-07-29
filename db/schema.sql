-- Grupo Nar closing platform — schema base
-- Roles: admin, agent, lawyer, buyer, seller
-- Una persona puede estar ligada a varias operaciones (deal_parties)

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','agent','lawyer','buyer','seller')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending','active')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario TEXT NOT NULL CHECK(scenario IN ('purchase','trust','transfer','trust_termination')),
  development TEXT NOT NULL DEFAULT 'punta_mita',
  property TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  furniture_price REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  start_date TEXT NOT NULL,
  escrow_company TEXT,
  contract_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Vendedores y compradores de una operación — reemplaza el viejo supuesto de
-- "un vendedor + un comprador": ahora son N partes por lado (hasta 4), cada
-- una individual o una entidad (LLC/persona moral) con su propia estructura
-- de propiedad de hasta 2 niveles (1-2 socios directos, una entidad padre,
-- o un revocable trust directo o arriba de esa entidad padre).
CREATE TABLE IF NOT EXISTS deal_party_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK(side IN ('seller','buyer')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  party_type TEXT NOT NULL CHECK(party_type IN ('individual','corporation','llc')),
  name TEXT NOT NULL,
  -- Todo lo siguiente solo aplica si party_type IN ('corporation','llc'):
  ownership_mode TEXT CHECK(ownership_mode IN ('direct_owners','parent_entity','direct_trust')),
  parent_entity_name TEXT,
  parent_entity_type TEXT CHECK(parent_entity_type IN ('corporation','llc')),
  parent_has_trust_above INTEGER NOT NULL DEFAULT 0,
  parent_trust_name TEXT,
  direct_trust_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 1-2 socios/accionistas directos de una parte con ownership_mode='direct_owners'.
CREATE TABLE IF NOT EXISTS deal_party_owners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_party_entity_id INTEGER NOT NULL REFERENCES deal_party_entities(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL
);

-- Une usuarios reales (con login) a una parte específica de una operación.
-- deal_party_entity_id es NULL para agentes (no representan una parte
-- transaccional, solo coordinan).
CREATE TABLE IF NOT EXISTS deal_parties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_in_deal TEXT NOT NULL CHECK(role_in_deal IN ('buyer','seller','agent')),
  deal_party_entity_id INTEGER REFERENCES deal_party_entities(id) ON DELETE CASCADE,
  UNIQUE(deal_id, user_id),
  UNIQUE(deal_party_entity_id)
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  deal_party_entity_id INTEGER NOT NULL REFERENCES deal_party_entities(id) ON DELETE CASCADE,
  sub_label TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done')),
  file_url TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  label_en TEXT NOT NULL,
  label_es TEXT NOT NULL,
  requires_signature INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','progress','done')),
  docusign_envelope_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Invitaciones para que un comprador/vendedor/agente cree su propia cuenta
-- y quede ligado a una operación específica, sin que el admin tenga que
-- inventarle una contraseña temporal. deal_id es NULL para invitaciones de
-- equipo (agente/abogado interno) que no están ligadas a ninguna operación
-- en particular — se unen a la firma en general, no a un cierre específico.
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
  deal_party_entity_id INTEGER REFERENCES deal_party_entities(id) ON DELETE CASCADE,
  role_in_deal TEXT NOT NULL CHECK(role_in_deal IN ('buyer','seller','agent','lawyer')),
  email TEXT,
  name TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by_user_id INTEGER REFERENCES users(id)
);

-- Expedientes KYC (formularios de identificación de cliente) llenados por
-- comprador/vendedor y generados a partir de la plantilla oficial de la
-- escrow company correspondiente (Armour/TLA), luego enviados a firma.
CREATE TABLE IF NOT EXISTS kyc_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  deal_party_entity_id INTEGER NOT NULL REFERENCES deal_party_entities(id) ON DELETE CASCADE,
  template_key TEXT NOT NULL,
  answers_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','generated','sent','signed')),
  generated_file_url TEXT,
  docusign_envelope_id TEXT,
  docusign_status TEXT NOT NULL DEFAULT 'not_sent',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  UNIQUE(deal_party_entity_id, template_key)
);

-- Machotes de contrato de promesa (uno o más por tipo de operación) — el
-- admin/abogado los sube en .docx con placeholders {{ASI}} y elige cuál usar
-- por operación. No hay un JSON de definición de campos por machote: los
-- campos se detectan automáticamente escaneando los placeholders del propio
-- archivo (lib/contractFill/mergeEngine.js).
CREATE TABLE IF NOT EXISTS contract_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario TEXT NOT NULL CHECK(scenario IN ('purchase','trust','transfer','trust_termination')),
  label TEXT NOT NULL,
  docx_file TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
