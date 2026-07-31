// Propiedad, gastos de cierre, tracker, personas y contrato
// Parte de la interfaz de Grupo NAR — ver public/index.html para el orden
// en que se cargan estos archivos (todos comparten el mismo ámbito global).

const NOTARY_CLOSING_DOC_NAME = 'Costos de cierre (recibo del notario)';
const ESCROW_PAYMENT_PROOF_DOC_NAME = 'Comprobante de pago a escrow (Proof of payment to escrow)';
const NOTARY_PAYMENT_PROOF_DOC_NAME = 'Comprobante de pago al notario (Proof of payment to notary)';
const CLOSING_COSTS_SECTION_DOC_NAMES = [NOTARY_CLOSING_DOC_NAME, ESCROW_PAYMENT_PROOF_DOC_NAME, NOTARY_PAYMENT_PROOF_DOC_NAME];
// Escritura pública / predial son del VENDEDOR (dueño de la propiedad) — un
// comprador real (viewerSide === 'buyer') solo puede consultarlos, nunca
// subirlos ni agregar un requisito nuevo: no son suyos, no los tiene.
function buildPropertyDocsSection(deal, isStaffView, viewerSide){
  const readOnly = !isStaffView && viewerSide === 'buyer';
  // Sin section: los de Gestoría/Banco (doc.section) tienen su propia
  // sección aparte (buildSectionDocsCard), no van dentro de Propiedad.
  const docs = deal.documents.filter(d => d.partyId === null && !d.section && !CLOSING_COSTS_SECTION_DOC_NAMES.includes(d.name));
  const box = document.createElement('div');
  box.style.marginBottom = '14px';
  const ul = document.createElement('ul');
  ul.className = 'doc-list';
  docs.forEach(doc => ul.appendChild(buildDocItemLi(deal, doc, isStaffView, readOnly)));
  box.appendChild(ul);
  if(!readOnly) box.appendChild(buildAddDocumentRow(deal, null));
  return box;
}

// Secciones Gestoría y Banco — documentos de trabajo de los abogados en los
// escenarios con fideicomiso (CLG, avalúo, no adeudos; formatos del banco,
// carta de instrucción, VoBo). Solo staff las ve (el backend ni siquiera se
// las manda a comprador/vendedor/agente). Mismo checklist de siempre, con
// su "+" para agregar renglones extra.
function buildSectionDocsCard(deal, section){
  const docs = deal.documents.filter(d => d.section === section);
  const box = document.createElement('div');
  const ul = document.createElement('ul');
  ul.className = 'doc-list';
  docs.forEach(doc => ul.appendChild(buildDocItemLi(deal, doc, true)));
  box.appendChild(ul);
  box.appendChild(buildAddDocumentRow(deal, null, section));
  return box;
}

// Costos de cierre del notario, en su propia sección — antes era un renglón
// más dentro de "Propiedad" y tanto admin (para subirlo) como comprador
// (para verlo) no lo encontraban ahí. La cotización del notario se ve como
// un botón claro de "Ver costos de cierre" (no un checklist — es solo
// consulta, admin la sube una vez); los comprobantes de pago (a escrow y al
// notario) sí son requisitos de verdad que el comprador tiene que subir,
// así que esos se ven como checklist normal, con su propio botón de
// aprobar/rechazar y su "+" por si hay más de un comprobante.
function buildNotaryClosingCostsSection(deal, isStaffView, viewerSide){
  const box = document.createElement('div');
  const quoteDoc = deal.documents.find(d => d.partyId === null && d.name === NOTARY_CLOSING_DOC_NAME);
  if(!quoteDoc) return box;

  if(notaryPaymentNote === undefined){
    loadNotaryPaymentNote();
  } else if(notaryPaymentNote){
    const note = document.createElement('div');
    note.className = 'field-hint';
    note.style.cssText = 'margin:0 0 12px; padding:8px 10px; border-radius:8px; background:var(--stone); white-space:pre-wrap;';
    note.innerHTML = `<b>${escapeHtml(t('notaryPaymentNoteLabel'))}:</b> ${escapeHtml(notaryPaymentNote)}`;
    box.appendChild(note);
  }

  const quoteRow = document.createElement('div');
  quoteRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap; padding-bottom:14px; margin-bottom:14px; border-bottom:0.5px solid var(--line);';
  const reviewBadgeHtml = quoteDoc.fileUrl
    ? `<span class="review-badge ${quoteDoc.reviewStatus}" style="margin-left:8px;">${t(quoteDoc.reviewStatus === 'approved' ? 'reviewApproved' : quoteDoc.reviewStatus === 'rejected' ? 'reviewRejected' : 'reviewPending')}</span>`
    : '';
  quoteRow.innerHTML = `
    <div style="display:flex; align-items:center; gap:12px;">
      <div style="width:38px; height:38px; border-radius:10px; background:var(--gold-soft); color:#6B4E1E; display:flex; align-items:center; justify-content:center; flex-shrink:0;"><i class="ti ti-file-invoice" aria-hidden="true" style="font-size:18px;"></i></div>
      <div>
        <div style="font-weight:600; font-size:14px;">${escapeHtml(t('notaryClosingCostsSection'))}${reviewBadgeHtml}</div>
        <div class="field-hint" style="margin:2px 0 0;">${quoteDoc.fileUrl ? escapeHtml(quoteDoc.originalName || '') : t('notUploaded')}</div>
      </div>
    </div>
  `;
  // Subir/reemplazar la cotización del notario, y aprobarla/rechazarla, es
  // solo de admin/abogado interno — igual que generar/mandar a firma el
  // escrow y el contrato, un agente (aunque tenga isStaffView=true para el
  // resto de la operación) no debe poder tocar este documento, solo verlo.
  const canManageQuote = isStaffView && ['admin','lawyer'].includes(currentUser.role);
  const quoteActions = document.createElement('div');
  quoteActions.style.cssText = 'display:flex; gap:8px; flex-wrap:wrap;';
  if(quoteDoc.fileUrl){
    const viewLink = document.createElement('a');
    viewLink.href = `/api/deals/${deal.id}/documents/${quoteDoc.id}/file`;
    viewLink.target = '_blank';
    viewLink.className = 'btn primary';
    viewLink.innerHTML = `<i class="ti ti-eye" aria-hidden="true"></i> ${t('viewClosingCosts')}`;
    quoteActions.appendChild(viewLink);
  }
  if(canManageQuote){
    const fileInput = document.createElement('input');
    fileInput.type = 'file'; fileInput.style.display = 'none'; fileInput.accept = '.pdf,.jpg,.jpeg,.png,.heic';
    const uploadBtn = document.createElement('button');
    uploadBtn.type = 'button'; uploadBtn.className = 'btn'; uploadBtn.style.fontSize = '11px';
    uploadBtn.innerHTML = `<i class="ti ti-upload" aria-hidden="true"></i> ${quoteDoc.fileUrl ? t('replaceFile') : t('upload')}`;
    uploadBtn.onclick = () => fileInput.click();
    fileInput.onchange = async (e) => {
      const file = e.target.files[0]; if(!file) return;
      const original = uploadBtn.innerHTML;
      uploadBtn.disabled = true; uploadBtn.innerHTML = `<i class="ti ti-loader-2" aria-hidden="true"></i> ${t('uploading')}`;
      const fd = new FormData(); fd.append('file', file);
      try{
        await apiUpload(`/api/deals/${deal.id}/documents/${quoteDoc.id}/file`, fd);
        await openDeal(deal.id);
      }catch(err){ showToast(err.message, 'error'); uploadBtn.disabled = false; uploadBtn.innerHTML = original; }
    };
    quoteActions.appendChild(uploadBtn);
    quoteActions.appendChild(fileInput);
    const canReview = canManageQuote;
    if(canReview && quoteDoc.fileUrl && quoteDoc.reviewStatus !== 'approved'){
      const approveBtn = document.createElement('button');
      approveBtn.className = 'btn success'; approveBtn.style.fontSize = '11px'; approveBtn.textContent = t('approveDocument');
      approveBtn.onclick = async () => {
        approveBtn.disabled = true;
        try{ await apiFetch(`/api/deals/${deal.id}/documents/${quoteDoc.id}/review`, { method:'PATCH', body: JSON.stringify({ reviewStatus:'approved' }) }); await openDeal(deal.id); }
        catch(e){ showToast(e.message, 'error'); approveBtn.disabled = false; }
      };
      quoteActions.appendChild(approveBtn);
    }
    if(canReview && quoteDoc.fileUrl && quoteDoc.reviewStatus !== 'rejected'){
      const rejectBtn = document.createElement('button');
      rejectBtn.className = 'btn danger'; rejectBtn.style.fontSize = '11px'; rejectBtn.textContent = t('rejectDocument');
      rejectBtn.onclick = async () => {
        const reviewNote = prompt(t('rejectReasonPrompt'), '');
        if(reviewNote === null) return;
        rejectBtn.disabled = true;
        try{ await apiFetch(`/api/deals/${deal.id}/documents/${quoteDoc.id}/review`, { method:'PATCH', body: JSON.stringify({ reviewStatus:'rejected', reviewNote }) }); await openDeal(deal.id); }
        catch(e){ showToast(e.message, 'error'); rejectBtn.disabled = false; }
      };
      quoteActions.appendChild(rejectBtn);
    }
  }
  quoteRow.appendChild(quoteActions);
  box.appendChild(quoteRow);
  if(quoteDoc.reviewStatus === 'rejected' && quoteDoc.reviewNote){
    const noteEl = document.createElement('div');
    noteEl.className = 'doc-review-note'; noteEl.style.cssText = 'margin:-8px 0 12px;';
    noteEl.innerHTML = `<b>${t('reviewRejectedNote')}:</b> ${escapeHtml(quoteDoc.reviewNote)}`;
    box.appendChild(noteEl);
  }
  if(!quoteDoc.fileUrl && !canManageQuote){
    const hint = document.createElement('div');
    hint.className = 'field-hint'; hint.style.cssText = 'margin:-8px 0 12px;';
    hint.textContent = t('closingCostsNotReady');
    box.appendChild(hint);
  }

  // El pago de los costos de cierre es obligación del comprador, no del
  // vendedor — el vendedor sí puede consultar los comprobantes que suba el
  // comprador (quiere ver que se pagó), pero nunca subir/agregar los suyos:
  // no es un requisito de su lado.
  const proofsReadOnly = !isStaffView && viewerSide === 'seller';
  const proofsTitle = document.createElement('div');
  proofsTitle.style.cssText = 'font-weight:500; font-size:12.5px; color:var(--ink-soft); margin-bottom:6px;';
  proofsTitle.textContent = t('paymentProofsLabel');
  box.appendChild(proofsTitle);
  const proofDocs = deal.documents.filter(d => d.partyId === null && [ESCROW_PAYMENT_PROOF_DOC_NAME, NOTARY_PAYMENT_PROOF_DOC_NAME].includes(d.name));
  const ul = document.createElement('ul');
  ul.className = 'doc-list';
  proofDocs.forEach(doc => ul.appendChild(buildDocItemLi(deal, doc, isStaffView, proofsReadOnly)));
  box.appendChild(ul);
  if(!proofsReadOnly) box.appendChild(buildAddDocumentRow(deal, null));
  return box;
}

