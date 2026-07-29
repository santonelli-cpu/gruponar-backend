const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { mergeAdjacentRuns, escapeXml } = require('../kycFill/docxFillEngine');

// Motor genérico de mail-merge para los machotes de contrato de promesa —
// a diferencia del motor de KYC (docxFillEngine/DocCursor, que ubica cada
// campo por su texto exacto porque esos formularios no tienen marcadores),
// aquí el propio machote trae placeholders {{CLAVE}} que el usuario escribe
// al redactarlo. No hace falta un JSON de definición por plantilla: los
// campos se detectan solos escaneando el archivo.
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

function decodeXmlEntities(str) {
  return str
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function extractRuns(xml) {
  const runRe = /<w:t([^>]*)>([^<]*)<\/w:t>/g;
  const runs = [];
  let m;
  while ((m = runRe.exec(xml))) {
    runs.push({ start: m.index, end: m.index + m[0].length, attrs: m[1], text: decodeXmlEntities(m[2]) });
  }
  return runs;
}

// Concatena el texto de todos los runs (ya fusionados con mergeAdjacentRuns)
// y arma un mapa carácter → {runIdx, offset} para poder ubicar un
// placeholder aunque haya quedado partido entre dos runs adyacentes.
function buildCharMap(runs) {
  let concatText = '';
  const charMap = [];
  runs.forEach((r, ri) => {
    for (let i = 0; i < r.text.length; i++) charMap.push({ runIdx: ri, offset: i });
    concatText += r.text;
  });
  return { concatText, charMap };
}

// Devuelve la lista ordenada y sin duplicados de claves {{CLAVE}} que
// aparecen en el .docx — es lo que arma el formulario dinámico en el
// frontend, sin que nadie tenga que mantener un JSON de campos a mano.
function extractPlaceholders(docxPath) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-scan-'));
  try {
    execFileSync('unzip', ['-oq', docxPath, '-d', workDir]);
    const docXmlPath = path.join(workDir, 'word', 'document.xml');
    const xml = mergeAdjacentRuns(fs.readFileSync(docXmlPath, 'utf-8'));
    const { concatText } = buildCharMap(extractRuns(xml));
    const keys = new Set();
    let m;
    PLACEHOLDER_RE.lastIndex = 0;
    while ((m = PLACEHOLDER_RE.exec(concatText))) keys.add(m[1]);
    return Array.from(keys).sort();
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// Reemplaza cada {{CLAVE}} por su valor en `data`, aunque el placeholder
// esté fragmentado entre varios runs de Word. Placeholders sin valor en
// `data` se dejan en blanco (no se quedan como "{{CLAVE}}" en el documento
// final).
function fillPlaceholdersInXml(xml, data) {
  const merged = mergeAdjacentRuns(xml);
  const runs = extractRuns(merged);
  const { concatText, charMap } = buildCharMap(runs);

  const replacements = [];
  let m;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(concatText))) {
    const key = m[1];
    const value = data[key] !== undefined && data[key] !== null ? String(data[key]) : '';
    const startChar = m.index;
    const endChar = m.index + m[0].length; // exclusivo
    const startPos = charMap[startChar];
    const endPos = charMap[endChar - 1];
    replacements.push({ startRun: startPos.runIdx, startOffset: startPos.offset, endRun: endPos.runIdx, endOffset: endPos.offset + 1, value, key });
  }

  // Se procesa de derecha a izquierda: así el slicing de un run no invalida
  // los offsets ya calculados (en base al texto ORIGINAL) de reemplazos
  // anteriores en ese mismo run.
  replacements.sort((a, b) => b.startRun - a.startRun || b.startOffset - a.startOffset);

  const newText = runs.map(r => r.text);
  for (const rep of replacements) {
    if (rep.startRun === rep.endRun) {
      const t = newText[rep.startRun];
      newText[rep.startRun] = t.slice(0, rep.startOffset) + rep.value + t.slice(rep.endOffset);
    } else {
      newText[rep.startRun] = newText[rep.startRun].slice(0, rep.startOffset) + rep.value;
      for (let ri = rep.startRun + 1; ri < rep.endRun; ri++) newText[ri] = '';
      newText[rep.endRun] = newText[rep.endRun].slice(rep.endOffset);
    }
  }

  let result = '';
  let lastEnd = 0;
  runs.forEach((r, ri) => {
    result += merged.slice(lastEnd, r.start);
    const attrs = r.attrs.includes('xml:space') ? r.attrs : `${r.attrs} xml:space="preserve"`;
    result += `<w:t${attrs}>${escapeXml(newText[ri])}</w:t>`;
    lastEnd = r.end;
  });
  result += merged.slice(lastEnd);
  return result;
}

