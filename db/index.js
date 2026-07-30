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
// Reemplazada por sub_checks_json (abajo) — cada documento de LLC que lo
// requiere ahora tiene sus propias casillas independientes (notarizado,
// apostillado, traducido), no un solo flag de "apostillado". Se deja la
// columna sin usar en vez de recrear la tabla otra vez (no llegó a tener
// datos reales todavía).
ensureColumn('documents', 'apostille_done', 'apostille_done INTEGER NOT NULL DEFAULT 0');
// { "Notarized": true, "Apostilled": false, "Translated": false } — solo
// para los documentos listados en routes/deals.js SUB_CHECKS_BY_DOC.
ensureColumn('documents', 'sub_checks_json', 'sub_checks_json TEXT');
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
ensureColumn('users', 'agency', 'agency TEXT');
// Base de contactos de clientes (admin, ver routes/users.js GET /clients) —
// sin campo propio de captura todavía, admin lo llena a mano o se rellena
// solo desde el KYC (answers.mobilePhone) si ya lo dieron ahí.
ensureColumn('users', 'phone', 'phone TEXT');
// Segundo factor (TOTP, Google Authenticator/Authy/etc.) — obligatorio para
// todos los roles. totp_secret se genera y se guarda desde el primer login
// después de este cambio (sin invalidar la contraseña ya puesta), pero
// totp_enabled se queda en 0 hasta que esa persona confirme un código real
// generado por su app, para no bloquear a nadie con un secreto que nunca
// llegó a escanear.
ensureColumn('users', 'totp_secret', 'totp_secret TEXT');
ensureColumn('users', 'totp_enabled', 'totp_enabled INTEGER NOT NULL DEFAULT 0');
// 'totp' o 'email' — cuál de los dos eligió esta cuenta la primera vez que
// confirmó un código real. NULL mientras no ha elegido todavía (login le
// ofrece las dos opciones). No todos quieren instalar una app de
// autenticador — un comprador/vendedor de una sola operación puede
// preferir un código por correo, que ya sabe usar.
ensureColumn('users', 'two_factor_method', 'two_factor_method TEXT');

// Qué escrow company usa la operación — determina qué plantilla KYC/escrow
// se ofrece (Armour o TLA). Sin CHECK aquí, igual que el resto de columnas
// agregadas por ensureColumn — se valida en la aplicación (routes/deals.js).
ensureColumn('deals', 'escrow_company', 'escrow_company TEXT');
// Fechas clave que define el contrato de promesa — se capturan aparte (no
// se intentan extraer de los campos de texto libre del machote, que
// mezclan prosa legal con la fecha) para poder mostrar los tiempos del
// cierre en orden y, más adelante, condicionar el tracker al fin del
// periodo de due diligence.
ensureColumn('deals', 'closing_date', 'closing_date TEXT');
ensureColumn('deals', 'due_diligence_end_date', 'due_diligence_end_date TEXT');

// Contrato de promesa: qué machote se eligió y en qué estado va (mismo
// patrón de estado/DocuSign que kyc_submissions, pero uno solo por
// operación — a diferencia del KYC no hay "por rol", el contrato es uno
// para ambas partes).
ensureColumn('deals', 'contract_template_id', 'contract_template_id INTEGER');
ensureColumn('deals', 'contract_status', "contract_status TEXT NOT NULL DEFAULT 'draft'");
ensureColumn('deals', 'contract_generated_file_url', 'contract_generated_file_url TEXT');
ensureColumn('deals', 'contract_docusign_envelope_id', 'contract_docusign_envelope_id TEXT');
ensureColumn('deals', 'contract_docusign_status', "contract_docusign_status TEXT NOT NULL DEFAULT 'not_sent'");
ensureColumn('deals', 'drive_folder_id', 'drive_folder_id TEXT');
ensureColumn('deals', 'drive_folder_url', 'drive_folder_url TEXT');

