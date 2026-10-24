// Prepara HubSpot para la integración portal → HubSpot (lib/hubspot.js).
// Se corre UNA vez, con HUBSPOT_TOKEN ya puesto en las variables de entorno
// (en Render: Environment del servicio). No pegues el token en la línea de
// comandos ni en archivos del repo.
//
//   node scripts/hubspot-setup.js          revisa y crea lo que falte
//   node scripts/hubspot-setup.js --check  solo revisa
//
// En Render: pestaña Shell del servicio → `node scripts/hubspot-setup.js`.
//
// Qué hace:
//   1. Crea la propiedad de deals `portal_deal_id` (texto, valor único) si no
//      existe — es la llave con la que el portal encuentra "su" deal.
//   2. Revisa que existan el pipeline y las propiedades que usa la
//      integración, y avisa si falta algo (no las crea).
require('dotenv').config();

// No abrir la base de datos del portal solo para esto: hsRequest vive en
// lib/hubspot.js, que requiere ../db; se reimplementa aquí lo mínimo.
const API_BASE = 'https://api.hubapi.com';
const PIPELINE_ID = process.env.HUBSPOT_PIPELINE_ID || '46373633';
const CHECK_ONLY = process.argv.includes('--check');

async function call(method, path, body) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: { Authorization: `Bearer ${process.env.HUBSPOT_TOKEN.trim()}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, body: json };
}

async function main() {
  if (!process.env.HUBSPOT_TOKEN || !process.env.HUBSPOT_TOKEN.trim()) {
    console.error('Falta HUBSPOT_TOKEN en el entorno.');
    process.exit(1);
  }
  let problems = 0;

  const prop = await call('GET', '/crm/v3/properties/deals/portal_deal_id');
  if (prop.status === 200) {
    console.log('✓ La propiedad de deals portal_deal_id ya existe.');
    if (!prop.body.hasUniqueValue) { console.warn('! portal_deal_id existe pero NO es de valor único — bórrala y vuelve a correr este script.'); problems++; }
  } else if (prop.status === 404) {
    if (CHECK_ONLY) { console.warn('! Falta la propiedad de deals portal_deal_id.'); problems++; }
    else {
      const created = await call('POST', '/crm/v3/properties/deals', {
        name: 'portal_deal_id', label: 'ID en el portal', type: 'string', fieldType: 'text',
        groupName: 'dealinformation', hasUniqueValue: true,
        description: 'ID de la operación en portal.gruponar.com. Lo llena la integración; no editar a mano.'
      });
      if (created.status === 201 || created.status === 200) console.log('✓ Creada la propiedad de deals portal_deal_id.');
      else { console.error(`✗ No se pudo crear portal_deal_id (HTTP ${created.status}): ${created.body && created.body.message}`); problems++; }
    }
  } else {
    console.error(`✗ No se pudo revisar portal_deal_id (HTTP ${prop.status}): ${prop.body && prop.body.message}`);
    problems++;
  }

  const pipeline = await call('GET', `/crm/v3/pipelines/deals/${PIPELINE_ID}`);
  if (pipeline.status === 200) console.log(`✓ Pipeline ${pipeline.body.label} (${PIPELINE_ID}).`);
  else { console.warn(`! No encontré el pipeline ${PIPELINE_ID} (HTTP ${pipeline.status}).`); problems++; }

  const needed = {
    deals: ['tipo_de_servicio', 'precio_de_la_compraventa', 'municipio'],
    contacts: ['tipo_de_contacto', 'consentimiento_comercial']
  };
  for (const [objectType, names] of Object.entries(needed)) {
    for (const name of names) {
      const r = await call('GET', `/crm/v3/properties/${objectType}/${name}`);
      if (r.status === 200) console.log(`✓ ${objectType}.${name}`);
      else { console.warn(`! Falta ${objectType}.${name} (HTTP ${r.status}).`); problems++; }
    }
  }

  console.log(problems ? `\nTerminado con ${problems} aviso(s).` : '\nTodo listo.');
  process.exit(problems ? 2 : 0);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
