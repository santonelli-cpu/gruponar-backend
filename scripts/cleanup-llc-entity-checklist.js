// Limpia el checklist de operaciones que ya se crearon con el bug corregido
// en el commit "Corrige checklist duplicado de LLC/corporation": antes,
// cualquier parte LLC/corporation recibía TAMBIÉN el set de documentos de
// persona física (CURP, pasaporte, actas...) pegado al de la entidad, sin
// ninguna etiqueta que lo distinguiera.
//
// Este script NUNCA borra un documento que ya tenga un archivo subido
// (status='done') — esos se listan para que los revises a mano, por si ya
// se subió algo ahí que en realidad pertenece a un socio y hay que
// reasignarlo, en vez de perderlo. Solo borra automáticamente los que
// siguen 'pending' (nunca se llegó a subir nada).
//
// Uso:
//   node scripts/cleanup-llc-entity-checklist.js            (dry-run, solo reporta)
//   node scripts/cleanup-llc-entity-checklist.js --apply     (borra los pending)
require('dotenv').config();
const db = require('../db');
const SCENARIO_DOCS = require('../data/scenario-docs.json');

const apply = process.argv.includes('--apply');

const parties = db.prepare(`
  SELECT dpe.id, dpe.deal_id, dpe.name, dpe.party_type, dpe.ownership_mode, deals.scenario, deals.property
  FROM deal_party_entities dpe JOIN deals ON deals.id = dpe.deal_id
  WHERE dpe.party_type IN ('llc', 'corporation')
`).all();

let toDeletePending = 0;
let flaggedDone = 0;

for (const party of parties) {
  const s = SCENARIO_DOCS[party.scenario];
  const correctNames = new Set(party.party_type === 'llc' ? s.llc_entity : s.corporation_extra);

  const unlabeledDocs = db.prepare(`
    SELECT id, name, status FROM documents WHERE deal_party_entity_id = ? AND sub_label IS NULL
  `).all(party.id);

  const wrongDocs = unlabeledDocs.filter(d => !correctNames.has(d.name));
  if (!wrongDocs.length) continue;

  console.log(`\n[${party.property}] ${party.name} (${party.party_type}, ${party.ownership_mode || 'sin estructura'})`);
  wrongDocs.forEach(d => {
    if (d.status === 'done') {
      flaggedDone++;
      console.log(`  ⚠ YA SUBIDO, revisar a mano: "${d.name}" (documents.id=${d.id})`);
    } else {
      toDeletePending++;
      console.log(`  ${apply ? '✓ borrado' : '  se borraría'}: "${d.name}" (documents.id=${d.id})`);
      if (apply) db.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
    }
  });
}

console.log(`\n${apply ? 'Borrados' : 'Se borrarían'}: ${toDeletePending} documento(s) pendiente(s) mal puestos.`);
if (flaggedDone) console.log(`⚠ ${flaggedDone} documento(s) YA SUBIDOS quedaron señalados arriba — revísalos a mano, no se tocaron.`);
if (!apply && toDeletePending) console.log('\nEsto fue un dry-run. Corre con --apply para borrar de verdad los pendientes.');