// A qué lado representa un agente en esta operación (solo aplica cuando
// role_in_deal='agent'; NULL para comprador/vendedor, o para agentes viejos
// que todavía no se les asignó lado). No lleva CHECK acá porque
// ensureColumn agrega columnas simples — la validación de 'buyer'/'seller'
// se hace en la ruta, igual que otros campos opcionales de este estilo.
ensureColumn('deal_parties', 'represents_side', 'represents_side TEXT');

// Igual que arriba pero en la invitación misma — para poder elegir a qué
// lado va a representar un agente NUEVO desde el propio formulario de
// invitar, en vez de tener que ir a elegirlo después en la sección de
// agentes de la operación.
ensureColumn('invites', 'represents_side', 'represents_side TEXT');

// Hasta ahora una operación no tenía forma de marcarse como cerrada — solo
// existía el % de checklist/tareas, nada decía "esto ya se cerró, déjalo de
// lado". 'active'/'completed' sin CHECK (igual que agency/represents_side
// arriba) porque ensureColumn solo agrega columnas simples; se valida en la
// ruta. closed_at queda NULL mientras status='active'.
ensureColumn('deals', 'status', "status TEXT NOT NULL DEFAULT 'active'");
ensureColumn('deals', 'closed_at', 'closed_at TEXT');

// "Papelera" — DELETE /api/deals/:id (routes/deals.js) ya no borra la fila
// de una vez: la marca como borrada (deleted_at) y la esconde de todo lo
// normal (lista, dashboard, canAccessDeal), sin tocar sus documentos en
// Cloud Storage todavía. Un admin puede restaurarla (limpia deleted_at) o
// borrarla PARA SIEMPRE aparte (ahí sí se borra la fila y los archivos) —
// antes un solo clic + confirmar en el navegador bastaba para perder una
// operación real sin ninguna forma de recuperarla.
ensureColumn('deals', 'deleted_at', 'deleted_at TEXT');
ensureColumn('deals', 'deleted_by', 'deleted_by INTEGER');

// Texto libre donde admin/abogado interno redactan los actos jurídicos
// exactos de la operación (lo que se lleva a la notaría) — no se deduce
// solo del escenario porque una misma operación puede combinar más de un
// acto o llevar condiciones particulares que hay que dejar por escrito.
ensureColumn('deals', 'legal_acts', 'legal_acts TEXT');

// La tarea "Cuenta de escrow aperturada" nunca traía requires_signature=1 en
// data/scenario-tasks.json, así que la sección de "Firma electrónica" (donde
// vive subir/generar el escrow agreement y mandarlo a firma) nunca se
// mostraba para ella — el botón no faltaba, la tarea nunca calificaba para
// tenerlo. Esto arregla el template para operaciones nuevas (routes/deals.js
// las inserta desde ahí); el UPDATE de abajo corrige, una sola vez, las
// operaciones que ya existían con la tarea sin la bandera.
db.prepare(`
  UPDATE tasks SET requires_signature = 1
  WHERE requires_signature = 0 AND label_es = 'Cuenta de escrow aperturada'
`).run();

// Todas las tareas con firma compartían el mismo botón "Generar escrow
// (Armour)" en el frontend, sin importar de qué tarea se tratara — para
// "KYC y formatos del fiduciario firmados" ese botón no tiene sentido (no
// es un escrow agreement, es un documento del banco que se sube ya
// recibido). doc_type distingue cuál tarea sí sabe generar su propio
// documento desde una plantilla ('escrow') de las que solo se suben a mano
// ('manual') — ver data/scenario-tasks.json.
ensureColumn('tasks', 'doc_type', "doc_type TEXT NOT NULL DEFAULT 'manual'");
db.prepare(`
  UPDATE tasks SET doc_type = 'escrow'
  WHERE doc_type = 'manual' AND label_es = 'Cuenta de escrow aperturada'
`).run();

