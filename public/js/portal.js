// Portal del cliente y del agente
// Parte de la interfaz de Grupo NAR — ver public/index.html para el orden
// en que se cargan estos archivos (todos comparten el mismo ámbito global).

const CLOSING_STAGE_KEYS = ['stageOfferAccepted','stageDueDiligence','stageNotaryClosing','stageReadyToSign','stageClosed'];
function closingStages(deal){
  const n = deal.tasks.length;
  if(n < 5) return null;
  const b1 = 1, b2 = Math.min(5, n-2), b3 = n-2, b4 = n-1;
  const ranges = [[0,b1],[b1,b2],[b2,b3],[b3,b4],[b4,n]];
  const stages = ranges.map((r,i) => {
    const slice = deal.tasks.slice(r[0], r[1]);
    return { key: CLOSING_STAGE_KEYS[i], done: slice.length > 0 && slice.every(t=>t.status==='done') };
  });
  if(deal.status === 'completed') stages.forEach(s => { s.done = true; });
  return stages;
}
function buildClosingStepper(deal){
  const stages = closingStages(deal);
  if(!stages) return null;
  const currentIdx = stages.findIndex(s=>!s.done);
  const wrap = document.createElement('div');
  wrap.className = 'stepper';
  stages.forEach((s, i) => {
    const step = document.createElement('div');
    step.className = 'step' + (s.done ? ' done' : '') + (i === currentIdx ? ' current' : '');
    step.innerHTML = `<div class="step-dot">${s.done ? '<i class="ti ti-check" aria-hidden="true"></i>' : (i+1)}</div><span class="step-label">${t(s.key)}</span>`;
    wrap.appendChild(step);
  });
  return wrap;
}

// Documentos/firmas pendientes que le tocan específicamente a ESTA parte
// (no a la operación en general) — respeta las mismas reglas de lado que
// buildPropertyDocsSection/buildNotaryClosingCostsSection (Propiedad es del
// vendedor, Pagos es del comprador) para que "Waiting on you" y el aviso de
// siguiente paso solo cuenten lo que de verdad depende de esta persona.
function pendingItemsForParty(deal, party){
  const uploads = deal.documents.filter(d => d.partyId === party.id && d.status !== 'done').slice();
  if(party.side === 'seller'){
    uploads.push(...deal.documents.filter(d => d.partyId === null && !CLOSING_COSTS_SECTION_DOC_NAMES.includes(d.name) && d.status !== 'done'));
  }
  if(party.side === 'buyer'){
    uploads.push(...deal.documents.filter(d => d.partyId === null && [ESCROW_PAYMENT_PROOF_DOC_NAME, NOTARY_PAYMENT_PROOF_DOC_NAME].includes(d.name) && d.status !== 'done'));
  }
  const signatures = deal.tasks.filter(t => t.sign && t.docusignStatus !== 'completed' && (!t.signSide || t.signSide === party.side));
  return { uploads, signatures };
}

function closingDaysLeftLabel(dateStr){
  const days = Math.ceil((new Date(dateStr + 'T00:00:00') - new Date()) / 86400000);
  if(days < 0) return t('closingOverdue');
  if(days === 0) return t('closingToday');
  return days === 1 ? t('daysToCloseSingular', { days }) : t('daysToClosePlural', { days });
}

// Property value / Closing date / Overall progress / Waiting on you — el
// último tile depende de si estamos viendo la operación como una parte
// específica (comprador/vendedor real, o staff previsualizándolo) o como
// staff "que ve todo", donde "esperando por ti" no aplica y se muestra el
// total de documentos pendientes de la operación en su lugar.
function buildPortalStatGrid(deal, myParty){
  const grid = document.createElement('div');
  grid.className = 'stat-grid';
  const pct = overallPct(deal);
  const totalItems = deal.documents.length + deal.tasks.length;
  const doneItems = deal.documents.filter(d=>d.status==='done').length + deal.tasks.filter(t=>t.status==='done').length;
  let waitingValue, waitingSub;
  if(myParty){
    const { uploads, signatures } = pendingItemsForParty(deal, myParty);
    waitingValue = t('waitingItemsCount', { count: uploads.length + signatures.length });
    const parts = [];
    if(uploads.length) parts.push(t(uploads.length===1 ? 'uploadSingular' : 'uploadsPlural', { count: uploads.length }));
    if(signatures.length) parts.push(t(signatures.length===1 ? 'signatureSingular' : 'signaturesPlural', { count: signatures.length }));
    waitingSub = parts.length ? parts.join(', ') : t('allCaughtUp');
  } else {
    const pendingDocs = deal.documents.filter(d=>d.status!=='done').length;
    waitingValue = t('waitingItemsCount', { count: pendingDocs });
    waitingSub = t('pendingDocsLabel');
  }
  grid.innerHTML = `
    <div class="stat-tile"><p class="label">${t('propertyValueLabel')}</p><p class="value">${deal.currency||'USD'} ${Number(deal.price||0).toLocaleString()}</p></div>
    <div class="stat-tile"><p class="label">${t('closingDateLabel')}</p><p class="value">${deal.closingDate || '—'}</p>${deal.closingDate ? `<p class="sub">${closingDaysLeftLabel(deal.closingDate)}</p>` : ''}</div>
    <div class="stat-tile"><p class="label">${t('overallProgressLabel')}</p><p class="value">${pct}%</p><p class="sub">${t('itemsDoneLabel', { done: doneItems, total: totalItems })}</p></div>
    <div class="stat-tile"><p class="label">${t('waitingOnYouLabel')}</p><p class="value">${waitingValue}</p><p class="sub">${waitingSub}</p></div>
  `;
  return grid;
}