// Confirmar que un paso del cierre ya se hizo es solo de admin/abogado
// interno — antes cualquiera con acceso a la operación (agente, comprador,
// vendedor) podía ir marcando el tracker, cuando en realidad es quien
// coordina el cierre (admin/abogado) quien sabe si ese paso de verdad ya se
// completó.
function buildTaskList(deal, canManage){
  const ul = document.createElement('div');
  const pct = pctTasks(deal);
  const pctRow = document.createElement('div');
  pctRow.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:baseline; font-size:12px; color:var(--ink-soft);">
      <span>${t('closingProgress')}</span><span style="font-weight:600; color:var(--oxblood-deep);">${pct}%</span>
    </div>
    <div class="progress-track"><div class="progress-fill" style="width:${pct}%;"></div></div>
  `;
  ul.appendChild(pctRow);
  if(deal.dueDiligenceEndDate){
    const today = new Date().toISOString().slice(0,10);
    const ddOver = today >= deal.dueDiligenceEndDate;
    const ddBanner = document.createElement('div');
    ddBanner.className = 'field-hint';
    ddBanner.style.cssText = `margin:8px 0 0; padding:6px 10px; border-radius:8px; background:${ddOver?'var(--jade-soft)':'var(--stone)'}; color:${ddOver?'var(--jade)':'var(--ink-soft)'};`;
    ddBanner.textContent = ddOver
      ? t('ddEndedBanner', { date: deal.dueDiligenceEndDate })
      : t('ddPendingBanner', { date: deal.dueDiligenceEndDate });
    ul.appendChild(ddBanner);
  }
  deal.tasks.forEach((task, idx) => {
    const row = document.createElement('div');
    row.className = 'task-row';
    const cls = task.status==='done'?'done':(task.status==='progress'?'progress':'');
    // kyc_review (ver ensureKycReviewTask en routes/kyc.js) no se tacha a
    // mano — se marca sola cuando admin/abogado interno de verdad manda el
    // expediente a firma desde la sección de KYC, para que la tarea no
    // pueda dar por hecho un envío que nunca pasó.
    const isKycReview = task.docType === 'kyc_review';
    const stampClickable = canManage && !isKycReview;
    row.innerHTML = `
      <div class="task-stamp ${cls}" ${stampClickable ? '' : 'style="cursor:default;"'}>${task.status==='done'?'<i class=\"ti ti-check\" aria-hidden=\"true\"></i>':(idx+1)}</div>
      <div style="flex:1;">
        <div class="task-en">${escapeHtml(task.en)}${task.sign?`<span class="sign-tag">${t('requiresSignature')}</span>`:''}</div>
        <div class="task-es">${escapeHtml(task.es)}</div>
        ${isKycReview && task.status !== 'done' ? `<a href="#" class="task-go-kyc" style="font-size:11px;">${t('goToKycSection')}</a>` : ''}
        ${canManage ? `<div class="task-assignee" style="margin-top:3px;"></div>` : (task.assignedToName ? `<div class="field-hint" style="margin:3px 0 0;">${t('assignedTo')}: ${escapeHtml(task.assignedToName)}</div>` : '')}
      </div>
    `;
    if(stampClickable) row.querySelector('.task-stamp').onclick = async () => {
      const order=['pending','progress','done'];
      const next = order[(order.indexOf(task.status)+1)%order.length];
      try{
        await apiFetch(`/api/deals/${deal.id}/tasks/${task.id}`, { method:'PATCH', body: JSON.stringify({status: next}) });
        task.status = next; render();
      }catch(e){ showToast(e.message, 'error'); }
    };
    const goKycLink = row.querySelector('.task-go-kyc');
    if(goKycLink) goKycLink.onclick = (e) => {
      e.preventDefault();
      dealDetailTab = 'kyc';
      render();
      document.getElementById('admin-kyc-section')?.scrollIntoView({ behavior:'smooth', block:'start' });
    };
    // Asignación de la tarea — admin elige a qué abogado interno/admin le
    // toca; un abogado ve a quién está asignada (solo lectura).
    const assigneeSlot = row.querySelector('.task-assignee');
    if(assigneeSlot){
      if(currentUser.role === 'admin'){
        if(teamAssigneesCache === undefined){
          loadTeamAssignees(deal.id);
        } else if(Array.isArray(teamAssigneesCache)){
          const sel = document.createElement('select');
          sel.style.cssText = 'font-size:11px; padding:1px 5px; max-width:200px;';
          sel.innerHTML = `<option value="">${t('assignedToNobody')}</option>` +
            teamAssigneesCache.map(u => `<option value="${u.id}" ${task.assignedTo===u.id?'selected':''}>${escapeHtml(u.name)}</option>`).join('');
          sel.onchange = async () => {
            try{
              await apiFetch(`/api/deals/${deal.id}/tasks/${task.id}`, { method:'PATCH', body: JSON.stringify({ assignedTo: sel.value ? Number(sel.value) : null }) });
              await openDeal(deal.id);
            }catch(e){ showToast(e.message, 'error'); sel.value = task.assignedTo || ''; }
          };
          const lbl = document.createElement('label');
          lbl.className = 'field-hint';
          lbl.style.cssText = 'margin:0; display:inline-flex; gap:5px; align-items:center;';
          lbl.append(`${t('assignedTo')}:`, sel);
          assigneeSlot.appendChild(lbl);
        }
      } else if(task.assignedToName){
        assigneeSlot.innerHTML = `<span class="field-hint" style="margin:0;">${t('assignedTo')}: ${escapeHtml(task.assignedToName)}</span>`;
      }
    }
    ul.appendChild(row);
  });

  // Resumen de avance por correo a las partes ("pasos 1-4 completados,
  // sigue el 5") — lo dispara admin/abogado cuando hay avance que comunicar.
  if(canManage){
    const summaryRow = document.createElement('div');
    summaryRow.style.cssText = 'display:flex; align-items:center; gap:10px; margin-top:12px; flex-wrap:wrap;';
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.innerHTML = `<i class="ti ti-mail-forward" aria-hidden="true"></i> ${t('sendProgressSummary')}`;
    btn.onclick = async () => {
      if(!await confirmDialog(t('confirmSendProgressSummary'))) return;
      btn.disabled = true;
      try{
        const r = await apiFetch(`/api/deals/${deal.id}/send-progress-summary`, { method:'POST' });
        showToast(t('progressSummarySent', { count: r.count }), 'success');
        await openDeal(deal.id);
      }catch(e){ showToast(e.message, 'error'); btn.disabled = false; }
    };
    summaryRow.appendChild(btn);
    if(deal.lastProgressEmailAt){
      const hint = document.createElement('span');
      hint.className = 'field-hint'; hint.style.margin = '0';
      hint.textContent = t('lastProgressSummary', { date: deal.lastProgressEmailAt.slice(0, 10) });
      summaryRow.appendChild(hint);
    }
    ul.appendChild(summaryRow);
  }
  return ul;
}

// El machote a usar se elige aparte en la sección de Contrato de promesa
// (no depende de esto) — antes estos labels traían un "(machote X)" pegado
// que ya no correspondía a nada real y solo confundía.
const DEVELOPMENT_LABEL_I18N = {
  mandarina: { es: 'Mandarina', en: 'Mandarina' },
  punta_mita: { es: 'Punta Mita', en: 'Punta Mita' },
  puerto_vallarta: { es: 'Puerto Vallarta', en: 'Puerto Vallarta' },
  general: { es: 'Bahía de Banderas', en: 'Bahía de Banderas' },
  las_varas: { es: 'Las Varas', en: 'Las Varas' },
  compostela: { es: 'Compostela', en: 'Compostela' },
  boca_tomatlan: { es: 'Boca de Tomatlán', en: 'Boca de Tomatlán' }
};
const DEVELOPMENT_LABEL = new Proxy(DEVELOPMENT_LABEL_I18N, {
  get(target, key){ const e = target[key]; return e ? (e[lang] || e.es) : undefined; }
});
// Lista de <option> compartida entre el form de nueva operación y el de
// editar — un solo lugar para el orden/valores, en vez de mantener el
// mismo <select> escrito dos veces.
function developmentOptionsHtml(selected){
  const order = ['mandarina', 'punta_mita', 'puerto_vallarta', 'general', 'las_varas', 'compostela', 'boca_tomatlan'];
  const keyToI18n = { mandarina: 'devMandarina', punta_mita: 'devPuntaMita', puerto_vallarta: 'devPuertoVallarta', general: 'devGeneral', las_varas: 'devLasVaras', compostela: 'devCompostela', boca_tomatlan: 'devBocaTomatlan' };
  return order.map(key => `<option value="${key}" ${(selected||'punta_mita')===key?'selected':''}>${t(keyToI18n[key])}</option>`).join('');
}

// Solo para agentes/abogados externos — un comprador/vendedor se da de
// alta/liga directo desde su propia tarjeta en "Sellers and buyers"
// (buildPartyFieldsBlock, con solo poner su correo y guardar), que es la
// única forma de hacerlo desde que esta sección confundía a los usuarios
// (parecía que había dos caminos distintos para lo mismo).
function buildInviteForm(deal){
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="field-hint" style="margin-top:0;">${t('inviteHint')}</div>
    <div class="form-row">
      <label>${t('personToInvite')} <select id="inv-target">
        <option value="agent">${t('agentThisDeal')}</option>
        <option value="external_lawyer">${t('externalLawyerThisDeal')}</option>
      </select></label>
      <label>${t('name')} <input type="text" id="inv-name" placeholder="${t('namePh')}"></label>
      <label>${t('email')} <input type="email" id="inv-email" placeholder="${t('emailPh')}"></label>
    </div>
    <div class="form-row" id="inv-agent-fields">
      <label>${t('representsUnset')} <select id="inv-represents">
        <option value="">${t('representsUnset')}</option>
        <option value="seller">${t('representsSeller')}</option>
        <option value="buyer">${t('representsBuyer')}</option>
      </select></label>
      <span id="inv-agency-fields" style="display:flex; gap:10px; flex-wrap:wrap;">
        <label>${t('registerAgencyPlaceholderSelect')} <select id="inv-agency">
          <option value="">${t('registerAgencyPlaceholderSelect')}</option>
          ${AGENCIES.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('')}
          <option value="Otro">${t('registerAgencyOther')}</option>
        </select></label>
        <label>${t('registerAgencyOther')} <input type="text" id="inv-agency-other" placeholder="${t('registerAgencyOtherPh')}" style="display:none;"></label>
      </span>
    </div>
    <div class="form-row" style="align-items:flex-end;">
      <button class="btn primary" id="inv-generate">${t('generateInvite')}</button>
      <button class="btn" id="inv-register-direct" title="${t('registerDirectTitle')}">${t('registerDirect')}</button>
    </div>
    <div id="inv-result" style="display:none;">
      <div class="field-hint" id="inv-email-status" style="margin:0 0 6px;"></div>
      <div class="form-row">
        <label style="flex:1;">${t('inviteLinkCopyShare')}
          <input type="text" id="inv-link" readonly>
        </label>
        <button class="btn" id="inv-copy" style="align-self:flex-end;">${t('copy')}</button>
      </div>
    </div>
    <div id="inv-direct-result" style="display:none;">
      <div class="field-hint" id="inv-direct-result-label" style="margin:0 0 6px; color:var(--jade);">${t('registerDirectDone')}</div>
      <div class="form-row" id="inv-direct-password-row">
        <label style="flex:1;">${t('temporaryPassword')}
          <input type="text" id="inv-direct-password" readonly>
        </label>
        <button class="btn" id="inv-direct-copy" style="align-self:flex-end;">${t('copy')}</button>
      </div>
      <div class="field-hint" style="margin:6px 0 0;">${t('registerDirectHint')}</div>
    </div>
    <div class="gate-error" id="inv-error"></div>
  `;
  const targetSel = card.querySelector('#inv-target');
  const nameInput = card.querySelector('#inv-name');
  const registerDirectBtn = card.querySelector('#inv-register-direct');
  const agencyFieldsSpan = card.querySelector('#inv-agency-fields');
  const agencySelect = card.querySelector('#inv-agency');
  const agencyOtherInput = card.querySelector('#inv-agency-other');
  agencySelect.onchange = () => { agencyOtherInput.style.display = agencySelect.value === 'Otro' ? '' : 'none'; };
  const updateAgencyVisibility = () => {
    // La agencia (LPR Luxury, etc.) solo aplica a agente de venta — un
    // abogado externo no tiene una.
    agencyFieldsSpan.style.display = targetSel.value === 'agent' ? '' : 'none';
  };
  targetSel.onchange = updateAgencyVisibility;
  updateAgencyVisibility();

  card.querySelector('#inv-generate').onclick = async () => {
    const target = targetSel.value;
    const name = nameInput.value.trim();
    const email = card.querySelector('#inv-email').value.trim();
    const errEl = card.querySelector('#inv-error');
    errEl.textContent = '';
    if (!name || !email) { errEl.textContent = t('errNameOrEmail'); return; }
    const body = { dealId: deal.id, roleInDeal: target, name, email, representsSide: card.querySelector('#inv-represents').value || null };
    try {
      const { url, emailSent, emailError } = await apiFetch('/api/invites', { method: 'POST', body: JSON.stringify(body) });
      const linkInput = card.querySelector('#inv-link');
      linkInput.value = window.location.origin + url;
      const statusEl = card.querySelector('#inv-email-status');
      statusEl.textContent = emailSent
        ? t('inviteEmailSent', { email })
        : t('inviteEmailFailed', { error: emailError || t('resendNotConfigured') });
      statusEl.style.color = emailSent ? 'var(--jade)' : 'var(--oxblood)';
      card.querySelector('#inv-result').style.display = 'block';
    } catch(e) {
      errEl.textContent = e.message;
    }
  };
  card.querySelector('#inv-copy').onclick = () => {
    const linkInput = card.querySelector('#inv-link');
    linkInput.select();
    navigator.clipboard.writeText(linkInput.value);
  };
  registerDirectBtn.onclick = async () => {
    const target = targetSel.value;
    const name = nameInput.value.trim();
    const email = card.querySelector('#inv-email').value.trim();
    const errEl = card.querySelector('#inv-error');
    errEl.textContent = '';
    if (!name || !email) { errEl.textContent = t('errNameOrEmail'); return; }
    try {
      const agency = target === 'agent' ? agencySelect.value : '';
      const agencyOther = target === 'agent' ? agencyOtherInput.value.trim() : '';
      if(target === 'agent' && (!agency || (agency === 'Otro' && !agencyOther))){ errEl.textContent = t('registerErrAgency'); return; }
      const representsSide = card.querySelector('#inv-represents').value || null;
      const { temporaryPassword, welcomeEmailSent, welcomeEmailError } = await apiFetch(`/api/deals/${deal.id}/agents/register`, {
        method: 'POST', body: JSON.stringify({ name, email, role: target, agency, agencyOther, representsSide })
      });
      let doneLabel = t('registerDirectDone');
      doneLabel += welcomeEmailSent ? t('welcomeEmailSentNote') : t('welcomeEmailFailedNote', { error: welcomeEmailError || '' });
      card.querySelector('#inv-direct-result-label').textContent = doneLabel;
      card.querySelector('#inv-direct-password-row').style.display = '';
      card.querySelector('#inv-direct-password').value = temporaryPassword || '';
      card.querySelector('#inv-direct-result').style.display = 'block';
      await openDeal(deal.id);
    } catch(e) {
      errEl.textContent = e.message;
    }
  };
  card.querySelector('#inv-direct-copy').onclick = () => {
    const pwInput = card.querySelector('#inv-direct-password');
    pwInput.select();
    navigator.clipboard.writeText(pwInput.value);
  };
  return card;
}

