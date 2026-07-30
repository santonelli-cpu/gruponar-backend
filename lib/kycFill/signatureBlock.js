// Genera un bloque de firmas (tabla, uno al lado del otro en la misma
// línea, como pidieron) para machotes que no traen uno propio — hoy solo
// el escrow agreement de Armour, que termina en la cláusula 10 sin ninguna
// sección de firma. Reutiliza la misma convención de anchors que ya usa el
// contrato de promesa (mergeEngine.js): /sig1/, /sig1_2/... para
// compradores, /sig2/, /sig2_2/... para vendedores — así el mismo código
// de armar el sobre de DocuSign (routes/docusign.js) funciona igual para
// ambos documentos.
const FONT_RPR = '<w:rFonts w:ascii="Helvetica Neue Light" w:hAnsi="Helvetica Neue Light"/><w:color w:val="000000" w:themeColor="text1"/><w:sz w:val="16"/><w:szCs w:val="16"/>';

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function paragraph(text, { bold = false, align, keepNext = false } = {}) {
  const rPr = `<w:rPr>${FONT_RPR}${bold ? '<w:b/><w:bCs/>' : ''}</w:rPr>`;
  // keepNext — para los encabezados "Seller(s):"/"Purchaser(s):", que no se
  // separen de la tabla de firmas que sigue justo abajo si caen cerca del
  // borde de una página.
  const pPr = `<w:pPr>${keepNext ? '<w:keepNext/>' : ''}${align ? `<w:jc w:val="${align}"/>` : ''}${rPr}</w:pPr>`;
  return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function anchorForIndex(base, index) {
  return index === 0 ? base : base.replace(/\/$/, `_${index + 1}/`);
}

function signerCell(name, anchor, widthDxa) {
  return `<w:tc><w:tcPr><w:tcW w:w="${widthDxa}" w:type="dxa"/><w:tcBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/></w:tcBorders></w:tcPr>` +
    paragraph(name, { bold: true, align: 'center' }) +
    paragraph(`_______________${anchor}`, { align: 'center' }) +
    paragraph('Firma / Signature', { align: 'center' }) +
    `</w:tc>`;
}

// `names` en el orden real de la operación (deal_party_entities.sort_order)
// — el primero usa el anchor base, cada uno más usa el sufijo _2/_3/_4 igual
// que el contrato.
function signatureRow(names, anchorBase) {
  if (!names.length) return '';
  const totalWidth = 9500;
  const colWidth = Math.floor(totalWidth / names.length);
  const grid = names.map(() => `<w:gridCol w:w="${colWidth}"/>`).join('');
  const cells = names.map((name, i) => signerCell(name, anchorForIndex(anchorBase, i), colWidth)).join('');
  // cantSplit — que el renglón de firmas no se corte entre dos páginas
  // (sin esto, un nombre puede quedar en una hoja y la línea de firma en
  // la siguiente si cae justo en el borde).
  return `<w:tbl><w:tblPr><w:tblW w:w="${totalWidth}" w:type="dxa"/><w:tblLook w:val="04A0" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid><w:tr><w:trPr><w:cantSplit/></w:trPr>${cells}</w:tr></w:tbl>`;
}

// sellerNames/buyerNames: arreglos de nombres reales de la operación, en
// orden. Devuelve el bloque completo (encabezado + tabla de vendedores +
// tabla de compradores) listo para insertar antes de </w:body>.
function buildSignatureBlockXml(sellerNames, buyerNames) {
  return (
    paragraph('') +
    paragraph('IN WITNESS WHEREOF, the parties execute this Agreement. / EN FE DE LO CUAL, las partes firman el presente Contrato.', { bold: true }) +
    paragraph('') +
    paragraph('Seller(s) / Vendedor(es):', { bold: true, keepNext: true }) +
    signatureRow(sellerNames, '/sig2/') +
    paragraph('') +
    paragraph('Purchaser(s) / Comprador(es):', { bold: true, keepNext: true }) +
    signatureRow(buyerNames, '/sig1/') +
    paragraph('')
  );
}

module.exports = { buildSignatureBlockXml };