// Un solo aviso con lo más urgente pendiente de ESTA parte — prioriza
// firmas (nadie más puede hacerlo por ellos) sobre subir documentos. Solo
// tiene sentido cuando se ve una parte específica, no en "ve todo" de staff.
// "Te toca a ti" — hasta 3 acciones que dependen del CLIENTE ahora mismo,
// cada una con su botón para brincar directo. Solo cosas realmente
// accionables: firmas que YA le llegaron (sent/delivered — una tarea de
// firma que el equipo aún no manda no es asunto suyo todavía), su KYC
// esperando firma, y documentos suyos por subir. Si no hay nada accionable,
// no se muestra nada: silencio = vas al día.
function buildNextStepCallout(deal, myParty){
  if(!myParty) return null;
  const { uploads, signatures } = pendingItemsForParty(deal, myParty);

  const items = [];
  signatures.filter(task => ['sent', 'delivered'].includes(task.docusignStatus)).forEach(task => {
    items.push({
      label: t('nextStepSignature', { name: lang==='en' ? task.en : task.es }),
      anchor: 'portal-esignature-section', btnLabel: t('signLabel')
    });
  });
  // KYC de mi parte esperando MI firma (si el cache ya lo trae — la sección
  // del portal lo carga sola al entrar, así que casi siempre está).
  const kycData = kycCache[deal.id + '-' + myParty.id + '-escrow'];
  if(kycData && !kycData.error && kycData.status === 'sent'){
    items.push({ label: t('nextStepKycSign'), anchor: 'portal-kyc-section', btnLabel: t('signLabel') });
  }
  uploads.forEach(doc => {
    const isPaymentProof = [ESCROW_PAYMENT_PROOF_DOC_NAME, NOTARY_PAYMENT_PROOF_DOC_NAME].includes(doc.name);
    items.push({
      label: t('nextStepUpload', { name: localizeDocName(doc.name) }),
      anchor: isPaymentProof ? 'portal-closing-costs-section' : (doc.partyId === null ? 'portal-property-section' : 'portal-mydocs-section'),
      btnLabel: t('uploadLabel')
    });
  });

  if(!items.length) return null;
  const expanded = waitingOnYouExpanded[deal.id] === true;
  const visible = expanded ? items : items.slice(0, 3);
  const extra = items.length - 3;
  const box = document.createElement('div');
  box.className = 'callout';
  box.style.flexDirection = 'column';
  box.style.alignItems = 'stretch';
  const head = document.createElement('p');
  head.className = 'callout-text';
  head.style.marginBottom = '8px';
  head.innerHTML = `<b>${t('waitingOnYouTitle', { count: items.length })}</b>`;
  box.appendChild(head);
  visible.forEach(item => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:10px; padding:5px 0;';
    const label = document.createElement('span');
    label.style.cssText = 'font-size:13px;';
    label.textContent = item.label;
    const btn = document.createElement('button');
    btn.className = 'btn primary'; btn.style.cssText = 'white-space:nowrap; font-size:11.5px; padding:4px 12px; flex-shrink:0;';
    btn.textContent = item.btnLabel;
    btn.onclick = () => {
      // Con pestañas, la sección destino puede no estar renderizada — se
      // cambia primero a su pestaña y luego se scrollea al ancla.
      const PORTAL_ANCHOR_TAB = {
        'portal-esignature-section': 'signatures',
        'portal-kyc-section': 'kyc',
        'portal-closing-costs-section': 'costs',
        'portal-property-section': 'property',
        'portal-mydocs-section': 'mydocs'
      };
      const wanted = PORTAL_ANCHOR_TAB[item.anchor];
      if(wanted && portalTab !== wanted){ portalTab = wanted; render(); }
      setTimeout(() => document.getElementById(item.anchor)?.scrollIntoView({ behavior:'smooth', block:'start' }), 60);
    };
    row.appendChild(label); row.appendChild(btn);
    box.appendChild(row);
  });
  if(extra > 0){
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'field-hint';
    more.style.cssText = 'margin:6px 0 0; background:none; border:0; padding:0; cursor:pointer; text-align:left; font-family:inherit; text-decoration:underline;';
    more.textContent = expanded ? t('waitingOnYouLess') : t('waitingOnYouMore', { count: extra });
    more.onclick = () => { waitingOnYouExpanded[deal.id] = !expanded; render(); };
    box.appendChild(more);
  }
  return box;
}