// Fila de una sola persona (agente / abogado interno / abogado externo)
// ligada a la operación — compartida entre la tarjeta principal y el modal
// de "Compartir". `opts.removable` muestra el botón de quitar; una fila
// "isCreator" (el abogado que creó la operación, con acceso vía
// deals.created_by, ver GET /api/deals/:id) nunca es removible desde aquí
// porque no tiene fila propia en deal_parties que borrar.
function buildPersonRow(dealId, a, opts){
  opts = opts || {};
  const row = document.createElement('div');
  row.style.cssText = 'display:flex; align-items:center; gap:12px; padding:8px 2px;' + (opts.bordered !== false ? ' border-bottom:0.5px solid var(--line);' : '');
  const isAgentLike = ['agent', 'external_lawyer'].includes(a.role);
  row.innerHTML = `
    ${avatarHtml(a, 36)}
    <span style="flex:1; min-width:0;">
      <div style="font-size:13px; font-weight:500; display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
        <span style="overflow:hidden; text-overflow:ellipsis;">${escapeHtml(a.name)}</span>
        ${roleChipHtml(a.role)}
        ${a.status==='pending' ? `<span class="badge" style="background:var(--oxblood-soft); color:var(--oxblood); margin:0; font-size:10px;">${t('pendingApproval')}</span>` : ''}
        ${a.isCreator ? `<span class="field-hint" style="margin:0;">· ${t('personCreatedDeal')}</span>` : ''}
      </div>
      <div class="field-hint" style="margin:1px 0 0;">${escapeHtml(a.email)}${a.agency ? ' · ' + escapeHtml(a.agency) : ''}</div>
    </span>
  `;
  const controls = document.createElement('span');
  controls.style.cssText = 'display:flex; align-items:center; gap:6px; flex-shrink:0;';
  if(isAgentLike){
    const sel = document.createElement('select');
    sel.style.cssText = 'font-size:11.5px; padding:2px 6px;';
    sel.innerHTML = `
      <option value="" ${!a.representsSide?'selected':''}>${t('representsUnset')}</option>
      <option value="seller" ${a.representsSide==='seller'?'selected':''}>${t('representsSeller')}</option>
      <option value="buyer" ${a.representsSide==='buyer'?'selected':''}>${t('representsBuyer')}</option>
    `;
    sel.onchange = async () => {
      try{
        await apiFetch(`/api/deals/${dealId}/agents/${a.userId}`, { method:'PATCH', body: JSON.stringify({ representsSide: sel.value || null }) });
        clearKycCacheForDeal(dealId);
        await openDeal(dealId);
        if(opts.onChange) opts.onChange();
      }catch(err){ showToast(err.message, 'error'); sel.value = a.representsSide || ''; }
    };
    controls.appendChild(sel);
  }
  if(opts.removable && a.dealPartyId !== null && a.dealPartyId !== undefined){
    const rmBtn = document.createElement('button');
    rmBtn.className = 'btn'; rmBtn.title = t('removeFromDeal');
    rmBtn.style.cssText = 'font-size:12px; padding:4px 8px; line-height:1;';
    rmBtn.innerHTML = `<i class="ti ti-x" aria-hidden="true"></i>`;
    rmBtn.onclick = async () => {
      try{
        await apiFetch(`/api/deals/${dealId}/agents/${a.userId}`, { method:'DELETE' });
        delete availableAgentsCache[dealId];
        clearKycCacheForDeal(dealId);
        await openDeal(dealId);
        if(opts.onChange) opts.onChange();
      }catch(e){ showToast(e.message, 'error'); }
    };
    controls.appendChild(rmBtn);
  }
  row.appendChild(controls);
  return row;
}

