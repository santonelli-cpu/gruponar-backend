const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { DocCursor } = require('./docxFillEngine');
const { buildSignatureBlockXml } = require('./signatureBlock');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', 'armour-escrow.docx');

function joinNames(names, conjunction) {
  if (!names || !names.length) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} ${conjunction} ${names[names.length - 1]}`;
}

// Llena el escrow agreement de Armour Secure. La mayoría de las 9 casillas
// salen directo de la operación (`deal`); solo depositAmount/fees/
// expirationDate/noticeAddress/placeDate/purchaseAgreementDescription los
// captura admin/agente/abogado a mano (routes/docusign.js). La casilla
// "Escrow Account" (5) se deja en blanco a propósito — la llena Armour con
// el número de cuenta que ellos asignan, no nosotros.
// `sellerNames`/`buyerNames` son arreglos (puede haber más de un vendedor/
// comprador) — el machote de Armour no trae bloque de firmas propio, así
// que se arma uno dinámico al final con una fila por lado (ver
// signatureBlock.js), un firmante por columna en la misma línea.
function fillArmourEscrow(deal, fields, outputDocxPath, sellerNames, buyerNames) {
  const f = fields || {};
  const sellers = sellerNames && sellerNames.length ? sellerNames : ['—'];
  const buyers = buyerNames && buyerNames.length ? buyerNames : ['—'];
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyc-armour-escrow-'));
  try {
    execFileSync('unzip', ['-oq', TEMPLATE_PATH, '-d', workDir]);
    const docXmlPath = path.join(workDir, 'word', 'document.xml');
    const xml = fs.readFileSync(docXmlPath, 'utf-8');

    const c = new DocCursor(xml);
    c.skip('ESCROW AGENCY AGREEMENT');
    c.skip('CONTRATO DE COMISIÓN MERCANTIL (ESCROW)');

    c.skip('1. Place and Date / Lugar y Fecha');
    c.insertIntoNextEmptyParagraph(f.placeDate || '');

    c.skip('2. Name of Seller / Nombre del Vendedor');
    c.insertIntoNextEmptyParagraph(joinNames(sellers, 'y'));

    c.skip('3. Name of Purchaser / Nombre del Comprador');
    c.insertIntoNextEmptyParagraph(joinNames(buyers, 'y'));

    c.skip('4. Description of Purchase Agreement /');
    c.skip('Descripción del Contrato de Compraventa');
    c.insertIntoNextEmptyParagraph(f.purchaseAgreementDescription || '');

    c.skip('5. Escrow Account / Cuenta de Depósito');
    c.skipEmptyParagraph(); // lo llena Armour

    // A diferencia de las demás casillas, "6. Deposit Amount" no tiene un
    // párrafo de respuesta propio en la plantilla (su celda de tabla queda
    // vacía justo después de la etiqueta) — se agrega el valor pegado a la
    // etiqueta en vez de en una línea aparte.
    if (f.depositAmount) c.replace('6. Deposit Amount / Monto del Depósito', `6. Deposit Amount / Monto del Depósito: ${f.depositAmount}`);
    else c.skip('6. Deposit Amount / Monto del Depósito');

    c.skip('7.  Fees / Comisiones');
    c.insertIntoNextEmptyParagraph(f.fees || '');

    c.skip('8.  Expiration Date / Fecha de Terminación');
    c.insertIntoNextEmptyParagraph(f.expirationDate || '');

    c.skip('9. Address for Notices / Domicilio para Notificaciones');
    c.insertIntoNextEmptyParagraph(f.noticeAddress || '');

    // El machote no trae sección de firmas — se agrega antes de cerrar el
    // cuerpo del documento (justo antes de <w:sectPr>, que debe seguir
    // siendo lo último dentro de <w:body>).
    const signatureBlock = buildSignatureBlockXml(sellers, buyers);
    const finalXml = c.xml.replace('<w:sectPr', signatureBlock + '<w:sectPr');

    fs.writeFileSync(docXmlPath, finalXml, 'utf-8');

    fs.mkdirSync(path.dirname(outputDocxPath), { recursive: true });
    if (fs.existsSync(outputDocxPath)) fs.rmSync(outputDocxPath);
    execFileSync('zip', ['-Xrq', outputDocxPath, '.'], { cwd: workDir });

    return { docxPath: outputDocxPath };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { fillArmourEscrow };
