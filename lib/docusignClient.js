const fs = require('fs');
const docusign = require('docusign-esign');

// Cache en memoria — no hace falta persistirlo en la base de datos, perder
// el token al reiniciar el servidor solo cuesta una llamada extra a DocuSign.
let cached = { token: null, expiresAt: 0 };

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

// Devuelve la URL de consentimiento de un solo uso — hay que abrirla una vez
// en un navegador (logueado como DOCUSIGN_USER_ID) y darle "Allow" antes de
// que el JWT grant funcione. DocuSign responde 'consent_required' hasta que
// eso pase.
function consentUrl() {
  const oauthBase = process.env.DOCUSIGN_OAUTH_BASE_PATH || 'account-d.docusign.com';
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
  apiClient.setOAuthBasePath(process.env.DOCUSIGN_OAUTH_BASE_PATH || 'account-d.docusign.com');
  const privateKey = loadPrivateKey();

  try {
    const results = await apiClient.requestJWTUserToken(
      process.env.DOCUSIGN_INTEGRATION_KEY,
      process.env.DOCUSIGN_USER_ID,
      ['signature', 'impersonation'],
      privateKey,
      3600
    );
    cached.token = results.body.access_token;
    cached.expiresAt = Date.now() + (results.body.expires_in - 60) * 1000; // refresca 60s antes
    return cached.token;
  } catch (err) {
    const dsError = err?.response?.data?.error;
    if (dsError === 'consent_required') {
      const e = new Error(
        `DocuSign necesita consentimiento único: abre esta URL en un navegador (logueado como el usuario DOCUSIGN_USER_ID) y da "Allow": ${consentUrl()}`
      );
      e.code = 'consent_required';
      throw e;
    }
    throw err;
  }
}

// ApiClient listo para llamar a EnvelopesApi (basePath + token ya puestos).
async function getAuthorizedApiClient() {
  const token = await getAccessToken();
  const apiClient = new docusign.ApiClient();
  apiClient.setBasePath(process.env.DOCUSIGN_BASE_PATH || 'https://demo.docusign.net/restapi');
  apiClient.addDefaultHeader('Authorization', 'Bearer ' + token);
  return apiClient;
}

module.exports = { isConfigured, getAccessToken, getAuthorizedApiClient, consentUrl };