// Sección unificada de personas en la operación (agentes, abogados internos
// y externos en un solo lugar, con distinción por chip de rol en vez de
// permisos tipo "editor/viewer") — agregar gente pasa por un modal estilo
// Google Drive (buscar por nombre, agregar al toque) en vez de un dropdown
// gigante, ver openAddPeopleModal.
function buildDealAgentsSection(deal){
  const card = document.createElement('div');
  card.className = 'card';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;' + (deal.agents && deal.agents.length ? ' margin-bottom:6px;' : '');
  header.innerHTML = `<div class="field-hint" style="margin:0;">${t('dealPeopleHint')}</div>`;
  const shareBtn = document.createElement('button');
  shareBtn.className = 'btn primary';
  shareBtn.style.cssText = 'font-size:12px; display:flex; align-items:center; gap:6px; flex-shrink:0;';
  shareBtn.innerHTML = `<i class="ti ti-user-plus" aria-hidden="true"></i> ${t('sharePeopleAdd')}`;
  shareBtn.onclick = () => openAddPeopleModal(deal.id);
  header.appendChild(shareBtn);
  card.appendChild(header);

  if(!deal.agents || !deal.agents.length){
    const hint = document.createElement('div');
    hint.className = 'field-hint'; hint.style.margin = '10px 0 0';
    hint.textContent = t('noAgentsInDeal');
    card.appendChild(hint);
  } else {
    deal.agents.forEach((a, i) => card.appendChild(buildPersonRow(deal.id, a, { removable: true, bordered: i < deal.agents.length - 1 })));
  }

  return card;
}