// Panel de todas MIS operaciones — el equivalente del Dashboard del admin
// para quien no es staff: un comprador con dos propiedades, o un agente
// con varios cierres, necesita ver el conjunto antes de meterse a una.
// Lo pendiente de cada quien sale de la campana (/api/dashboard/
// notifications), que ya viene acotada por rol y por lado, en vez de
// cargar cada operación completa nada más para contar.
function buildPortalOverview(body){
  const title = document.createElement('div');
  title.className = 'section-title';
  title.textContent = t('portalAllDeals');
  body.appendChild(title);

  const pendingByDeal = {};
  (notifData ? notifData.actionRequired : []).forEach(item => {
    pendingByDeal[item.dealId] = (pendingByDeal[item.dealId] || 0) + 1;
  });

  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:12px;';
  deals.forEach(d => {
    const s = SCENARIOS[d.scenario];
    const pct = overallPct(d);
    const pend = pendingByDeal[d.id] || 0;
    const card = document.createElement('div');
    card.className = 'deal-card';
    card.innerHTML = `
      <div class="deal-title">${escapeHtml(d.property)}</div>
      <span class="badge ${s.badgeClass}">${s.labelShort}</span>
      ${d.status === 'completed' ? `<span class="badge" style="background:var(--jade-soft); color:var(--jade); margin-left:4px;">${t('dealCompletedBadge')}</span>` : ''}
      <div class="deal-sub" style="margin-top:8px;">${escapeHtml(dealPartyNames(d,'seller'))} → ${escapeHtml(dealPartyNames(d,'buyer'))}</div>
      <div style="margin-top:10px; display:flex; align-items:center; gap:8px;">
        <div style="flex:1; height:6px; background:var(--stone); border-radius:4px; overflow:hidden;">
          <div style="width:${pct}%; height:100%; background:var(--jade);"></div>
        </div>
        <span class="field-hint" style="margin:0;">${pct}%</span>
      </div>
      <div class="field-hint" style="margin-top:6px;">
        ${d.closingDate ? `<i class="ti ti-calendar-event" aria-hidden="true"></i> ${escapeHtml(d.closingDate)} · ${escapeHtml(closingDaysLeftLabel(d.closingDate))}` : t('noClosingDateYet')}
      </div>
      ${pend ? `<div style="margin-top:8px;"><span class="badge" style="background:var(--oxblood-soft); color:var(--oxblood-deep);">${t('portalPendingOnYou', { count: pend })}</span></div>` : ''}
    `;
    card.onclick = () => { portalView = 'deal'; portalDealId = d.id; portalRole = 'agent'; portalPartyId = null; render(); };
    grid.appendChild(card);
  });
  body.appendChild(grid);
}

