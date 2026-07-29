const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { DocCursor, mergeAdjacentRuns, fmtDateMDY } = require('./docxFillEngine');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', 'tla-entity-en.docx');
const SIGNATURE_ANCHOR = '/firmakyc/';

// Las tablas de beneficiarios (III) y de responsable de gestión llenan
// hasta 3 filas fijas cada una (cubre el patrón usual: un revocable trust +
// 1-2 personas, o hasta 3 personas) — no son filas dinámicas de verdad,
// pero alcanza para el caso real sin la complejidad de duplicar filas de
// tabla en el XML. Si una fila es un trust, solo se llena el nombre.
// Los datos bancarios de wire se llenan aparte, no por este formulario —
// TLA recomienda confirmarlos por teléfono, no por escrito, por seguridad.
function fillTlaEntityEn(answers, outputDocxPath) {
  const a = answers || {};
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyc-tla-entity-en-'));
  try {
    execFileSync('unzip', ['-oq', TEMPLATE_PATH, '-d', workDir]);
    const docXmlPath = path.join(workDir, 'word', 'document.xml');
    const xml = mergeAdjacentRuns(fs.readFileSync(docXmlPath, 'utf-8'));

    const c = new DocCursor(xml);

    c.skip('Name:');
    c.insertIntoNextEmptyParagraph(a.repName || '');
    c.skip('Title:');
    c.insertIntoNextEmptyParagraph(a.repTitle || '');
    c.skip('Social Security No.:');
    c.insertIntoNextEmptyParagraph(a.repSSN || '');
    c.skip('Email').skip(' Address:');
    c.insertIntoNextEmptyParagraph(a.repEmail || '');
    c.skip('Contact Phone No.:');
    c.insertIntoNextEmptyParagraph(a.repPhone || '');

    c.skip('Company Name:');
    c.insertIntoNextEmptyParagraph(a.companyName || '');
    c.skip('Entity Type:');
    c.insertIntoNextEmptyParagraph(a.entityType || '');
    c.skip('Place of Formation:');
    c.insertIntoNextEmptyParagraph(a.placeOfFormation || '');
    c.skip('DBA (if different):');
    c.insertIntoNextEmptyParagraph(a.dba || '');
    c.skip('Taxpayer Identification No.').skip('(EIN):');
    c.insertIntoNextEmptyParagraph(a.ein || '');
    c.skip('Registration No. (other than').skip('EIN, if applicable):');
    c.insertIntoNextEmptyParagraph(a.registrationNo || '');
    c.skip('Date of Incorporation:');
    c.insertIntoNextEmptyParagraph(fmtDateMDY(a.dateOfIncorporation));
    c.skip('Primary Business Address (no').skip('PO Boxes):');
    c.insertIntoNextEmptyParagraph(a.primaryBusinessAddress || '');
    c.skip('Business Mailing Address (if').skip('different):');
    c.insertIntoNextEmptyParagraph(a.businessMailingAddress || '');
    c.skip('Business Website:');
    c.insertIntoNextEmptyParagraph(a.businessWebsite || '');
    c.skip('Business').skip(' Activities:');
    c.insertIntoNextEmptyParagraph(a.businessActivities || '');

    // --- III. Beneficial Ownership (hasta 3 filas) ---
    c.skip('NAME');
    c.skip('DATE').skip('OF').skip('BIRTH');
    c.skip('ADDRESS');
    c.skip('(Residential').skip('or').skip('Business)');
    c.skip('SOCIAL SECURITY NO');
    [1, 2, 3].forEach(n => {
      c.insertIntoNextEmptyParagraph(a[`owner${n}Name`] || '');
      c.insertIntoNextEmptyParagraph(fmtDateMDY(a[`owner${n}DateOfBirth`]));
      c.insertIntoNextEmptyParagraph(a[`owner${n}Address`] || '');
      c.insertIntoNextEmptyParagraph(a[`owner${n}SSN`] || '');
    });

    // --- Individual(s) con responsabilidad significativa (hasta 3 filas) ---
    c.skip('NAME');
    c.skip('DATE').skip('OF').skip('BIRTH');
    c.skip('ADDRESS');
    c.skip('(Residential').skip('or').skip('Business)');
    c.skip('SOCIAL SECURITY NO');
    [1, 2, 3].forEach(n => {
      c.insertIntoNextEmptyParagraph(a[`responsible${n}Name`] || '');
      c.insertIntoNextEmptyParagraph(fmtDateMDY(a[`responsible${n}DateOfBirth`]));
      c.insertIntoNextEmptyParagraph(a[`responsible${n}Address`] || '');
      c.insertIntoNextEmptyParagraph(a[`responsible${n}SSN`] || '');
    });

    c.skip('Is any of the owners or executive officers, or in the past, holding a political position? (Yes/No)');
    c.insertIntoNextEmptyParagraph(a.hasPoliticalPosition === 'yes' ? 'Yes' : (a.hasPoliticalPosition === 'no' ? 'No' : ''));
    c.skip('If a family member, what is the relationship?');
    c.insertIntoNextEmptyParagraph(a.familyRelationship || '');
    c.skip('If yes, when and which position?');
    c.insertIntoNextEmptyParagraph(a.whenAndWhichPosition || '');
    c.skip('Name:');
    c.insertIntoNextEmptyParagraph(a.familyMemberName || '');
    c.skip('Physical').skip(' Address:');
    c.insertIntoNextEmptyParagraph(a.familyMemberAddress || '');
    c.skip('Date of Birth:');
    c.insertIntoNextEmptyParagraph(fmtDateMDY(a.familyMemberDateOfBirth));
    c.skip('Social Security Number:');
    c.insertIntoNextEmptyParagraph(a.familyMemberSSN || '');
    c.skip('Other forms of primary ID, if non-US person:');
    c.insertIntoNextEmptyParagraph(a.otherPrimaryId || '');

    c.skip('Does the Company manage third-party funds? (if yes, attach explanation)');
    c.insertIntoNextEmptyParagraph(a.managesThirdPartyFunds === 'yes' ? 'Yes' : (a.managesThirdPartyFunds === 'no' ? 'No' : ''));
    c.skip('Does the Company deal or exchange currency?');
    c.insertIntoNextEmptyParagraph(a.dealsCurrency === 'yes' ? 'Yes' : (a.dealsCurrency === 'no' ? 'No' : ''));
    c.skip('Does the Company deal with traveler’s checks, official bank checks, money orders, and stored value cards?');
    c.insertIntoNextEmptyParagraph(a.dealsTravelersChecks === 'yes' ? 'Yes' : (a.dealsTravelersChecks === 'no' ? 'No' : ''));
    c.skip('Does the Company’s business activity involve payments into other jurisdictions? (if yes, attach list of');
    c.skip('countries for money transmission)');
    c.insertIntoNextEmptyParagraph(a.paymentsOtherJurisdictions === 'yes' ? 'Yes' : (a.paymentsOtherJurisdictions === 'no' ? 'No' : ''));
    c.skip('Is the Company a taxpayer in any other country (for income tax purposes)? If yes, provide country and');
    c.skip('taxpayer number below:');
    c.insertIntoNextEmptyParagraph(a.taxpayerOtherCountry || '');
    c.skip('Describe the source of funds (business activity that generated the funds):');
    c.insertIntoNextEmptyParagraph(a.sourceOfFundsDescription || '');
    ['1-2', '3-5', '5-10', '10+'].forEach(opt => {
      const label = { '1-2': '1-2 Deposits', '3-5': '3-5 Deposits', '5-10': '5-10 Deposits', '10+': '10 and more' }[opt];
      a.depositsCount === opt ? c.replace(label, `${label} (X)`) : c.skip(label);
    });
    c.skip('Which country(ies) the funds');
    c.skip('will be coming from?');
    c.insertIntoNextEmptyParagraph(a.fundsCountry || '');
    c.skip('Please specify the accounts where the funds will be coming from');
    c.insertIntoNextEmptyParagraph(a.accountsFundsComingFrom || '');

    // La línea de firma vive en la sección "ANTI-MONEY LAUNDERING
    // DECLARATION", ANTES de "WIRE FRAUD AND WIRING INSTRUCTIONS" (última
    // página) — el anchor hay que colocarlo aquí, antes de avanzar el
    // cursor hacia esa tabla (el cursor solo avanza hacia adelante).
    c.replace('Signature: ', `Signature: ${SIGNATURE_ANCHOR} `);

    // --- Wire instructions (última página) — a dónde escrow debe mandar los
    // fondos que le correspondan a esta entidad. ---
    c.skip('Bank Name:');
    c.insertIntoNextEmptyParagraph(a.wireBankName || '');
    c.skip('ABA');
    c.skip('6');
    c.skip(' Number or Swift Code:');
    c.insertIntoNextEmptyParagraph(a.wireRoutingOrSwift || '');
    c.skip('Account Name:');
    c.insertIntoNextEmptyParagraph(a.wireAccountName || '');
    c.skip('Account No. (IBAN/CLABE):');
    c.insertIntoNextEmptyParagraph(a.wireAccountNumber || '');
    c.skip('Beneficiary Address:');
    c.insertIntoNextEmptyParagraph(a.wireBeneficiaryAddress || '');
    c.skip('Reference (optional):');
    c.insertIntoNextEmptyParagraph(a.wireReference || '');
    c.skip('Intermediary Bank Information (for international wires only):');
    c.skip('Intermediary Bank:');
    c.insertIntoNextEmptyParagraph(a.intermediaryBankName || '');
    c.skip('Intermediary Bank ABA No or');
    c.skip('Swift Code:');
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

module.exports = { fillTlaEntityEn, SIGNATURE_ANCHOR };