const SIDE_LABEL = {
  buyer: { es: 'PROMITENTE COMPRADOR ADICIONAL', en: 'ADDITIONAL PROMISSORY PURCHASER' },
  seller: { es: 'PROMITENTE VENDEDOR ADICIONAL', en: 'ADDITIONAL PROMISSORY SELLER' }
};

// El machote trae UN solo bloque de firma por lado (una operación con 1
// comprador + 1 vendedor no necesita más). Cuando la operación real tiene
// más firmantes de ese lado, no hay forma de que el machote genérico ya
// traiga esas líneas — se agregan aquí, después del merge, una por cada
// firmante extra. El primer firmante de cada lado sigue usando el ancla que
// ya trae el machote (/sig1/, /sig2/); estas líneas nuevas llevan su propia
// ancla (`anchor`) para que DocuSign no superponga varias firmas en el mismo
// punto del documento. El texto de la ancla se hace casi invisible (blanco,
// 1pt) porque solo es una marca de posición para DocuSign, no contenido del
// contrato.
function buildExtraSignatureParagraphsXml(extraSigners) {
  return extraSigners.map(({ side, name, anchor }) => {
    const label = SIDE_LABEL[side] || SIDE_LABEL.buyer;
    const nameEsc = escapeXml(name || '');
    const anchorEsc = escapeXml(anchor);
    return (
      '<w:p><w:pPr><w:rPr><w:b/></w:rPr></w:pPr></w:p>' +
      `<w:p><w:pPr><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${escapeXml(label.es)} / ${escapeXml(label.en)}</w:t></w:r></w:p>` +
      '<w:p><w:r><w:t xml:space="preserve">______________________________</w:t></w:r>' +
      `<w:r><w:rPr><w:color w:val="FFFFFF"/><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr><w:t xml:space="preserve">${anchorEsc}</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t xml:space="preserve">${nameEsc}</w:t></w:r></w:p>`
    );
  }).join('');
}

// Inserta las líneas de firma extra justo antes de las propiedades de
// sección del documento (`<w:sectPr>` a nivel de body, el caso normal para
// un machote de una sola sección) — así quedan al final del documento, tras
// el bloque de firma original.
function insertExtraSignatureParagraphs(xml, extraSigners) {
  if (!extraSigners || !extraSigners.length) return xml;
  const paragraphsXml = buildExtraSignatureParagraphsXml(extraSigners);
  const sectPrIdx = xml.lastIndexOf('<w:sectPr');
  if (sectPrIdx === -1) return xml.replace('</w:body>', paragraphsXml + '</w:body>');
  return xml.slice(0, sectPrIdx) + paragraphsXml + xml.slice(sectPrIdx);
}

// Toma un machote (.docx con placeholders) + los valores capturados y
// produce el contrato final listo para ver/descargar/enviar a firma.
// `extraSigners` (opcional): firmantes adicionales del mismo lado más allá
// del primero — ver insertExtraSignatureParagraphs.
function fillContractTemplate(templateDocxPath, data, outputDocxPath, extraSigners) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-fill-'));
  try {
    execFileSync('unzip', ['-oq', templateDocxPath, '-d', workDir]);
    const docXmlPath = path.join(workDir, 'word', 'document.xml');
    const xml = fs.readFileSync(docXmlPath, 'utf-8');
    const filled = insertExtraSignatureParagraphs(fillPlaceholdersInXml(xml, data || {}), extraSigners);
    fs.writeFileSync(docXmlPath, filled, 'utf-8');

    fs.mkdirSync(path.dirname(outputDocxPath), { recursive: true });
    if (fs.existsSync(outputDocxPath)) fs.rmSync(outputDocxPath);
    execFileSync('zip', ['-Xrq', outputDocxPath, '.'], { cwd: workDir });
    return outputDocxPath;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// Número de páginas del PDF final — se usa para poner una iniciales de
// cada firmante en CADA hoja del contrato (requisito legal habitual en
// este tipo de documento), como tabs de posición fija por página en vez de
// depender de un texto ancla repetido en el footer del .docx.
function countPdfPages(pdfPath) {
  const out = execFileSync('pdfinfo', [pdfPath]).toString();
  const m = out.match(/Pages:\s+(\d+)/);
  return m ? parseInt(m[1], 10) : 1;
}

module.exports = { extractPlaceholders, fillContractTemplate, countPdfPages };
