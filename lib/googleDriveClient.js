const { google } = require('googleapis');
const db = require('../db');

// Carpetas fijas dentro de cada operación — mismo criterio que ya usa el
// checklist de documentos (ver data/scenario-docs.json), para que la
// estructura de Drive se sienta igual a la del portal.
const DEAL_SUBFOLDERS = ['Propiedad', 'Vendedor', 'Comprador', 'Escrow', 'Notaría'];

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function redirectUri(req) {
  return process.env.GOOGLE_OAUTH_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/google-drive/oauth/callback`;
}

function oauthClient(req) {
  return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirectUri(req));
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

function isConnected() {
  return !!getSetting('google_refresh_token');
}

// Un solo consentimiento (access_type=offline + prompt=consent) para que
// Google mande el refresh_token — sin eso solo daría un token de acceso que
// expira en 1h y no se podría renovar solo.
function getAuthUrl(req) {
  const client = oauthClient(req);
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive']
  });
}

async function exchangeCodeForTokens(req, code) {
  const client = oauthClient(req);
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error('Google no mandó un refresh token — revoca el acceso de la app en myaccount.google.com/permissions y vuelve a intentar (pasa si ya se había conectado antes con esta cuenta).');
  }
  setSetting('google_refresh_token', tokens.refresh_token);
}

function disconnect() {
  db.prepare("DELETE FROM app_settings WHERE key = 'google_refresh_token'").run();
}

// Cliente autorizado listo para llamar a la API de Drive — usa el
// refresh_token guardado para sacar un access_token nuevo en cada llamada
// (la librería lo cachea internamente durante la vida del proceso).
function getAuthorizedClient(req) {
  const refreshToken = getSetting('google_refresh_token');
  if (!refreshToken) {
    const err = new Error('Google Drive no está conectado todavía — ve a Equipo → Integraciones y conéctalo.');
    err.code = 'not_connected';
    throw err;
  }
  const client = oauthClient(req);
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

async function findFolderByName(drive, name, parentId) {
  const q = [
    `name = '${name.replace(/'/g, "\\'")}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    'trashed = false',
    parentId ? `'${parentId}' in parents` : "'root' in parents"
  ].join(' and ');
  const res = await drive.files.list({ q, fields: 'files(id, name)', spaces: 'drive' });
  return res.data.files && res.data.files[0] ? res.data.files[0] : null;
}

async function createFolder(drive, name, parentId) {
  const res = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: parentId ? [parentId] : undefined },
    fields: 'id'
  });
  return res.data.id;
}

// Busca (o crea si todavía no existe, ej. al cruzar de año) la carpeta
// "Closings {año}" directamente en la raíz del Drive del usuario conectado
// — así es como Stefano ya organiza sus cierres a mano, una carpeta nueva
// por año calendario.
async function findOrCreateYearFolder(drive, year) {
  const name = `Closings ${year}`;
  const existing = await findFolderByName(drive, name, null);
  if (existing) return existing.id;
  return createFolder(drive, name, null);
}

// Crea (si no existe ya) la carpeta de la operación dentro de la carpeta del
// año actual, con las 5 subcarpetas fijas adentro. Idempotente: si ya existe
// una carpeta con ese nombre en el año en curso, la reutiliza en vez de
// duplicarla (puede pasar si se reintenta después de una falla a medias).
async function createDealFolderStructure(req, propertyName) {
  const client = getAuthorizedClient(req);
  const drive = google.drive({ version: 'v3', auth: client });

  const year = new Date().getFullYear();
  const yearFolderId = await findOrCreateYearFolder(drive, year);

  let dealFolder = await findFolderByName(drive, propertyName, yearFolderId);
  const dealFolderId = dealFolder ? dealFolder.id : await createFolder(drive, propertyName, yearFolderId);

  for (const sub of DEAL_SUBFOLDERS) {
    const existingSub = await findFolderByName(drive, sub, dealFolderId);
    if (!existingSub) await createFolder(drive, sub, dealFolderId);
  }

  return { folderId: dealFolderId, folderUrl: `https://drive.google.com/drive/folders/${dealFolderId}` };
}

module.exports = { isConfigured, isConnected, getAuthUrl, exchangeCodeForTokens, disconnect, createDealFolderStructure };
