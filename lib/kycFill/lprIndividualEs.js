const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { DocCursor, fmtDateDMY } = require('./docxFillEngine');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', 'lpr-individual-es.docx');

// Ancla de firma para DocuSign — mismo mecanismo que armourIndividualEs.js.
const SIGNATURE_ANCHOR = '/firmakyclpr/';

// Llena la plantilla de LPR Luxury Persona Física (ES) — mismo formato
// regulatorio genérico que armour-individual-es.docx pero con su propio
// archivo/runs, así que el mapeo de campos está hecho contra el XML EXACTO
// de templates/lpr-individual-es.docx, no copiado del de Armour.
function fillLprIndividualEs(answers, outputDocxPath) {
  const a = answers || {};
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyc-lpr-individual-es-'));
  try {
    execFileSync('unzip', ['-oq', TEMPLATE_PATH, '-d', workDir]);
    const docXmlPath = path.join(workDir, 'word', 'document.xml');
    const xml = fs.readFileSync(docXmlPath, 'utf-8');

    const c = new DocCursor(xml);

    // --- Tipo de persona (checkbox va en el mismo run que la etiqueta) ---
    c.replace('PERSONA FISICA MEXICANA (    ) ', a.tipoPersona === 'mexicana' ? 'PERSONA FISICA MEXICANA (X   ) ' : 'PERSONA FISICA MEXICANA (    ) ');
    c.skip('persona con nacionalidad mexicana.');
    c.skip(' ');
    c.skip('PERSONA FISICA EXTRANJERA ');
    c.skip('RESIDENTE ');
    c.replace('(    ) ', a.tipoPersona === 'extranjera_residente' ? '(X   ) ' : '(    ) ');
    c.skip('residente temporal o permanente que cuente con FM2, FM3, VISA');
    c.skip('PERSONA FISICA EXTRANJERA ');
    c.skip('VISITANTE ');
    c.replace('(    ) ', a.tipoPersona === 'extranjera_visitante' ? '(X   ) ' : '(    ) ');
    c.skip('extranjero no residente');

    c.skip('EN CUMPLIMIENTO A LO DISPUESTO EN LAS REGLAS DE CARÁCTER GENERAL A QUE SE REFIERE LA LEY FEDERAL PARA LA PREVENCIÓN E IDENTIFICACIÓN DE OPERACIONES CON RECURSOS DE PROCEDENCIA ILICITA, EL QUE SUSCRIBE PROPORCIONA LA INFORMACIÓN QUE A CONTINUACIÓN SE SEÑALA:');

    // --- Identificación ---
    c.skip('NOMBRE:');
    c.skip(' APELLIDO PATERNO, APELLIDO MATERNO Y NOMBRE (S) TAL Y COMO APARECE EN ');
    c.fillBlank('IDENTIFICACIÓN OFICIAL:  ____________________________________________________________________', a.nombre || '');

    c.replace('FECHA DE NACIMIENTO |___|___|___|___|___|___|', 'FECHA DE NACIMIENTO ' + fmtDateDMY(a.fechaNacimiento));
    c.skip('   ');

    c.skip('LUGAR DE NACIMIENTO ( PAIS)');
    c.replace('____ ___________________', '  ' + (a.lugarNacimiento || '') + '                ');
    c.skip('  ');
    c.skip('PAIS DE ');
    c.replace('NACIONALIDAD   __________________   ', 'NACIONALIDAD   ' + (a.nacionalidad || '') + '   ');

    c.fillBlank('CONDICION DE LEGAL ESTANCIA EN MEXICO (EN CASO DE QUE APLIQUE)  ___________________________  ', a.condicionEstanciaMexico || '');

    c.replace(
      'LUGAR DE RESIDENCIA  ________________________    OCUPACIÓN: __________________________________',
      `LUGAR DE RESIDENCIA  ${a.lugarResidencia || ''}    OCUPACIÓN: ${a.ocupacion || ''}`
    );

    c.fillBlank('TELEFONO DE CASA (CLAVE INTERNACIONAL) ____________________________________________________', a.telefonoCasa || '');
    c.fillBlank('TELEFONO DE OFICINA (CLAVE INTERNACIONAL) __________________________________________________', a.telefonoOficina || '');
    c.fillBlank('TELEFONO CELULAR (CLAVE INTERNACIONAL) ____________________________________________________', a.telefonoCelular || '');
    c.fillBlank('CORREO ELECTRONICO ________________________________________________________________________', a.correoElectronico || '');
    c.fillBlank('TIPO DE DOCUMENTO CON EL QUE SE IDENTIFICA _________________________________________________', a.tipoDocumento || '');
    c.fillBlank('AUTORIDAD QUE EMITE LA IDENTIFICACION  ______________________________________________________  ', a.autoridadEmisora || '');
    c.fillBlank('NUMERO DE  IDENTIFICACIÓN: ___________________________________________ ', a.numeroIdentificacion || '');
    c.fillBlank('FECHA DE EXPEDICIÓN DE IDENTIFICACION: _______________________________', fmtDateDMY(a.fechaExpedicionId));
    c.fillBlank('FECHA DE VENCIMIENTO DE IDENTIFICACION: ________________________________', fmtDateDMY(a.fechaVencimientoId));

    // --- Domicilio (solo la primera línea de cada bloque, las líneas de
    // continuación se dejan en blanco, igual que el filler de Armour) ---
    c.skip('DOMICILIO PARTICULAR EN MEXICO: (CALLE, NUMERO EXTERIOR E INTERIOR, COLONIA, DELEGACION O MUNICIPIO, CIUDAD O POBLACION, ENTIDAD FEDERATIVA O DEMARCACION POLITICA, CODIGO POSTAL Y');
    c.fillBlank('PAIS) _______________________________________________________________________________________', a.domicilioMexico || '');
    c.skip('_____________________________________________________________________________________________');
    c.skip(' ');
    c.skip('                                                                                        ');
    c.skip('        ');

    c.skip('DOMICILIO PARTICULAR EN EL EXTRANJERO: (CALLE, NUMERO EXTERIOR E INTERIOR, COLONIA, DELEGACION O MUNICIPIO, CIUDAD O POBLACION, ENTIDAD FEDERATIVA O DEMARCACION POLITICA, CODIGO POSTAL Y');
    c.fillBlank('PAIS) _______________________________________________________________________________________', a.domicilioExtranjero || '');
    c.skip('_____________________________________________________________________________________________');

    // --- Identificadores fiscales ---
    c.skip('CLAVE UNICA DE REGISTRO DE POBLACIÓN (CURP) (EN CASO DE MEXICANOS Y RESIDENTES)');
    if (a.curp) c.fillBoxGrid('|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|', a.curp);
    else c.skip('|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|');

    c.skip('CLAVE DEL REGISTRO FEDERAL DE CONTRIBUYENTES (RFC) (EN CASO DE MEXICANOS Y RESIDENTES)');
    if (a.rfc) c.fillBoxGrid('|__|__|__|__|__|__|__|__|__|__|__|__|__|', a.rfc);
    else c.skip('|__|__|__|__|__|__|__|__|__|__|__|__|__|');

    c.skip('NUMERO DE SEGURIDAD SOCIAL O NUMERO DE ACREDITACION DE CIUDADANÍA (EN CASO DE EXTRANJEROS) ');
    c.fillBlank('______________________________________________________________________', a.numeroSeguridadSocial || '');

    // --- Dueño beneficiario ---
    if (a.tieneDuenoBeneficiario === 'si') {
      c.replace('SEÑALE SI TIENE CONOCIMIENTO DE LA EXISTENCIA DE DUEÑO BENEFICIARIO SI (   ) NO (   )', 'SEÑALE SI TIENE CONOCIMIENTO DE LA EXISTENCIA DE DUEÑO BENEFICIARIO SI (X  ) NO (   )');
    } else if (a.tieneDuenoBeneficiario === 'no') {
      c.replace('SEÑALE SI TIENE CONOCIMIENTO DE LA EXISTENCIA DE DUEÑO BENEFICIARIO SI (   ) NO (   )', 'SEÑALE SI TIENE CONOCIMIENTO DE LA EXISTENCIA DE DUEÑO BENEFICIARIO SI (   ) NO (X  )');
    } else {
      c.skip('SEÑALE SI TIENE CONOCIMIENTO DE LA EXISTENCIA DE DUEÑO BENEFICIARIO SI (   ) NO (   )');
    }

    c.skip('EN CASO DE RESPONDER EN SENTIDO AFIRMATIVO AL APARTADO ANTERIOR INDIQUE EL TIPO DE DUEÑO BENEFICIARIO DE QUE SE TRATE:');
    const tipoDuenoRuns = [
      ['persona_fisica_mx', 'PERSONA FISICA MEXICANA O EXTRANJERA RESIDENTE      (    )'],
      ['persona_fisica_visitante', 'PERSONA FISICA EXTRANJERA VISITANTE                                (    )'],
      ['persona_moral_mx', 'PERSONA MORAL MEXICANA                                                        (    )'],
      ['persona_moral_extranjera', 'PERSONA MORAL EXTRANJERA                                                   (    )'],
      ['fideicomiso', 'FIDEICOMISO                                                                                   (    )']
    ];
    for (const [value, runText] of tipoDuenoRuns) {
      if (a.tipoDuenoBeneficiario === value) c.replace(runText, runText.replace('(    )', '(X   )'));
      else c.skip(runText);
    }

    // --- Declaración / firma ---
    c.skip('CUANDO SE TENGA CONOCIMIENTO DE DUEÑO BENEFICIARIO FAVOR DE LLENAR EXPEDIENTE DE IDENTIFICACIÓN DE DUEÑO BENEFICIARIO. ');
    c.skip('DECLARO BAJO PROTESTA DE DECIR VERDAD, QUE TODA LA INFORMACIÓN ASENTADA POR EL SUSCRITO EN EL PRESENTE DOCUMENTO, ASÍ COMO TODA LA DOCUMENTACIÓN ANEXA ES CIERTA Y VERDADERA');
    c.replace(
      '________________________________                                 ______________________________________________',
      `${fmtDateDMY(a.fechaFirma)}                                                                 ${SIGNATURE_ANCHOR}`
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

module.exports = { fillLprIndividualEs, SIGNATURE_ANCHOR };
