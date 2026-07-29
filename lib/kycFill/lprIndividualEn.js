const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { DocCursor, fmtDateMDY } = require('./docxFillEngine');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', 'lpr-individual-en.docx');

const SIGNATURE_ANCHOR = '/firmakyclprEn/';

// Llena la plantilla de LPR Luxury Persona Física (EN) — mapeo de campos
// hecho contra el XML EXACTO de templates/lpr-individual-en.docx.
function fillLprIndividualEn(answers, outputDocxPath) {
  const a = answers || {};
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyc-lpr-individual-en-'));
  try {
    execFileSync('unzip', ['-oq', TEMPLATE_PATH, '-d', workDir]);
    const docXmlPath = path.join(workDir, 'word', 'document.xml');
    const xml = fs.readFileSync(docXmlPath, 'utf-8');

    const c = new DocCursor(xml);

    // --- Type of person ---
    c.skip('MEXICAN NATURAL PERSON ');
    a.tipoPersona === 'mexicana' ? c.markCheckbox('(  ') : c.skip('(  ');
    c.skip('  ) ');
    c.skip('person with Mexican nationality');
    c.skip('NATURAL PERSON RESIDENT ALIEN ');
    a.tipoPersona === 'extranjera_residente' ? c.markCheckbox('(  ') : c.skip('(  ');
    c.skip('  ) ');
    c.skip('temporary or permanent resident that has FM2, FM3, VISA');
    c.replace('NATURAL PERSON FOREIGN VISITOR (    ) ', a.tipoPersona === 'extranjera_visitante' ? 'NATURAL PERSON FOREIGN VISITOR (X   ) ' : 'NATURAL PERSON FOREIGN VISITOR (    ) ');
    c.skip('nonresident alien');

    c.fillBlank('FILE NUMBER: FME-_________________________', a.numeroExpediente || '');

    c.skip('PURSUANT TO THE PROVISIONS OF THE GENERAL RULES REFERRED TO FEDERAL LAW ON PREVENTION AND IDENTIFICATION OF OPERATIONS RESOURCES FROM ILLICIT, THEREFORE I PROVIDE INFORMATION BELOW AS SHOWN');
    c.skip(':');
    c.skip('NAME:');
    c.skip(' LAST NAME, MAIDEN NAME Y NAME (S) AS SHOWN ON OFFICIAL IDENTIFICATION:  ');
    c.replace('____________________________________________________________________', a.nombre || '');

    c.replace('DATE OF BIRTH: |___|___|___|___|___|___|', 'DATE OF BIRTH: ' + fmtDateMDY(a.fechaNacimiento));
    c.skip('   ');

    c.replace(
      'BIRTHPLACE (CITY AND COUNTRY) ______________________    NATIONALITY   __________________________   ',
      `BIRTHPLACE (CITY AND COUNTRY) ${a.lugarNacimiento || ''}    NATIONALITY   ${a.nacionalidad || ''}   `
    );
    c.fillBlank('LEGAL STATUS OF STAY IN MEXICO (IF APPLICABLE) ________________________________________________  ', a.condicionEstanciaMexico || '');
    c.replace(
      'PLACE OF RESIDENCE __________________________    OCUPATION: ___________________________________',
      `PLACE OF RESIDENCE ${a.lugarResidencia || ''}    OCUPATION: ${a.ocupacion || ''}`
    );

    c.skip('HOME  PHONE');
    c.fillBlank(' NUMBER (INCLUDING INTERNATIONAL CODE) _________________________________________', a.telefonoCasa || '');
    c.fillBlank('OFFICE PHONE NUMBER (INCLUDING INTERNATIONAL CODE) ________________________________________', a.telefonoOficina || '');
    c.fillBlank('CELL PHONE  NUMBER (INCLUDING INTERNATIONAL CODE) __________________________________________', a.telefonoCelular || '');
    c.replace('E-MAIL ADDRESS_______ ________________________________________________________________________', 'E-MAIL ADDRESS ' + (a.correoElectronico || ''));
    c.fillBlank('DOCUMENT TYPE WITH NAMED WHICH YOU IDENTIFY YOURSELF _____________________________________', a.tipoDocumento || '');
    c.fillBlank('ISSUING AUTHORITY ____________________________________________________________________________  ', a.autoridadEmisora || '');
    c.fillBlank('IDENTIFICATION NUMBER: ___________________________________________ ', a.numeroIdentificacion || '');
    c.fillBlank('DATE ISSUED: _______________________________', fmtDateMDY(a.fechaExpedicionId));
    c.fillBlank('EXPIRATION DATE: ________________________________', fmtDateMDY(a.fechaVencimientoId));

    c.fillBlank(
      'HOME ADDRESS IN MEXICO COMPLETE: (STREET NUMBER AND INTERIOR EXTERIOR,  MUNICIPALITY, OR CITY, AND POSTAL CODE, COUNTRY) _______________________________________________________________________________________',
      a.domicilioMexico || ''
    );
    c.skip('_____________________________________________________________________________________________');
    c.skip('                                                                                                 ');

    c.skip('PRIVATE HOME ABROAD ADDRESS: (STREET NUMBER AND INTERIOR ');
    c.skip('EXTERIOR,  MUNICIPALITY');
    c.fillBlank(', OR CITY, AND POSTAL CODE, COUNTRY) _______________________________________________________________________________________', a.domicilioExtranjero || '');
    c.skip('_____________________________________________________________________________________________');

    c.skip('CLAVE UNICA DE REGISTRO DE POBLACIÓN (CURP) (MEXICANS AND RESIDENTS)');
    if (a.curp) c.fillBoxGrid('|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|', a.curp);
    else c.skip('|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|');

    c.skip('CLAVE DEL REGISTRO FEDERAL DE CONTRIBUYENTES (RFC) (MEXICANS AND RESIDENTS)');
    if (a.rfc) c.fillBoxGrid('|__|__|__|__|__|__|__|__|__|__|__|__|__|', a.rfc);
    else c.skip('|__|__|__|__|__|__|__|__|__|__|__|__|__|');

    c.skip('SOCIAL SECURITY NUMBER OR GOVERNMENT ACCREDITATION NUMBER OF CITIZENSHIP  (IF ALIENS)');
    c.fillBlank('______________________________________________________________________', a.numeroSeguridadSocial || '');

    // --- Beneficiary owner ---
    c.skip('INDICATE IF YOU HAVE KNOWLEDGE OF THE EXISTENCE OF BENEFICIARY ');
    c.skip('OWNER  YES');
    if (a.tieneDuenoBeneficiario === 'si') c.replace(' (   ) NO (   )', ' (X  ) NO (   )');
    else if (a.tieneDuenoBeneficiario === 'no') c.replace(' (   ) NO (   )', ' (   ) NO (X  )');
    else c.skip(' (   ) NO (   )');

    c.skip('IF YES TO RESPOND IN THE  SECTION ABOVE INDICATE THE TYPE OF BENEFICIARY OWNER:');
    const tipoDuenoRuns = [
      ['persona_fisica_mx', 'NATURAL PERSON OR MEXICAN FOREIGN RESIDENT      (    )'],
      ['persona_fisica_visitante', 'NATURAL PERSON FOREIGN VISITOR                                  (    )'],
      ['persona_moral_mx', 'MEXICAN LEGAL ENTITY                                                         (    )'],
      ['persona_moral_extranjera', 'FOREIGN LEGAL ENTITY                                                         (    )'],
      ['fideicomiso', 'TRUST                                                                                        (    )']
    ];
    for (const [value, runText] of tipoDuenoRuns) {
      if (a.tipoDuenoBeneficiario === value) c.replace(runText, runText.replace('(    )', '(X   )'));
      else c.skip(runText);
    }

    c.skip('IF ADVISED OF BENEFICIARY OWNER PLEASE COMPLETE RECORD OWNER IDENTIFICATION OF BENEFICIARY.');
    c.skip('I DECLARE UNDER PENALTY OF PERJURY, THAT ALL INFORMATION SEATED SIGNED BY THE HEREIN, AND ANY ACCOMPANYING DOCUMENTATION IS TRUE AND CORRECT');
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

module.exports = { fillLprIndividualEn, SIGNATURE_ANCHOR };
