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

    // El machote SÍ trae su propio bloque de firmas nativo en la primera
    // página (justo después de las 9 casillas, antes de los Antecedentes)
    // — Vendedor y Comprador, cada uno con su línea de Nombre/Cargo/
    // Domicilio. Este código asumía (mal, ver comentario viejo de
    // signatureBlock.js) que el machote no traía nada y agregaba un bloque
    // artificial al final del documento — eso dejaba el de la primera
    // página vacío y las firmas terminaban hasta el final, que es donde
    // nadie las esperaba.
    //
    // El bloque nativo solo tiene una fila por lado, así que aquí se llena
    // con el PRIMER firmante de cada lado (usa el mismo anchor base /sig1//
    // /sig2/ que espera routes/docusign.js). El renglón de "Cargo/Title" se
    // deja en blanco (no hay ese dato) para llenarse a mano si hace falta.
    c.skip('The Seller / El Vendedor');
    c.fillBlank('By: / Por:  ____________________', '/sig2/');
    c.replace('Name: / Nombre:', `Name: / Nombre: ${sellers[0]}`);
    c.skip('Title: / Cargo:');
    c.replace('Address: / Domicilio:', `Address: / Domicilio: ${f.noticeAddressSeller || ''}`);

    c.skip('The Purchaser / El Comprador');
    c.skip('By: / Por: ');
    c.fillBlank('_________________________', '/sig1/');
    c.skip('_______');
    c.replace('Name: / Nombre: ', `Name: / Nombre: ${buyers[0]}`);
    c.skip('Title: / Cargo:');
    c.replace('Address: / Domicilio:', `Address: / Domicilio: ${f.noticeAddressBuyer || ''}`);

    // Antecedente A trae la descripción legal del inmueble como una raya en
    // blanco separada, más abajo en el documento (después de las 9
    // casillas y del bloque de firmas de la plantilla) — se llenaba aquí
    // hasta que se movió por accidente al reordenar el fill de firmas (ver
    // git blame), dejando este bloque completo borrado en vez de
    // reubicado. El primer blanco en inglés ("...purchase agreement (____)
    // described in Box 4...") es la fecha del contrato de compraventa
    // referenciado — no hay un campo propio para eso todavía, se deja en
    // blanco a propósito en vez de adivinar. La versión en español no
    // tiene ese primer blanco.
    if (f.propertyLegalDescription) {
      c.skip('A. Seller and Purchaser have entered into a certain purchase agreement (');
      c.skip('_____________________________');
      c.fillBlank('_______________________________', f.propertyLegalDescription);
      c.skip('A. El Vendedor y el Comprador han celebrado el contrato de compraventa que se describe en la Casilla 4 (el “');
      c.fillBlank('______________________________', f.propertyLegalDescription);
    }

    // Si hay más de un vendedor/comprador, el bloque nativo de arriba no
    // les da lugar (solo tiene una fila por lado) — a esos adicionales
    // (índice 1+) sí se les agrega una tabla de firmas aparte, pero
    // pegada justo después del bloque nativo (nunca hasta el final del
    // documento, que es lo que se quejaban que pasaba).
    const extraSellers = sellers.slice(1);
    const extraBuyers = buyers.slice(1);
    let finalXml = c.xml;
    if (extraSellers.length || extraBuyers.length) {
      const extraBlock = buildSignatureBlockXml(extraSellers, extraBuyers, 1);
      const marker = '<w:t>The Purchaser / El Comprador</w:t>';
      const idx = finalXml.indexOf(marker);
      // Se inserta antes del párrafo de "The Purchaser..." para que quede
      // pegado al bloque nativo del vendedor — buscando desde ahí hacia
      // atrás el inicio de esa fila de tabla (<w:tr>) para no partir la
      // tabla del machote a la mitad.
      const rowStart = finalXml.lastIndexOf('<w:tr>', idx);
      finalXml = finalXml.slice(0, rowStart) + extraBlock + finalXml.slice(rowStart);
    }

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
