// Genera llamadas de prueba a la API de DocuSign (sandbox) con tu
// Integration Key, para cumplir el requisito de "20+ test API calls" del
// formulario de verificación de Go Live. No contiene ningún secreto — lee
// todo de variables de entorno que TÚ pones al correrlo, así tu llave
// privada nunca queda guardada en ningún archivo de este proyecto.
//
// Uso (en tu propia terminal, no le pases esto a Claude):
//   export DOCUSIGN_INTEGRATION_KEY=0a5ae437-af4a-4462-a913-a16884dc050c
//   export DOCUSIGN_USER_ID=b8f580e3-12bd-4f8b-8f6a-15bb13b83696
//   export DOCUSIGN_PRIVATE_KEY_PATH=/ruta/a/tu/llave.pem
//   node scripts/docusign-test-calls.js
//
// La primera vez, si sale un error que dice "consent_required" con un link,
// ábrelo en tu navegador (logueado con ese User ID) y dale "Allow" — luego
// vuelve a correr el script.
const docusign = require('docusign-esign');
const fs = require('fs');

const INTEGRATION_KEY = process.env.DOCUSIGN_INTEGRATION_KEY;
const USER_ID = process.env.DOCUSIGN_USER_ID;
const PRIVATE_KEY = process.env.DOCUSIGN_PRIVATE_KEY || (process.env.DOCUSIGN_PRIVATE_KEY_PATH && fs.readFileSync(process.env.DOCUSIGN_PRIVATE_KEY_PATH));
const OAUTH_BASE_PATH = process.env.DOCUSIGN_OAUTH_BASE_PATH || 'account-d.docusign.com'; // sandbox por default

if (!INTEGRATION_KEY || !USER_ID || !PRIVATE_KEY) {
  console.error('Faltan DOCUSIGN_INTEGRATION_KEY / DOCUSIGN_USER_ID / DOCUSIGN_PRIVATE_KEY(_PATH) en el entorno.');
  process.exit(1);
}

function consentUrl() {
  const params = new URLSearchParams({
    response_type: 'code',
    scope: 'signature impersonation',
    client_id: INTEGRATION_KEY,
    redirect_uri: 'https://developers.docusign.com/platform/auth/consent'
  });
  return `https://${OAUTH_BASE_PATH}/oauth/auth?${params.toString()}`;
}

async function main() {
  const apiClient = new docusign.ApiClient();
  apiClient.setOAuthBasePath(OAUTH_BASE_PATH);

  console.log('Integration Key:', INTEGRATION_KEY);
  console.log('User ID:', USER_ID);
  console.log('Llave privada — primera línea:', PRIVATE_KEY.toString().split('\n')[0]);
  console.log('Llave privada — largo:', PRIVATE_KEY.toString().length, 'caracteres\n');

  let token, accountId, basePath;
  try {
    const results = await apiClient.requestJWTUserToken(INTEGRATION_KEY, USER_ID, ['signature', 'impersonation'], PRIVATE_KEY, 3600);
    token = results.body.access_token;
  } catch (err) {
    const dsError = err?.response?.data?.error;
    if (dsError === 'consent_required') {
      console.error('\nFalta el consentimiento único — abre esto en tu navegador y dale "Allow":\n' + consentUrl() + '\n');
      process.exit(1);
    }
    console.error('\nRespuesta completa del error de DocuSign:');
    console.error(JSON.stringify(err?.response?.data || { message: err.message }, null, 2));
    process.exit(1);
  }

  apiClient.addDefaultHeader('Authorization', 'Bearer ' + token);
  const userInfo = await apiClient.getUserInfo(token);
  accountId = userInfo.accounts[0].accountId;
  basePath = userInfo.accounts[0].baseUri + '/restapi';
  apiClient.setBasePath(basePath);
  console.log(`Autenticado. Account ID: ${accountId} — Base URI: ${basePath}\n`);

  const accountsApi = new docusign.AccountsApi(apiClient);
  const TOTAL_CALLS = 20;
  for (let i = 1; i <= TOTAL_CALLS; i++) {
    await accountsApi.getAccountInformation(accountId);
    console.log(`Llamada ${i}/${TOTAL_CALLS} OK`);
  }

  console.log(`\nListo — ${TOTAL_CALLS} llamadas de prueba hechas hoy (${new Date().toLocaleDateString('en-US')}). Usa esa fecha en el formulario de verificación.`);
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
