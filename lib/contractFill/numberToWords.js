// Convierte un monto en USD a su versión en letras, en español e inglés,
// para las cláusulas del contrato de promesa (ej. "USD $25,500.00
// (veinticinco mil quinientos dólares 00/100 moneda de curso legal en los
// Estados Unidos de América)"). El machote real de Punta Mita usa
// exactamente esa frase (ver ensureContractPlaceholdersNormalized en
// routes/contracts.js) — de ahí sale la redacción fija de acá.

const ONES_ES = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
  'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte'];
const TWENTIES_ES = ['veinti']; // 21-29 usan "veinti" + unidad (veintiuno, veintidós...)
const TENS_ES = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const HUNDREDS_ES = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

function under100Es(n) {
  if (n <= 20) return ONES_ES[n];
  if (n < 30) return n === 20 ? 'veinte' : TWENTIES_ES[0] + ONES_ES[n - 20];
  const t = Math.floor(n / 10), u = n % 10;
  return u === 0 ? TENS_ES[t] : `${TENS_ES[t]} y ${ONES_ES[u]}`;
}

function under1000Es(n) {
  if (n === 100) return 'cien';
  if (n < 100) return under100Es(n);
  const h = Math.floor(n / 100), rest = n % 100;
  return rest === 0 ? HUNDREDS_ES[h] : `${HUNDREDS_ES[h]} ${under100Es(rest)}`;
}

// Apócope de "uno" frente a sustantivo masculino ("veintiún mil",
// "treinta y un dólares", "ciento un millones") — sin esto, número tras
// número terminado en 1 quedaría gramaticalmente incorrecto en un
// documento legal ("veintiuno mil" en vez de "veintiún mil").
function apocopeEs(phrase) {
  if (phrase.endsWith('veintiuno')) return phrase.slice(0, -'veintiuno'.length) + 'veintiún';
  if (phrase === 'uno') return 'un';
  if (phrase.endsWith(' uno')) return phrase.slice(0, -3) + 'un';
  return phrase;
}

// `un millón`/`un mil` no aplica en español para miles (se dice "mil", no
// "un mil"), pero sí para millones ("un millón", no "uno millón").
function integerToWordsEs(n) {
  if (n === 0) return 'cero';
  const millions = Math.floor(n / 1000000);
  const thousands = Math.floor((n % 1000000) / 1000);
  const rest = n % 1000;
  const parts = [];
  if (millions) parts.push(millions === 1 ? 'un millón' : `${apocopeEs(integerToWordsEs(millions))} millones`);
  if (thousands) parts.push(thousands === 1 ? 'mil' : `${apocopeEs(under1000Es(thousands))} mil`);
  if (rest) parts.push(under1000Es(rest));
  return parts.join(' ');
}

const ONES_EN = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS_EN = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function under100En(n) {
  if (n < 20) return ONES_EN[n];
  const t = Math.floor(n / 10), u = n % 10;
  return u === 0 ? TENS_EN[t] : `${TENS_EN[t]}-${ONES_EN[u]}`;
}

function under1000En(n) {
  const h = Math.floor(n / 100), rest = n % 100;
  if (!h) return under100En(rest);
  return rest ? `${ONES_EN[h]} hundred ${under100En(rest)}` : `${ONES_EN[h]} hundred`;
}

function integerToWordsEn(n) {
  if (n === 0) return 'zero';
  const millions = Math.floor(n / 1000000);
  const thousands = Math.floor((n % 1000000) / 1000);
  const rest = n % 1000;
  const parts = [];
  if (millions) parts.push(`${under1000En(millions)} million`);
  if (thousands) parts.push(`${under1000En(thousands)} thousand`);
  if (rest) parts.push(under1000En(rest));
  return parts.join(' ');
}

// Separa un monto (número o string con comas, ej. "25,500.75") en parte
// entera y centavos (0-99), redondeando al centavo más cercano.
function splitAmount(amount) {
  const n = Math.round(Number(String(amount).replace(/,/g, '')) * 100) / 100;
  if (!Number.isFinite(n) || n < 0) throw new Error(`Monto inválido: ${amount}`);
  const cents = Math.round((n - Math.floor(n)) * 100);
  return { whole: Math.floor(n), cents };
}

// Frase completa autocontenida, tal como debe quedar insertada en las
// cláusulas que ya NO tienen texto fijo después del placeholder (Precio,
// Depósito Inicial, Saldo a la Firma, Cuota de Depósito, Membresía — ver
// ensureContractPlaceholdersNormalized).
function amountToWordsEs(amount) {
  const { whole, cents } = splitAmount(amount);
  const centsStr = String(cents).padStart(2, '0');
  return `${apocopeEs(integerToWordsEs(whole))} dólares ${centsStr}/100 moneda de curso legal en los Estados Unidos de América`;
}

function amountToWordsEn(amount) {
  const { whole, cents } = splitAmount(amount);
  const centsStr = String(cents).padStart(2, '0');
  return `${integerToWordsEn(whole)} dollars ${centsStr}/100 lawful currency in the United States of America`;
}

// Formato "$25,500.00" para los campos _MONTO/_AMOUNT.
function formatAmount(amount) {
  const { whole, cents } = splitAmount(amount);
  return `${whole.toLocaleString('en-US')}.${String(cents).padStart(2, '0')}`;
}

module.exports = { amountToWordsEs, amountToWordsEn, formatAmount, integerToWordsEs, integerToWordsEn };