// Lado que firma una tarea de firma ad-hoc (routes/docusign.js POST
// /deals/:id/tasks) — NULL para las tareas fijas de scenario-tasks.json
// (escrow, etc.), que siempre firman ambos lados.
ensureColumn('tasks', 'sign_side', 'sign_side TEXT');

// Liga una tarea doc_type='kyc_review' (routes/kyc.js ensureKycReviewTask)
// de vuelta al expediente que hay que revisar — así se puede marcar
// automáticamente como hecha cuando admin/abogado interno de verdad lo
// manda a firma, en vez de que sea alguien tachándola a mano sin haber
// mandado nada.
ensureColumn('tasks', 'kyc_submission_id', 'kyc_submission_id INTEGER');

// "Costos de cierre (recibo del notario)" se agregó a data/scenario-docs.json
// como documento de Propiedad — insertPropertyDocs (routes/deals.js) solo
// corre al CREAR una operación, así que las que ya existían nunca lo
// reciben solas. Igual que el resto de estos backfills, es puramente
// aditivo: solo inserta el documento si todavía no existe para esa
// operación, nunca toca ni borra nada que ya esté ahí.
db.prepare(`
  INSERT INTO documents (deal_id, deal_party_entity_id, name, created_at)
  SELECT d.id, NULL, 'Costos de cierre (recibo del notario)', datetime('now')
  FROM deals d
  WHERE NOT EXISTS (
    SELECT 1 FROM documents doc
    WHERE doc.deal_id = d.id AND doc.deal_party_entity_id IS NULL
      AND doc.name = 'Costos de cierre (recibo del notario)'
  )
`).run();

// "Carta de Instrucción a Fiduciario (Instruction Letter to Trustee)" se
// agregó a data/scenario-docs.json como documento de Propiedad para cesión
// de derechos y extinción de fideicomiso — mismo backfill puramente aditivo
// que "Costos de cierre" arriba, para las operaciones de esos dos escenarios
// que ya existían.
db.prepare(`
  INSERT INTO documents (deal_id, deal_party_entity_id, name, created_at)
  SELECT d.id, NULL, 'Carta de Instrucción a Fiduciario (Instruction Letter to Trustee)', datetime('now')
  FROM deals d
  WHERE d.scenario IN ('transfer', 'trust_termination')
    AND NOT EXISTS (
      SELECT 1 FROM documents doc
      WHERE doc.deal_id = d.id AND doc.deal_party_entity_id IS NULL
        AND doc.name = 'Carta de Instrucción a Fiduciario (Instruction Letter to Trustee)'
    )
`).run();

// Comprobantes de pago (a escrow y al notario) se agregaron a
// data/scenario-docs.json como documentos de Propiedad, para todos los
// escenarios — mismo backfill puramente aditivo que los de arriba, para las
// operaciones que ya existían antes de este cambio.
['Comprobante de pago a escrow (Proof of payment to escrow)', 'Comprobante de pago al notario (Proof of payment to notary)'].forEach(name => {
  db.prepare(`
    INSERT INTO documents (deal_id, deal_party_entity_id, name, created_at)
    SELECT d.id, NULL, ?, datetime('now')
    FROM deals d
    WHERE NOT EXISTS (
      SELECT 1 FROM documents doc
      WHERE doc.deal_id = d.id AND doc.deal_party_entity_id IS NULL AND doc.name = ?
    )
  `).run(name, name);
});

// "Bank trust KYC and formats signed" se quitó de data/scenario-tasks.json —
// ese expediente ya se maneja completo por el sistema real de KYC
// (routes/kyc.js); este task de "subir a mano y firmar" en el tracker de
// cierre era un duplicado confuso en la tarjeta de E-signature, que debe
// tener solo el escrow agreement. Solo borra las filas que todavía no
// tengan ningún avance (sin archivo subido ni enviadas a firma) — las que
// ya tengan trabajo real se dejan intactas para no perderlo.
db.prepare(`
  DELETE FROM tasks
  WHERE label_es = 'KYC y formatos del fiduciario firmados'
    AND doc_type = 'manual'
    AND document_url IS NULL
    AND docusign_status = 'not_sent'
`).run();

