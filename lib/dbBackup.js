const path = require('path');
const fs = require('fs');
const os = require('os');
const db = require('../db');
const gcs = require('./gcsStorage');

// Respaldo diario de la base de datos a Cloud Storage — la base vive en el
// Disk de Render, y un disco que falla (o un error humano con la Papelera
// vacía) sin respaldo significa perder TODAS las operaciones. better-sqlite3
// hace un "online backup" consistente (seguro con WAL, sin parar el
// servidor); el archivo resultante se sube a _backups/ del mismo bucket.
//
// Retención: se conservan los últimos KEEP respaldos (uno por día); los más
// viejos se borran solos. La clave incluye la fecha — si el chequeo corre
// dos veces el mismo día (reinicio), la segunda pasada ve que ya existe y
// no sube nada.
//
// Solo corre en Render (env RENDER=true) — la base local de desarrollo no
// debe pisar el respaldo del día de producción. FORCE_DB_BACKUP=1 permite
// forzarlo a mano (con su propio prefijo si se quiere probar).
const KEEP = 14;

async function runDailyDbBackup(prefix = '_backups/') {
  if (!gcs.isConfigured()) return;
  if (!process.env.RENDER && process.env.FORCE_DB_BACKUP !== '1') return;

  const stamp = new Date().toISOString().slice(0, 10);
  const key = `${prefix}gruponar-${stamp}.db`;
  if (await gcs.existsFile(key)) return; // el respaldo de hoy ya existe

  const tmp = path.join(os.tmpdir(), `gruponar-backup-${stamp}-${process.pid}.db`);
  try {
    await db.backup(tmp);
    await gcs.uploadLocalFile(key, tmp, 'application/vnd.sqlite3');
    console.log(`[backup] base de datos respaldada en ${key}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }

  // Poda: quedarse con los KEEP más recientes (los nombres traen la fecha,
  // así que orden alfabético = orden cronológico).
  try {
    const files = (await gcs.listFiles(prefix)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP))) {
      await gcs.deleteFile(f);
      console.log(`[backup] respaldo viejo eliminado: ${f}`);
    }
  } catch (err) {
    console.error('[backup] no se pudieron podar respaldos viejos:', err.message);
  }
}

module.exports = { runDailyDbBackup };
