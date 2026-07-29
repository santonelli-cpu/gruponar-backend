// Formulario "inteligente" para el contrato de promesa de Punta Mita: en vez
// de mostrar los 52 placeholders crudos del machote (la mayoría son la misma
// información repetida en inglés y español, o derivable de la propia
// operación), el admin llena un formulario compacto y este módulo expande
// esas respuestas a los valores reales que pide fillPlaceholdersInXml.
// Ver routes/contracts.js para dónde se usa.
const db = require('../../db');
const { amountToWordsEs, amountToWordsEn, formatAmount } = require('./numberToWords');
const { formatDateEs, formatMonthDayEn, formatOrdinalEn, formatYear, formatDateEnFull } = require('./dateWords');

const ESCROW_COMPANY_LABELS = { armour: 'Armour Secure Title & Escrow', tla: 'TLA Financial Services' };

// Opciones de comisión por agencia: 1% a 8% en pasos de 0.5% (piden esto
// como dropdown para que no se escriba a mano un % fuera de lo pactado).
const AGENCY_COMMISSION_OPTIONS = [];
for (let pct = 1; pct <= 8; pct += 0.5) AGENCY_COMMISSION_OPTIONS.push(pct);

// Esquema del formulario compacto — data-driven, el frontend lo pinta en
// secciones sin tener que hardcodear cada campo (mismo espíritu que los
// formularios de KYC). Lo que NO aparece acá (fechas, nombres de partes,
// escrow company) sale solo de la operación, sin volver a escribirlo.
function getSmartSchema() {
  return {
    sections: [
      {
        title: 'Precio y pagos', key: 'money',
        fields: [
          { id: 'price', label: 'Precio de venta (USD)', type: 'money' },
          { id: 'initialDeposit', label: 'Depósito inicial (USD)', type: 'money' },
          { id: 'closingBalance', label: 'Saldo a la firma (USD)', type: 'money' },
          { id: 'escrowFee', label: 'Cuota de la cuenta de depósito (USD)', type: 'money' },
          { id: 'membershipFee', label: 'Membresía Club Punta Mita (USD)', type: 'money' }
        ]
      },
      {
        title: 'Comisión de agencias', key: 'agencies', repeatable: true,
        hint: 'La comisión total y el "más I.V.A." de cada agencia se calculan solos — el % de cada fila es sobre el precio.',
        fields: [
          { id: 'name', label: 'Agencia', type: 'text' },
          { id: 'pct', label: '%', type: 'select', options: AGENCY_COMMISSION_OPTIONS.map(p => ({ value: p, label: `${p}%` })) }
        ]
      },
      {
        title: 'Escritura y notaría', key: 'notary',
        fields: [
          { id: 'escrituraNumero', label: 'Número de escritura (título actual)', type: 'text' },
          { id: 'escrituraFecha', label: 'Fecha de la escritura (título actual)', type: 'date' },
          { id: 'notarioOriginalNombre', label: 'Notario que otorgó la escritura', type: 'text' },
          { id: 'notarioOriginalNumero', label: 'Número de notaría (escritura original)', type: 'text' },
          { id: 'notarioOriginalSede', label: 'Sede de la notaría original', type: 'text' },
          { id: 'notarioCierreNombre', label: 'Notario que hará el cierre', type: 'text' },
          { id: 'notarioCierreNumero', label: 'Número de notaría (cierre)', type: 'text' }
        ]
      },
      {
        title: 'Descripción de la propiedad', key: 'property',
        hint: 'El nombre/número de unidad ya sale del nombre de la operación — no hace falta repetirlo.',
        fields: [
          { id: 'sizeSqm', label: 'Superficie (m²)', type: 'text' },
          { id: 'subcondo', label: 'Régimen de condominio / subdivisión', type: 'text' },
          { id: 'indivisoPct', label: 'Porcentaje de indiviso', type: 'text' }
        ]
      }
    ]
  };
}

