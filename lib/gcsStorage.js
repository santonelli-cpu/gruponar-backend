const { Storage } = require('@google-cloud/storage');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Reemplaza el disco local (lib/storage.js) como backend real de archivos —
// documentos del checklist, expedientes KYC generados, contratos, escrow
// agreements. Las mismas claves relativas que antes se guardaban como rutas
// de disco ("<dealId>/<archivo>") ahora son el nombre del objeto dentro del
// bucket — no hizo falta cambiar ninguna columna de la base de datos.

function isConfigured() {
  return !!(process.env.GCS_BUCKET_NAME && process.env.GCS_SERVICE_ACCOUNT_JSON);
}

let _bucket = null;
function bucket() {
  if (_bucket) return _bucket;
  const credentials = JSON.parse(process.env.GCS_SERVICE_ACCOUNT_JSON);
  const storage = new Storage({ projectId: credentials.project_id, credentials });
  _bucket = storage.bucket(process.env.GCS_BUCKET_NAME);
  return _bucket;
}

async function uploadBuffer(key, buffer, contentType) {
  await bucket().file(key).save(buffer, { contentType, resumable: false });
  return key;
}

// Para archivos que un binario externo (LibreOffice, zip) ya escribió en
// disco local — se sube tal cual y se puede borrar el local después.
async function uploadLocalFile(key, localPath, contentType) {
  await bucket().upload(localPath, { destination: key, resumable: false, metadata: contentType ? { contentType } : undefined });
  return key;
}

async function downloadToBuffer(key) {
  const [buf] = await bucket().file(key).download();
  return buf;
}

// Para pasos que necesitan un archivo REAL en disco (LibreOffice, unzip,
// pdfinfo no saben leer un bucket) — descarga a un temporal y devuelve la
// ruta; quien la use es responsable de borrarla cuando termine.
async function downloadToTempFile(key) {
  const tmpPath = path.join(os.tmpdir(), crypto.randomBytes(16).toString('hex') + path.extname(key));
  await bucket().file(key).download({ destination: tmpPath });
  return tmpPath;
}

async function existsFile(key) {
  const [ok] = await bucket().file(key).exists();
  return ok;
}

// Envía el objeto directamente en la respuesta (reemplaza res.sendFile) —
// setea los headers antes de hacer streaming.
function streamToResponse(key, res, { contentType, downloadName, inline } = {}) {
  return new Promise((resolve, reject) => {
    if (contentType) res.setHeader('Content-Type', contentType);
    if (downloadName) {
      res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${downloadName.replace(/"/g, '')}"`);
    }
    bucket().file(key).createReadStream()
      .on('error', (err) => { if (!res.headersSent) res.status(404); reject(err); })
      .on('end', resolve)
      .pipe(res);
  });
}

async function deleteFile(key) {
  await bucket().file(key).delete({ ignoreNotFound: true });
}

// Borra todo lo de una operación (usado al eliminar el deal completo) — el
// bucket organiza los objetos igual que el disco: todo bajo "<dealId>/...".
async function deletePrefix(prefix) {
  await bucket().deleteFiles({ prefix, force: true });
}

module.exports = {
  isConfigured, uploadBuffer, uploadLocalFile, downloadToBuffer, downloadToTempFile,
  existsFile, streamToResponse, deleteFile, deletePrefix
};