// Revisión de admin/abogado interno sobre un documento ya subido (para
// rechazarlo si se subió mal o no es válido) — 'pending' hasta que alguien
// lo revise; vuelve a 'pending' cada vez que se sube un archivo nuevo (ver
// routes/deals.js) porque la revisión anterior ya no aplica a ese archivo.
ensureColumn('documents', 'review_status', "review_status TEXT NOT NULL DEFAULT 'pending'");
ensureColumn('documents', 'review_note', 'review_note TEXT');
ensureColumn('documents', 'reviewed_by', 'reviewed_by INTEGER');
ensureColumn('documents', 'reviewed_at', 'reviewed_at TEXT');

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

// Reemplaza el supuesto de "un vendedor + un comprador" por N partes por
// lado, cada una individual o entidad con estructura de propiedad — ver
// db/schema.sql (deal_party_entities, deal_party_owners) para el porqué.
// Es la migración más grande de todas: recrea deals, documents,
// kyc_submissions, deal_parties e invites en una sola transacción,
// backfillando deal_party_entities desde las columnas viejas de deals antes
// de dejarlas ir. Va al final porque depende de que ya existan
// deals.contract_* y invites.deal_party_entity_id-compatible (todas las
// migraciones de arriba).
function ensureDealPartyEntitiesModel() {
  // OJO: no basta con revisar si deal_party_entities existe — schema.sql
  // arriba ya la crea vacía con CREATE TABLE IF NOT EXISTS en cualquier
  // arranque (para instalaciones nuevas), así que en una base de datos
  // vieja la tabla EXISTE pero está sin backfillear cuando este código
  // corre por primera vez. El guard real es: ¿deals TODAVÍA tiene las
  // columnas viejas? Si ya no las tiene, esta migración ya corrió.
  const dealsCols = db.prepare(`PRAGMA table_info(deals)`).all().map(c => c.name);
  if (!dealsCols.includes('seller_name')) return;

  const docCols = db.prepare(`PRAGMA table_info(documents)`).all().map(c => c.name);
  const hasDocExtras = docCols.includes('mime_type');

  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    // deal_party_entities y deal_party_owners ya existen (vacías) — las creó
    // schema.sql con CREATE TABLE IF NOT EXISTS al arrancar, antes de que
    // este código corriera. No hace falta (ni se puede) volver a crearlas.

    // 2. Backfill: cada deal vieja tenía exactamente 1 vendedor y 1
    // comprador — se vuelven la fila sort_order=0 de cada lado.
    // ownership_mode queda NULL (nunca se capturó estructura de propiedad
    // antes de este cambio); la UI debe poder completarla después.
    db.exec(`
      INSERT INTO deal_party_entities (deal_id, side, sort_order, party_type, name)
        SELECT id, 'seller', 0, seller_type, seller_name FROM deals;
      INSERT INTO deal_party_entities (deal_id, side, sort_order, party_type, name)
        SELECT id, 'buyer', 0, buyer_type, buyer_name FROM deals;
    `);

    // 3. documents: owner ('seller'/'buyer') → deal_party_entity_id.
    db.exec(`
      CREATE TABLE documents_migration_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        deal_party_entity_id INTEGER NOT NULL REFERENCES deal_party_entities(id) ON DELETE CASCADE,
        sub_label TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done')),
        file_url TEXT,
        uploaded_by INTEGER REFERENCES users(id),
        uploaded_at TEXT,
        mime_type TEXT,
        size_bytes INTEGER,
        original_name TEXT,
        created_at TEXT
      );
      INSERT INTO documents_migration_new (id, deal_id, deal_party_entity_id, name, status, file_url, uploaded_by, uploaded_at, mime_type, size_bytes, original_name, created_at)
        SELECT d.id, d.deal_id,
          (SELECT dpe.id FROM deal_party_entities dpe WHERE dpe.deal_id = d.deal_id AND dpe.side = d.owner AND dpe.sort_order = 0),
          d.name, d.status, d.file_url, d.uploaded_by, d.uploaded_at,
          ${hasDocExtras ? 'd.mime_type, d.size_bytes, d.original_name' : 'NULL, NULL, NULL'}, d.created_at
        FROM documents d;
      DROP TABLE documents;
      ALTER TABLE documents_migration_new RENAME TO documents;
    `);

    // 4. kyc_submissions: role_in_deal → deal_party_entity_id.
    db.exec(`
      CREATE TABLE kyc_submissions_migration_new (
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
      INSERT INTO kyc_submissions_migration_new (id, deal_id, deal_party_entity_id, template_key, answers_json, status, generated_file_url, docusign_envelope_id, docusign_status, created_by, created_at, updated_at)
        SELECT k.id, k.deal_id,
          (SELECT dpe.id FROM deal_party_entities dpe WHERE dpe.deal_id = k.deal_id AND dpe.side = k.role_in_deal AND dpe.sort_order = 0),
          k.template_key, k.answers_json, k.status, k.generated_file_url, k.docusign_envelope_id, k.docusign_status, k.created_by, k.created_at, k.updated_at
        FROM kyc_submissions k;
      DROP TABLE kyc_submissions;
      ALTER TABLE kyc_submissions_migration_new RENAME TO kyc_submissions;
    `);

    // 5. deal_parties: agrega deal_party_entity_id (NULL para agentes).
    db.exec(`
      CREATE TABLE deal_parties_migration_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role_in_deal TEXT NOT NULL CHECK(role_in_deal IN ('buyer','seller','agent')),
        deal_party_entity_id INTEGER REFERENCES deal_party_entities(id) ON DELETE CASCADE,
        UNIQUE(deal_id, user_id),
        UNIQUE(deal_party_entity_id)
      );
      INSERT INTO deal_parties_migration_new (id, deal_id, user_id, role_in_deal, deal_party_entity_id)
        SELECT dp.id, dp.deal_id, dp.user_id, dp.role_in_deal,
          (SELECT dpe.id FROM deal_party_entities dpe WHERE dpe.deal_id = dp.deal_id AND dpe.side = dp.role_in_deal AND dpe.sort_order = 0)
        FROM deal_parties dp;
      DROP TABLE deal_parties;
      ALTER TABLE deal_parties_migration_new RENAME TO deal_parties;
    `);

    // 6. invites: agrega deal_party_entity_id (NULL para team invites o
    // invitaciones pendientes viejas — se resuelven solas al aceptar).
    db.exec(`
      CREATE TABLE invites_migration_new2 (
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
      INSERT INTO invites_migration_new2 (id, token, deal_id, deal_party_entity_id, role_in_deal, email, name, created_by, created_at, expires_at, used_at, used_by_user_id)
        SELECT i.id, i.token, i.deal_id,
          CASE WHEN i.deal_id IS NOT NULL AND i.role_in_deal IN ('buyer','seller')
            THEN (SELECT dpe.id FROM deal_party_entities dpe WHERE dpe.deal_id = i.deal_id AND dpe.side = i.role_in_deal AND dpe.sort_order = 0)
            ELSE NULL END,
          i.role_in_deal, i.email, i.name, i.created_by, i.created_at, i.expires_at, i.used_at, i.used_by_user_id
        FROM invites i;
      DROP TABLE invites;
      ALTER TABLE invites_migration_new2 RENAME TO invites;
    `);

    // 7. deals: al final — ya no hacen falta seller_name/type, buyer_name/type.
    db.exec(`
      CREATE TABLE deals_migration_new2 (
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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        contract_template_id INTEGER,
        contract_status TEXT NOT NULL DEFAULT 'draft',
        contract_generated_file_url TEXT,
        contract_docusign_envelope_id TEXT,
        contract_docusign_status TEXT NOT NULL DEFAULT 'not_sent'
      );
      INSERT INTO deals_migration_new2 (id, scenario, development, property, price, furniture_price, currency, start_date, escrow_company, contract_json, created_by, created_at, contract_template_id, contract_status, contract_generated_file_url, contract_docusign_envelope_id, contract_docusign_status)
        SELECT id, scenario, development, property, price, furniture_price, currency, start_date, escrow_company, contract_json, created_by, created_at, contract_template_id, contract_status, contract_generated_file_url, contract_docusign_envelope_id, contract_docusign_status
        FROM deals;
      DROP TABLE deals;
      ALTER TABLE deals_migration_new2 RENAME TO deals;
    `);

    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) {
      throw new Error('Migración de deal_party_entities dejaría foreign keys rotas: ' + JSON.stringify(violations));
    }
  })();
  db.pragma('foreign_keys = ON');
  console.log('[migration] modelo deal_party_entities aplicado (vendedores/compradores múltiples + estructura de propiedad)');
}
ensureDealPartyEntitiesModel();