function renderPortal(body){
  // Solo admin/agente/abogado pueden "ver como" cualquier persona — es una
  // vista previa interna. Un comprador/vendedor real siempre ve solo su
  // propia parte (nunca elige, ni ve el checklist de otra persona del mismo
  // lado si hay varias).
  const isPreview = ['admin','agent','lawyer','external_lawyer'].includes(currentUser.role);

  if(isPreview){
    const banner = document.createElement('div');
    banner.className = 'banner';
    banner.innerHTML = `<i class="ti ti-eye" aria-hidden="true"></i> ${t('portalPreviewBanner')}`;
    body.appendChild(banner);
  }

  if(!deals.length){
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = `<i class="ti ti-folder-search" aria-hidden="true"></i><div>${t('noDealsYetPortal')}</div>`;
    body.appendChild(empty);
    return;
  }

  // Con una sola operación (el caso normal de un comprador/vendedor) no
  // tiene caso mostrar el scroller de tarjetas — se abre directo. Con varias
  // (agente con múltiples clientes, o admin/abogado en vista previa), el
  // scroller queda siempre visible arriba (como en el mockup) para saltar de
  // una a otra sin perder de vista cuál está abierta — no es un modo
  // "dashboard" aparte que reemplaza el detalle, conviven en la misma vista.
  if(portalDealId && !deals.some(d => d.id === portalDealId)) portalDealId = null;
  if(!portalDealId) portalDealId = deals[0].id;

  // Con varias operaciones (agente con varios clientes, comprador con dos
  // propiedades, o admin/abogado en vista previa): primero el panel con
  // todas, y la lista en el menú lateral — como Stripe: siempre visible,
  // sin robarle altura al contenido.
  const multiDeal = deals.length > 1;
  if(multiDeal){
    sidebarGroup(t('yourOperations'));
    sidebarItem({
      label: t('portalAllDeals'), icon: 'ti-layout-dashboard', active: portalView === 'overview',
      onClick: () => { portalView = 'overview'; render(); }
    });
    deals.forEach(d => sidebarItem({
      label: d.property, sub: true, group: 'deals', active: portalView === 'deal' && d.id === portalDealId,
      onClick: () => { portalView = 'deal'; portalDealId = d.id; portalRole = 'agent'; portalPartyId = null; render(); }
    }));
    if(portalView === 'overview'){
      buildPortalOverview(body);
      return;
    }
  } else {
    portalView = 'deal';
  }

  const deal = deals.find(d=>d.id===portalDealId);
  const s = SCENARIOS[deal.scenario];

  if(!deal._loaded){
    if(!deal._loading){ deal._loading = true; openDeal(portalDealId); }
    const loading = document.createElement('div');
    loading.className = 'empty';
    loading.innerHTML = `<i class="ti ti-loader-2" aria-hidden="true"></i><div>${t('loadingFile')}</div>`;
    body.appendChild(loading);
    return;
  }

  // Vista previa de staff: elige entre "Agente" (ve todo, como el admin) o
  // una persona específica de esta operación (ve exactamente lo que esa
  // persona vería). Comprador/vendedor real: se resuelve solo, a la parte
  // que tiene ligada su cuenta.
  let myParty = null;
  if(isPreview){
    const roleRow = document.createElement('div');
    roleRow.className = 'card';
    roleRow.innerHTML = `<label>${t('viewAs')} <select id="p-party">
      <option value="agent">${t('agentSeesAll')}</option>
      ${deal.parties.map(p=>`<option value="${p.id}">${escapeHtml(p.name)} (${p.side==='seller'?t('sellerLabel2'):t('buyerLabel2')})</option>`).join('')}
    </select></label>`;
    body.appendChild(roleRow);
    roleRow.querySelector('#p-party').value = portalRole==='agent' ? 'agent' : String(portalPartyId||'');
    roleRow.querySelector('#p-party').onchange = e => {
      if(e.target.value === 'agent'){ portalRole='agent'; portalPartyId=null; }
      else { portalRole='party'; portalPartyId = Number(e.target.value); }
      render();
    };
    if(portalRole === 'party' && portalPartyId) myParty = deal.parties.find(p=>p.id===portalPartyId) || null;
  } else {
    myParty = deal.parties.find(p => p.linkedUserIds.includes(currentUser.id)) || null;
  }

  // "Resumen" es su propia sección (como el "Tu resumen" de Stripe): ahí
  // viven el avance, las cifras y el "te toca a ti". En las demás secciones
  // solo queda una franja con el nombre de la operación, para que lo que
  // fuiste a ver salga de inmediato sin bajar por todo el encabezado.
  const hasSignTasks = deal.tasks.some(tk => tk.sign);
  const pendingSignsCount = deal.tasks.filter(tk => tk.sign && tk.docusignStatus !== 'completed').length;
  const myPendingDocs = myParty ? deal.documents.filter(d => d.partyId === myParty.id && d.status !== 'done').length : 0;
  const allPendingDocs = deal.documents.filter(d => d.status !== 'done').length;
  const waitingCount = myParty
    ? (() => { const { uploads, signatures } = pendingItemsForParty(deal, myParty); return uploads.length + signatures.length; })()
    : 0;
  // Orden por lo que le TOCA hacer al cliente, no por cómo está organizado
  // el expediente: primero sus documentos, su KYC y sus firmas; después lo
  // de consulta (propiedad, gastos, contrato, seguimiento). En celular las
  // primeras cuatro son además las que caben en la barra inferior.
  const TABS = [
    ['overview', t('tabOverview'), waitingCount],
    ...(myParty ? [
      ['mydocs', t('tabYourDocs'), myPendingDocs],
      ['kyc', t('tabYourKyc'), 0]
    ] : [
      ['docs', t('tabDocs'), allPendingDocs]
    ]),
    ...(hasSignTasks ? [['signatures', t('eSignature'), pendingSignsCount]] : []),
    ['property', t('propertySection'), 0],
    ['costs', t('tabCosts'), 0],
    ['contract', t('contractPromiseShort'), 0],
    ['tracker', t('tabTracker'), 0]
  ];
  const tabKey = `${deal.id}|${myParty ? myParty.id : 'all'}`;
  if(portalTabKey !== tabKey){ portalTabKey = tabKey; portalTab = 'overview'; }
  if(!TABS.some(([id]) => id === portalTab)) portalTab = TABS[0][0];
  sidebarSections(TABS, portalTab, (id) => { portalTab = id; render(); });

  const header = document.createElement('div');
  header.className = 'card';
  header.innerHTML = `
    <div class="deal-title" style="font-size:17px;">${escapeHtml(deal.property)}</div>
    <span class="badge ${s.badgeClass}">${s.labelShort}</span>
    <div class="deal-sub" style="margin-top:6px;">${escapeHtml(dealPartyNames(deal,'seller'))} → ${escapeHtml(dealPartyNames(deal,'buyer'))}</div>
  `;
  if(portalTab === 'overview'){
    const stepper = buildClosingStepper(deal);
    if(stepper) header.appendChild(stepper);
    header.appendChild(buildPortalStatGrid(deal, myParty));
    const callout = buildNextStepCallout(deal, myParty);
    if(callout) header.appendChild(callout);
  }
  body.appendChild(header);

  if(portalTab === 'property'){
    const pt = document.createElement('div'); pt.className='section-title'; pt.id='portal-property-section'; pt.textContent=t('propertySection');
    body.appendChild(pt);
    const pcard = document.createElement('div'); pcard.className='card';
    pcard.appendChild(buildPropertyDocsSection(deal, isPreview && !myParty, myParty && myParty.side));
    body.appendChild(pcard);
  }

  if(portalTab === 'costs'){
    const nt = document.createElement('div'); nt.className='section-title'; nt.id='portal-closing-costs-section'; nt.textContent=t('notaryClosingCostsSection');
    body.appendChild(nt);
    const ncard = document.createElement('div'); ncard.className='card';
    ncard.appendChild(buildNotaryClosingCostsSection(deal, isPreview && !myParty, myParty && myParty.side));
    body.appendChild(ncard);
  }

  if(portalTab === 'mydocs' && myParty){
    const secTitle = document.createElement('div'); secTitle.className='section-title'; secTitle.id='portal-mydocs-section'; secTitle.textContent=t('yourDocsChecklist');
    body.appendChild(secTitle);
    const card = document.createElement('div'); card.className='card';
    card.appendChild(buildDocListForParty(deal, myParty, false));
    body.appendChild(card);
  }

  if(portalTab === 'kyc' && myParty){
    const kt = document.createElement('div'); kt.className='section-title'; kt.id='portal-kyc-section'; kt.textContent=t('yourKycFile');
    body.appendChild(kt);
    const kcard = document.createElement('div'); kcard.className='card';
    kcard.appendChild(buildKycSection(deal, myParty, false));
    body.appendChild(kcard);
  }

  if(portalTab === 'docs' && !myParty){
    const secTitle = document.createElement('div'); secTitle.className='section-title'; secTitle.textContent=t('allPartiesChecklist');
    body.appendChild(secTitle);
    const card = document.createElement('div'); card.className='card';
    card.appendChild(buildDocsBySideGrouping(deal, isPreview));
    body.appendChild(card);
  }

  if(portalTab === 'contract'){
    const ct = document.createElement('div'); ct.className='section-title'; ct.textContent=t('contractPromiseShort');
    body.appendChild(ct);
    const ccard = document.createElement('div'); ccard.className='card';
    ccard.appendChild(buildContractSection(deal, false));
    body.appendChild(ccard);
  }

  if(portalTab === 'tracker'){
    const tt = document.createElement('div'); tt.className='section-title'; tt.textContent=t('closingFollowup');
    body.appendChild(tt);
    const tcard = document.createElement('div'); tcard.className='card';
    tcard.appendChild(buildTaskList(deal, isPreview && ['admin','lawyer'].includes(currentUser.role)));
    body.appendChild(tcard);
  }

  if(portalTab === 'signatures'){
    buildSignatureTasksSection(deal, body, false);
  }
}

