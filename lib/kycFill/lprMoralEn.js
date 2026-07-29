const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { DocCursor, fmtDateMDY } = require('./docxFillEngine');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', 'lpr-moral-en.docx');

const SIGNATURE_ANCHOR = '/firmakyclprmoralEn/';

// Llena la plantilla de LPR Luxury Persona Moral (EN) — mapeo de campos
// hecho contra el XML EXACTO de templates/lpr-moral-en.docx.
function fillLprMoralEn(answers, outputDocxPath) {
  const a = answers || {};
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyc-lpr-moral-en-'));
  try {
    execFileSync('unzip', ['-oq', TEMPLATE_PATH, '-d', workDir]);
    const docXmlPath = path.join(workDir, 'word', 'document.xml');
    const xml = fs.readFileSync(docXmlPath, 'utf-8');

    const c = new DocCursor(xml);

    // --- Type of person ---
    c.skip('FOREIGN  LEGAL');
    c.replace(' ENTITY (    )  ', a.tipoPersona === 'moral_extranjera' ? ' ENTITY (X   )  ' : ' ENTITY (    )  ');
    c.skip('Companies or firms established abroad');
    c.skip('MEXICAN LEGAL ');
    c.skip('ENTITY  (');
    c.replace('    )  ', a.tipoPersona === 'moral_mexicana' ? 'X   )  ' : '    )  ');
    c.skip('Companies or firms formed in Mexico');
    c.skip('TRUST  ');
    c.skip('   (');
    c.replace('    ) ', a.tipoPersona === 'fideicomiso' ? 'X   ) ' : '    ) ');
    c.fillBlank('FILE NUMBER: FME-___________________________', a.numeroExpediente || '');

    c.skip('PURSUANT TO THE PROVISIONS OF THE GENERAL RULES REFERRED TO FEDERAL LAW ON PREVENTION AND IDENTIFICATION OF OPERATIONS RESOURCES FROM ILLICIT, THEREFORE I PROVIDE INFORMATION BELOW AS SHOWN:');

    // --- Legal entity data ---
    c.skip('NAME OF LEGAL ENTITY: ');
    c.replace('_____________________________________________________________', a.denominacionSocial || '');
    c.fillBlank('DATE OF INCORPORATION: ____________________________________________________________________', fmtDateMDY(a.fechaConstitucion));
    c.fillBlank('NACIONALITY: ______________________________________________________________________________', a.nacionalidadEmpresa || '');
    c.fillBlank('ACTIVITY OR BUSINESS OBJECT: _________________________________________________________________', a.actividadObjetoSocial || '');
    c.fillBlank('TYPE OF BUSINESS: _____________________________________________________________________________', a.giroMercantil || '');

    c.skip('CLAVE DEL REGISTRO FEDERAL DE CONTRIBUYENTES (RFC) (MEXICAN LEGAL ENTITY)');
    if (a.rfcEmpresa) c.fillBoxGrid('|__|__|__|__|__|__|__|__|__|__|__|__|__|', a.rfcEmpresa);
    else c.skip('|__|__|__|__|__|__|__|__|__|__|__|__|__|');

    c.fillBlank(
      'ADDRESS WHERE HOLDING COMPANY ADMINISTRATIVE ACTIVITIES: ____________________________________________________________________________________________',
      a.domicilioAdministrativo || ''
    );
    c.skip('_____________________________________________________________________________________________');

    // --- Legal representative ---
    c.skip('INFORMATION FROM THE LEGAL REPRESENTATIVE:');
    c.skip('NAME:');
    c.skip(' LAST NAME, MAIDEN NAME Y NAME (S) AS SHOWN ON OFFICIAL IDENTIFICATION:  ');
    c.skip(' ');
    c.replace('____________________________________________________________________', a.repNombre || '');

    c.replace('DATE OF BIRTH |___|___|___|___|___|___|', 'DATE OF BIRTH ' + fmtDateMDY(a.repFechaNacimiento));
    c.skip('   ');
    c.skip('BIRTHPLACE (CITY AND ');
    c.skip('COUNTRY)   ');
    c.replace(
      '______________________    NATIONALITY   __________________   ',
      `${a.repLugarNacimiento || ''}    NATIONALITY   ${a.repNacionalidad || ''}   `
    );
    c.skip('LEGAL STATUS OF STAY IN MEXICO ');
    c.skip('   (');
    c.fillBlank('IF APPLICABLE)  ___________________________  ', a.repCondicionEstanciaMexico || '');
    c.skip('PLACE OF ');
    c.replace('RESIDENCY  _', 'RESIDENCY  ');
    c.replace(
      '_______________________    OCUPATION: __________________________________',
      `${a.repLugarResidencia || ''}                        OCUPATION: ${a.repOcupacion || ''}`
    );

    c.skip('HOME  PHONE');
    c.fillBlank(' NUMBER (INCLUDING INTERNATIONAL CODE) _________________________________________', a.repTelefonoCasa || '');
    c.fillBlank('OFFICE PHONE NUMBER (INCLUDING INTERNATIONAL CODE) ________________________________________', a.repTelefonoOficina || '');
    c.skip('CELL ');
    c.skip('PHONE  NUMBER');
    c.fillBlank(' (INCLUDING INTERNATIONAL CODE) __________________________________________', a.repTelefonoCelular || '');
    c.replace('E-MAIL ________________________________________________________________________', 'E-MAIL ' + (a.repCorreoElectronico || ''));
    c.fillBlank('DOCUMENT TYPE WITH NAMED WHICH YOU IDENTIFY YOURSELF _____________________________________', a.repTipoDocumento || '');
    c.fillBlank('ISSUING AUTHORITY ____________________________________________________________________________  ', a.repAutoridadEmisora || '');
    c.fillBlank('IDENTIFICATION NUMBER: ___________________________________________ ', a.repNumeroIdentificacion || '');
    c.fillBlank('DATE ISSUED: _______________________________', fmtDateMDY(a.repFechaExpedicionId));
    c.fillBlank('EXPIRATION DATE: ________________________________', fmtDateMDY(a.repFechaVencimientoId));

    c.fillBlank(
      'HOME ADDRESS IN MEXICO COMPLETE: (STREET NUMBER AND INTERIOR EXTERIOR,  MUNICIPALITY, OR CITY, AND POSTAL CODE, COUNTRY) _______________________________________________________________________________________',
      a.domicilioMexico || ''
    );
    c.skip('_____________________________________________________________________________________________');

    c.fillBlank(
      'PRIVATE HOME ABROAD ADDRESS: (STREET NUMBER AND INTERIOR EXTERIOR,  MUNICIPALITY, OR CITY, AND POSTAL CODE, COUNTRY) _______________________________________________________________________________________',
      a.domicilioExtranjero || ''
    );
    c.skip('_____________________________________________________________________________________________');

    c.skip('CLAVE UNICA DE REGISTRO DE POBLACIÓN (CURP) (MEXICANS AND RESIDENTS)');
    if (a.curp) c.fillBoxGrid('|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|', a.curp);
    else c.skip('|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|');

    c.skip('CLAVE DEL REGISTRO FEDERAL DE CONTRIBUYENTES (RFC) (MEXICANS AND RESIDENTS)');
    if (a.rfc) c.fillBoxGrid('|__|__|__|__|__|__|__|__|__|__|__|__|__|', a.rfc);
    else c.skip('|__|__|__|__|__|__|__|__|__|__|__|__|__|');

    c.skip('SOCIAL SECURITY NUMBER OR GOVERNMENT ACCREDITATION NUMBER OF ');
    c.skip('CITIZENSHIP  (');
    c.skip('IF ALIENS)');
    c.fillBlank('______________________________________________________________________', a.numeroSeguridadSocial || '');

    // --- Beneficiary owner ---
    c.skip('INDICATE IF YOU HAVE KNOWLEDGE OF THE EXISTENCE OF BENEFICIARY ');
    c.skip('OWNER  YES');
    if (a.tieneDuenoBeneficiario === 'si') c.replace(' (   ) NO (   )', ' (X  ) NO (   )');
    else if (a.tieneDuenoBeneficiario === 'no') c.replace(' (   ) NO (   )', ' (   ) NO (X  )');
    else c.skip(' (   ) NO (   )');

    c.skip('IF YES RESPONDED ON ');
    c.skip('THE  SECTION');
    c.skip(' ABOVE INDICATE THE TYPE OF BENEFICIARY OWNER:');
    const tipoDuenoRuns = [
      ['persona_fisica_mx', 'NATURAL PERSON OR MEXICAN FOREIGN RESIDENT   '],
      ['persona_fisica_visitante', 'NATURAL PERSON FOREIGN VISITOR                               '],
      ['persona_moral_mx', 'MEXICAN LEGAL ENTITY                                                      '],
      ['persona_moral_extranjera', 'FOREIGN LEGAL ENTITY                                                      '],
      ['fideicomiso', 'TRUST                                                                                     ']
    ];
    for (const [value, labelRun] of tipoDuenoRuns) {
      c.skip(labelRun);
      c.skip('   (');
      c.replace('    )', value === a.tipoDuenoBeneficiario ? 'X   )' : '    )');
    }

    c.skip('IF ADVISED OF BENEFICIARY OWNER PLEASE COMPLETE RECORD OWNER IDENTIFICATION OF BENEFICIARY.');
    c.skip('I DECLARE UNDER PENALTY OF PERJURY, THAT ALL INFORMATION SEATED SIGNED BY THE HEREIN, AND ANY ACCOMPANYING DOCUMENTATION IS TRUE AND CORRECT');
    c.skip('                                                                                                ');
    c.skip('LEGAL ENTITY NAME');
    c.replace(
      '________________________________                                 ______________________________________________',
      `${fmtDateMDY(a.fechaFirma)}                                                                 ${SIGNATURE_ANCHOR}`
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

module.exports = { fillLprMoralEn, SIGNATURE_ANCHOR };
