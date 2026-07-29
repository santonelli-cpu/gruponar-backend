const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { DocCursor, fmtDateDMY } = require('./docxFillEngine');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', 'armour-moral-es.docx');
const SIGNATURE_ANCHOR = '/firmakyc/';

function fillArmourMoralEs(answers, outputDocxPath) {
  const a = answers || {};
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyc-armour-moral-es-'));
  try {
    execFileSync('unzip', ['-oq', TEMPLATE_PATH, '-d', workDir]);
    const docXmlPath = path.join(workDir, 'word', 'document.xml');
    const xml = fs.readFileSync(docXmlPath, 'utf-8');

    const c = new DocCursor(xml);

    // --- Tipo de persona (checkbox fusionado con la etiqueta, no separado
    // como en persona física — se reemplaza el run completo). ---
    a.tipoPersona === 'moral_extranjera'
      ? c.replace('PERSONA MORAL EXTRANJERA (    ) ', 'PERSONA MORAL EXTRANJERA (X   ) ')
      : c.skip('PERSONA MORAL EXTRANJERA (    ) ');
    c.skip('Sociedades o empresas constituidas en el extranjero');
    a.tipoPersona === 'moral_mexicana'
      ? c.replace('PERSONA MORAL MEXICANA (    ) ', 'PERSONA MORAL MEXICANA (X   ) ')
      : c.skip('PERSONA MORAL MEXICANA (    ) ');
    c.skip('Sociedades o empresas constituidas en México.');
    a.tipoPersona === 'fideicomiso'
      ? c.replace('FIDEICOMISO (    ) ', 'FIDEICOMISO (X   ) ')
      : c.skip('FIDEICOMISO (    ) ');

    c.skip('NUMERO DE EXPEDIENTE: ');
    c.skip('ASE');
    if (a.numeroExpediente) c.fillBlank('-___________________________', a.numeroExpediente);
    else c.skip('-___________________________');

    c.skip('EN CUMPLIMIENTO A LO DISPUESTO EN LAS REGLAS DE CARÁCTER GENERAL A QUE SE REFIERE LA LEY FEDERAL PARA LA PREVENCIÓN E IDENTIFICACIÓN DE OPERACIONES CON RECURSOS DE PROCEDENCIA ILICITA, EL QUE SUSCRIBE PROPORCIONA LA INFORMACIÓN QUE A CONTINUACIÓN SE SEÑALA:');
    c.skip('DENOMINACION O RAZON SOCIAL: ');
    c.fillBlank('_____________________________________________________________', a.denominacionSocial || '');
    c.fillBlank('FECHA DE CONSTITUCIÓN: ____________________________________________________________________', fmtDateDMY(a.fechaConstitucion));
    c.fillBlank('NACIONALIDAD: ______________________________________________________________________________', a.nacionalidadEmpresa || '');
    c.fillBlank('ACTIVIDAD U OBJETO SOCIAL: __________________________________________________________________', a.actividadObjetoSocial || '');
    c.fillBlank('GIRO MERCANTIL: _____________________________________________________________________________', a.giroMercantil || '');

    c.skip('CLAVE DEL REGISTRO FEDERAL DE CONTRIBUYENTES (RFC) (EN CASO DE SOCIEDADES MEXICANAS)');
    if (a.rfcEmpresa) c.fillBoxGrid('|__|__|__|__|__|__|__|__|__|__|__|__|__|', a.rfcEmpresa);
    else c.skip('|__|__|__|__|__|__|__|__|__|__|__|__|__|');

    c.fillBlank('DOMICILIO DONDE SE LLEVAN A CABO LAS ACTIVIDADES ADMINISTRATIVAS DE LA SOCIEDAD: ____________________________________________________________________________________________', a.domicilioAdministrativo || '');

    // --- Representante legal (mismos campos que persona física) ---
    c.skip('INFORMACIÓN DEL REPRESENTANTE LEGAL DE LA SOCIEDAD:');
    c.skip('NOMBRE: APELLIDO PATERNO, APELLIDO MATERNO Y NOMBRE (S) TAL Y COMO APARECE EN ');
    c.fillBlank('IDENTIFICACIÓN OFICIAL:  ____________________________________________________________________', a.repNombre || '');
    c.replace('FECHA DE NACIMIENTO |___|___|___|___|___|___|', 'FECHA DE NACIMIENTO ' + fmtDateDMY(a.repFechaNacimiento));

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

    // --- Domicilio del representante ---
    c.skip('DOMICILIO PARTICULAR EN MEXICO: (CALLE, NUMERO EXTERIOR E INTERIOR, COLONIA, DELEGACION O MUNICIPIO, CIUDAD O POBLACION, ENTIDAD FEDERATIVA O DEMARCACION POLITICA, CODIGO POSTAL Y');
    c.fillBlank('PAIS) _______________________________________________________________________________________', a.domicilioMexico || '');
    c.skip('DOMICILIO PARTICULAR EN EL EXTRANJERO: (CALLE, NUMERO EXTERIOR E INTERIOR, COLONIA, DELEGACION O MUNICIPIO, CIUDAD O POBLACION, ENTIDAD FEDERATIVA O DEMARCACION POLITICA, CODIGO POSTAL Y');
    c.fillBlank('PAIS) _______________________________________________________________________________________', a.domicilioExtranjero || '');

    // --- Identificadores fiscales del representante ---
    c.skip('CLAVE UNICA DE REGISTRO DE POBLACIÓN (CURP) (EN CASO DE MEXICANOS Y RESIDENTES)');
    if (a.curp) c.fillBoxGrid('|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|', a.curp);
    else c.skip('|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|');

    c.skip('CLAVE DEL REGISTRO FEDERAL DE CONTRIBUYENTES (RFC) (EN CASO DE MEXICANOS Y RESIDENTES)');
    if (a.rfc) c.fillBoxGrid('|__|__|__|__|__|__|__|__|__|__|__|__|__|', a.rfc);
    else c.skip('|__|__|__|__|__|__|__|__|__|__|__|__|__|');

    c.fillBlank('______________________________________________________________________', a.numeroSeguridadSocial || '');

    // --- Dueño beneficiario (SI/NO fusionados en un solo run) ---
    const dueñoText = 'SEÑALE SI TIENE CONOCIMIENTO DE LA EXISTENCIA DE DUEÑO BENEFICIARIO SI (   ) NO (   )';
    let dueñoMarked = dueñoText;
    if (a.tieneDuenoBeneficiario === 'si') dueñoMarked = dueñoMarked.replace('SI (   )', 'SI (X   )');
    else if (a.tieneDuenoBeneficiario === 'no') dueñoMarked = dueñoMarked.replace('NO (   )', 'NO (X   )');
    c.replace(dueñoText, dueñoMarked);

    c.skip('EN CASO DE RESPONDER EN SENTIDO AFIRMATIVO AL APARTADO ANTERIOR INDIQUE EL TIPO DE DUEÑO BENEFICIARIO DE QUE SE TRATE:');
    const tipoDuenoOptions = [
      ['persona_fisica_mx', 'PERSONA FISICA MEXICANA O EXTRANJERA RESIDENTE      (    )'],
      ['persona_fisica_visitante', 'PERSONA FISICA EXTRANJERA VISITANTE                                (    )'],
      ['persona_moral_mx', 'PERSONA MORAL MEXICANA                                                        (    )'],
      ['persona_moral_extranjera', 'PERSONA MORAL EXTRANJERA                                                   (    )'],
      ['fideicomiso', 'FIDEICOMISO                                                                                   (    )']
    ];
    tipoDuenoOptions.forEach(([value, text]) => {
      a.tipoDuenoBeneficiario === value ? c.replace(text, text.replace('(    )', '(X   )')) : c.skip(text);
    });

    // --- Declaración / firma ---
    c.skip('CUANDO SE TENGA CONOCIMIENTO DE DUEÑO BENEFICIARIO FAVOR DE LLENAR EXPEDIENTE DE IDENTIFICACIÓN DE DUEÑO BENEFICIARIO. ');
    c.skip('DECLARO BAJO PROTESTA DE DECIR VERDAD, QUE TODA LA INFORMACIÓN ASENTADA POR EL SUSCRITO EN EL PRESENTE DOCUMENTO, ASÍ COMO TODA LA DOCUMENTACIÓN ANEXA ES CIERTA Y VERDADERA');
    c.replace(
      '________________________________                                 ______________________________________________',
      `${fmtDateDMY(a.fechaFirma)}                                                                  ${SIGNATURE_ANCHOR}`
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

module.exports = { fillArmourMoralEs, SIGNATURE_ANCHOR };