// Modal estilo "Compartir" de Google Drive: buscar entre agentes/abogados
// que YA tienen cuenta (filtro en cliente sobre availableAgentsCache, sin
// endpoint nuevo) y agregarlos al toque; además, un link secundario para
// invitar a alguien que todavía no tiene cuenta (reusa buildInviteForm).
// Se monta fuera de #body (como openKycSigningModal) para sobrevivir a los
// render() que dispara cada alta/baja vía openDeal.
function openAddPeopleModal(dealId){
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(33,22,19,0.55); display:flex; align-items:center; justify-content:center; z-index:1000; padding:20px;';
  document.body.appendChild(overlay);
  overlay.onclick = (e) => { if(e.target === overlay) close(); };

  let query = '';
  let showInvite = false;

  function close(){ overlay.remove(); }

  function renderModal(){
    const deal = deals.find(d => d.id === dealId);
    if(!deal){ close(); return; }
    if(availableAgentsCache[dealId] === undefined) loadAvailableAgents(dealId);
    const avail = availableAgentsCache[dealId];

    const q = query.trim().toLowerCase();
    const results = (q && Array.isArray(avail)) ? avail.filter(a =>
      a.name.toLowerCase().includes(q) || (a.email && a.email.toLowerCase().includes(q))
    ).slice(0, 8) : [];

    overlay.innerHTML = '';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--stone-card); border-radius:14px; width:min(480px,94vw); max-height:min(640px,88vh); display:flex; flex-direction:column; overflow:hidden; box-shadow:0 12px 40px rgba(33,22,19,0.3);';
    modal.onclick = (e) => e.stopPropagation();
    modal.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:14px 18px; border-bottom:0.5px solid var(--line); flex-shrink:0;">
        <div class="section-title" style="margin:0;">${t('sharePeopleTitle')}</div>
        <button class="btn primary" id="people-modal-done" style="font-size:12px;">${t('done')}</button>
      </div>
      <div style="padding:14px 18px 4px; flex-shrink:0;">
        <input type="text" id="people-search-input" placeholder="${t('sharePeopleSearchPh')}" autocomplete="off" style="width:100%; box-sizing:border-box;">
      </div>
      <div id="people-search-results" style="padding:0 10px; flex-shrink:0;"></div>
      <div id="people-invite-toggle-wrap" style="padding:6px 18px; flex-shrink:0;"></div>
      <div style="padding:10px 18px 4px; font-size:11px; font-weight:600; letter-spacing:.02em; text-transform:uppercase; color:var(--ink-faint); flex-shrink:0;">${t('sharePeopleAccessTitle')}</div>
      <div id="people-access-list" style="padding:0 18px 16px; overflow-y:auto; flex:1;"></div>
    `;
    overlay.appendChild(modal);

    modal.querySelector('#people-modal-done').onclick = close;

    const searchInput = modal.querySelector('#people-search-input');
    searchInput.value = query;
    searchInput.oninput = (e) => {
      query = e.target.value;
      const cursor = e.target.selectionStart;
      renderModal();
      // renderModal() reconstruye todo el contenido del modal (incluido este
      // input) — sin esto, el foco y la posición del cursor se pierden en
      // cada tecla mientras buscas (mismo patrón que #clients-search). Se
      // busca por `overlay` (persiste entre renders) y no por `modal` (se
      // recrea en cada renderModal(), la referencia de este closure queda
      // obsoleta apenas overlay.innerHTML se limpia arriba).
      const el = overlay.querySelector('#people-search-input');
      if(el){ el.focus(); el.setSelectionRange(cursor, cursor); }
    };
    searchInput.focus();
    searchInput.setSelectionRange(query.length, query.length);

    const resultsEl = modal.querySelector('#people-search-results');
    if(avail === undefined){
      resultsEl.innerHTML = q ? `<div class="field-hint" style="margin:6px 4px;">${t('loading')}</div>` : '';
    } else if(avail.error){
      resultsEl.innerHTML = `<div class="field-hint" style="margin:6px 4px;">${escapeHtml(avail.error)}</div>`;
    } else if(q && results.length){
      results.forEach(a => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:7px 8px; cursor:pointer; border-radius:8px;';
        row.onmouseenter = () => row.style.background = 'var(--stone)';
        row.onmouseleave = () => row.style.background = '';
        row.innerHTML = `
          ${avatarHtml(a, 32)}
          <span style="flex:1; min-width:0;">
            <div style="font-size:13px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(a.name)}</div>
            <div class="field-hint" style="margin:0;">${escapeHtml(a.email)}</div>
          </span>
          ${roleChipHtml(a.role)}
        `;
        row.onclick = async () => {
          try{
            await apiFetch(`/api/deals/${dealId}/agents`, { method:'POST', body: JSON.stringify({ userId: a.id, representsSide: null }) });
            delete availableAgentsCache[dealId];
            clearKycCacheForDeal(dealId);
            query = '';
            await openDeal(dealId);
            renderModal();
          }catch(e){ showToast(e.message, 'error'); }
        };
        resultsEl.appendChild(row);
      });
    } else if(q){
      resultsEl.innerHTML = `<div class="field-hint" style="margin:6px 4px;">${t('noAvailableAgents')}</div>`;
    } else {
      resultsEl.innerHTML = '';
    }

    const inviteWrap = modal.querySelector('#people-invite-toggle-wrap');
    if(showInvite){
      const toggle = document.createElement('button');
      toggle.className = 'btn'; toggle.style.fontSize = '11.5px'; toggle.style.marginBottom = '8px';
      toggle.textContent = t('sharePeopleInviteHide');
      toggle.onclick = () => { showInvite = false; renderModal(); };
      inviteWrap.appendChild(toggle);
      inviteWrap.appendChild(buildInviteForm(deal));
    } else {
      const toggle = document.createElement('button');
      toggle.className = 'btn'; toggle.style.fontSize = '11.5px';
      toggle.innerHTML = `<i class="ti ti-mail" aria-hidden="true"></i> ${t('sharePeopleInviteShow')}`;
      toggle.onclick = () => { showInvite = true; renderModal(); };
      inviteWrap.appendChild(toggle);
    }

    const accessList = modal.querySelector('#people-access-list');
    if(!deal.agents || !deal.agents.length){
      accessList.innerHTML = `<div class="field-hint" style="margin:4px 0;">${t('noAgentsInDeal')}</div>`;
    } else {
      deal.agents.forEach((a, i) => accessList.appendChild(buildPersonRow(dealId, a, {
        removable: true, bordered: i < deal.agents.length - 1, onChange: renderModal
      })));
    }
  }

  renderModal();

  const onKeydown = (e) => { if(e.key === 'Escape') close(); };
  window.addEventListener('keydown', onKeydown);
  const observer = new MutationObserver(() => {
    if(!document.body.contains(overlay)){ window.removeEventListener('keydown', onKeydown); observer.disconnect(); }
  });
  observer.observe(document.body, { childList: true });
}

const CONTRACT_STATUS_LABEL = KYC_STATUS_LABEL;

// Reemplaza la vieja exportación de JSON por un sistema real de machotes:
// el admin/abogado sube el .docx de la operación (con placeholders
// {{CLAVE}} ya escritos en el texto), la plataforma detecta solos los
// campos a llenar (sin JSON de definición a mano), y desde aquí mismo se
// genera/descarga el .docx, se ve el PDF, y se manda a firma electrónica.
function buildContractSection(deal, isStaffView){
  const box = document.createElement('div');
  const data = contractCache[deal.id];
  if(data === undefined){
    box.innerHTML = `<div class="field-hint" style="margin:0;">${t('loading')}</div>`;
    loadContract(deal.id);
    return box;
  }
  if(data.error){
    box.innerHTML = `<div class="field-hint" style="margin:0;">${escapeHtml(data.error)}</div>`;
    return box;
  }

  const statusLabel = CONTRACT_STATUS_LABEL[data.status] || data.status;
  box.innerHTML = `<div style="font-weight:500; font-size:13px;">${t('contractPromiseShort')} <span class="badge" style="margin-left:6px; background:var(--stone); border:0.5px solid var(--line); color:var(--ink-soft);">${escapeHtml(statusLabel)}</span></div>`;

  if(!isStaffView){
    // Comprador/vendedor: solo ver el contrato ya preparado + firmar cuando
    // se envíe — nunca ven el machote en blanco ni los campos de captura.
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;';
    if(data.hasDocument){
      const viewLink = document.createElement('a');
      viewLink.href = `/api/deals/${deal.id}/contract/file?format=pdf`;
      viewLink.target = '_blank';
      viewLink.className = 'btn';
      viewLink.textContent = t('viewContract');
      actions.appendChild(viewLink);
    } else {
      const hint = document.createElement('div');
      hint.className = 'field-hint'; hint.style.margin = '0';
      hint.textContent = t('coordinatorPreparing');
      actions.appendChild(hint);
    }
    if(data.status === 'sent'){
      const sentHint = document.createElement('span');
      sentHint.className = 'field-hint'; sentHint.style.cssText = 'margin:0; display:flex; align-items:center;';
      sentHint.textContent = t('checkEmailToSign');
      actions.appendChild(sentHint);
    }
    box.appendChild(actions);
    return box;
  }

  // --- Vista de admin/abogado ---
  const tplRow = document.createElement('div');
  tplRow.style.cssText = 'margin-top:8px; display:flex; gap:8px; align-items:flex-end; flex-wrap:wrap;';
  const templates = data.templates || [];
  tplRow.innerHTML = `
    <label style="display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--ink-soft); min-width:220px;">${t('template')}
      <select id="ct-template">
        <option value="">${t('selectTemplate')}</option>
        ${templates.map(tpl => `<option value="${tpl.id}" ${data.selectedTemplateId===tpl.id?'selected':''}>${escapeHtml(tpl.label)}</option>`).join('')}
      </select>
    </label>
    <button class="btn" id="ct-upload-toggle" style="font-size:12px;">${t('uploadNewTemplate')}</button>
    ${data.selectedTemplateId ? `<button class="btn" id="ct-delete" style="font-size:12px;" title="${t('deleteTemplateTitle')}"><i class="ti ti-trash" aria-hidden="true"></i> ${t('deleteCurrentTemplate')}</button>` : ''}
  `;
  box.appendChild(tplRow);
  tplRow.querySelector('#ct-template').onchange = async (e) => {
    const templateId = Number(e.target.value) || null;
    if(!templateId) return;
    try{
      await apiFetch(`/api/deals/${deal.id}/contract`, { method:'POST', body: JSON.stringify({ templateId }) });
      await loadContract(deal.id);
    }catch(err){ showToast(err.message, 'error'); }
  };
  const deleteBtn = tplRow.querySelector('#ct-delete');
  if(deleteBtn){
    deleteBtn.onclick = async () => {
      if(!await confirmDialog(t('confirmDeleteTemplate'), { danger: true })) return;
      try{
        await apiFetch(`/api/contract-templates/${data.selectedTemplateId}`, { method:'DELETE' });
        await loadContract(deal.id);
      }catch(err){ showToast(err.message, 'error'); }
    };
  }

  const uploadBox = document.createElement('div');
  uploadBox.style.cssText = 'display:none; margin-top:8px; padding:10px; background:var(--stone); border-radius:8px;';
  uploadBox.innerHTML = `
    <div class="field-hint" style="margin-top:0;">${t('uploadTemplateHint', { scenario: SCENARIOS[deal.scenario].labelShort })}</div>
    <div class="form-row">
      <label style="flex:1;">${t('templateName')} <input type="text" id="ct-new-label" placeholder="${t('templateNamePh')}"></label>
      <label>${t('docxFile')} <input type="file" id="ct-new-file" accept=".docx"></label>
    </div>
    <button class="btn primary" id="ct-new-save">${t('upload')}</button>
    <div class="gate-error" id="ct-upload-error"></div>
  `;
  box.appendChild(uploadBox);
  tplRow.querySelector('#ct-upload-toggle').onclick = () => {
    uploadBox.style.display = uploadBox.style.display === 'none' ? 'block' : 'none';
  };
  uploadBox.querySelector('#ct-new-save').onclick = async () => {
    const label = uploadBox.querySelector('#ct-new-label').value.trim();
    const file = uploadBox.querySelector('#ct-new-file').files[0];
    const errEl = uploadBox.querySelector('#ct-upload-error');
    errEl.textContent = '';
    if(!label || !file){ errEl.textContent = t('errNameOrFile'); return; }
    const fd = new FormData();
    fd.append('scenario', deal.scenario);
    fd.append('label', label);
    fd.append('file', file);
    try{
      await apiUpload('/api/contract-templates', fd);
      await loadContract(deal.id);
    }catch(err){ errEl.textContent = err.message; }
  };

  if(!data.selectedTemplateId){
    return box;
  }

  const schema = data.schema;
  const smartValues = data.smartValues || {};
  const fieldsWrap = document.createElement('div');
  fieldsWrap.style.cssText = 'margin-top:12px; padding:14px; background:var(--stone); border-radius:10px;';

  if(schema){
    fieldsWrap.innerHTML = `<div class="field-hint" style="margin-top:0;">Fechas, escrow, nombres de las partes y nombre de la propiedad salen solos de la operación — abajo solo lo que de verdad cambia por contrato.</div>`;

    function fieldInputHtml(field, value){
      const v = value === undefined || value === null ? '' : value;
      if(field.type === 'select'){
        return `<select data-field="${field.id}">${field.options.map(o=>`<option value="${o.value}" ${String(v)===String(o.value)?'selected':''}>${escapeHtml(o.label)}</option>`).join('')}</select>`;
      }
      if(field.type === 'textarea'){
        return `<textarea data-field="${field.id}" rows="2" style="resize:vertical;">${escapeHtml(v)}</textarea>`;
      }
      if(field.type === 'date'){
        return `<input type="date" data-field="${field.id}" value="${escapeHtml(v)}">`;
      }
      if(field.type === 'money'){
        return `<input type="number" step="0.01" min="0" data-field="${field.id}" value="${escapeHtml(v)}" placeholder="0.00">`;
      }
      return `<input type="text" data-field="${field.id}" value="${escapeHtml(v)}">`;
    }

    schema.sections.forEach(section => {
      const sec = document.createElement('div');
      sec.style.cssText = 'margin-bottom:16px;';
      sec.innerHTML = `<div style="font-weight:500; font-size:12.5px; margin-bottom:6px;">${escapeHtml(section.title)}</div>${section.hint ? `<div class="field-hint" style="margin:0 0 8px;">${escapeHtml(section.hint)}</div>` : ''}`;

      if(section.repeatable){
        const rowsWrap = document.createElement('div');
        rowsWrap.dataset.section = section.key;
        sec.appendChild(rowsWrap);

        function addRow(rowValues){
          const row = document.createElement('div');
          row.className = 'contract-repeat-row';
          row.style.cssText = 'display:flex; gap:8px; align-items:center; margin-bottom:6px;';
          row.innerHTML = section.fields.map(f => `<label style="flex:${f.type==='select'?'0 0 90px':'1'}; display:flex; flex-direction:column; gap:2px; font-size:11px; color:var(--ink-soft);">${escapeHtml(f.label)}${fieldInputHtml(f, rowValues ? rowValues[f.id] : '')}</label>`).join('');
          const rmBtn = document.createElement('button');
          rmBtn.type = 'button'; rmBtn.className = 'btn'; rmBtn.style.cssText = 'font-size:11px; padding:4px 8px; align-self:flex-end;';
          rmBtn.innerHTML = `<i class="ti ti-trash" aria-hidden="true"></i>`;
          rmBtn.onclick = () => row.remove();
          row.appendChild(rmBtn);
          rowsWrap.appendChild(row);
        }

        const existingRows = Array.isArray(smartValues[section.key]) ? smartValues[section.key] : [];
        if(existingRows.length) existingRows.forEach(addRow); else addRow(null);

        const addBtn = document.createElement('button');
        addBtn.type = 'button'; addBtn.className = 'btn'; addBtn.style.fontSize = '11px';
        addBtn.textContent = '+ agregar agencia';
        addBtn.onclick = () => addRow(null);
        sec.appendChild(addBtn);

        sec._collect = () => Array.from(rowsWrap.children).map(row => {
          const rowVal = {};
          section.fields.forEach(f => { rowVal[f.id] = row.querySelector(`[data-field="${f.id}"]`).value.trim(); });
          return rowVal;
        }).filter(r => r.name && r.pct);
      } else {
        const grid = document.createElement('div');
        grid.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:8px;';
        section.fields.forEach(f => {
          if(f.type === 'notary-select'){
            const wrap = document.createElement('div');
            wrap.style.cssText = 'display:flex; flex-direction:column; gap:3px; font-size:11px; color:var(--ink-soft);';
            const currentVal = smartValues[f.id] !== undefined && smartValues[f.id] !== null ? String(smartValues[f.id]) : '';
            wrap.innerHTML = `${escapeHtml(f.label)}
              <select data-field="${f.id}">
                <option value="">…</option>
                ${f.options.map(o=>`<option value="${o.value}" ${currentVal===String(o.value)?'selected':''}>${escapeHtml(o.label)}</option>`).join('')}
                <option value="otro" ${currentVal==='otro'?'selected':''}>${escapeHtml(f.otherLabel || 'Otro')}</option>
              </select>
              <div data-other-wrap style="display:${currentVal==='otro'?'flex':'none'}; flex-direction:column; gap:6px; margin-top:4px;">
                ${f.otherFields.map(of => `<label style="display:flex; flex-direction:column; gap:2px;">${escapeHtml(of.label)}${fieldInputHtml(of, smartValues[of.id])}</label>`).join('')}
              </div>`;
            const selectEl = wrap.querySelector('select');
            const otherWrap = wrap.querySelector('[data-other-wrap]');
            selectEl.onchange = () => { otherWrap.style.display = selectEl.value === 'otro' ? 'flex' : 'none'; };
            grid.appendChild(wrap);
          } else {
            const label = document.createElement('label');
            label.style.cssText = 'display:flex; flex-direction:column; gap:3px; font-size:11px; color:var(--ink-soft);';
            label.innerHTML = `${escapeHtml(f.label)}${fieldInputHtml(f, smartValues[f.id])}`;
            grid.appendChild(label);
          }
        });
        sec.appendChild(grid);
        sec._collect = () => {
          const rowVal = {};
          section.fields.forEach(f => {
            const el = grid.querySelector(`[data-field="${f.id}"]`);
            if(el) rowVal[f.id] = el.value.trim();
            if(f.otherFields){
              f.otherFields.forEach(of => {
                const oEl = grid.querySelector(`[data-field="${of.id}"]`);
                if(oEl) rowVal[of.id] = oEl.value.trim();
              });
            }
          });
          return rowVal;
        };
      }

      fieldsWrap._sections = fieldsWrap._sections || [];
      fieldsWrap._sections.push(sec);
      fieldsWrap.appendChild(sec);
    });
  } else {
    fieldsWrap.innerHTML = `
      <div class="field-hint" style="margin-top:0; color:var(--ink);">${t('noFieldsTitle')}</div>
      <div class="field-hint" style="margin:6px 0 0;">${t('noFieldsHint1')}</div>
      <div style="font-size:12px; font-family:monospace; background:var(--stone-card); border:0.5px solid var(--line); border-radius:6px; padding:8px 10px; margin-top:6px;">${t('noFieldsExample')}</div>
      <div class="field-hint" style="margin:6px 0 0;">${t('noFieldsHint2')}</div>
    `;
  }
  box.appendChild(fieldsWrap);

  function collectValues(){
    if(!schema) return {};
    const result = {};
    schema.sections.forEach((section, i) => {
      const sec = fieldsWrap._sections[i];
      if(section.repeatable) result[section.key] = sec._collect();
      else Object.assign(result, sec._collect());
    });
    return result;
  }

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex; gap:8px; margin-top:12px; flex-wrap:wrap;';

  if(schema){
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn'; saveBtn.textContent = t('saveDraft');
    saveBtn.onclick = async () => {
      try{
        await apiFetch(`/api/deals/${deal.id}/contract`, { method:'POST', body: JSON.stringify({ smartValues: collectValues() }) });
        await loadContract(deal.id);
      }catch(e){ showToast(e.message, 'error'); }
    };
    actions.appendChild(saveBtn);
  }

  const genDownloadBtn = document.createElement('button');
  genDownloadBtn.className = 'btn primary'; genDownloadBtn.textContent = t('generateDownloadDocx');
  genDownloadBtn.onclick = async () => {
    try{
      await apiFetch(`/api/deals/${deal.id}/contract`, { method:'POST', body: JSON.stringify({ smartValues: collectValues() }) });
      await apiFetch(`/api/deals/${deal.id}/contract/generate`, { method:'POST' });
      window.open(`/api/deals/${deal.id}/contract/file?format=docx`, '_blank');
      await loadContract(deal.id);
    }catch(e){ showToast(e.message, 'error'); }
  };
  actions.appendChild(genDownloadBtn);

  if(data.hasDocument){
    const viewLink = document.createElement('a');
    viewLink.href = `/api/deals/${deal.id}/contract/file?format=pdf`;
    viewLink.target = '_blank';
    viewLink.className = 'btn';
    viewLink.textContent = t('viewPdf');
    actions.appendChild(viewLink);
  }

  if(data.status === 'generated'){
    const sendBtn = document.createElement('button');
    sendBtn.className = 'btn gold'; sendBtn.textContent = t('sendForSignature');
    sendBtn.onclick = () => withButtonLoading(sendBtn, async () => {
      try{
        await apiFetch(`/api/deals/${deal.id}/contract/send-for-signature`, { method:'POST' });
        await loadContract(deal.id);
      }catch(e){ showToast(e.message, 'error'); }
    });
    actions.appendChild(sendBtn);
  }

  const uploadSignedContractBtn = document.createElement('button');
  uploadSignedContractBtn.className = 'btn'; uploadSignedContractBtn.style.fontSize = '11px';
  uploadSignedContractBtn.title = t('uploadSignedContractTitle');
  uploadSignedContractBtn.innerHTML = `<i class="ti ti-upload" aria-hidden="true"></i> ${t('uploadSignedContract')}`;
  const uploadSignedContractInput = document.createElement('input');
  uploadSignedContractInput.type = 'file'; uploadSignedContractInput.accept = '.pdf'; uploadSignedContractInput.style.display = 'none';
  uploadSignedContractBtn.onclick = () => uploadSignedContractInput.click();
  uploadSignedContractInput.onchange = async (e) => {
    const file = e.target.files[0];
    if(!file) return;
    const original = uploadSignedContractBtn.innerHTML;
    uploadSignedContractBtn.disabled = true; uploadSignedContractBtn.innerHTML = `<i class="ti ti-loader-2" aria-hidden="true"></i> ${t('uploading')}`;
    const fd = new FormData(); fd.append('file', file);
    try{
      await apiUpload(`/api/deals/${deal.id}/contract/upload-signed`, fd);
      await loadContract(deal.id);
    }catch(err){ showToast(err.message, 'error'); uploadSignedContractBtn.disabled = false; uploadSignedContractBtn.innerHTML = original; }
  };
  actions.appendChild(uploadSignedContractBtn);
  actions.appendChild(uploadSignedContractInput);

  box.appendChild(actions);

  return box;
}

// ---------- PORTAL ----------

// Reduce las ~12-15 tareas detalladas del tracker a 5 etapas de alto nivel
// (igual que el mockup) — funciona para las 4 variantes de escenario porque
// todas comparten la misma tarea inicial ("Purchase agreement signed") y
// las mismas 3 finales (borrador de escritura, firma, entrega en notaría),
// sin importar cuántas tareas intermedias tenga cada una.