function joinNames(names, conjunction) {
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} ${conjunction} ${names[names.length - 1]}`;
}

function dealPartyNames(dealId, side) {
  return db.prepare('SELECT name FROM deal_party_entities WHERE deal_id = ? AND side = ? ORDER BY sort_order').all(dealId, side).map(r => r.name);
}

// `smart` = { price, initialDeposit, closingBalance, escrowFee, membershipFee,
//   agencies: [{name, pct}], escrituraNumero, escrituraFecha,
//   notarioOriginalNombre, notarioOriginalNumero, notarioOriginalSede,
//   notarioCierreNombre, notarioCierreNumero, descripcion, sizeSqm, subcondo,
//   indivisoPct }
// Devuelve el dict plano de 51 claves que espera fillPlaceholdersInXml.
function expandSmartFields(deal, smart) {
  const s = smart || {};
  const out = {};

  const moneyFields = {
    price: ['PRECIO_MONTO', 'PRICE_AMOUNT', 'PRECIO_LETRA_ES', 'PRICE_WORDS_EN'],
    initialDeposit: ['DEPOSITO_INICIAL_MONTO', 'INITIAL_DEPOSIT_AMOUNT', 'DEPOSITO_INICIAL_LETRA_ES', 'INITIAL_DEPOSIT_WORDS_EN'],
    closingBalance: ['SALDO_FIRMA_MONTO', 'CLOSING_BALANCE_AMOUNT', 'SALDO_FIRMA_LETRA_ES', 'CLOSING_BALANCE_WORDS_EN'],
    escrowFee: ['CUOTA_ESCROW_MONTO', 'ESCROW_FEE_AMOUNT', 'CUOTA_ESCROW_LETRA_ES', 'ESCROW_FEE_WORDS_EN'],
    membershipFee: ['MEMBRESIA_MONTO', 'MEMBERSHIP_AMOUNT', 'MEMBRESIA_LETRA_ES', 'MEMBERSHIP_WORDS_EN']
  };
  Object.entries(moneyFields).forEach(([key, [montoKey, amountKey, letraKey, wordsKey]]) => {
    if (s[key] === undefined || s[key] === null || s[key] === '') return;
    out[montoKey] = formatAmount(s[key]);
    out[amountKey] = formatAmount(s[key]);
    out[letraKey] = amountToWordsEs(s[key]);
    out[wordsKey] = amountToWordsEn(s[key]);
  });

  // Comisión total = suma de los % de cada agencia (no se vuelve a
  // preguntar) — ver 8.1 del machote, la comisión pactada es un solo
  // porcentaje del que luego se reparte entre agencias.
  const agencies = Array.isArray(s.agencies) ? s.agencies.filter(a => a && a.name && a.pct) : [];
  if (agencies.length) {
    const total = agencies.reduce((sum, a) => sum + Number(a.pct), 0);
    const totalStr = Number.isInteger(total) ? String(total) : String(total.toFixed(1));
    out.COMISION_PCT = totalStr;
    out.COMMISSION_PCT = totalStr;
    out.AGENCIAS_DESGLOSE_ES = joinNames(agencies.map(a => `${a.name} (${a.pct}% más I.V.A.)`), 'y');
    out.AGENCIES_BREAKDOWN_EN = joinNames(agencies.map(a => `${a.name} (${a.pct}% plus VAT)`), 'and');
  }

  const notaryMap = {
    escrituraNumero: ['ESCRITURA_NUMERO'], notarioOriginalNombre: ['NOTARIO_ORIGINAL_NOMBRE'],
    notarioOriginalNumero: ['NOTARIO_ORIGINAL_NUMERO'], notarioOriginalSede: ['NOTARIO_ORIGINAL_SEDE'],
    // Notario de cierre no lleva traducción (es un nombre propio) — mismo
    // valor va tanto en la cláusula en español como en la de inglés.
    notarioCierreNombre: ['NOTARIO_CIERRE_NOMBRE', 'CLOSING_NOTARY_NAME'],
    notarioCierreNumero: ['NOTARIO_CIERRE_NUMERO', 'CLOSING_NOTARY_NUMBER']
  };
  Object.entries(notaryMap).forEach(([key, placeholderKeys]) => { if (s[key]) placeholderKeys.forEach(pk => { out[pk] = s[key]; }); });
  if (s.escrituraFecha) {
    out.ESCRITURA_FECHA_ES = formatDateEs(s.escrituraFecha);
    out.ESCRITURA_FECHA_EN = formatDateEnFull(s.escrituraFecha);
  }

  const propertyMap = {
    sizeSqm: 'PROPERTY_SIZE_EN',
    subcondo: 'PROPERTY_SUBCONDO_EN', indivisoPct: 'PROPIEDAD_INDIVISO_PCT'
  };
  Object.entries(propertyMap).forEach(([key, placeholderKey]) => { if (s[key]) out[placeholderKey] = s[key]; });

  // Todo lo de acá para abajo sale solo de la operación — nadie lo vuelve a
  // escribir en el formulario del contrato.
  if (deal.closing_date) {
    out.FECHA_CIERRE_ES = formatDateEs(deal.closing_date);
    out.CLOSING_DATE_MONTH_DAY_EN = formatMonthDayEn(deal.closing_date);
    out.CLOSING_DATE_ORDINAL_EN = formatOrdinalEn(deal.closing_date);
    out.CLOSING_DATE_YEAR_EN = formatYear(deal.closing_date);
  }
  if (deal.due_diligence_end_date) {
    out.FECHA_LIMITE_AUDITORIA_ES = formatDateEs(deal.due_diligence_end_date);
    out.DUE_DILIGENCE_DEADLINE_EN_MONTH_DAY = formatMonthDayEn(deal.due_diligence_end_date);
    out.DUE_DILIGENCE_ORDINAL_EN = formatOrdinalEn(deal.due_diligence_end_date);
    out.DUE_DILIGENCE_YEAR_EN = formatYear(deal.due_diligence_end_date);
  }

  const escrowLabel = ESCROW_COMPANY_LABELS[deal.escrow_company] || '';
  if (escrowLabel) { out.AGENTE_ESCROW_NOMBRE = escrowLabel; out.ESCROW_AGENT_NAME = escrowLabel; }

  const sellerNames = dealPartyNames(deal.id, 'seller');
  const buyerNames = dealPartyNames(deal.id, 'buyer');
  if (sellerNames.length) { out.VENDEDORES_NOMBRES_ES = joinNames(sellerNames, 'y'); out.SELLERS_NAMES_EN = joinNames(sellerNames, 'and'); }
  if (buyerNames.length) out.COMPRADOR_NOMBRE = joinNames(buyerNames, 'y');
  // La cláusula en español menciona la unidad con su propia clave
  // (PROPIEDAD_DESCRIPCION_ES) pero es el mismo dato que PROPIEDAD_NOMBRE
  // en la cláusula en inglés — no son dos campos distintos en el machote.
  if (deal.property) { out.PROPIEDAD_NOMBRE = deal.property; out.PROPIEDAD_DESCRIPCION_ES = deal.property; }

  return out;
}

module.exports = { getSmartSchema, expandSmartFields, AGENCY_COMMISSION_OPTIONS };
