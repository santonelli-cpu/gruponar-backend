const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { DocCursor, fmtDateDMY } = require('./docxFillEngine');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', 'lpr-moral-es.docx');

const SIGNATURE_ANCHOR = '/firmakyclprmoral/';

// Llena la plantilla de LPR Luxury Persona Moral (ES) — mapeo de campos
// hecho contra el XML EXACTO de templates/lpr-moral-es.docx.
function fillLprMoralEs(answers, outputDocxPath) {
  const a = answers || {};
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyc-lpr-moral-es-'));
  try {
    execFileSync('unzip', ['-oq', TEMPLATE_PATH, '-d', workDir]);
    const docXmlPath = path.join(workDir, 'word', 'document.xml');
    const xml = fs.readFileSync(docXmlPath, 'utf-8');

    const c = new DocCursor(xml);

    // --- Tipo de persona ---
    c.skip('TIPO DE PERSONA:');
    c.skip(' (MARCAR CON UNA X)');
    c.skip(' ');
    c.replace('PERSONA MORAL EXTRANJERA (    ) ', a.tipoPersona === 'moral_extranjera' ? 'PERSONA MORAL EXTRANJERA (X   ) ' : 'PERSONA MORAL EXTRANJERA (    ) ');
    c.skip(' ');
    c.skip('Sociedades o empresas constituidas en el extranjero');
    c.replace('PERSONA MORAL MEXICANA (    ) ', a.tipoPersona === 'moral_mexicana' ? 'PERSONA MORAL MEXICANA (X   ) ' : 'PERSONA MORAL MEXICANA (    ) ');
    c.skip(' ');
    c.skip('Sociedades o empresas constituidas en México.');
    c.skip(' ');
    c.replace('FIDEICOMISO (    ) ', a.tipoPersona === 'fideicomiso' ? 'FIDEICOMISO (X   ) ' : 'FIDEICOMISO (    ) ');
    c.skip('NUMERO DE EXPEDIENTE: ');
    c.fillBlank('___________________________', a.numeroExpediente || '');

    c.skip('EN CUMPLIMIENTO A LO DISPUESTO EN LAS REGLAS DE CARÁCTER GENERAL A QUE SE REFIERE LA LEY FEDERAL PARA LA PREVENCIÓN E IDENTIFICACIÓN DE OPERACIONES CON RECURSOS DE PROCEDENCIA ILICITA, EL QUE SUSCRIBE PROPORCIONA LA INFORMACIÓN QUE A CONTINUACIÓN SE SEÑALA:');

    // --- Datos de la sociedad ---
    c.skip('DENOMINACION O RAZON SOCIAL: ');
    c.replace('_____________________________________________________________', a.denominacionSocial || '');
    c.fillBlank('FECHA DE CONSTITUCIÓN: ____________________________________________________________________', fmtDateDMY(a.fechaConstitucion));
    c.fillBlank('NACIONALIDAD: ______________________________________________________________________________', a.nacionalidadEmpresa || '');
    c.fillBlank('ACTIVIDAD U OBJETO SOCIAL: __________________________________________________________________', a.actividadObjetoSocial || '');
    c.fillBlank('GIRO MERCANTIL: _____________________________________________________________________________', a.giroMercantil || '');

    c.skip('CLAVE DEL REGISTRO FEDERAL DE CONTRIBUYENTES (RFC) (EN CASO DE SOCIEDADES MEXICANAS)');
    if (a.rfcEmpresa) c.fillBoxGrid('|__|__|__|__|__|__|__|__|__|__|__|__|__|', a.rfcEmpresa);
    else c.skip('|__|__|__|__|__|__|__|__|__|__|__|__|__|');

    c.fillBlank(
      'DOMICILIO DONDE SE LLEVAN A CABO LAS ACTIVIDADES ADMINISTRATIVAS DE LA SOCIEDAD: ____________________________________________________________________________________________',
      a.domicilioAdministrativo || ''
    );
    c.skip('_____________________________________________________________________________________________');

    // --- Representante legal ---
    c.skip('INFORMACIÓN DEL REPRESENTANTE LEGAL DE LA SOCIEDAD:');
    c.skip('NOMBRE: APELLIDO PATERNO, APELLIDO MATERNO Y NOMBRE (S) TAL Y COMO APARECE EN ');
    c.fillBlank('IDENTIFICACIÓN OFICIAL:  ____________________________________________________________________', a.repNombre || '');

    c.replace('FECHA DE NACIMIENTO |___|___|___|___|___|___|', 'FECHA DE NACIMIENTO ' + fmtDateDMY(a.repFechaNacimiento));
    c.skip('   ');

    c.replace(
      'LUGAR DE NACIMIENTO (CIUDAD Y PAIS) ______________________    NACIONALIDAD   __________________   ',
      `LUGAR DE NACIMIENTO (CIUDAD Y PAIS) ${a.repLugarNacimiento || ''}    NACIONALIDAD   ${a.repNacionalidad || ''}   `
    );
    c.fillBlank('CONDICION DE LEGAL ESTANCIA EN MEXICO (EN CASO DE QUE APLIQUE)  ___________________________  ', a.repCondicionEstanciaMexico || '');
    c.replace(
      'LUGAR DE RESIDENCIA  ________________________    OCUPACIÓN: __________________________________',
      `LUGAR DE RESIDENCIA  ${a.repLugarResidencia || ''}    OCUPACIÓN: ${a.repOcupacion || ''}`
    );

    c.fillBlank('TELEFONO DE CASA (CLAVE INTERNACIONAL) ____________________________________________________', a.repTelefonoCasa || '');
    c.fillBlank('TELEFONO DE OFICINA (CLAVE INTERNACIONAL) __________________________________________________', a.repTelefonoOficina || '');
    c.fillBlank('TELEFONO CELULAR (CLAVE INTERNACIONAL) ____________________________________________________', a.repTelefonoCelular || '');
    c.fillBlank('CORREO ELECTRONICO ________________________________________________________________________', a.repCorreoElectronico || '');
    c.fillBlank('TIPO DE DOCUMENTO CON EL QUE SE IDENTIFICA _________________________________________________', a.repTipoDocumento || '');
    c.fillBlank('AUTORIDAD QUE EMITE LA IDENTIFICACION  ______________________________________________________  ', a.repAutoridadEmisora || '');
    c.fillBlank('NUMERO DE  IDENTIFICACIÓN: ___________________________________________ ', a.repNumeroIdentificacion || '');
    c.fillBlank('FECHA DE EXPEDICIÓN DE IDENTIFICACION: _______________________________', fmtDateDMY(a.repFechaExpedicionId));
    c.fillBlank('FECHA DE VENCIMIENTO DE IDENTIFICACION: ________________________________', fmtDateDMY(a.repFechaVencimientoId));

    c.skip('DOMICILIO PARTICULAR EN MEXICO: (CALLE, NUMERO EXTERIOR E INTERIOR, COLONIA, DELEGACION O MUNICIPIO, CIUDAD O POBLACION, ENTIDAD FEDERATIVA O DEMARCACION POLITICA, CODIGO POSTAL Y');
    c.fillBlank('PAIS) _______________________________________________________________________________________', a.domicilioMexico || '');
    c.skip('_____________________________________________________________________________________________');
    c.skip(' ');
    c.skip('                                                                                        ');
    c.skip('        ');

    c.skip('DOMICILIO PARTICULAR EN EL EXTRANJERO: (CALLE, NUMERO EXTERIOR E INTERIOR, COLONIA, DELEGACION O MUNICIPIO, CIUDAD O POBLACION, ENTIDAD FEDERATIVA O DEMARCACION POLITICA, CODIGO POSTAL Y');
    c.fillBlank('PAIS) _______________________________________________________________________________________', a.domicilioExtranjero || '');
    c.skip('_____________________________________________________________________________________________');

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

    c.skip('CUANDO SE TENGA CONOCIMIENTO DE DUEÑO BENEFICIARIO FAVOR DE LLENAR EXPEDIENTE DE IDENTIFICACIÓN DE DUEÑO BENEFICIARIO. ');
    c.skip('DECLARO BAJO PROTESTA DE DECIR VERDAD, QUE TODA LA INFORMACIÓN ASENTADA POR EL SUSCRITO EN EL PRESENTE DOCUMENTO, ASÍ COMO TODA LA DOCUMENTACIÓN ANEXA ES CIERTA Y VERDADERA');
    c.skip('                                                                                                NOMBRE DE LA SOCIEDAD');
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

module.exports = { fillLprMoralEs, SIGNATURE_ANCHOR };
