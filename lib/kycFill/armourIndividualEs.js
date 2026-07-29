const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { DocCursor } = require('./docxFillEngine');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', 'armour-individual-es.docx');

// Anchor de texto que queda en el documento generado, en el lugar exacto
// donde va la firma — routes/kyc.js lo usa como `anchorString` para que
// DocuSign coloque ahí el tab de firma embebida (mismo mecanismo que ya
// usa routes/docusign.js para las tareas de firma de deals).
const SIGNATURE_ANCHOR = '/firmakyc/';

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return (d && m && y) ? `${d}/${m}/${y}` : iso;
}

// Llena la plantilla de Armour Persona Física (ES) con las respuestas del
// formulario y produce un .docx en `outputDocxPath`. Cada línea de abajo
// corresponde a un campo específico de data/kyc-templates/armour-individual-es.json,
// mapeado contra el texto EXACTO de cada run en templates/armour-individual-es.docx
// (extraído directamente del XML, no adivinado).
function fillArmourIndividualEs(answers, outputDocxPath) {
  const a = answers || {};
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyc-armour-individual-es-'));
  try {
    execFileSync('unzip', ['-oq', TEMPLATE_PATH, '-d', workDir]);
    const docXmlPath = path.join(workDir, 'word', 'document.xml');
    const xml = fs.readFileSync(docXmlPath, 'utf-8');

    const c = new DocCursor(xml);

    // --- Tipo de persona ---
    c.skip('PERSONA FISICA MEXICANA ');
    a.tipoPersona === 'mexicana' ? c.markCheckbox('(  ') : c.skip('(  ');
    c.skip('  ) ');
    c.skip('persona con nacionalidad mexicana.');
    c.skip('PERSONA FISICA EXTRANJERA ');
    c.skip('RESIDENTE ');
    a.tipoPersona === 'extranjera_residente' ? c.markCheckbox('(    ) ') : c.skip('(    ) ');
    c.skip('residente temporal o permanente que cuente con FM2, FM3, VISA');
    c.skip('PERSONA FISICA EXTRANJERA ');
    c.skip('VISITANTE ');
    a.tipoPersona === 'extranjera_visitante' ? c.markCheckbox('(    ) ') : c.skip('(    ) ');
    c.skip('extranjero no residente');

    // --- Número de expediente ---
    c.skip('NUMERO DE EXPEDIENTE: ');
    c.skip('ASE');
    if (a.numeroExpediente) c.fillBlank('-_________________________', a.numeroExpediente);
    else c.skip('-_________________________');

    // --- Identificación ---
    c.skip('EN CUMPLIMIENTO A LO DISPUESTO EN LAS REGLAS DE CARÁCTER GENERAL A QUE SE REFIERE LA LEY FEDERAL PARA LA PREVENCIÓN E IDENTIFICACIÓN DE OPERACIONES CON RECURSOS DE PROCEDENCIA ILICITA, EL QUE SUSCRIBE PROPORCIONA LA INFORMACIÓN QUE A CONTINUACIÓN SE SEÑALA:');
    c.skip('NOMBRE:');
    c.skip(' APELLIDO PATERNO, APELLIDO MATERNO Y NOMBRE (S) TAL Y COMO APARECE EN ');
    c.fillBlank('IDENTIFICACIÓN OFICIAL:  ____________________________________________________________________', a.nombre || '');

    c.replace('FECHA DE NACIMIENTO |___|___|___|___|___|___|', 'FECHA DE NACIMIENTO ' + fmtDate(a.fechaNacimiento));

    c.replace(
      'LUGAR DE NACIMIENTO (CIUDAD Y PAIS) ______________________    NACIONALIDAD   __________________   ',
      `LUGAR DE NACIMIENTO (CIUDAD Y PAIS) ${a.lugarNacimiento || ''}    NACIONALIDAD   ${a.nacionalidad || ''}   `
    );

    c.skip('CONDICION DE LEGAL ESTANCIA EN MEXICO (EN CASO DE QUE ');
    c.replace('APLIQUE)  _', 'APLIQUE)  ');
    c.replace('__________________________  ', (a.condicionEstanciaMexico || '') + '  ');

    c.skip('LUGAR DE ');
    c.replace('RESIDENCIA  _', 'RESIDENCIA  ');
    c.replace(
      '_______________________    OCUPACIÓN: __________________________________',
      `${a.lugarResidencia || ''}    OCUPACIÓN: ${a.ocupacion || ''}`
    );

    c.fillBlank('TELEFONO DE CASA (CLAVE INTERNACIONAL) ____________________________________________________', a.telefonoCasa || '');
    c.fillBlank('TELEFONO DE OFICINA (CLAVE INTERNACIONAL) __________________________________________________', a.telefonoOficina || '');
    c.fillBlank('TELEFONO CELULAR (CLAVE INTERNACIONAL) ____________________________________________________', a.telefonoCelular || '');
    c.fillBlank('CORREO ELECTRONICO ________________________________________________________________________', a.correoElectronico || '');
    c.fillBlank('TIPO DE DOCUMENTO CON EL QUE SE IDENTIFICA _________________________________________________', a.tipoDocumento || '');

    c.skip('AUTORIDAD QUE EMITE LA ');
    c.replace('IDENTIFICACION  _', 'IDENTIFICACION  ');
    c.replace('_____________________________________________________  ', (a.autoridadEmisora || '') + '  ');

    c.skip('NUMERO ');
    c.skip('DE  IDENTIFICACIÓN');
    c.fillBlank(': ___________________________________________ ', a.numeroIdentificacion || '');
    c.fillBlank('FECHA DE EXPEDICIÓN DE IDENTIFICACION: _______________________________', fmtDate(a.fechaExpedicionId));
    c.fillBlank('FECHA DE VENCIMIENTO DE IDENTIFICACION: ________________________________', fmtDate(a.fechaVencimientoId));

    // --- Domicilio ---
    c.skip('DOMICILIO PARTICULAR EN MEXICO: (CALLE, NUMERO EXTERIOR E INTERIOR, COLONIA, DELEGACION O MUNICIPIO, CIUDAD O POBLACION, ENTIDAD FEDERATIVA O DEMARCACION POLITICA, CODIGO POSTAL Y');
    c.fillBlank('PAIS) _______________________________________________________________________________________', a.domicilioMexico || '');

    c.skip('DOMICILIO PARTICULAR EN EL EXTRANJERO: (CALLE, NUMERO EXTERIOR E INTERIOR, COLONIA, DELEGACION O MUNICIPIO, CIUDAD O POBLACION, ENTIDAD FEDERATIVA O DEMARCACION POLITICA, CODIGO POSTAL Y');
    c.fillBlank('PAIS) _______________________________________________________________________________________', a.domicilioExtranjero || '');

    // --- Identificadores fiscales ---
    c.skip('CLAVE UNICA DE REGISTRO DE POBLACIÓN (CURP) (EN CASO DE MEXICANOS Y RESIDENTES)');
    if (a.curp) c.fillBoxGrid('|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|', a.curp);
    else c.skip('|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|');

    c.skip('CLAVE DEL REGISTRO FEDERAL DE CONTRIBUYENTES (RFC) (EN CASO DE MEXICANOS Y RESIDENTES)');
    if (a.rfc) c.fillBoxGrid('|__|__|__|__|__|__|__|__|__|__|__|__|__|', a.rfc);
    else c.skip('|__|__|__|__|__|__|__|__|__|__|__|__|__|');

    c.fillBlank('______________________________________________________________________', a.numeroSeguridadSocial || '');

    // --- Dueño beneficiario ---
    c.skip('SEÑALE SI TIENE CONOCIMIENTO DE LA EXISTENCIA DE DUEÑO BENEFICIARIO SI ');
    a.tieneDuenoBeneficiario === 'si' ? c.markCheckbox('(  ') : c.skip('(  ');
    a.tieneDuenoBeneficiario === 'no'
      ? c.replace(' ) NO (   )', ' ) NO (X   )')
      : c.skip(' ) NO (   )');

    c.skip('EN CASO DE RESPONDER EN SENTIDO AFIRMATIVO AL APARTADO ANTERIOR INDIQUE EL TIPO DE DUEÑO BENEFICIARIO DE QUE SE TRATE:');
    const tipoDueno = [
      ['persona_fisica_mx', 'PERSONA FISICA MEXICANA O EXTRANJERA RESIDENTE   ', '   (', '    )'],
      ['persona_fisica_visitante', 'PERSONA FISICA EXTRANJERA VISITANTE                             ', '   (', '    )'],
      ['persona_moral_mx', 'PERSONA MORAL MEXICANA                                                     ', '   (', '    )'],
      ['persona_moral_extranjera', 'PERSONA MORAL EXTRANJERA                                                ', '   (', '    )'],
      ['fideicomiso', 'FIDEICOMISO                                                                                ', '   (', '    )']
    ];
    for (const [value, label, openParen, closeParen] of tipoDueno) {
      c.skip(label);
      a.tipoDuenoBeneficiario === value ? c.markCheckbox(openParen) : c.skip(openParen);
      c.skip(closeParen);
    }

    // --- Declaración / firma ---
    c.skip('CUANDO SE TENGA CONOCIMIENTO DE DUEÑO BENEFICIARIO FAVOR DE LLENAR EXPEDIENTE DE IDENTIFICACIÓN DE DUEÑO BENEFICIARIO. ');
    c.skip('DECLARO BAJO PROTESTA DE DECIR VERDAD, QUE TODA LA INFORMACIÓN ASENTADA POR EL SUSCRITO EN EL PRESENTE DOCUMENTO, ASÍ COMO TODA LA DOCUMENTACIÓN ANEXA ES CIERTA Y VERDADERA');
    c.replace(
      '________________________________                                 ______________________________________________',
      `${fmtDate(a.fechaFirma)}                                                                  ${SIGNATURE_ANCHOR}`
    );

    fs.writeFileSync(docXmlPath, c.xml, 'utf-8');

    fs.mkdirSync(path.dirname(outputDocxPath), { recursive: true });
    if (fs.existsSync(outputDocxPath)) fs.rmSync(outputDocxPath);
    execFileSync('zip', ['-Xrq', outputDocxPath, '.'], { cwd: workDir });

    return { docxPath: outputDocxPath, signatureAnchor: SIGNATURE_ANCHOR };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { fillArmourIndividualEs, SIGNATURE_ANCHOR };
