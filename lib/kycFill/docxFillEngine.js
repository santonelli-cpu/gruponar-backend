const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Motor genérico para llenar plantillas .docx legales que no tienen campos
// de formulario reales (solo texto con rayas "____" para llenar a mano).
// Word fragmenta el texto en runs de forma impredecible (a veces la
// etiqueta y la raya en blanco viven en el mismo run, a veces la raya se
// parte en dos runs por el ajuste de línea, y textos idénticos como
// "   (" se repiten varias veces para distintas casillas) — por eso se
// trabaja con el texto EXACTO de cada run (ground truth extraído del
// propio XML) y un cursor de posición que avanza en orden del documento,
// para no confundir dos runs con el mismo contenido.

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Algunos .docx traen el texto fragmentado en runs muy chicos — a veces
// literalmente palabra por palabra o carácter por carácter, cada uno con su
// propio <w:spacing> (ajuste de kerning) ligeramente distinto — lo que hace
// imposible ubicar frases completas por texto exacto aunque el formato
// "visible" (negrita, tamaño, color) sea el mismo. Esto coalesce runs <w:r>
// ADYACENTES (sin nada entre ellos) cuyo formato es igual IGNORANDO
// <w:spacing> (kerning, cosmético, no afecta la lectura del campo) y que
// tienen un solo <w:t> cada uno. No toca runs con tabs/saltos/otros hijos.
function normalizeRPrForMerge(rPr) {
  if (rPr === undefined) return undefined;
  return rPr.replace(/<w:spacing[^/]*\/>/g, '');
}

function mergeAdjacentRuns(xml) {
  const runRe = /<w:r>(?:<w:rPr>([\s\S]*?)<\/w:rPr>)?<w:t([^>]*)>([^<]*)<\/w:t><\/w:r>/g;
  let result = '';
  let lastEnd = 0;
  let pending = null; // { rPrKey, rPr, attrs, text }

  function flush() {
    if (pending) {
      const attrs = pending.attrs.includes('xml:space') ? pending.attrs : `${pending.attrs} xml:space="preserve"`;
      const rPrXml = pending.rPr !== undefined ? `<w:rPr>${pending.rPr}</w:rPr>` : '';
      result += `<w:r>${rPrXml}<w:t${attrs}>${pending.text}</w:t></w:r>`;
      pending = null;
    }
  }

  let m;
  while ((m = runRe.exec(xml))) {
    const [full, rPr, attrs, text] = m;
    const rPrKey = normalizeRPrForMerge(rPr);
    const gapText = xml.slice(lastEnd, m.index);
    if (pending && gapText === '' && pending.rPrKey === rPrKey) {
      pending.text += text;
    } else {
      flush();
      result += gapText;
      pending = { rPrKey, rPr: rPrKey, attrs, text };
    }
    lastEnd = m.index + full.length;
  }
  flush();
  result += xml.slice(lastEnd);
  return result;
}

class DocCursor {
  constructor(xml) {
    this.xml = xml;
    this.pos = 0;
  }

  // Reemplaza el siguiente run cuyo texto sea EXACTAMENTE `exactOldText`,
  // buscando a partir de la posición actual del cursor, y avanza el cursor.
  replace(exactOldText, newText) {
    const re = new RegExp(`<w:t([^>]*)>${escapeRegex(exactOldText)}</w:t>`);
    const tail = this.xml.slice(this.pos);
    const match = tail.match(re);
    if (!match) {
      throw new Error(`No se encontró este texto exacto en la plantilla (desde la posición actual): "${exactOldText}"`);
    }
    const attrs = match[1].includes('xml:space') ? match[1] : `${match[1]} xml:space="preserve"`;
    const replacement = `<w:t${attrs}>${escapeXml(newText)}</w:t>`;
    const startAbs = this.pos + match.index;
    this.xml = this.xml.slice(0, startAbs) + replacement + this.xml.slice(startAbs + match[0].length);
    this.pos = startAbs + replacement.length;
    return this;
  }

  // Como replace(), pero solo si `value` viene con contenido — útil para
  // campos opcionales del formulario donde no queremos tocar la raya si el
  // usuario no contestó esa pregunta.
  replaceIfPresent(exactOldText, value) {
    if (value) this.replace(exactOldText, value);
    else this.skip(exactOldText);
    return this;
  }

