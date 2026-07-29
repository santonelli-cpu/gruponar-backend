const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Mismo DATA_DIR que db/index.js — en producción vive en el disco
// persistente montado; en local, sin DATA_DIR, sigue siendo uploads/ junto
// al proyecto (comportamiento sin cambios).
const UPLOADS_ROOT = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'uploads')
  : path.join(__dirname, '..', 'uploads');

function dealDir(dealId) {
  const dir = path.join(UPLOADS_ROOT, String(dealId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Nunca usar el nombre original del archivo en el path (evita path traversal
// y colisiones) — el nombre original se guarda aparte en la base de datos
// solo para mostrarlo/descargarlo con su nombre real.
function genFilename(originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  return crypto.randomBytes(16).toString('hex') + ext;
}

module.exports = { UPLOADS_ROOT, dealDir, genFilename };
