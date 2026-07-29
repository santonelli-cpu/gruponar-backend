const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { DocCursor, mergeAdjacentRuns, fmtDateDMY } = require('./docxFillEngine');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', 'tla-individual-es.docx');
const SIGNATURE_ANCHOR = '/firmakyc/';

function fillTlaIndividualEs(answers, outputDocxPath) {
  const a = answers || {};
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyc-tla-individual-es-'));
  try {
    execFileSync('unzip', ['-oq', TEMPLATE_PATH, '-d', workDir]);
    const docXmlPath = path.join(workDir, 'word', 'document.xml');
    const xml = mergeAdjacentRuns(fs.readFileSync(docXmlPath, 'utf-8'));

    const c = new DocCursor(xml);

    c.skip('Nombre Legal completo:');
    c.insertIntoNextEmptyParagraph(a.fullLegalName || '');

    c.skip('Documento de');
    c.skip('identificación');
    a.identificationDocumentType === 'passport' ? c.replace('Pasaporte', 'Pasaporte (X)') : c.skip('Pasaporte');
    a.identificationDocumentType === 'drivers_license' ? c.replace('Licencia de conducir', 'Licencia de conducir (X)') : c.skip('Licencia de conducir');
    a.identificationDocumentType === 'other' ? c.replace('Otro', 'Otro (X)') : c.skip('Otro');
    c.skip(':');
    if (a.identificationDocumentOther) c.insertIntoNextEmptyParagraph(a.identificationDocumentOther);
    else c.skipEmptyParagraph();

    c.skip('No. de documento:');
    c.insertIntoNextEmptyParagraph(a.documentNumber || '');
    c.skip('Vencimiento:');
    c.insertIntoNextEmptyParagraph(fmtDateDMY(a.expiration));
    c.skip('Emitido por:');
    c.insertIntoNextEmptyParagraph(a.issuedBy || '');
    c.skip('Nacionalidad:');
    c.insertIntoNextEmptyParagraph(a.citizenship || '');
    c.skip('Otra nacionalidad:');
    c.insertIntoNextEmptyParagraph(a.otherCitizenship || '');
    c.skip('Lugar').skip('de').skip('nacimiento:');
    c.insertIntoNextEmptyParagraph(a.placeOfBirth || '');
    c.skip('Fecha').skip(' de').skip('nacimiento:');
    c.insertIntoNextEmptyParagraph(fmtDateDMY(a.dateOfBirth));

    c.skip('No. de Seguro').skip('Social');
    c.insertIntoNextEmptyParagraph(a.socialSecurityNo || '');
    c.skip('País de').skip('residencia').skip('fiscal:');
    c.insertIntoNextEmptyParagraph(a.countryOfTaxResidency || '');

    c.skip('Dirección de residencia:');
    c.insertIntoNextEmptyParagraph(a.residencyAddress || '');
    c.skip('Dirección (En caso de que sea diferente)');
    c.insertIntoNextEmptyParagraph(a.mailingAddress || '');
    c.skip('No. de celular:');
    c.insertIntoNextEmptyParagraph(a.mobilePhone || '');
    c.skip('No. de trabajo/ casa:');
    c.insertIntoNextEmptyParagraph(a.workHomePhone || '');
    c.skip('Correo electrónico:');
    c.insertIntoNextEmptyParagraph(a.email || '');
    c.skip('Ocupación (¿En caso de ser jubilado, jubilado de qué?):');
    c.insertIntoNextEmptyParagraph(a.occupation || '');
    c.skip('Empleador o naturaleza del negocio:');
    c.insertIntoNextEmptyParagraph(a.employerOrBusiness || '');
    c.skip('Actúas como intermediario');
    c.skip(' en nombre de otra persona? (Si/ No)');
    c.insertIntoNextEmptyParagraph(a.actsAsIntermediary === 'yes' ? 'Sí' : (a.actsAsIntermediary === 'no' ? 'No' : ''));
    c.skip('En caso afirmativo, proporcione una descripción');
    c.insertIntoNextEmptyParagraph(a.intermediaryDescription || '');

    c.skip('¿Usted, o algún miembro de la familia, actualmente o en el pasado, ocupa un cargo político? (Si/ No)');
    c.insertIntoNextEmptyParagraph(a.hasPoliticalPosition === 'yes' ? 'Sí' : (a.hasPoliticalPosition === 'no' ? 'No' : ''));
    c.skip('En caso de que sea un familiar, ¿cuál es la relación?');
    c.insertIntoNextEmptyParagraph(a.familyRelationship || '');
    c.skip('En caso afirmativo, ¿cuándo y en qué puesto?');
    c.insertIntoNextEmptyParagraph(a.whenAndWhichPosition || '');
    c.skip('Nombre:');
    c.insertIntoNextEmptyParagraph(a.familyMemberName || '');
    c.skip('Dirección:');
    c.insertIntoNextEmptyParagraph(a.familyMemberAddress || '');
    c.skip('Fecha').skip(' de').skip('nacimiento:');
    c.insertIntoNextEmptyParagraph(fmtDateDMY(a.familyMemberDateOfBirth));
    c.skip('No. de Seguro Social:');
    c.insertIntoNextEmptyParagraph(a.familyMemberSSN || '');
    c.skip('Otras formas de identificación primaria, si es una persona no');
    c.skip('estadounidense:');
    c.insertIntoNextEmptyParagraph(a.otherPrimaryId || '');

    c.skip('Fuente de ingresos (salarios laborales, operación comercial, financiamiento, etc. / ¿de dónde provienen y cómo?):');
    c.skip('Respuesta:');
    c.insertIntoNextEmptyParagraph(a.sourceOfFunds || '');
    ['1-2', '3-5', '5-10', '10+'].forEach(opt => {
      const label = { '1-2': '1-2 Depósitos', '3-5': '3-5 Depósitos', '5-10': '5-10 Depósitos', '10+': '10 o más' }[opt];
      a.depositsCount === opt ? c.replace(label, `${label} (X)`) : c.skip(label);
    });
    c.skip('¿De').skip('qué').skip('país').skip('(países)').skip('provienen los fondos?');
    c.insertIntoNextEmptyParagraph(a.fundsCountry || '');
    c.skip('Por favor, especifique las cuentas de las cuales provendrán los fondos');
    c.insertIntoNextEmptyParagraph(a.bankAccountNames || '');

    // La línea de firma vive en la "DECLARACIÓN PARA LA PREVENCIÓN DE LAVADO
    // DE DINERO", ANTES de "INSTRUCCIONES BANCARIAS" (última página) — el
    // anchor hay que colocarlo aquí, antes de avanzar el cursor hacia esa
    // tabla (el cursor solo avanza hacia adelante).
    c.replace('Firma:', `Firma: ${SIGNATURE_ANCHOR}`);

    // --- Instrucciones bancarias (última página) — a dónde escrow debe
    // mandar los fondos que le correspondan a esta parte. ---
    c.skip('Nombre del banco:');
    c.insertIntoNextEmptyParagraph(a.wireBankName || '');
    c.skip('No. de ABA o código SWIFT');
    c.skip('5');
    c.skip(':');
    c.insertIntoNextEmptyParagraph(a.wireRoutingOrSwift || '');
    c.skip('Nombre del beneficiario:');
    c.insertIntoNextEmptyParagraph(a.wireAccountName || '');
    c.skip('No. de cuenta. (IBAN/CLABE)');
    c.insertIntoNextEmptyParagraph(a.wireAccountNumber || '');
    c.skip('Dirección del beneficiario:');
    c.insertIntoNextEmptyParagraph(a.wireBeneficiaryAddress || '');
    c.skip('Referencia (opcional):');
    c.insertIntoNextEmptyParagraph(a.wireReference || '');
    c.skip('Información del banco intermediario (solo para transferencias internacionales):');
    c.skip('Banco Intermediario:');
    c.insertIntoNextEmptyParagraph(a.intermediaryBankName || '');
    c.skip('ABA o código SWIFT del');
    c.skip('banco intermediario:');
    c.insertIntoNextEmptyParagraph(a.intermediaryBankSwift || '');
    c.skip('Referencias adicionales');
    c.skip('(opcional)');
    c.insertIntoNextEmptyParagraph(a.wireAdditionalDetails || '');

    fs.writeFileSync(docXmlPath, c.xml, 'utf-8');

    fs.mkdirSync(path.dirname(outputDocxPath), { recursive: true });
    if (fs.existsSync(outputDocxPath)) fs.rmSync(outputDocxPath);
    execFileSync('zip', ['-Xrq', outputDocxPath, '.'], { cwd: workDir });

    return { docxPath: outputDocxPath };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { fillTlaIndividualEs, SIGNATURE_ANCHOR };