// Escritura pública y Predial son de LA PROPIEDAD, no de cada vendedor — con
// el modelo de partes múltiples (ver ensureDealPartyEntitiesModel arriba)
// terminaban pidiéndose una vez POR CADA vendedor, duplicados. Se vuelve
// deal_party_entity_id nullable (NULL = documento a nivel de operación,
// "Propiedad") y se deduplican los que ya existan de operaciones creadas
// mientras existió el bug.
function ensureDocumentsPropertyLevel() {
  const col = db.prepare(`PRAGMA table_info(documents)`).all().find(c => c.name === 'deal_party_entity_id');
  if (!col || col.notnull === 0) return; // ya migrado

  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE documents_migration_new3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        deal_party_entity_id INTEGER REFERENCES deal_party_entities(id) ON DELETE CASCADE,
        sub_label TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done')),
        file_url TEXT,
        uploaded_by INTEGER REFERENCES users(id),
        uploaded_at TEXT,
        mime_type TEXT,
        size_bytes INTEGER,
        original_name TEXT,
        created_at TEXT,
        apostille_done INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO documents_migration_new3
        (id, deal_id, deal_party_entity_id, sub_label, name, status, file_url, uploaded_by, uploaded_at, mime_type, size_bytes, original_name, created_at, apostille_done)
        SELECT id, deal_id, deal_party_entity_id, sub_label, name, status, file_url, uploaded_by, uploaded_at, mime_type, size_bytes, original_name, created_at, apostille_done
        FROM documents;
      DROP TABLE documents;
      ALTER TABLE documents_migration_new3 RENAME TO documents;
    `);

    // Deduplicar Escritura pública / Predial ya insertados por vendedor
    // (bug de antes de este cambio): nos quedamos con 1 copia por operación
    // — la que ya tenga archivo subido, si alguna lo tiene — la volvemos
    // documento de operación (deal_party_entity_id NULL), conservamos
    // "done" si CUALQUIERA de las copias ya estaba marcada, y borramos el
    // resto.
    const PROPERTY_DOC_NAMES = ['Escritura pública', 'Predial'];
    const dealIds = db.prepare('SELECT id FROM deals').all().map(d => d.id);
    const findDocs = db.prepare(`SELECT * FROM documents WHERE deal_id = ? AND name = ? AND deal_party_entity_id IS NOT NULL ORDER BY id`);
    dealIds.forEach(dealId => {
      PROPERTY_DOC_NAMES.forEach(name => {
        const rows = findDocs.all(dealId, name);
        if (!rows.length) return;
        const keep = rows.find(r => r.file_url) || rows[0];
        const anyDone = rows.some(r => r.status === 'done');
        db.prepare('UPDATE documents SET deal_party_entity_id = NULL, status = ? WHERE id = ?').run(anyDone ? 'done' : keep.status, keep.id);
        const dropIds = rows.filter(r => r.id !== keep.id).map(r => r.id);
        if (dropIds.length) db.prepare(`DELETE FROM documents WHERE id IN (${dropIds.map(() => '?').join(',')})`).run(...dropIds);
      });
    });

    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) {
      throw new Error('Migración de documentos a nivel de operación dejaría foreign keys rotas: ' + JSON.stringify(violations));
    }
  })();
  db.pragma('foreign_keys = ON');
  console.log('[migration] documents.deal_party_entity_id nullable (documentos de Propiedad a nivel de operación) + deduplicación de Escritura/Predial');
}
ensureDocumentsPropertyLevel();

// Red de seguridad idempotente: por cada operación, revisa que existan TODOS
// los documentos de Propiedad que le tocan según su escenario (ver
// data/scenario-docs.json .property) y agrega los que falten. Cubre
// operaciones creadas antes de que existiera este concepto (la migración de
// arriba solo alcanza a convertir documentos de Escritura/Predial que YA
// existían de algún vendedor — si esa operación tenía únicamente vendedores
// persona moral/LLC, nunca tuvo esos documentos que convertir, y se quedaba
// sin sección de Propiedad). Corre en cada arranque porque es barato
// (una operación con pocos documentos) y no depende de detectar "¿ya corrió
// antes?" — simplemente no inserta lo que ya existe.
function ensurePropertyDocsBackfill() {
  const SCENARIO_DOCS = require('../data/scenario-docs.json');
  const deals = db.prepare('SELECT id, scenario FROM deals').all();
  const insertDoc = db.prepare("INSERT INTO documents (deal_id, deal_party_entity_id, name, created_at) VALUES (?,NULL,?,datetime('now'))");
  let added = 0;
  deals.forEach(deal => {
    const wanted = (SCENARIO_DOCS[deal.scenario] && SCENARIO_DOCS[deal.scenario].property) || [];
    if (!wanted.length) return;
    const existing = new Set(
      db.prepare('SELECT name FROM documents WHERE deal_id = ? AND deal_party_entity_id IS NULL').all(deal.id).map(d => d.name)
    );
    wanted.forEach(name => {
      if (!existing.has(name)) { insertDoc.run(deal.id, name); added++; }
    });
  });
  if (added) console.log(`[migration] ${added} documento(s) de Propiedad agregados a operaciones que les faltaban`);
}
ensurePropertyDocsBackfill();

// 'external_lawyer' — abogado externo (del despacho del comprador/vendedor,
// no de Grupo Nar): se comporta como 'agent' en todos lados (se liga por
// deal_parties a operaciones específicas, puede elegir a qué lado
// representa) en vez de como 'lawyer' interno, que ve TODAS las operaciones
// sin restricción (UNRESTRICTED_ROLES en lib/access.js) — un despacho
// externo no debe tener esa visibilidad global.
function ensureUserRoleAllowsExternalLawyer() {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`).get();
  if (row && row.sql.includes("'external_lawyer'")) return;

  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE users_migration_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','agent','lawyer','external_lawyer','buyer','seller')),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending','active')),
        agency TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users_migration_new (id, name, email, password_hash, role, status, agency, created_at)
        SELECT id, name, email, password_hash, role, status, agency, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_migration_new RENAME TO users;
    `);
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) {
      throw new Error('Migración de users dejaría foreign keys rotas: ' + JSON.stringify(violations));
    }
  })();
  db.pragma('foreign_keys = ON');
  console.log('[migration] users.role ahora acepta \'external_lawyer\'');
}
ensureUserRoleAllowsExternalLawyer();

module.exports = db;
