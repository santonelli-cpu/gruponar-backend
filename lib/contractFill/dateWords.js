// Formatea una fecha ISO ("YYYY-MM-DD", la que guarda deals.closing_date /
// due_diligence_end_date) para las cláusulas del contrato de promesa, en
// español e inglés. Se parsea a mano (no `new Date(str)`) para no depender
// de la zona horaria del servidor con fechas sin hora.
const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function parseIsoDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) throw new Error(`Fecha inválida (se espera YYYY-MM-DD): ${dateStr}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

// "15 de marzo de 2026"
function formatDateEs(dateStr) {
  const { year, month, day } = parseIsoDate(dateStr);
  return `${day} de ${MONTHS_ES[month - 1]} de ${year}`;
}

// "March 15" — sin sufijo ordinal ni año, esos van en placeholders propios
// porque el machote los formatea con superíndice (ver CLOSING_DATE_ORDINAL_EN).
function formatMonthDayEn(dateStr) {
  const { month, day } = parseIsoDate(dateStr);
  return `${MONTHS_EN[month - 1]} ${day}`;
}

// "st"/"nd"/"rd"/"th" — 11-13 son siempre "th" (excepción al patrón por
// unidad: eleventh/twelfth/thirteenth, no "first/second/third").
function ordinalSuffixEn(day) {
  if (day % 100 >= 11 && day % 100 <= 13) return 'th';
  switch (day % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

function formatOrdinalEn(dateStr) {
  const { day } = parseIsoDate(dateStr);
  return ordinalSuffixEn(day);
}

function formatYear(dateStr) {
  return String(parseIsoDate(dateStr).year);
}

// "July 28, 2018" — fecha completa en inglés, para cláusulas que no usan el
// estilo de ordinal en superíndice (ej. fecha de la escritura original).
function formatDateEnFull(dateStr) {
  const { year, month, day } = parseIsoDate(dateStr);
  return `${MONTHS_EN[month - 1]} ${day}, ${year}`;
}

module.exports = { formatDateEs, formatMonthDayEn, formatOrdinalEn, formatYear, formatDateEnFull };
