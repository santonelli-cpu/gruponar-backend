const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { DocCursor, mergeAdjacentRuns } = require('./docxFillEngine');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', 'tla-escrow.docx');

// Anchors para que DocuSign coloque la firma de cada parte — comprador
// firma primero (routingOrder '1' en routes/docusign.js), vendedor después.
const SIGNATURE_ANCHOR_PURCHASER = '/sig1/';
const SIGNATURE_ANCHOR_SELLER = '/sig2/';

// Este contrato es prosa larga (no una tabla de casillas como el de Armour)
// con ~72 fragmentos resaltados en amarillo marcando los espacios a llenar,
// bilingüe (inglés/español en columnas). Se llenan los campos que
// identifican la operación (partes, propiedad, montos, fechas) — el resto
// del texto legal (cláusulas de terminación, desembolso, etc.) se deja
// intacto tal como lo redactó TLA.
function fillTlaEscrow(deal, fields, outputDocxPath) {
  const f = fields || {};
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyc-tla-escrow-'));
  try {
    execFileSync('unzip', ['-oq', TEMPLATE_PATH, '-d', workDir]);
    const docXmlPath = path.join(workDir, 'word', 'document.xml');
    const xml = mergeAdjacentRuns(fs.readFileSync(docXmlPath, 'utf-8'));

    const c = new DocCursor(xml);

    // --- Vendedor (inglés) ---
    c.skip('(i)').skip('[');
    c.replace('SELLER', deal.seller_name || '');
    c.skip('] (“').skip('Seller').skip('”),');
    c.skip('with an address at: [');
    c.replace('address', f.sellerAddress || '');
    c.skip(']; Email: [');
    c.replace('emai', f.sellerEmail || '');
    c.skip('l]');
    c.skip('Phone: [');
    c.replace('phone', f.sellerPhone || '');
    c.skip(']');

    // --- Vendedor (español) ---
    c.skip('(i)').skip('[');
    c.replace('VENDEDOR', deal.seller_name || '');
    c.skip('] (“').skip('Vendedor').skip('”), con domicilio en: [');
    c.replace('dirección', f.sellerAddress || '');
    c.skip(']; Correo electrónico: [');
    c.replace('*', f.sellerEmail || '');
    c.skip('] Número de teléfono: [');
    c.replace('*', f.sellerPhone || '');
    c.skip(']');

    // --- Comprador (inglés) ---
    c.skip('(ii)').skip('[');
    c.replace('PURCHASER', deal.buyer_name || '');
    c.skip('] (“').skip('Purchaser').skip('”), with an address at: [');
    c.replace('address', f.buyerAddress || '');
    c.skip(']; and Email: [');
    c.replace('emai', f.buyerEmail || '');
    c.skip('l]');
    c.skip('Phone: [');
    c.replace('phone', f.buyerPhone || '');
    c.skip(']');

    // --- Comprador (español) ---
    c.skip('(ii)').skip('[');
    c.replace('COMPRADOR', deal.buyer_name || '');
    c.skip('] (“').skip('Comprador').skip('”), con domicilio en: [');
    c.replace('dirección', f.buyerAddress || '');
    c.skip(']; y Correo electrónico: [');
    c.replace('*', f.buyerEmail || '');
    c.skip(']');
    c.skip('Número de teléfono: [');
    c.replace('*', f.buyerPhone || '');
    c.skip(']');

    // --- Descripción del contrato de compraventa y de la propiedad ---
    c.skip('A. Seller and Purchaser have entered into that certain [');
    c.skip('Purchase and Sale Agreement'); // se deja el nombre estándar del contrato tal cual
    c.skip('], dated [');
    c.replace('date', f.purchaseAgreementDate || '');
    c.skip('] (“').skip('Purchase Agreement').skip('”), pursuant to which Seller has agreed to sell and Purchaser has agreed to purchase certain real property described as: [');
    c.replace('Property Description', f.propertyDescription || '');
    c.skip('] (“').skip('Property').skip('”).');

    // --- Depósito inicial ---
    c.skip('Upon execution of this Escrow Agreement, Purchaser shall deposit ');
    c.skip('USD [');
    c.replace('$$$', f.depositAmount || '');
    c.skip('] ').skip('(“').skip('Initial Deposit').skip('”) with Escrow Agent.');

    // --- Fecha de cierre --- ("[Closing Date]" está partido en 3 runs; el
    // valor va en el primero, los otros dos se vacían para no dejar
    // "Closing Date" pegado después de la fecha real.
    c.skip('No later than two (2) business days before [');
    c.replace('Closing', f.closingDate || '');
    c.replace(' ', '');
    c.replace('Date', '');
    c.skip('], or such other date that the Parties may mutually designate in writing (“').skip('Closing Date');
    c.skip('”), Purchaser shall deposit any remaining balance necessary to complete the purchase of the Property.');

    // --- Depósito y cierre (español) ---
    c.skip('Al momento de la firma del presente Escrow, el Comprador deberá depositar la cantidad de ');
    c.skip('USD ');
    c.replace('[$$$]', `USD ${f.depositAmount || ''}`);
    c.skip(' (“Depósito Inicial”) ');
    c.skip('ante el Agente Escrow.');
    c.skip('A más tardar dos (2) días hábiles antes de [');
    c.replace('cierre pactado]', `${f.closingDate || ''}]`);

    // --- Plazo de terminación (fecha) ---
    c.skip('Termination Period');
    c.skip('. To Purchaser, if Purchaser delivers written notice of termination to both Escrow Agent and Seller on or before [');
    c.replace('insert date', f.terminationDate || '');
    c.skip('], or such other date as the Parties may mutually agree in writing (“').skip('Termination Period');

    c.skip('El Comprador podrá dar por terminado unilateralmente el presente Contrato Escrow mediante aviso escrito de terminación tanto al Agente de Escrow como al Vendedor en o antes del ');
    c.replace('[insertar fecha', `[${f.terminationDate || ''}`);

    // --- Firmas: solo se deja el anchor para que DocuSign coloque el tab
    // de firma — el resto de la línea (nombre/domicilio) se llena a mano
    // o se deja en blanco, igual que en las plantillas de Armour.
    c.replace('Seller:', `Seller: ${SIGNATURE_ANCHOR_SELLER}`);
    c.replace('Purchaser:', `Purchaser: ${SIGNATURE_ANCHOR_PURCHASER}`);

    fs.writeFileSync(docXmlPath, c.xml, 'utf-8');

    fs.mkdirSync(path.dirname(outputDocxPath), { recursive: true });
    if (fs.existsSync(outputDocxPath)) fs.rmSync(outputDocxPath);
    execFileSync('zip', ['-Xrq', outputDocxPath, '.'], { cwd: workDir });

    return { docxPath: outputDocxPath };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { fillTlaEscrow, SIGNATURE_ANCHOR_PURCHASER, SIGNATURE_ANCHOR_SELLER };
