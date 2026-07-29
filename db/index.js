const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// En producción (Render/Railway/etc.) el disco persistente se monta en un
// solo directorio (DATA_DIR) — ahí viven la base de datos, las sesiones y
// los uploads, para que sobrevivan a un redeploy. En local, sin DATA_DIR
// definido, todo sigue funcionando exactamente igual que antes (gruponar.db
// junto a este archivo).
const DATA_DIR = process.env.DATA_DIR;
if (DATA_DIR) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DATABASE_PATH || (DATA_DIR ? path.join(DATA_DIR, 'gruponar.db') : path.join(__dirname, 'gruponar.db'));
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
db.exec(schema);

// CREATE TABLE IF NOT EXISTS no agrega columnas a tablas que ya existían
// antes del cambio de esquema — este helper cubre ese caso para bases de
// datos de desarrollo que ya tenían datos.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`[migration] agregada ${table}.${column}`);
  }
}
ensureColumn('tasks', 'document_url', 'document_url TEXT');
ensureColumn('tasks', 'document_original_name', 'document_original_name TEXT');
ensureColumn('tasks', 'docusign_status', "docusign_status TEXT NOT NULL DEFAULT 'not_sent'");
ensureColumn('documents', 'mime_type', 'mime_type TEXT');
ensureColumn('documents', 'size_bytes', 'size_bytes INTEGER');
ensureColumn('documents', 'original_name', 'original_name TEXT');
// SQLite exige que el DEFAULT de un ADD COLUMN sea una constante — ni
// datetime('now') ni CURRENT_TIMESTAMP califican para una columna NOT NULL
// agregada después. En vez de pelear con eso: columna sin default (nullable),
// se rellenan las filas viejas una sola vez, y las inserciones nuevas
// (routes/deals.js) ponen datetime('now') explícito.
ensureColumn('tasks', 'created_at', 'created_at TEXT');
ensureColumn('documents', 'created_at', 'created_at TEXT');
db.exec(`UPDATE tasks SET created_at = datetime('now') WHERE created_at IS NULL`);
db.exec(`UPDATE documents SET created_at = datetime('now') WHERE created_at IS NULL`);

// El CHECK de users.role no se puede alterar con ADD COLUMN — para agregar
// 'lawyer' a bases de datos que ya tenían la tabla creada con el CHECK
// viejo, hay que recrearla (SQLite no soporta ALTER de constraints).
function ensureUserRoleAllowsLawyer() {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`).get();
  if (row && row.sql.includes("'lawyer'")) return;

  // deals/deal_parties/documents/invites/access_log referencian users(id) —
  // hay que apagar el chequeo de foreign keys mientras se recrea la tabla
  // (no se puede cambiar este pragma dentro de una transacción, por eso va
  // fuera del db.transaction()). Es el procedimiento que la propia
  // documentación de SQLite recomienda para alterar constraints.
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE users_migration_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','agent','lawyer','buyer','seller')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users_migration_new (id, name, email, password_hash, role, created_at)
        SELECT id, name, email, password_hash, role, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_migration_new RENAME TO users;
    `);
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) {
      throw new Error('Migración de users dejaría foreign keys rotas: ' + JSON.stringify(violations));
    }
  })();
  db.pragma('foreign_keys = ON');
  console.log('[migration] users.role ahora acepta \'lawyer\'');
}
ensureUserRoleAllowsLawyer();

// 'active' es una constante literal (no una función como datetime('now')),
// así que sí califica como DEFAULT válido en un ADD COLUMN normal.
ensureColumn('users', 'status', "status TEXT NOT NULL DEFAULT 'active'");

// Qué escrow company usa la operación — determina qué plantilla KYC/escrow
// se ofrece (Armour o TLA). Sin CHECK aquí, igual que el resto de columnas
// agregadas por ensureColumn — se valida en la aplicación (routes/deals.js).
ensureColumn('deals', 'escrow_company', 'escrow_company TEXT');

// Contrato de promesa: qué machote se eligió y en qué estado va (mismo
// patrón de estado/DocuSign que kyc_submissions, pero uno solo por
// operación — a diferencia del KYC no hay "por rol", el contrato es uno
// para ambas partes).
ensureColumn('deals', 'contract_template_id', 'contract_template_id INTEGER');
ensureColumn('deals', 'contract_status', "contract_status TEXT NOT NULL DEFAULT 'draft'");
ensureColumn('deals', 'contract_generated_file_url', 'contract_generated_file_url TEXT');
ensureColumn('deals', 'contract_docusign_envelope_id', 'contract_docusign_envelope_id TEXT');
ensureColumn('deals', 'contract_docusign_status', "contract_docusign_status TEXT NOT NULL DEFAULT 'not_sent'");

