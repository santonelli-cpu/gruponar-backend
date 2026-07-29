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

// Toma un machote (.docx con placeholders) + los valores capturados y
// produce el contrato final listo para ver/descargar/enviar a firma.
function fillContractTemplate(templateDocxPath, data, outputDocxPath) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-fill-'));
  try {
    execFileSync('unzip', ['-oq', templateDocxPath, '-d', workDir]);
    const docXmlPath = path.join(workDir, 'word', 'document.xml');
    const xml = fs.readFileSync(docXmlPath, 'utf-8');
    const filled = fillPlaceholdersInXml(xml, data || {});
    fs.writeFileSync(docXmlPath, filled, 'utf-8');

    fs.mkdirSync(path.dirname(outputDocxPath), { recursive: true });
    if (fs.existsSync(outputDocxPath)) fs.rmSync(outputDocxPath);
    execFileSync('zip', ['-Xrq', outputDocxPath, '.'], { cwd: workDir });
    return outputDocxPath;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { extractPlaceholders, fillContractTemplate };
