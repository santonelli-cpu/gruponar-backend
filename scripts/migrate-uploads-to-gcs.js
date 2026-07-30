// Migración de un solo uso: copia todo lo que haya en el disco local
// (uploads/, o $DATA_DIR/uploads en Render) al bucket de Cloud Storage, con
// la misma ruta relativa como nombre de objeto — así los registros ya
// guardados en la base de datos (documents.file_url, kyc_submissions.
// generated_file_url, deals.contract_generated_file_url, tasks.document_url,
// contract_templates.docx_file) siguen apuntando al mismo lugar sin tocar
// ninguna fila.
//
// Uso: node scripts/migrate-uploads-to-gcs.js
// (en Render: pestaña "Shell" del servicio, mismo comando — ya tiene
// GCS_BUCKET_NAME/GCS_SERVICE_ACCOUNT_JSON/DATA_DIR en el entorno)
//
// Es seguro correrlo más de una vez: simplemente vuelve a subir lo mismo.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { UPLOADS_ROOT } = require('../lib/storage');
const gcsStorage = require('../lib/gcsStorage');

function walk(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, out);
    } else {
      out.push(path.relative(base, full));
    }
  }
}

async function main() {
  if (!gcsStorage.isConfigured()) {
    console.error('Falta GCS_BUCKET_NAME/GCS_SERVICE_ACCOUNT_JSON en el entorno — no hay nada que hacer.');
    process.exit(1);
  }
  if (!fs.existsSync(UPLOADS_ROOT)) {
    console.log(`No existe ${UPLOADS_ROOT} — no hay archivos locales que migrar.`);
    return;
  }

  const files = [];
  walk(UPLOADS_ROOT, UPLOADS_ROOT, files);
  console.log(`Encontrados ${files.length} archivo(s) en ${UPLOADS_ROOT}.`);

  let ok = 0, failed = 0;
  for (const relPath of files) {
    const key = relPath.split(path.sep).join('/'); // Windows no aplica acá pero por si acaso
    try {
      await gcsStorage.uploadLocalFile(key, path.join(UPLOADS_ROOT, relPath));
      ok++;
      console.log(`  ✓ ${key}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${key}: ${err.message}`);
    }
  }
  console.log(`\nListo: ${ok} subidos, ${failed} con error.`);
}

main();