// Documentos de cierre que requieren firma (escrow agreement, KYC del
// fiduciario, escritura) — llenar/generar/mandar a firma es SOLO de
// admin/abogado interno (canManage), nunca de agente ni abogado externo:
// son documentos legales de la operación, no algo que un facilitador deba
// poder armar por su cuenta. Agente/abogado externo/cliente ven lo mismo
// que un comprador/vendedor: estado + "Firmar ahora" si les toca firmar.
// Se usa tanto en el detalle de Operaciones (admin/abogado) como en Portal
// (donde antes vivía esto en solitario, con permisos más laxos de los que
// debía tener).
function buildSignatureTasksSection(deal, body, isStaffView){
  const canManage = isStaffView && ['admin','lawyer'].includes(currentUser.role);
  const signTasks = deal.tasks.filter(task=>task.sign);
  if(!signTasks.length) return;
  const st = document.createElement('div'); st.className='section-title'; st.id='portal-esignature-section'; st.textContent=t('eSignature');
  body.appendChild(st);
  const scard = document.createElement('div'); scard.className='card';
  scard.innerHTML = `<div class="field-hint" style="margin-top:0;">${canManage ? t('eSignHintStaff') : t('eSignHintClient')}</div>`;
  signTasks.forEach(task => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:0.5px solid var(--line); flex-wrap:wrap; gap:8px;';
    const statusLabel = {not_sent:t('docusignNotSent'), sent:t('docusignSent'), delivered:t('docusignDelivered'), completed:t('docusignCompleted'), declined:t('docusignDeclined'), voided:t('docusignVoided')}[task.docusignStatus] || task.docusignStatus;
    const sideTag = task.signSide ? ` <span class="field-hint" style="margin:0;">(${task.signSide === 'buyer' ? t('buyerLabel2') : t('sellerLabel2')})</span>` : '';
    row.innerHTML = `<span style="font-size:13px;">${escapeHtml(task.en)}${task.en !== task.es ? ` <span class="task-es">(${escapeHtml(task.es)})</span>` : ''}${sideTag}<br><span class="field-hint" style="margin:0;">${t('documentColon')}: ${task.documentOriginalName ? escapeHtml(task.documentOriginalName) : t('notUploaded')} · ${t('docusignStatusColon')}: ${escapeHtml(statusLabel)}</span></span>`;

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex; gap:8px; align-items:center; flex-wrap:wrap;';

    if(task.documentOriginalName){
      const viewLink = document.createElement('a');
      viewLink.href = `/api/docusign/deals/${deal.id}/tasks/${task.id}/document`;
      viewLink.target = '_blank';
      viewLink.className = 'btn';
      viewLink.style.fontSize = '11px';
      viewLink.innerHTML = `<i class="ti ti-eye" aria-hidden="true"></i> ${t('viewDocument')}`;
      actions.appendChild(viewLink);
    }

    if(canManage){
      const fileInput = document.createElement('input');
      fileInput.type = 'file'; fileInput.accept = '.pdf'; fileInput.style.display = 'none';
      const uploadBtn = document.createElement('button');
      uploadBtn.type = 'button'; uploadBtn.className = 'btn'; uploadBtn.style.fontSize = '11px';
      uploadBtn.title = t('uploadSignedDocTitle');
      uploadBtn.innerHTML = `<i class="ti ti-upload" aria-hidden="true"></i> ${task.documentOriginalName ? t('replaceFile') : t('upload')}`;
      uploadBtn.onclick = () => fileInput.click();
      fileInput.onchange = async (e) => {
        const file = e.target.files[0]; if(!file) return;
        const original = uploadBtn.innerHTML;
        uploadBtn.disabled = true; uploadBtn.innerHTML = `<i class="ti ti-loader-2" aria-hidden="true"></i> ${t('uploading')}`;
        const fd = new FormData(); fd.append('file', file);
        try{
          await apiUpload(`/api/docusign/deals/${deal.id}/tasks/${task.id}/document`, fd);
          await openDeal(deal.id);
        }catch(err){ showToast(err.message, 'error'); uploadBtn.disabled = false; uploadBtn.innerHTML = original; }
      };
      actions.appendChild(uploadBtn);
      actions.appendChild(fileInput);

      // El botón de "generar desde plantilla" solo tiene sentido para la
      // tarea del escrow agreement (docType 'escrow') — para las demás
      // (ej. KYC del fiduciario) no hay plantilla, el documento llega de
      // afuera (banco/notaría) y solo se sube con el input de arriba.
      if(task.docType === 'escrow'){
        const escrowBtn = document.createElement('button');
        escrowBtn.className = 'btn'; escrowBtn.style.fontSize = '11px';
        escrowBtn.textContent = t('generateEscrow');
        escrowBtn.onclick = () => { escrowFormOpenFor = (escrowFormOpenFor === task.id ? null : task.id); render(); };
        actions.appendChild(escrowBtn);
      }

      const sendBtn = document.createElement('button');
      sendBtn.className = 'btn gold';
      sendBtn.textContent = t('sendForSignature');
      sendBtn.disabled = !task.documentOriginalName || task.docusignStatus !== 'not_sent';
      sendBtn.onclick = () => withButtonLoading(sendBtn, async () => {
        try{
          await apiFetch(`/api/docusign/deals/${deal.id}/tasks/${task.id}/send-for-signature`, { method:'POST' });
          await openDeal(deal.id);
        }catch(err){ showToast(err.message, 'error'); }
      });
      actions.appendChild(sendBtn);

      // "Firmado fuera de la plataforma" — si el documento se subió YA
      // firmado (papel, correo), esto lo marca completado y le quita al
      // cliente la firma pendiente sin pasar por DocuSign. Reversible solo
      // si fue marcado a mano (nunca sobre un sobre real).
      if(task.documentOriginalName && task.docusignStatus === 'not_sent'){
        const offlineBtn = document.createElement('button');
        offlineBtn.className = 'btn'; offlineBtn.style.fontSize = '11px';
        offlineBtn.innerHTML = `<i class="ti ti-checks" aria-hidden="true"></i> ${t('markSignedOffline')}`;
        offlineBtn.title = t('markSignedOfflineTitle');
        offlineBtn.onclick = async () => {
          if(!await confirmDialog(t('confirmMarkSignedOffline', { name: lang==='en' ? task.en : task.es }))) return;
          try{
            await apiFetch(`/api/deals/${deal.id}/tasks/${task.id}`, { method:'PATCH', body: JSON.stringify({ signedOffline: true }) });
            showToast(t('markedSignedOffline'), 'success');
            await openDeal(deal.id);
          }catch(err){ showToast(err.message, 'error'); }
        };
        actions.appendChild(offlineBtn);
      }
      if(task.docusignStatus === 'completed' && !task.docusignEnvelopeId){
        const undoBtn = document.createElement('button');
        undoBtn.className = 'btn'; undoBtn.style.fontSize = '11px';
        undoBtn.innerHTML = `<i class="ti ti-rotate-2" aria-hidden="true"></i> ${t('undoSignedOffline')}`;
        undoBtn.title = t('undoSignedOfflineTitle');
        undoBtn.onclick = async () => {
          try{
            await apiFetch(`/api/deals/${deal.id}/tasks/${task.id}`, { method:'PATCH', body: JSON.stringify({ signedOffline: false }) });
            await openDeal(deal.id);
          }catch(err){ showToast(err.message, 'error'); }
        };
        actions.appendChild(undoBtn);
      }
    } else if(task.status !== 'done' && task.docusignStatus !== 'not_sent'){
      const sentHint = document.createElement('span');
      sentHint.className = 'field-hint'; sentHint.style.cssText = 'margin:0; display:flex; align-items:center;';
      sentHint.textContent = t('checkEmailToSign');
      actions.appendChild(sentHint);
    }

    const checkBtn = document.createElement('button');
    checkBtn.className = 'btn';
    checkBtn.textContent = t('checkStatus');
    checkBtn.style.fontSize = '11px';
    checkBtn.onclick = () => withButtonLoading(checkBtn, async () => {
      try{
        const result = await apiFetch(`/api/docusign/deals/${deal.id}/tasks/${task.id}/status`);
        await openDeal(deal.id);
        if(result.warning) showToast(result.warning);
      }catch(err){ showToast(err.message, 'error'); }
    });
    actions.appendChild(checkBtn);

    row.appendChild(actions);
    scard.appendChild(row);

    if(canManage && escrowFormOpenFor === task.id){
      scard.appendChild(buildEscrowForm(deal, task));
    }
  });
  if(canManage){
    scard.appendChild(buildAddSignatureTaskRow(deal));
  }
  body.appendChild(scard);
}

