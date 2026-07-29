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
  seller_name TEXT NOT NULL,
  seller_type TEXT NOT NULL,
  buyer_name TEXT NOT NULL,
  buyer_type TEXT NOT NULL,
  escrow_company TEXT,
  contract_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Une usuarios reales (con login) a una operación en un rol específico.
CREATE TABLE IF NOT EXISTS deal_parties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_in_deal TEXT NOT NULL CHECK(role_in_deal IN ('buyer','seller','agent')),
  UNIQUE(deal_id, user_id)
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  owner TEXT NOT NULL CHECK(owner IN ('seller','buyer')),
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
  role_in_deal TEXT NOT NULL CHECK(role_in_deal IN ('buyer','seller')),
  template_key TEXT NOT NULL,
  answers_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','generated','sent','signed')),
  generated_file_url TEXT,
  docusign_envelope_id TEXT,
  docusign_status TEXT NOT NULL DEFAULT 'not_sent',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  UNIQUE(deal_id, role_in_deal, template_key)
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
