const fs = require('fs');
const docusign = require('docusign-esign');

// Cache en memoria — no hace falta persistirlo en la base de datos, perder
// el token al reiniciar el servidor solo cuesta una llamada extra a DocuSign.
// basePath/accountId también se cachean junto con el token porque se
// descubren dinámicamente (ver getAccessToken) y no cambian mientras el
// token siga vigente.
let cached = { token: null, expiresAt: 0, basePath: null, accountId: null };

function isConfigured() {
  return !!(
    process.env.DOCUSIGN_INTEGRATION_KEY &&
    process.env.DOCUSIGN_USER_ID &&
    process.env.DOCUSIGN_ACCOUNT_ID &&
    (process.env.DOCUSIGN_PRIVATE_KEY_PATH || process.env.DOCUSIGN_PRIVATE_KEY)
  );
}

// La llave privada puede venir de un archivo local (DOCUSIGN_PRIVATE_KEY_PATH,
// cómodo en tu máquina) o directamente como texto en una variable de entorno
// (DOCUSIGN_PRIVATE_KEY — necesario en hosts como Render/Railway donde subir
// un archivo .pem no es práctico; pega el PEM completo, con los saltos de
// línea reales, como valor de la variable).
function loadPrivateKey() {
  if (process.env.DOCUSIGN_PRIVATE_KEY) return process.env.DOCUSIGN_PRIVATE_KEY;
  return fs.readFileSync(process.env.DOCUSIGN_PRIVATE_KEY_PATH);
}

// Los valores de entorno a veces vienen con protocolo/espacios de más (ej.
// alguien pega "https://account.docusign.com" en vez de "account.docusign.com"
// en la variable de entorno) — el SDK arma la URL como https://${host}, así
// que un protocolo de más produce "https://https://..." y truena la llamada
// con un error de red que no dice claramente cuál es el problema. Limpiarlo
// aquí hace que ese error de dedo deje de importar.
function normalizeHost(value, fallback) {
  return String(value || fallback).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

// Devuelve la URL de consentimiento de un solo uso — hay que abrirla una vez
// en un navegador (logueado como DOCUSIGN_USER_ID) y darle "Allow" antes de
// que el JWT grant funcione. DocuSign responde 'consent_required' hasta que
// eso pase.
function consentUrl() {
  const oauthBase = normalizeHost(process.env.DOCUSIGN_OAUTH_BASE_PATH, 'account-d.docusign.com');
  const params = new URLSearchParams({
    response_type: 'code',
    scope: 'signature impersonation',
    client_id: process.env.DOCUSIGN_INTEGRATION_KEY,
    redirect_uri: process.env.DOCUSIGN_CONSENT_REDIRECT_URI || 'https://developers.docusign.com/platform/auth/consent'
  });
  return `https://${oauthBase}/oauth/auth?${params.toString()}`;
}

async function getAccessToken() {
  if (cached.token && Date.now() < cached.expiresAt) return cached.token;

  const apiClient = new docusign.ApiClient();
  apiClient.setOAuthBasePath(normalizeHost(process.env.DOCUSIGN_OAUTH_BASE_PATH, 'account-d.docusign.com'));
  const privateKey = loadPrivateKey();

  let accessToken, expiresIn;
  try {
    const results = await apiClient.requestJWTUserToken(
      process.env.DOCUSIGN_INTEGRATION_KEY,
      process.env.DOCUSIGN_USER_ID,
      ['signature', 'impersonation'],
      privateKey,
      3600
    );
    accessToken = results.body.access_token;
    expiresIn = results.body.expires_in;
  } catch (err) {
    const dsError = err?.response?.data?.error;
    if (dsError === 'consent_required') {
      const e = new Error(
        `DocuSign necesita consentimiento único: abre esta URL en un navegador (logueado como el usuario DOCUSIGN_USER_ID) y da "Allow": ${consentUrl()}`
      );
      e.code = 'consent_required';
      throw e;
    }
    throw new Error(`Error pidiendo el token JWT a DocuSign: ${err.message || err}`);
  }

  // La URL real de la API (base_uri) depende del centro de datos donde vive
  // la cuenta (na1/na2/na3/eu/...) y NO es la misma para todas las cuentas
  // de producción — adivinarla a mano (como hacía antes el default fijo a
  // demo.docusign.net) rompe en cuanto se pasa a producción con un error de
  // autorización que no dice claramente "la URL está mal". DocuSign
  // recomienda descubrirla siempre con /oauth/userinfo en vez de fijarla —
  // si hay más de una cuenta ligada a este usuario, se usa
  // DOCUSIGN_ACCOUNT_ID para elegir cuál (si no se puso, la que sea default).
  let userInfo;
  try {
    userInfo = await apiClient.getUserInfo(accessToken);
  } catch (err) {
    throw new Error(`DocuSign autorizó el token pero falló /oauth/userinfo (revisa DOCUSIGN_OAUTH_BASE_PATH — debe ser solo el host, ej. "account.docusign.com", sin "https://"): ${err.message || err}`);
  }
  const wantedAccountId = process.env.DOCUSIGN_ACCOUNT_ID && process.env.DOCUSIGN_ACCOUNT_ID.trim();
  const account = wantedAccountId
    ? userInfo.accounts.find(a => a.accountId.toLowerCase() === wantedAccountId.toLowerCase())
    : (userInfo.accounts.find(a => a.isDefault === 'true') || userInfo.accounts[0]);
  if (!account) {
    throw new Error(`No se encontró${wantedAccountId ? ` la cuenta ${wantedAccountId}` : ' ninguna cuenta'} de DocuSign para este usuario (DOCUSIGN_USER_ID) — cuentas disponibles: ${(userInfo.accounts || []).map(a => a.accountId).join(', ') || 'ninguna'}.`);
  }

  cached.token = accessToken;
  cached.expiresAt = Date.now() + (expiresIn - 60) * 1000; // refresca 60s antes
  cached.basePath = `${account.baseUri}/restapi`;
  cached.accountId = account.accountId;
  return cached.token;
}

// ApiClient listo para llamar a EnvelopesApi (basePath + token ya puestos).
async function getAuthorizedApiClient() {
  const token = await getAccessToken();
  const apiClient = new docusign.ApiClient();
  apiClient.setBasePath(cached.basePath);
  apiClient.addDefaultHeader('Authorization', 'Bearer ' + token);
  return apiClient;
}

// El account_id verificado por DocuSign mismo (ver getAccessToken arriba) —
// úsalo en vez de leer process.env.DOCUSIGN_ACCOUNT_ID directamente, así
// nunca se le manda a la API un id que no corresponda al base_uri ya resuelto.
async function getAccountId() {
  await getAccessToken();
  return cached.accountId;
}

// Descarga el documento YA FIRMADO de un sobre completado (con la firma
// aplicada, no el PDF original en blanco que se mandó a firmar) — se usa
// cuando el estado del sobre pasa a "completed", para que "Ver documento"
// muestre lo que realmente se firmó, no el borrador previo.
async function downloadEnvelopeDocument(envelopeId, documentId = '1') {
  const apiClient = await getAuthorizedApiClient();
  const envelopesApi = new docusign.EnvelopesApi(apiClient);
  return envelopesApi.getDocument(await getAccountId(), envelopeId, documentId);
}

module.exports = { isConfigured, getAccessToken, getAuthorizedApiClient, getAccountId, downloadEnvelopeDocument, consentUrl };
