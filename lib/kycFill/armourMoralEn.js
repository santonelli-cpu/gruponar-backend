const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { DocCursor, fmtDateDMY } = require('./docxFillEngine');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', 'armour-moral-en.docx');
const SIGNATURE_ANCHOR = '/firmakyc/';

function fillArmourMoralEn(answers, outputDocxPath) {
  const a = answers || {};
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyc-armour-moral-en-'));
  try {
    execFileSync('unzip', ['-oq', TEMPLATE_PATH, '-d', workDir]);
    const docXmlPath = path.join(workDir, 'word', 'document.xml');
    const xml = fs.readFileSync(docXmlPath, 'utf-8');

    const c = new DocCursor(xml);

    // --- Type of person (checkbox split from its label into separate runs). ---
    c.skip('TYPE OF PERSON: (MARK WITH AN X) ');
    c.skip('FOREIGN  LEGAL');
    a.tipoPersona === 'moral_extranjera'
      ? c.replace(' ENTITY (    )  ', ' ENTITY (X   )  ')
      : c.skip(' ENTITY (    )  ');
    c.skip('Companies or firms established abroad');
    c.skip('MEXICAN LEGAL ');
    c.skip('ENTITY  (');
    a.tipoPersona === 'moral_mexicana'
      ? c.replace('    )  ', 'X   )  ')
      : c.skip('    )  ');
    c.skip('Companies or firms formed in Mexico');
    a.tipoPersona === 'fideicomiso'
      ? c.replace('TRUST     (    ) ', 'TRUST     (X   ) ')
      : c.skip('TRUST     (    ) ');

    c.skip('FILE NUMBER: ');
    c.skip('ASE');
    if (a.numeroExpediente) c.fillBlank('-___________________________', a.numeroExpediente);
    else c.skip('-___________________________');

    c.skip('PURSUANT TO THE PROVISIONS OF THE GENERAL RULES REFERRED TO FEDERAL LAW ON PREVENTION AND IDENTIFICATION OF OPERATIONS RESOURCES FROM ILLICIT, THEREFORE I PROVIDE INFORMATION BELOW AS SHOWN:');
    c.skip('NAME OF LEGAL ENTITY: ');
    c.fillBlank('_____________________________________________________________', a.denominacionSocial || '');
    c.fillBlank('DATE OF INCORPORATION: ____________________________________________________________________', fmtDateDMY(a.fechaConstitucion));
    c.fillBlank('NACIONALITY: ______________________________________________________________________________', a.nacionalidadEmpresa || '');
    c.fillBlank('ACTIVITY OR BUSINESS OBJECT: _________________________________________________________________', a.actividadObjetoSocial || '');
    c.fillBlank('TYPE OF BUSINESS: _____________________________________________________________________________', a.giroMercantil || '');

    c.skip('CLAVE DEL REGISTRO FEDERAL DE CONTRIBUYENTES (RFC) (MEXICAN LEGAL ENTITY)');
    if (a.rfcEmpresa) c.fillBoxGrid('|__|__|__|__|__|__|__|__|__|__|__|__|__|', a.rfcEmpresa);
    else c.skip('|__|__|__|__|__|__|__|__|__|__|__|__|__|');

    c.fillBlank('ADDRESS WHERE HOLDING COMPANY ADMINISTRATIVE ACTIVITIES: ____________________________________________________________________________________________', a.domicilioAdministrativo || '');
    c.skip('_____________________________________________________________________________________________');

    // --- Legal representative ---
    c.skip('INFORMATION FROM THE LEGAL REPRESENTATIVE:');
    c.skip('NAME:');
    c.skip(' LAST NAME, MAIDEN NAME Y NAME (S) AS SHOWN ON OFFICIAL IDENTIFICATION:  ');
    c.fillBlank(' ____________________________________________________________________', a.repNombre || '');

    c.replace('DATE OF BIRTH |___|___|___|___|___|___|', 'DATE OF BIRTH ' + fmtDateDMY(a.repFechaNacimiento));
    c.skip('   ');
    c.skip('BIRTHPLACE (CITY AND ');
    c.skip('COUNTRY)   ');
    c.replace(
      '______________________    NATIONALITY   __________________   ',
      `${a.repLugarNacimiento || ''}    NATIONALITY   ${a.repNacionalidad || ''}   `
    );
    c.fillBlank('LEGAL STATUS OF STAY IN MEXICO    (IF APPLICABLE)  ___________________________  ', a.repCondicionEstanciaMexico || '');
    c.replace(
      'PLACE OF RESIDENCY  ________________________    OCUPATION: __________________________________',
      `PLACE OF RESIDENCY  ${a.repLugarResidencia || ''}    OCUPATION: ${a.repOcupacion || ''}`
    );
    c.fillBlank('HOME  PHONE NUMBER (INCLUDING INTERNATIONAL CODE) _________________________________________', a.repTelefonoCasa || '');
    c.fillBlank('OFFICE PHONE NUMBER (INCLUDING INTERNATIONAL CODE) ________________________________________', a.repTelefonoOficina || '');
    c.fillBlank('CELL PHONE  NUMBER (INCLUDING INTERNATIONAL CODE) __________________________________________', a.repTelefonoCelular || '');
    c.fillBlank('E-MAIL ________________________________________________________________________', a.repCorreoElectronico || '');
    c.fillBlank('DOCUMENT TYPE WITH NAMED WHICH YOU IDENTIFY YOURSELF _____________________________________', a.repTipoDocumento || '');
    c.fillBlank('ISSUING AUTHORITY ____________________________________________________________________________  ', a.repAutoridadEmisora || '');
    c.fillBlank('IDENTIFICATION NUMBER: ___________________________________________ ', a.repNumeroIdentificacion || '');
    c.fillBlank('DATE ISSUED: _______________________________', fmtDateDMY(a.repFechaExpedicionId));
    c.fillBlank('EXPIRATION DATE: ________________________________', fmtDateDMY(a.repFechaVencimientoId));

    // --- Representative's address ---
    c.fillBlank('HOME ADDRESS IN MEXICO COMPLETE: (STREET NUMBER AND INTERIOR EXTERIOR,  MUNICIPALITY, OR CITY, AND POSTAL CODE, COUNTRY) _______________________________________________________________________________________', a.domicilioMexico || '');
    c.skip('_____________________________________________________________________________________________');
    c.fillBlank('PRIVATE HOME ABROAD ADDRESS: (STREET NUMBER AND INTERIOR EXTERIOR,  MUNICIPALITY, OR CITY, AND POSTAL CODE, COUNTRY) _______________________________________________________________________________________', a.domicilioExtranjero || '');
    c.skip('_____________________________________________________________________________________________');

    // --- Tax identifiers ---
    c.skip('CLAVE UNICA DE REGISTRO DE POBLACIÓN (CURP) (MEXICANS AND RESIDENTS)');
    if (a.curp) c.fillBoxGrid('|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|', a.curp);
    else c.skip('|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|');

    c.skip('CLAVE DEL REGISTRO FEDERAL DE CONTRIBUYENTES (RFC) (MEXICANS AND RESIDENTS)');
    if (a.rfc) c.fillBoxGrid('|__|__|__|__|__|__|__|__|__|__|__|__|__|', a.rfc);
    else c.skip('|__|__|__|__|__|__|__|__|__|__|__|__|__|');

    c.fillBlank('______________________________________________________________________', a.numeroSeguridadSocial || '');

    // --- Beneficiary owner (YES/NO fused into one run) ---
    const dueñoText = 'INDICATE IF YOU HAVE KNOWLEDGE OF THE EXISTENCE OF BENEFICIARY OWNER  YES (   ) NO (   )';
    let dueñoMarked = dueñoText;
    if (a.tieneDuenoBeneficiario === 'si') dueñoMarked = dueñoMarked.replace('YES (   )', 'YES (X   )');
    else if (a.tieneDuenoBeneficiario === 'no') dueñoMarked = dueñoMarked.replace('NO (   )', 'NO (X   )');
    c.replace(dueñoText, dueñoMarked);

    c.skip('IF YES RESPONDED ON THE  SECTION ABOVE INDICATE THE TYPE OF BENEFICIARY OWNER:');
    const tipoDuenoOptions = [
      ['persona_fisica_mx', 'NATURAL PERSON OR MEXICAN FOREIGN RESIDENT      (    )'],
      ['persona_fisica_visitante', 'NATURAL PERSON FOREIGN VISITOR                                  (    )'],
      ['persona_moral_mx', 'MEXICAN LEGAL ENTITY                                                         (    )'],
      ['persona_moral_extranjera', 'FOREIGN LEGAL ENTITY                                                         (    )'],
      ['fideicomiso', 'TRUST                                                                                        (    )']
    ];
    tipoDuenoOptions.forEach(([value, text]) => {
      a.tipoDuenoBeneficiario === value ? c.replace(text, text.replace('(    )', '(X   )')) : c.skip(text);
    });

    // --- Declaration / signature ---
    c.skip('IF ADVISED OF BENEFICIARY OWNER PLEASE COMPLETE RECORD OWNER IDENTIFICATION OF BENEFICIARY.');
    c.skip('I DECLARE UNDER PENALTY OF PERJURY, THAT ALL INFORMATION SEATED SIGNED BY THE HEREIN, AND ANY ACCOMPANYING DOCUMENTATION IS TRUE AND CORRECT');
    c.skip('LEGAL ENTITY NAME');
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

module.exports = { fillArmourMoralEn, SIGNATURE_ANCHOR };
