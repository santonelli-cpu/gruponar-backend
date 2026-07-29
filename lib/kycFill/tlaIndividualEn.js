const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { DocCursor, mergeAdjacentRuns, fmtDateMDY } = require('./docxFillEngine');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', 'tla-individual-en.docx');

// Anchor de texto para que DocuSign coloque ahí el tab de firma embebida
// (mismo mecanismo que routes/kyc.js ya usa para Armour) — la línea de
// firma de este formulario usa tabs con subrayado, no texto con rayas, así
// que no se puede "llenar" directamente; el anchor se inserta junto a la
// etiqueta "Signature:".
const SIGNATURE_ANCHOR = '/firmakyc/';

function fillTlaIndividualEn(answers, outputDocxPath) {
  const a = answers || {};
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyc-tla-individual-en-'));
  try {
    execFileSync('unzip', ['-oq', TEMPLATE_PATH, '-d', workDir]);
    const docXmlPath = path.join(workDir, 'word', 'document.xml');
    const rawXml = fs.readFileSync(docXmlPath, 'utf-8');
    // Este .docx trae el texto muy fragmentado (casi palabra por palabra,
    // con <w:spacing> distinto por run) — se consolida primero para poder
    // ubicar las etiquetas como texto contiguo.
    const xml = mergeAdjacentRuns(rawXml);

    const c = new DocCursor(xml);

    c.skip('Full Legal Name:');
    c.insertIntoNextEmptyParagraph(a.fullLegalName || '');

    c.skip('Identification Document');
    a.identificationDocumentType === 'passport' ? c.replace('Passport', 'Passport (X)') : c.skip('Passport');
    a.identificationDocumentType === 'drivers_license' ? c.replace('Drivers’ ', 'Drivers’ (X) ') : c.skip('Drivers’ ');
    c.skip('License');
    a.identificationDocumentType === 'other' ? c.replace('Other', 'Other (X)') : c.skip('Other');
    c.skip(':');
    if (a.identificationDocumentOther) c.insertIntoNextEmptyParagraph(a.identificationDocumentOther);
    else c.skipEmptyParagraph();

    c.skip('Document Number:');
    c.insertIntoNextEmptyParagraph(a.documentNumber || '');
    c.skip('Expiration:');
    c.insertIntoNextEmptyParagraph(fmtDateMDY(a.expiration));
    c.skip('Issued By:');
    c.insertIntoNextEmptyParagraph(a.issuedBy || '');
    c.skip('Citizenship:');
    c.insertIntoNextEmptyParagraph(a.citizenship || '');
    c.skip('Other Citizenship:');
    c.insertIntoNextEmptyParagraph(a.otherCitizenship || '');
    c.skip('Place of Birth');
    c.insertIntoNextEmptyParagraph(a.placeOfBirth || '');
    c.skip('Date of Birth:');
    c.insertIntoNextEmptyParagraph(fmtDateMDY(a.dateOfBirth));

    c.skip('Social Security No. ');
    c.insertIntoNextEmptyParagraph(a.socialSecurityNo || '');
    c.skip('Country of Tax Residency:');
    c.insertIntoNextEmptyParagraph(a.countryOfTaxResidency || '');

    c.skip('Residency Address:');
    c.insertIntoNextEmptyParagraph(a.residencyAddress || '');
    c.skip('Mailing Address (if');
    c.skip('different)');
    c.insertIntoNextEmptyParagraph(a.mailingAddress || '');
    c.skip('Mobile Phone No.:');
    c.insertIntoNextEmptyParagraph(a.mobilePhone || '');
    c.skip('Work/Home');
    c.skip('Phone No:');
    c.insertIntoNextEmptyParagraph(a.workHomePhone || '');
    c.skip('Email:');
    c.insertIntoNextEmptyParagraph(a.email || '');
    c.skip('Occupation (if retired,');
    c.skip('retired as what?):');
    c.insertIntoNextEmptyParagraph(a.occupation || '');
    c.skip('Employer or nature of');
    c.skip('business:');
    c.insertIntoNextEmptyParagraph(a.employerOrBusiness || '');
    c.skip('Do you act as an intermediary');
    c.skip(' on behalf of someone else? (Yes/No)');
    c.insertIntoNextEmptyParagraph(a.actsAsIntermediary === 'yes' ? 'Yes' : (a.actsAsIntermediary === 'no' ? 'No' : ''));
    c.skip('If yes, provide description');
    c.insertIntoNextEmptyParagraph(a.intermediaryDescription || '');

    c.skip('Are you, or a member of your family currently, or in the past, holding a political position? (Yes/No)');
    c.insertIntoNextEmptyParagraph(a.hasPoliticalPosition === 'yes' ? 'Yes' : (a.hasPoliticalPosition === 'no' ? 'No' : ''));
    c.skip('If a family member, what is the relationship?');
    c.insertIntoNextEmptyParagraph(a.familyRelationship || '');
    c.skip('If yes, when and which position?');
    c.insertIntoNextEmptyParagraph(a.whenAndWhichPosition || '');
    c.skip('Name:');
    c.insertIntoNextEmptyParagraph(a.familyMemberName || '');
    c.skip('Physical');
    c.skip(' Address:');
    c.insertIntoNextEmptyParagraph(a.familyMemberAddress || '');
    c.skip('Date of Birth:');
    c.insertIntoNextEmptyParagraph(fmtDateMDY(a.familyMemberDateOfBirth));
    c.skip('Social Security Number:');
    c.insertIntoNextEmptyParagraph(a.familyMemberSSN || '');
    c.skip('Other forms of primary ID, if non-US person:');
    c.insertIntoNextEmptyParagraph(a.otherPrimaryId || '');

    c.skip('Source of funds (employment salaries, commercial activity, financing, etc. / where do they come from and how?):');
    c.skip('Answer:');
    c.insertIntoNextEmptyParagraph(a.sourceOfFunds || '');
    ['1-2', '3-5', '5-10', '10+'].forEach(opt => {
      const label = { '1-2': '1-2 Deposits', '3-5': '3-5 Deposits', '5-10': '5-10 Deposits', '10+': '10 and more' }[opt];
      a.depositsCount === opt ? c.replace(label, `${label} (X)`) : c.skip(label);
    });
    c.skip('Which country(ies) the funds');
    c.skip('will be coming from?');
    c.insertIntoNextEmptyParagraph(a.fundsCountry || '');
    c.skip('Please specify bank account names where the funds will be coming from:');
    c.insertIntoNextEmptyParagraph(a.bankAccountNames || '');

    // La línea de firma vive en la sección "ANTI-MONEY LAUNDERING
    // DECLARATION", ANTES de "WIRE INSTRUCTIONS" (última página) — hay que
    // colocar el anchor aquí, antes de avanzar el cursor hacia la tabla de
    // wire, o ya no se puede encontrar (el cursor solo avanza hacia adelante).
    c.replace('Signature: ', `Signature: ${SIGNATURE_ANCHOR} `);

    // --- Wire instructions (última página) — a dónde escrow debe mandar los
    // fondos que le correspondan a esta parte. ---
    c.skip('Bank Name:');
    c.insertIntoNextEmptyParagraph(a.wireBankName || '');
    c.skip('ABA/Wire Routing Number or');
    c.skip('SWIFT Code');
    c.skip('5');
    c.skip(':');
    c.insertIntoNextEmptyParagraph(a.wireRoutingOrSwift || '');
    c.skip('Account Name:');
    c.insertIntoNextEmptyParagraph(a.wireAccountName || '');
    c.skip('Account No. (IBAN/CLABE)');
    c.insertIntoNextEmptyParagraph(a.wireAccountNumber || '');
    c.skip('Beneficiary Address:');
    c.insertIntoNextEmptyParagraph(a.wireBeneficiaryAddress || '');
    c.skip('Reference (optional):');
    c.insertIntoNextEmptyParagraph(a.wireReference || '');
    c.skip('Intermediary Bank Information (for international wires only):');
    c.skip('Intermediary Bank:');
    c.insertIntoNextEmptyParagraph(a.intermediaryBankName || '');
    c.skip('Intermediary Bank ABA No or');
    c.skip('SWIFT Code:');
    c.insertIntoNextEmptyParagraph(a.intermediaryBankSwift || '');
    c.skip('Additional Details (optional):');
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

module.exports = { fillTlaIndividualEn, SIGNATURE_ANCHOR };
