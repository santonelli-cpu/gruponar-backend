// Un solo formulario que llena DOS expedientes.
//
// Cuando el agente de la operación es de LPR Luxury, cada parte necesita el
// expediente de la escrow company (Armour o TLA) Y el de LPR — dos
// documentos distintos que en el fondo piden lo mismo. Antes el cliente
// tenía que llenar los dos formularios a mano, capturando el mismo nombre,
// la misma fecha de nacimiento y el mismo número de identificación otra vez.
//
// Aquí vive el mapeo entre ambos vocabularios. El expediente de la escrow
// company es el ORIGEN (su answers_json es la única fuente de verdad) y el
// de LPR se deriva de él:
//
//   - Armour y LPR usan exactamente los mismos ids de campo (los formatos
//     salieron del mismo machote), así que el mapeo es la identidad y no
//     queda ningún campo suelto: el cliente llena el de Armour y el de LPR
//     se llena solo, completo.
//   - TLA usa un vocabulario propio en inglés (fullLegalName, dateOfBirth…)
//     equivalente campo por campo, pero NO pide algunas cosas que LPR sí
//     necesita (CURP, fecha de expedición de la identificación, tipo de
//     persona…). Esos quedan como "campos extra": se agregan AL MISMO
//     formulario de TLA en una sección aparte, se guardan en el mismo
//     answers_json (los ids no chocan: los vocabularios son disjuntos) y la
//     función de llenado de TLA simplemente los ignora.

// Mapeo LPR → escrow. La llave es el id del campo de LPR; el valor es el id
// del campo del formulario de la escrow company del que sale su contenido.
const TLA_INDIVIDUAL_TO_LPR = {
  nombre: 'fullLegalName',
  fechaNacimiento: 'dateOfBirth',
  lugarNacimiento: 'placeOfBirth',
  nacionalidad: 'citizenship',
  lugarResidencia: 'countryOfTaxResidency',
  ocupacion: 'occupation',
  telefonoCasa: 'workHomePhone',
  telefonoCelular: 'mobilePhone',
  correoElectronico: 'email',
  autoridadEmisora: 'issuedBy',
  numeroIdentificacion: 'documentNumber',
  fechaVencimientoId: 'expiration',
  domicilioExtranjero: 'residencyAddress',
  // El campo de TLA dice literal "RFC (si eres mexicano) o No. de Seguro
  // Social (si eres extranjero)" — el de LPR que acepta ambos es este; RFC y
  // CURP quedan como campos extra opcionales para quien sí los tenga.
  numeroSeguridadSocial: 'socialSecurityNo'
};

const TLA_ENTITY_TO_LPR = {
  denominacionSocial: 'companyName',
  fechaConstitucion: 'dateOfIncorporation',
  nacionalidadEmpresa: 'placeOfFormation',
  actividadObjetoSocial: 'businessActivities',
  domicilioAdministrativo: 'primaryBusinessAddress',
  repNombre: 'repName',
  repOcupacion: 'repTitle',
  repTelefonoOficina: 'repPhone',
  repCorreoElectronico: 'repEmail',
  numeroSeguridadSocial: 'repSSN'
};

// Campos de LPR que no salen de una copia directa sino de una conversión.
// Reciben las respuestas completas del formulario de la escrow company.
const DERIVED = {
  // LPR lo pide como texto libre; TLA como opción (pasaporte / licencia /
  // otro, con un campo aparte para especificar "otro").
  tipoDocumento: (a, lang) => {
    const LABELS = {
      passport: { es: 'Pasaporte', en: 'Passport' },
      drivers_license: { es: 'Licencia de conducir', en: "Driver's license" }
    };
    const v = a.identificationDocumentType;
    if (v === 'other') return a.identificationDocumentOther || '';
    const l = LABELS[v];
    return l ? (l[lang] || l.es) : '';
  },
  // La fecha de la declaración es el día en que se genera el documento.
  fechaFirma: () => new Date().toISOString().slice(0, 10)
};

function fieldMapFor(escrowCompany, partyKind) {
  if (escrowCompany === 'armour') return 'identity';
  if (escrowCompany === 'tla') return partyKind === 'individual' ? TLA_INDIVIDUAL_TO_LPR : TLA_ENTITY_TO_LPR;
  return null;
}

// Qué expediente de LPR le toca a una plantilla de escrow company — mismo
// tipo de persona y mismo idioma que el que ya está llenando, para no
// mandarle un documento en otro idioma del que acaba de leer.
function mirrorTargetKey(escrowDefinition) {
  if (!escrowDefinition || escrowDefinition.company === 'lpr') return null;
  const kind = escrowDefinition.partyKind === 'individual' ? 'individual' : 'moral';
  return `lpr-${kind}-${escrowDefinition.language || 'es'}`;
}

function allFields(definition) {
  return (definition.sections || []).reduce((acc, s) => acc.concat(s.fields || []), []);
}

// Los campos del expediente de LPR que NO se pueden derivar del formulario
// de la escrow company — se agregan a ese mismo formulario para que el
// cliente los conteste una sola vez, ahí mismo.
function extraFields(escrowDefinition, lprDefinition) {
  const map = fieldMapFor(escrowDefinition.company, escrowDefinition.partyKind);
  if (!map) return [];
  if (map === 'identity') {
    const escrowIds = new Set(allFields(escrowDefinition).map(f => f.id));
    return allFields(lprDefinition).filter(f => !escrowIds.has(f.id) && !DERIVED[f.id]);
  }
  return allFields(lprDefinition).filter(f => !map[f.id] && !DERIVED[f.id]);
}

// Las respuestas del expediente de LPR, derivadas de las del formulario de
// la escrow company (que ya incluye los campos extra de arriba).
function deriveAnswers(escrowDefinition, lprDefinition, escrowAnswers) {
  const map = fieldMapFor(escrowDefinition.company, escrowDefinition.partyKind);
  if (!map) return null;
  const answers = escrowAnswers || {};
  const lang = lprDefinition.language || 'es';
  const out = {};
  allFields(lprDefinition).forEach(f => {
    if (DERIVED[f.id]) { out[f.id] = DERIVED[f.id](answers, lang); return; }
    // Identidad: mismo id. Vocabulario distinto: el id equivalente del
    // mapeo. Campo extra (sin equivalente): se contestó con su propio id
    // dentro del mismo formulario, así que también se copia tal cual.
    const sourceId = map === 'identity' ? f.id : (map[f.id] || f.id);
    if (answers[sourceId] !== undefined) out[f.id] = answers[sourceId];
  });
  return out;
}

module.exports = { mirrorTargetKey, extraFields, deriveAnswers };