// Botón "+" para que admin/abogado interno manden a firma cualquier
// documento que no tenga su propio renglón fijo (ej. un NDA o un poder) —
// eligen a quién le toca firmar (nunca ambos lados a la vez: si hiciera
// falta, ya está el escrow agreement/contrato). Una vez creada, la tarea
// aparece arriba con los mismos controles de subir/mandar a firma que las demás.
function buildAddSignatureTaskRow(deal){
  const row = document.createElement('div');
  row.style.cssText = 'margin-top:6px; padding-top:8px; border-top:0.5px solid var(--line);';
  row.innerHTML = `
    <button type="button" class="btn add-sign-task-toggle" title="${t('addSignatureTaskTitle')}" style="font-size:13px; padding:4px 9px; line-height:1;"><i class="ti ti-plus" aria-hidden="true"></i></button>
    <div class="add-sign-task-form" style="display:none; gap:6px; align-items:center; margin-top:6px; flex-wrap:wrap;">
      <input type="text" class="add-sign-task-name" placeholder="${t('signatureTaskNamePh')}" style="flex:1; min-width:180px; font-size:12px; padding:5px 8px;">
      <select class="add-sign-task-side" style="font-size:12px; padding:5px 8px;">
        <option value="">${t('selectSignerSide')}</option>
        <option value="buyer">${t('buyerLabel2')}</option>
        <option value="seller">${t('sellerLabel2')}</option>
      </select>
      <button type="button" class="btn primary add-sign-task-save" style="font-size:11px; padding:4px 10px; white-space:nowrap;">${t('addChecklistItem')}</button>
      <button type="button" class="btn add-sign-task-cancel" title="${t('close')}" style="font-size:11px; padding:4px 8px;"><i class="ti ti-x" aria-hidden="true"></i></button>
    </div>
    <div class="gate-error add-sign-task-error"></div>
  `;
  const toggleBtn = row.querySelector('.add-sign-task-toggle');
  const form = row.querySelector('.add-sign-task-form');
  const nameInput = row.querySelector('.add-sign-task-name');
  const sideSelect = row.querySelector('.add-sign-task-side');
  const saveBtn = row.querySelector('.add-sign-task-save');
  const cancelBtn = row.querySelector('.add-sign-task-cancel');
  const errEl = row.querySelector('.add-sign-task-error');
  toggleBtn.onclick = () => {
    toggleBtn.style.display = 'none';
    form.style.display = 'flex';
    nameInput.focus();
  };
  cancelBtn.onclick = () => {
    form.style.display = 'none';
    toggleBtn.style.display = 'inline-flex';
    nameInput.value = ''; sideSelect.value = ''; errEl.textContent = '';
  };
  saveBtn.onclick = async () => {
    const label = nameInput.value.trim();
    const side = sideSelect.value;
    errEl.textContent = '';
    if(!label || !side){ errEl.textContent = t('errNameOrSide'); return; }
    saveBtn.disabled = true;
    try{
      await apiFetch(`/api/docusign/deals/${deal.id}/tasks`, { method:'POST', body: JSON.stringify({ label, side }) });
      await openDeal(deal.id);
    }catch(e){ errEl.textContent = e.message; saveBtn.disabled = false; }
  };
  nameInput.onkeydown = (e) => { if(e.key === 'Escape') cancelBtn.click(); };
  return row;
}