  // Avanza el cursor sin modificar nada (para runs que no cambian, pero
  // que hay que "pasar" para que la siguiente búsqueda no los reencuentre).
  skip(exactText) {
    const re = new RegExp(`<w:t([^>]*)>${escapeRegex(exactText)}</w:t>`);
    const tail = this.xml.slice(this.pos);
    const match = tail.match(re);
    if (!match) throw new Error(`No se encontró este texto exacto en la plantilla: "${exactText}"`);
    this.pos = this.pos + match.index + match[0].length;
    return this;
  }

  // Toma un run que termina en una raya de guiones bajos (con o sin
  // etiqueta pegada delante) y sustituye solo la parte de guiones bajos,
  // conservando el texto/etiqueta que venga antes.
  fillBlank(exactOldText, value) {
    const m = exactOldText.match(/^(.*?)(_{3,}\s*)$/);
    if (!m) throw new Error(`Este texto no termina en una raya en blanco: "${exactOldText}"`);
    return this.replace(exactOldText, m[1] + value);
  }

  // Para tablas tipo "casilla: etiqueta arriba, celda vacía abajo" (como el
  // escrow agreement de Armour) — no hay raya de texto que reemplazar, el
  // párrafo de la celda de respuesta está genuinamente vacío
  // (`<w:pPr>...</w:pPr></w:p>` sin ningún `<w:r>`). Inserta un run nuevo
  // ahí, en el primer párrafo vacío que encuentre después de la posición
  // actual del cursor.
  insertIntoNextEmptyParagraph(value) {
    const marker = '</w:pPr></w:p>';
    const tail = this.xml.slice(this.pos);
    const idx = tail.indexOf(marker);
    if (idx === -1) throw new Error('No se encontró un párrafo vacío después de la posición actual del cursor.');
    const runXml = `<w:r><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r>`;
    const insertAt = this.pos + idx + '</w:pPr>'.length;
    this.xml = this.xml.slice(0, insertAt) + runXml + this.xml.slice(insertAt);
    this.pos = insertAt + runXml.length + '</w:p>'.length;
    return this;
  }

  // Avanza el cursor más allá del próximo párrafo vacío sin llenarlo (para
  // casillas que Armour llena por su cuenta, ej. su número de cuenta interno).
  skipEmptyParagraph() {
    const marker = '</w:pPr></w:p>';
    const tail = this.xml.slice(this.pos);
    const idx = tail.indexOf(marker);
    if (idx === -1) throw new Error('No se encontró un párrafo vacío después de la posición actual del cursor.');
    this.pos = this.pos + idx + marker.length;
    return this;
  }

  // Marca con "X" un run de casilla tipo "(  " o "(    ) " o "   (".
  markCheckbox(exactOldText) {
    const newText = exactOldText.includes('(')
      ? exactOldText.replace('(', '(X')
      : exactOldText;
    return this.replace(exactOldText, newText);
  }

  // Grid de casillas tipo "|__|__|__|" (CURP, RFC): un carácter por casilla.
  fillBoxGrid(exactOldText, value) {
    const boxWidth = (exactOldText.match(/_+/) || ['__'])[0].length;
    const boxCount = (exactOldText.match(/_+/g) || []).length;
    const chars = String(value).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, boxCount).split('');
    let filled = '|';
    for (let i = 0; i < boxCount; i++) {
      const c = chars[i] || '';
      filled += c + '_'.repeat(Math.max(0, boxWidth - c.length)) + '|';
    }
    return this.replace(exactOldText, filled);
  }
}

// Formatea una fecha ISO (yyyy-mm-dd, como la manda un <input type="date">)
// a DD/MM/AAAA (documentos en español) o MM/DD/AAAA (documentos en inglés,
// convención de EE.UU. — TLA es una compañía de Texas).
function fmtDateDMY(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return (d && m && y) ? `${d}/${m}/${y}` : iso;
}
function fmtDateMDY(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return (d && m && y) ? `${m}/${d}/${y}` : iso;
}

// Convierte el .docx lleno a PDF con LibreOffice — es lo que se manda a
// DocuSign (mismo binario que usa el skill de docx de este proyecto para
// verificar sus propias salidas).
function convertDocxToPdf(docxPath) {
  const outDir = path.dirname(docxPath);
  execFileSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', outDir, docxPath], { timeout: 60000 });
  const pdfPath = path.join(outDir, path.basename(docxPath).replace(/\.docx$/i, '.pdf'));
  if (!fs.existsSync(pdfPath)) throw new Error('LibreOffice no generó el PDF esperado.');
  return pdfPath;
}

module.exports = { DocCursor, convertDocxToPdf, escapeXml, mergeAdjacentRuns, fmtDateDMY, fmtDateMDY };
