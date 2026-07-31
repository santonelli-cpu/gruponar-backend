-- Grupo Nar closing platform — schema base
-- Roles: admin, agent, lawyer, buyer, seller
-- Una persona puede estar ligada a varias operaciones (deal_parties)

-- Definición COMPLETA y actual — una instalación desde cero debe quedar
-- idéntica a una base migrada. Si la creas sin alguna columna que los
-- ensureColumn de db/index.js agregan, no pasa nada (los agregan solos);
-- pero el CHECK de role SÍ tiene que traer todos los roles actuales, o
-- ensureUserRoleAllowsExternalLawyer recreará la tabla en el primer
-- arranque sin necesidad.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','agent','lawyer','external_lawyer','buyer','seller')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending','active')),
  agency TEXT,
  phone TEXT,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  two_factor_method TEXT,
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
  -- NULL = documento a nivel de operación (sección "Propiedad": Escritura
  -- pública, Predial) en vez de uno de una parte específica.
  deal_party_entity_id INTEGER REFERENCES deal_party_entities(id) ON DELETE CASCADE,
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

-- "Olvidé mi contraseña" — un token de un solo uso por solicitud, con
-- vigencia corta (ver PASSWORD_RESET_TTL_HOURS en routes/auth.js). Varias
-- solicitudes seguidas del mismo usuario no invalidan las anteriores solas
-- (se revisa used_at/expires_at al usarlas), así que quien haga clic en un
-- link viejo pero todavía vigente puede seguir usándolo.
CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- Segundo factor por correo (alternativa a la app de autenticación, ver
-- routes/auth.js) — código de 6 dígitos, vigente 10 minutos, un solo uso.
-- code_hash en vez del código en claro: aunque es de vida corta, no hay
-- razón para guardarlo legible en la base de datos.
CREATE TABLE IF NOT EXISTS email_otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- "Recuérdame en este dispositivo" (ver routes/auth.js) — un token por
-- navegador que se marcó como confiable, para saltarse el 2FA mientras no
-- venza. token_hash en vez del token en claro, mismo motivo que arriba.
CREATE TABLE IF NOT EXISTS remembered_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  last_used_at TEXT
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

-- Última vez que se mandó un recordatorio automático de documentos
-- pendientes a cada parte (lib/reminders.js) — evita mandar uno nuevo cada
-- vez que corre el chequeo diario si ya se mandó uno hace poco.
CREATE TABLE IF NOT EXISTS document_reminders_log (
  deal_party_entity_id INTEGER PRIMARY KEY REFERENCES deal_party_entities(id) ON DELETE CASCADE,
  last_sent_at TEXT NOT NULL
);

-- Configuración de un solo valor por llave, para cosas que no tiene sentido
-- meter en variables de entorno porque se obtienen en vivo desde la app (el
-- refresh token de Drive sale del consentimiento OAuth que el admin da
-- haciendo clic en "Conectar Google Drive", no algo que él escriba a mano).
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Historial de actividad por operación — cada acción relevante (documento
-- subido/aprobado, paso del tracker completado, KYC enviado, persona
-- agregada...) deja una fila aquí. Es lo que alimenta la línea de tiempo
-- del detalle de la operación: quién hizo qué y cuándo, sin reconstruirlo
-- después desde columnas sueltas.
CREATE TABLE IF NOT EXISTS deal_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deal_activity_deal ON deal_activity(deal_id, id);

-- Recordatorios de fechas límite ya mandados (lib/deadlineReminders.js) —
-- una fila por operación+tipo+fecha objetivo, para no repetir el correo si
-- el chequeo diario corre varias veces (o el servidor se reinicia).
CREATE TABLE IF NOT EXISTS deadline_reminders_log (
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  target_date TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (deal_id, kind, target_date)
);

-- Historial de versiones de documentos del checklist — al re-subir un
-- archivo (o quitarlo), la versión que estaba se archiva aquí en vez de
-- perderse: el objeto en Cloud Storage NO se borra, solo deja de ser "el
-- actual". Para una plataforma legal, poder responder "¿qué versión del
-- avalúo estaba subida el día X y quién la subió?" no es opcional.
CREATE TABLE IF NOT EXISTS document_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  file_url TEXT NOT NULL,
  original_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT,
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_document_versions_doc ON document_versions(document_id, id);