function buildEscrowForm(deal, task){
  const wrap = document.createElement('div');
  wrap.style.cssText = 'padding:12px; margin-bottom:10px; background:var(--stone); border-radius:10px;';
  wrap.innerHTML = `
    <div class="field-hint" style="margin-top:0;">${t('escrowFormHint')}</div>
    <div class="form-row">
      <label>${t('placeDate')} <input type="text" data-escrow-field="placeDate" placeholder="${t('placeDatePh')}"></label>
      <label>${t('expirationDate')} <input type="text" data-escrow-field="expirationDate" placeholder="${t('expirationDatePh')}"></label>
    </div>
    <div class="form-row">
      <label>${t('purchaseAgreementDesc')} <input type="text" data-escrow-field="purchaseAgreementDescription"></label>
    </div>
    <div class="form-row">
      <label>${t('depositAmount')} <input type="text" data-escrow-field="depositAmount" placeholder="${t('depositAmountPh')}"></label>
      <label>${t('fees')} <input type="text" data-escrow-field="fees" placeholder="${t('feesPh')}"></label>
    </div>
    <div class="form-row">
      <label>${t('noticeAddressSeller')} <input type="text" data-escrow-field="noticeAddressSeller"></label>
      <label>${t('noticeAddressBuyer')} <input type="text" data-escrow-field="noticeAddressBuyer"></label>
    </div>
    <div class="gate-error" id="escrow-error"></div>
    <button class="btn primary" id="escrow-generate">${t('generateDocument')}</button>
  `;
  wrap.querySelector('#escrow-generate').onclick = async () => {
    const body = {};
    wrap.querySelectorAll('[data-escrow-field]').forEach(el => { body[el.dataset.escrowField] = el.value.trim(); });
    try{
      await apiFetch(`/api/docusign/deals/${deal.id}/tasks/${task.id}/generate-escrow-document`, { method:'POST', body: JSON.stringify(body) });
      escrowFormOpenFor = null;
      await openDeal(deal.id);
    }catch(e){ wrap.querySelector('#escrow-error').textContent = e.message; }
  };
  return wrap;
}

// Cierra el menú "···" de una tarjeta de operación si se hace clic fuera de
// él — los clics del propio botón/menú ya llaman stopPropagation, así que
// esto solo se dispara para clics genuinamente afuera.
document.addEventListener('click', () => {
  if(dealMenuOpenFor !== null || docActionsMenuFor !== null){ dealMenuOpenFor = null; docActionsMenuFor = null; render(); }
});

// --- Aviso de versión nueva ---
// Una pestaña abierta desde hace días nunca se recarga sola: se queda con
// el código de ANTES del último deploy y "no se ven" las mejoras nuevas.
// Se consulta /api/health (que trae la versión del deploy) cada 5 minutos
// y, si cambió desde que cargó esta pestaña, aparece el aviso de recargar.