// El CHECK de deals.scenario y contract_templates.scenario tampoco se puede
// alterar con ADD COLUMN — mismo procedimiento que ensureUserRoleAllowsLawyer.
// Van al final, después de todos los ensureColumn de arriba, porque hay que
// copiar TODAS las columnas que ya existan en la tabla vieja (incluidas las
// agregadas después de la creación original) o se perderían al recrearla.
function ensureDealsScenarioAllowsTrustTermination() {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='deals'`).get();
  if (row && row.sql.includes("'trust_termination'")) return;

  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE deals_migration_new (
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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        contract_template_id INTEGER,
        contract_status TEXT NOT NULL DEFAULT 'draft',
        contract_generated_file_url TEXT,
        contract_docusign_envelope_id TEXT,
        contract_docusign_status TEXT NOT NULL DEFAULT 'not_sent'
      );
      INSERT INTO deals_migration_new (id, scenario, development, property, price, furniture_price, currency, start_date, seller_name, seller_type, buyer_name, buyer_type, escrow_company, contract_json, created_by, created_at, contract_template_id, contract_status, contract_generated_file_url, contract_docusign_envelope_id, contract_docusign_status)
        SELECT id, scenario, development, property, price, furniture_price, currency, start_date, seller_name, seller_type, buyer_name, buyer_type, escrow_company, contract_json, created_by, created_at, contract_template_id, contract_status, contract_generated_file_url, contract_docusign_envelope_id, contract_docusign_status FROM deals;
      DROP TABLE deals;
      ALTER TABLE deals_migration_new RENAME TO deals;
    `);
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) {
      throw new Error('Migración de deals dejaría foreign keys rotas: ' + JSON.stringify(violations));
    }
  })();
  db.pragma('foreign_keys = ON');
  console.log('[migration] deals.scenario ahora acepta \'trust_termination\'');
}
ensureDealsScenarioAllowsTrustTermination();

function ensureContractTemplatesScenarioAllowsTrustTermination() {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='contract_templates'`).get();
  if (!row || row.sql.includes("'trust_termination'")) return;

  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE contract_templates_migration_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scenario TEXT NOT NULL CHECK(scenario IN ('purchase','trust','transfer','trust_termination')),
        label TEXT NOT NULL,
        docx_file TEXT NOT NULL,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO contract_templates_migration_new (id, scenario, label, docx_file, created_by, created_at)
        SELECT id, scenario, label, docx_file, created_by, created_at FROM contract_templates;
      DROP TABLE contract_templates;
      ALTER TABLE contract_templates_migration_new RENAME TO contract_templates;
    `);
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) {
      throw new Error('Migración de contract_templates dejaría foreign keys rotas: ' + JSON.stringify(violations));
    }
  })();
  db.pragma('foreign_keys = ON');
  console.log('[migration] contract_templates.scenario ahora acepta \'trust_termination\'');
}
ensureContractTemplatesScenarioAllowsTrustTermination();

// invites.deal_id ahora acepta NULL (invitaciones de equipo, no ligadas a
// una operación) y role_in_deal acepta 'lawyer' — mismo procedimiento de
// recrear la tabla que los CHECK de arriba.
function ensureInvitesAllowTeamInvites() {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='invites'`).get();
  if (row && row.sql.includes("'lawyer'")) return;

  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE invites_migration_new (
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
      INSERT INTO invites_migration_new (id, token, deal_id, role_in_deal, email, name, created_by, created_at, expires_at, used_at, used_by_user_id)
        SELECT id, token, deal_id, role_in_deal, email, name, created_by, created_at, expires_at, used_at, used_by_user_id FROM invites;
      DROP TABLE invites;
      ALTER TABLE invites_migration_new RENAME TO invites;
    `);
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) {
      throw new Error('Migración de invites dejaría foreign keys rotas: ' + JSON.stringify(violations));
    }
  })();
  db.pragma('foreign_keys = ON');
  console.log('[migration] invites ahora acepta deal_id NULL y role_in_deal \'lawyer\'');
}
ensureInvitesAllowTeamInvites();

module.exports = db;
