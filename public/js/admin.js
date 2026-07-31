// Perfil, Dashboard, Equipo, Clientes, Papelera
// Parte de la interfaz de Grupo NAR — ver public/index.html para el orden
// en que se cargan estos archivos (todos comparten el mismo ámbito global).

// avatarUrl}).
function avatarHtml(user, size){
  const s = size || 44;
  const style = `width:${s}px; height:${s}px; font-size:${Math.max(10, Math.round(s/3.2))}px; flex-shrink:0;`;
  if(user && user.avatarUrl){
    return `<span class="session-avatar" style="${style} overflow:hidden;"><img src="/api/users/${user.userId || user.id}/avatar" alt="" style="width:100%; height:100%; object-fit:cover; display:block;"></span>`;
  }
  return `<span class="session-avatar" style="${style}">${escapeHtml(personInitials(user && user.name || ''))}</span>`;
}

// ---------- ADMIN ----------
let profileEditOpen = false;

function buildProfileEditor(){
  const box = document.createElement('div');
  box.style.cssText = 'margin-top:14px; padding-top:14px; border-top:0.5px solid var(--line); display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:10px; width:100%;';
  const isFacilitator = ['agent','external_lawyer'].includes(currentUser.role);
  box.innerHTML = `
    <label>${t('profileName')}<input type="text" id="prof-name" value="${escapeHtml(currentUser.name||'')}" maxlength="200"></label>
    <label>${t('profilePhone')}<input type="text" id="prof-phone" value="${escapeHtml(currentUser.phone||'')}" maxlength="30" placeholder="+52 ..."></label>
    <label>${t('profileAgency')}<input type="text" id="prof-agency" value="${escapeHtml(currentUser.agency||'')}" maxlength="200" ${isFacilitator ? '' : `placeholder="${t('profileAgencyOptional')}"`}></label>
    <label>${t('profileBio')}<input type="text" id="prof-bio" value="${escapeHtml(currentUser.bio||'')}" maxlength="600" placeholder="${t('profileBioPh')}"></label>
    <label>${t('profilePhoto')}<input type="file" id="prof-avatar" accept="image/png,image/jpeg,image/webp"></label>
    <div style="display:flex; gap:8px; align-items:flex-end;">
      <button class="btn primary" id="prof-save"><i class="ti ti-check" aria-hidden="true"></i> ${t('save')}</button>
      ${currentUser.avatarUrl ? `<button class="btn" id="prof-remove-avatar"><i class="ti ti-photo-off" aria-hidden="true"></i> ${t('profileRemovePhoto')}</button>` : ''}
    </div>
  `;
  box.querySelector('#prof-save').onclick = (e) => withButtonLoading(e.currentTarget, async () => {
    const payload = {
      name: box.querySelector('#prof-name').value.trim(),
      phone: box.querySelector('#prof-phone').value.trim(),
      agency: box.querySelector('#prof-agency').value.trim(),
      bio: box.querySelector('#prof-bio').value.trim()
    };
    if(!payload.name){ showToast(t('profileNameRequired'), 'error'); return; }
    let r = await fetch('/api/users/me/profile', { method:'PATCH', headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify(payload) });
    if(!r.ok){ const j = await r.json().catch(()=>({})); showToast(j.error || t('genericError'), 'error'); return; }
    const file = box.querySelector('#prof-avatar').files[0];
    if(file){
      const fd = new FormData(); fd.append('avatar', file);
      r = await fetch('/api/users/me/avatar', { method:'POST', credentials:'include', body: fd });
      if(!r.ok){ const j = await r.json().catch(()=>({})); showToast(j.error || t('genericError'), 'error'); return; }
    }
    const me = await fetch('/api/auth/me', { credentials:'include' }).then(x=>x.json());
    currentUser = { ...currentUser, ...me };
    profileEditOpen = false;
    showToast(t('profileSaved'), 'success');
    render();
  });
  const removeBtn = box.querySelector('#prof-remove-avatar');
  if(removeBtn) removeBtn.onclick = (e) => withButtonLoading(e.currentTarget, async () => {
    await fetch('/api/users/me/avatar', { method:'DELETE', credentials:'include' });
    currentUser.avatarUrl = null;
    showToast(t('profileSaved'), 'success');
    render();
  });
  return box;
}

function renderAdmin(body){
  if(adminView === 'list' || adminView === 'dashboard' || adminView === 'team' || adminView === 'clients' || adminView === 'trash' || adminView === null){
    // La tarjeta de sesión se fue al pie del menú lateral (quien la ve todo
    // el día ya sabe quién es); aquí solo aparece el editor de perfil
    // cuando lo abre a propósito.
    if(profileEditOpen){
      const profCard = document.createElement('div');
      profCard.className = 'card';
      profCard.innerHTML = `<div class="section-title" style="margin:0;">${t('editProfile')}</div>`;
      profCard.appendChild(buildProfileEditor());
      body.appendChild(profCard);
    }
  }

  if(adminView === 'team'){
    body.appendChild(buildTeamSection());
    return;
  }

  if(adminView === 'clients'){
    body.appendChild(buildClientsSection());
    return;
  }

  if(adminView === 'trash'){
    body.appendChild(buildTrashSection());
    return;
  }

  const deal = deals.find(d=>d.id===activeDealId);
  if(adminView === 'newDeal'){
    body.appendChild(buildNewDealForm());
    return;
  }
  if(deal){
    body.appendChild(buildAdminDealDetail(deal));
    return;
  }
  if(adminView === 'dashboard'){
    body.appendChild(buildDashboard());
    return;
  }

  const title = document.createElement('div');
  title.className = 'section-title';
  title.textContent = t('operationsTitle');
  body.appendChild(title);

  const addBtn = document.createElement('button');
  addBtn.className = 'btn primary';
  addBtn.style.marginBottom = '14px';
  addBtn.innerHTML = `<i class="ti ti-plus" aria-hidden="true"></i> ${t('newDeal')}`;
  addBtn.onclick = () => { adminView = 'newDeal'; render(); };
  body.appendChild(addBtn);

  const activeCount = deals.filter(d => (d.status||'active') === 'active').length;
  const completedCount = deals.filter(d => d.status === 'completed').length;
  const filterRow = document.createElement('div');
  filterRow.style.cssText = 'display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap; align-items:center;';
  filterRow.innerHTML = `
    <button class="btn ${dealsListFilter==='active'?'primary':''}" id="deals-filter-active">${t('dealsFilterActive')} (${activeCount})</button>
    <button class="btn ${dealsListFilter==='completed'?'primary':''}" id="deals-filter-completed">${t('dealsFilterCompleted')} (${completedCount})</button>
    <input type="text" id="deals-search" placeholder="${t('dealsSearchPh')}" value="${escapeHtml(dealsSearch)}" style="flex:1; min-width:200px; font-size:13px; padding:7px 12px;">
  `;
  body.appendChild(filterRow);
  filterRow.querySelector('#deals-filter-active').onclick = () => { dealsListFilter = 'active'; render(); };
  filterRow.querySelector('#deals-filter-completed').onclick = () => { dealsListFilter = 'completed'; render(); };
  filterRow.querySelector('#deals-search').oninput = (e) => {
    dealsSearch = e.target.value;
    const cursor = e.target.selectionStart;
    render();
    const el = document.getElementById('deals-search');
    if(el){ el.focus(); el.setSelectionRange(cursor, cursor); }
  };

  // Búsqueda por inmueble, cualquier parte (vendedor/comprador), agente o
  // desarrollo — todo ya viene en el resumen de cada operación, así que el
  // filtro es instantáneo, sin viaje al servidor.
  const search = dealsSearch.trim().toLowerCase();
  const matchesSearch = (d) => !search
    || d.property.toLowerCase().includes(search)
    || d.parties.some(p => p.name.toLowerCase().includes(search))
    || (d.agents || []).some(a => (a.name || '').toLowerCase().includes(search))
    || (DEVELOPMENT_LABEL[d.development||'punta_mita'] || '').toLowerCase().includes(search);
  const visibleDeals = deals.filter(d => (d.status||'active') === dealsListFilter && matchesSearch(d));
  if(!visibleDeals.length){
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = `<i class="ti ti-building-estate" aria-hidden="true"></i><div>${search ? t('noDealsMatchSearch') : (dealsListFilter==='completed' ? t('emptyCompletedDeals') : t('emptyDeals'))}</div>`;
    body.appendChild(empty);
    return;
  }
  visibleDeals.forEach(d => {
    const s = SCENARIOS[d.scenario];
    const canManageDeal = ['admin','agent','lawyer','external_lawyer'].includes(currentUser.role);
    const card = document.createElement('div');
    card.className = 'deal-card';
    card.innerHTML = `
      ${canManageDeal ? `<button class="deal-card-menu-btn" id="menu-btn-${d.id}" title="${t('dealMenu')}"><i class="ti ti-dots-vertical" aria-hidden="true"></i></button>` : ''}
      <div class="deal-title">${escapeHtml(d.property)}</div>
      <div class="deal-sub">${escapeHtml(dealPartyNames(d,'seller'))} → ${escapeHtml(dealPartyNames(d,'buyer'))} · ${d.currency||'USD'} ${Number(d.price||0).toLocaleString()}${d.furniturePrice ? ' + '+Number(d.furniturePrice).toLocaleString()+' muebles' : ''}</div>
      <span class="badge ${s.badgeClass}">${s.labelShort}</span>
      <span class="badge" style="background:var(--stone); border:0.5px solid var(--line); color:var(--ink-soft); margin-left:4px;">${DEVELOPMENT_LABEL[d.development||'punta_mita'].split(' (')[0]}</span>
      ${d.status==='completed' ? `<span class="badge" style="background:var(--jade-soft); color:var(--jade); margin-left:4px;">${t('dealCompletedBadge')}</span>` : ''}
      <div class="deal-sub" style="margin-top:6px;">Docs: ${pctDocs(d)}% · Tracker: ${pctTasks(d)}%</div>
      ${dealMenuOpenFor === d.id ? `
        <div class="deal-card-menu" id="menu-${d.id}">
          <button id="menu-edit-${d.id}"><i class="ti ti-pencil" aria-hidden="true"></i> ${t('editDeal')}</button>
          <button id="menu-status-${d.id}"><i class="ti ti-${d.status==='completed'?'rotate':'check'}" aria-hidden="true"></i> ${d.status==='completed' ? t('reopenDeal') : t('markDealCompleted')}</button>
          <button class="danger" id="menu-delete-${d.id}"><i class="ti ti-trash" aria-hidden="true"></i> ${t('deleteDeal')}</button>
        </div>
      ` : ''}
    `;
    card.onclick = () => { activeDealId = d.id; openDeal(d.id); };
    const menuBtn = card.querySelector(`#menu-btn-${d.id}`);
    if(menuBtn) menuBtn.onclick = (e) => {
      e.stopPropagation();
      dealMenuOpenFor = dealMenuOpenFor === d.id ? null : d.id;
      render();
    };
    const menuEl = card.querySelector(`#menu-${d.id}`);
    if(menuEl){
      menuEl.onclick = (e) => e.stopPropagation();
      menuEl.querySelector(`#menu-edit-${d.id}`).onclick = async () => {
        dealMenuOpenFor = null;
        activeDealId = d.id;
        await openDeal(d.id);
      };
      menuEl.querySelector(`#menu-status-${d.id}`).onclick = async () => {
        dealMenuOpenFor = null;
        const nextStatus = d.status === 'completed' ? 'active' : 'completed';
        if(nextStatus === 'completed' && !await confirmDialog(t('confirmMarkCompleted'))) return;
        try{
          await apiFetch(`/api/deals/${d.id}`, { method:'PATCH', body: JSON.stringify({ status: nextStatus }) });
          d.status = nextStatus;
          render();
        }catch(err){ showToast(err.message, 'error'); }
      };
      menuEl.querySelector(`#menu-delete-${d.id}`).onclick = async () => {
        dealMenuOpenFor = null;
        if(!await confirmDialog(t('confirmDeleteDeal'), { danger: true })) return;
        try{
          await apiFetch(`/api/deals/${d.id}`, { method: 'DELETE' });
          deals = deals.filter(x => x.id !== d.id);
          if(currentUser.role === 'admin') loadTrash();
          render();
        }catch(err){ showToast(err.message, 'error'); }
      };
    }
    body.appendChild(card);
  });
}


// Colores por urgencia (no por % de avance) — entre menos días falten para
// el cierre, más "caliente" el color, independientemente de qué tan
// avanzada esté la operación (una operación al 90% que cierra mañana sigue
// necesitando atención esta semana).
function closingUrgencyColor(daysToClose){
  if (daysToClose <= 7) return { ring: 'var(--oxblood)', pillBg: 'var(--oxblood-soft)', pillFg: 'var(--oxblood)' };
  if (daysToClose <= 21) return { ring: 'var(--gold)', pillBg: 'var(--gold-soft)', pillFg: '#6B4E1E' };
  return { ring: 'var(--jade)', pillBg: 'var(--jade-soft)', pillFg: 'var(--jade)' };
}

function buildUpcomingClosings(closings){
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:12px; margin-bottom:16px;';
  closings.forEach(c => {
    const colors = closingUrgencyColor(c.daysToClose);
    const card = document.createElement('div');
    card.className = 'card';
    card.style.cssText = 'display:flex; align-items:center; gap:14px; cursor:pointer; margin-bottom:0;';
    const pct = Math.max(0, Math.min(100, c.percent));
    const daysLabel = c.daysToClose < 0 ? t('closingOverdue')
      : c.daysToClose === 0 ? t('closingToday')
      : c.daysToClose === 1 ? t('daysToCloseSingular', { days: c.daysToClose })
      : t('daysToClosePlural', { days: c.daysToClose });
    card.innerHTML = `
      <div style="width:70px; height:70px; border-radius:50%; flex-shrink:0; background:conic-gradient(${colors.ring} ${pct}%, var(--line) ${pct}% 100%); display:flex; align-items:center; justify-content:center;">
        <div style="width:52px; height:52px; border-radius:50%; background:var(--stone-card); display:flex; align-items:center; justify-content:center; font-weight:600; font-size:15px;">${pct}%</div>
      </div>
      <div style="min-width:0;">
        <div style="font-weight:600; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(c.property)}</div>
        <span class="badge" style="background:${colors.pillBg}; color:${colors.pillFg}; margin-top:6px;">${escapeHtml(daysLabel)}</span>
      </div>
    `;
    card.onclick = () => { adminView='list'; activeDealId=c.dealId; openDeal(c.dealId); };
    grid.appendChild(card);
  });
  return grid;
}

function buildDashboard(){
  const wrap = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'section-title'; title.textContent = t('dashboard');
  wrap.appendChild(title);

  if(!dashboardData){
    const loading = document.createElement('div');
    loading.className = 'empty';
    loading.innerHTML = `<i class="ti ti-loader-2" aria-hidden="true"></i><div>${t('loadingDashboard')}</div>`;
    wrap.appendChild(loading);
    return wrap;
  }
  const d = dashboardData;

  const totalsCard = document.createElement('div');
  totalsCard.className = 'card';
  totalsCard.innerHTML = `
    <div class="grid2">
      <div><div style="font-size:26px; font-weight:600; color:var(--oxblood-deep);">${d.totalDeals}</div><div class="field-hint" style="margin:0;">${t('statActiveDeals')}</div></div>
      <div><div style="font-size:26px; font-weight:600; color:var(--oxblood-deep);">${d.documentsPending}</div><div class="field-hint" style="margin:0;">${t('statDocsPending')}</div></div>
      <div><div style="font-size:26px; font-weight:600; color:var(--oxblood-deep);">${d.tasksPending + d.tasksInProgress}</div><div class="field-hint" style="margin:0;">${t('statTasksUnfinished')}</div></div>
      <div><div style="font-size:26px; font-weight:600; color:var(--oxblood-deep);">${d.signaturesAwaiting.length}</div><div class="field-hint" style="margin:0;">${t('statAwaitingSignature')}</div></div>
    </div>
    ${d.dealsByScenario.length ? `<div style="margin-top:14px; display:flex; gap:8px; flex-wrap:wrap;">${d.dealsByScenario.map(s=>`<span class="badge">${(SCENARIOS[s.scenario]&&SCENARIOS[s.scenario].labelShort)||s.scenario}: ${s.count}</span>`).join('')}</div>` : ''}
  `;
  wrap.appendChild(totalsCard);

  // "Mis tareas" — lo asignado A MÍ, primero que todo lo demás: un abogado
  // (o admin) entra al Dashboard y ve directo qué le toca sin abrir
  // operación por operación.
  if(d.myTasks && d.myTasks.length){
    const myTitle = document.createElement('div');
    myTitle.className = 'section-title'; myTitle.textContent = t('myTasksTitle', { count: d.myTasks.length });
    wrap.appendChild(myTitle);
    const myCard = document.createElement('div'); myCard.className = 'card';
    d.myTasks.forEach((item, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:8px 0; cursor:pointer; gap:10px;' + (i < d.myTasks.length - 1 ? ' border-bottom:0.5px solid var(--line);' : '');
      row.innerHTML = `
        <span style="font-size:13px;">${escapeHtml(lang==='en'?item.label_en:item.label_es)} <span class="field-hint" style="margin:0;">· ${escapeHtml(item.property)}</span></span>
        <span class="field-hint" style="margin:0; flex-shrink:0;">${t('viewDeal')} <i class="ti ti-arrow-right" aria-hidden="true"></i></span>
      `;
      row.onclick = () => { adminView='list'; activeDealId=item.dealId; openDeal(item.dealId); };
      myCard.appendChild(row);
    });
    wrap.appendChild(myCard);
  }

  if(d.totalDeals > 0){
    const ucTitle = document.createElement('div');
    ucTitle.className = 'section-title'; ucTitle.textContent = t('upcomingClosings');
    wrap.appendChild(ucTitle);
    if(d.upcomingClosings && d.upcomingClosings.length){
      wrap.appendChild(buildUpcomingClosings(d.upcomingClosings));
    } else {
      const hint = document.createElement('div'); hint.className = 'card';
      hint.innerHTML = `<div class="field-hint" style="margin:0;">${t('noUpcomingClosingsHint')}</div>`;
      wrap.appendChild(hint);
    }
  }

  if(d.signaturesAwaiting.length){
    const signTitle = document.createElement('div');
    signTitle.className = 'section-title'; signTitle.textContent = t('awaitingSignature');
    wrap.appendChild(signTitle);
    const signCard = document.createElement('div'); signCard.className = 'card';
    d.signaturesAwaiting.forEach(item => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:0.5px solid var(--line); cursor:pointer; gap:10px;';
      row.innerHTML = `<span style="font-size:13px;">"${escapeHtml(lang==='en'?item.label_en:item.label_es)}" · ${escapeHtml(item.property)}</span><span class="badge" style="background:var(--gold-soft); color:#6B4E1E; flex-shrink:0;">${t('signature')}</span>`;
      row.onclick = () => { adminView='list'; activeDealId=item.dealId; openDeal(item.dealId); };
      signCard.appendChild(row);
    });
    wrap.appendChild(signCard);
  }

  const pendingTitle = document.createElement('div');
  pendingTitle.className = 'section-title'; pendingTitle.textContent = t('pendingByDeal');
  wrap.appendChild(pendingTitle);

  const groups = {};
  d.pendingDocuments.forEach(x => {
    if(!groups[x.dealId]) groups[x.dealId] = { property: x.property, docs: [], tasks: [] };
    groups[x.dealId].docs.push(x);
  });
  d.pendingTasks.forEach(x => {
    if(!groups[x.dealId]) groups[x.dealId] = { property: x.property, docs: [], tasks: [] };
    groups[x.dealId].tasks.push(x);
  });

  if(!Object.keys(groups).length){
    const emptyCard = document.createElement('div'); emptyCard.className = 'card';
    emptyCard.innerHTML = `<div class="field-hint" style="margin:0;">${t('noPending')}</div>`;
    wrap.appendChild(emptyCard);
  } else {
    Object.entries(groups).forEach(([dealId, g]) => {
      const card = document.createElement('div'); card.className = 'card';
      const totalCount = g.docs.length + g.tasks.length;
      // Sin tocar todavía: pocos pendientes arranca abierto, muchos arranca
      // cerrado — para que una operación con 15+ pendientes no siempre
      // ocupe toda la pantalla del Dashboard.
      const isExpanded = dashboardExpandedGroups[dealId] !== undefined ? dashboardExpandedGroups[dealId] : totalCount <= 4;
      const header = document.createElement('div');
      header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; cursor:pointer;';
      header.innerHTML = `
        <span style="display:flex; align-items:center; gap:8px;">
          <button class="icon-btn" id="toggle-${dealId}" style="width:24px; height:24px; flex-shrink:0;" title="${t('toggleExpand')}"><i class="ti ti-chevron-${isExpanded?'down':'right'}" aria-hidden="true"></i></button>
          <span style="font-weight:600; font-size:13.5px;">${escapeHtml(g.property)}</span>
          <span class="field-hint" style="margin:0;">(${g.docs.length} ${t('docsCountLabel')} · ${g.tasks.length} ${t('tasksCountLabel')})</span>
        </span>
        <span class="field-hint" style="margin:0;">${t('viewDeal')} <i class="ti ti-arrow-right" aria-hidden="true"></i></span>
      `;
      header.onclick = () => { adminView='list'; activeDealId=Number(dealId); openDeal(Number(dealId)); };
      card.appendChild(header);
      header.querySelector(`#toggle-${dealId}`).onclick = (e) => {
        e.stopPropagation();
        dashboardExpandedGroups[dealId] = !isExpanded;
        render();
      };

      if(!isExpanded){ wrap.appendChild(card); return; }

      // Documentos y tareas separados con su propio sub-encabezado — antes
      // era una sola lista corrida y una operación con 37 pendientes se
      // veía como un solo número enorme en vez de, por ejemplo,
      // "22 documentos" y "15 tareas" por separado.
      if(g.docs.length){
        const docsSub = document.createElement('div');
        docsSub.style.cssText = 'font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; color:var(--ink-faint); margin-top:10px;';
        docsSub.textContent = `${t('docsCountLabel')} (${g.docs.length})`;
        card.appendChild(docsSub);
      }
      g.docs.forEach(doc => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:6px 0; border-bottom:0.5px solid var(--line);';
        row.innerHTML = `
          <span class="doc-check" style="flex-shrink:0;"></span>
          <span style="font-size:12.5px; flex:1;">${t('docLabel')}: ${escapeHtml(localizeDocName(doc.name))} <span class="field-hint" style="margin:0;">(${doc.partyName ? escapeHtml(doc.partyName) + ' · ' + (doc.side==='seller'?t('sellerLabel'):t('buyerLabel')) : t('propertyLabel')})</span></span>
          ${doc.stale ? `<span class="badge" style="background:var(--oxblood-soft); color:var(--oxblood); flex-shrink:0;">${t('stale')}</span>` : ''}
        `;
        row.querySelector('.doc-check').onclick = async () => {
          try{
            await apiFetch(`/api/deals/${dealId}/documents/${doc.documentId}`, { method:'PATCH', body: JSON.stringify({status:'done'}) });
            await loadDashboard();
          }catch(e){ showToast(e.message, 'error'); }
        };
        card.appendChild(row);
      });

      if(g.tasks.length){
        const tasksSub = document.createElement('div');
        tasksSub.style.cssText = 'font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; color:var(--ink-faint); margin-top:10px;';
        tasksSub.textContent = `${t('tasksCountLabel')} (${g.tasks.length})`;
        card.appendChild(tasksSub);
      }
      g.tasks.forEach(task => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:6px 0; border-bottom:0.5px solid var(--line);';
        const cls = task.status==='progress' ? 'progress' : '';
        row.innerHTML = `
          <div class="task-stamp ${cls}" style="width:22px; height:22px; font-size:10px; flex-shrink:0;">${task.status==='progress'?'<i class=\"ti ti-clock\" aria-hidden=\"true\"></i>':''}</div>
          <span style="font-size:12.5px; flex:1;">${t('taskLabel')}: ${escapeHtml(lang==='en'?task.label_en:task.label_es)}</span>
          ${task.stale ? `<span class="badge" style="background:var(--oxblood-soft); color:var(--oxblood); flex-shrink:0;">${t('stale')}</span>` : ''}
        `;
        // Confirmar un paso del tracker es solo de admin/abogado interno —
        // este widget del Dashboard también lo ve un agente/abogado externo.
        if(['admin','lawyer'].includes(currentUser.role)) row.querySelector('.task-stamp').onclick = async () => {
          const order=['pending','progress','done'];
          const next = order[(order.indexOf(task.status)+1)%order.length];
          try{
            await apiFetch(`/api/deals/${dealId}/tasks/${task.taskId}`, { method:'PATCH', body: JSON.stringify({status: next}) });
            await loadDashboard();
          }catch(e){ showToast(e.message, 'error'); }
        };
        card.appendChild(row);
      });

      wrap.appendChild(card);
    });
  }

  return wrap;
}

function buildTeamSection(){
  const wrap = document.createElement('div');

  const pendingTitle = document.createElement('div');
  pendingTitle.className = 'section-title'; pendingTitle.textContent = t('pendingApprovalTitle');
  wrap.appendChild(pendingTitle);
  const pendingCard = document.createElement('div'); pendingCard.className = 'card';
  if(pendingUsers === null){
    pendingCard.innerHTML = `<div class="field-hint" style="margin:0;">${t('loading')}</div>`;
    loadPendingUsers();
  } else if(!pendingUsers.length){
    pendingCard.innerHTML = `<div class="field-hint" style="margin:0;">${t('noPendingAccounts')}</div>`;
  } else {
    pendingUsers.forEach(u => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:0.5px solid var(--line); gap:10px;';
      row.innerHTML = `<span style="font-size:13px;">${escapeHtml(u.name)} <span class="field-hint" style="margin:0;">— ${escapeHtml(u.email)} · ${escapeHtml(roleDisplayLabel(u.role))}${u.agency ? ' · ' + escapeHtml(u.agency) : ''}</span></span>`;
      const approveBtn = document.createElement('button');
      approveBtn.className = 'btn primary'; approveBtn.textContent = t('approve');
      approveBtn.onclick = async () => {
        try{
          await apiFetch(`/api/users/${u.id}/approve`, { method:'PATCH' });
          await loadPendingUsers();
        }catch(e){ showToast(e.message, 'error'); }
      };
      row.appendChild(approveBtn);
      pendingCard.appendChild(row);
    });
  }
  wrap.appendChild(pendingCard);

  const activeTitle = document.createElement('div');
  activeTitle.className = 'section-title'; activeTitle.textContent = t('activeTeamTitle');
  wrap.appendChild(activeTitle);
  const activeCard = document.createElement('div'); activeCard.className = 'card';
  if(activeTeamMembers === null){
    activeCard.innerHTML = `<div class="field-hint" style="margin:0;">${t('loading')}</div>`;
  } else if(!activeTeamMembers.length){
    activeCard.innerHTML = `<div class="field-hint" style="margin:0;">${t('noActiveTeam')}</div>`;
  } else {
    activeCard.style.overflowX = 'auto';
    const table = document.createElement('table');
    table.className = 'data-table';
    table.innerHTML = `<thead><tr>
      <th>${t('nameLabel')}</th><th>${t('emailLabel')}</th><th>${t('roleLabel')}</th><th>${t('agencyLabel')}</th><th></th>
    </tr></thead>`;
    const tbody = document.createElement('tbody');
    activeTeamMembers.forEach(u => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td></td><td></td><td></td><td></td><td></td>`;

      const nameCell = tr.children[0];
      const nameInput = document.createElement('input');
      nameInput.type = 'text'; nameInput.value = u.name; nameInput.placeholder = t('namePh');
      nameInput.style.cssText = 'font-size:12px; padding:4px 8px; width:140px;';
      nameCell.appendChild(nameInput);
      const emailCell = tr.children[1];
      const emailInput = document.createElement('input');
      emailInput.type = 'email'; emailInput.value = u.email; emailInput.placeholder = t('emailPh');
      emailInput.style.cssText = 'font-size:12px; padding:4px 8px; width:180px;';
      emailCell.appendChild(emailInput);
      tr.children[2].innerHTML = roleChipHtml(u.role);

      const actionsCell = tr.children[4];
      const profileErr = document.createElement('div');
      profileErr.className = 'gate-error'; profileErr.style.cssText = 'margin:0 0 4px; font-size:11px;';
      const profileSaveBtn = document.createElement('button');
      profileSaveBtn.className = 'btn'; profileSaveBtn.style.cssText = 'font-size:11px; margin-right:6px;'; profileSaveBtn.textContent = t('save');
      profileSaveBtn.onclick = async () => {
        profileErr.textContent = '';
        const name = nameInput.value.trim();
        const email = emailInput.value.trim();
        if(!name || !email){ profileErr.textContent = t('errNameOrEmail'); return; }
        profileSaveBtn.disabled = true;
        try{
          await apiFetch(`/api/users/${u.id}/profile`, { method:'PATCH', body: JSON.stringify({ name, email }) });
          u.name = name; u.email = email;
          profileSaveBtn.textContent = t('saved');
          setTimeout(() => { profileSaveBtn.textContent = t('save'); }, 1200);
        }catch(e){ profileErr.textContent = e.message; }
        profileSaveBtn.disabled = false;
      };
      actionsCell.appendChild(profileErr);
      actionsCell.appendChild(profileSaveBtn);

      // Solo agentes tienen agencia — de esto depende que el KYC de LPR
      // salga automático (dealAgentIsLprAgency en routes/kyc.js), así que
      // tiene que haber forma de corregirla después del alta/registro.
      const agencyCell = tr.children[3];
      if(u.role === 'agent'){
        const agencyDisplay = document.createElement('span');
        agencyDisplay.style.cssText = 'font-size:12px;';
        agencyDisplay.textContent = u.agency || '—';
        const editBtn = document.createElement('button');
        editBtn.className = 'btn'; editBtn.style.cssText = 'font-size:10.5px; padding:2px 6px; margin-left:6px;';
        editBtn.textContent = u.agency ? t('editAgency') : t('setAgency');
        const editWrap = document.createElement('div');
        editWrap.style.cssText = 'display:none; gap:6px; align-items:center; flex-wrap:wrap; margin-top:4px;';
        editWrap.innerHTML = `
          <select style="font-size:11.5px;">
            <option value="">${t('registerAgencyPlaceholderSelect')}</option>
            ${AGENCIES.map(a => `<option value="${escapeHtml(a)}" ${u.agency===a?'selected':''}>${escapeHtml(a)}</option>`).join('')}
            <option value="Otro" ${u.agency && !AGENCIES.includes(u.agency)?'selected':''}>${t('registerAgencyOther')}</option>
          </select>
          <input type="text" placeholder="${t('registerAgencyOtherPh')}" style="font-size:11.5px; width:100px; display:${u.agency && !AGENCIES.includes(u.agency)?'':'none'};" value="${u.agency && !AGENCIES.includes(u.agency)?escapeHtml(u.agency):''}">
          <button class="btn primary" style="font-size:10.5px; padding:2px 6px;">${t('saveChanges')}</button>
          <span class="gate-error" style="margin:0; font-size:10.5px;"></span>
        `;
        const [selectEl, otherEl] = editWrap.querySelectorAll('select, input[type=text]');
        const agencySaveBtn = editWrap.querySelector('button');
        const agencyErrEl = editWrap.querySelector('.gate-error');
        selectEl.onchange = () => { otherEl.style.display = selectEl.value === 'Otro' ? '' : 'none'; };
        editBtn.onclick = () => { editWrap.style.display = editWrap.style.display === 'none' ? 'flex' : 'none'; };
        agencySaveBtn.onclick = async () => {
          agencyErrEl.textContent = '';
          try{
            await apiFetch(`/api/users/${u.id}/agency`, {
              method:'PATCH', body: JSON.stringify({ agency: selectEl.value, agencyOther: otherEl.value.trim() })
            });
            await loadPendingUsers();
          }catch(e){ agencyErrEl.textContent = e.message; }
        };
        agencyCell.appendChild(agencyDisplay);
        agencyCell.appendChild(editBtn);
        agencyCell.appendChild(editWrap);
      } else {
        agencyCell.textContent = '—';
      }

      // Para cuando alguien pierde el teléfono donde tenía la app de 2FA
      // (o cambió de equipo) — sin esto no hay forma de que vuelva a entrar,
      // el código que genera su app vieja ya no sirve para nada.
      const reset2faBtn = document.createElement('button');
      reset2faBtn.className = 'btn'; reset2faBtn.style.fontSize = '11px';
      reset2faBtn.textContent = t('reset2fa');
      reset2faBtn.title = t('reset2faTitle');
      reset2faBtn.onclick = async () => {
        if(!await confirmDialog(t('reset2faConfirm', { name: u.name }))) return;
        reset2faBtn.disabled = true;
        try{
          await apiFetch(`/api/users/${u.id}/reset-2fa`, { method:'POST' });
          showToast(t('reset2faDone'), 'success');
        }catch(e){ showToast(e.message, 'error'); }
        reset2faBtn.disabled = false;
      };
      actionsCell.appendChild(reset2faBtn);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    activeCard.innerHTML = '';
    activeCard.appendChild(table);
  }
  wrap.appendChild(activeCard);

  const inviteTitle = document.createElement('div');
  inviteTitle.className = 'section-title'; inviteTitle.textContent = t('inviteAgentLawyer');
  wrap.appendChild(inviteTitle);
  const inviteCard = document.createElement('div'); inviteCard.className = 'card';
  inviteCard.innerHTML = `
    <div class="field-hint" style="margin-top:0;">${t('inviteTeamHint')}</div>
    <div class="form-row">
      <label>${t('role')} <select id="team-inv-role">
        <option value="agent">${t('registerRoleAgent')}</option>
        <option value="external_lawyer">${t('registerRoleExternalLawyer')}</option>
        <option value="lawyer">${t('registerRoleLawyer')}</option>
      </select></label>
      <label>${t('name')} <input type="text" id="team-inv-name" placeholder="${t('namePh')}"></label>
      <label>${t('email')} <input type="email" id="team-inv-email" placeholder="${t('emailPh')}"></label>
    </div>
    <div class="form-actions" style="display:flex; justify-content:flex-end;">
      <button class="btn primary" id="team-inv-generate">${t('generateInvite')}</button>
    </div>
    <div id="team-inv-result" style="display:none;">
      <div class="form-row">
        <label style="flex:1;">${t('inviteLinkLabel')}
          <input type="text" id="team-inv-link" readonly>
        </label>
        <button class="btn" id="team-inv-copy" style="align-self:flex-end;">${t('copy')}</button>
      </div>
    </div>
    <div class="gate-error" id="team-inv-error"></div>
  `;
  wrap.appendChild(inviteCard);
  inviteCard.querySelector('#team-inv-generate').onclick = async () => {
    const roleInDeal = inviteCard.querySelector('#team-inv-role').value;
    const name = inviteCard.querySelector('#team-inv-name').value.trim();
    const email = inviteCard.querySelector('#team-inv-email').value.trim();
    const errEl = inviteCard.querySelector('#team-inv-error');
    errEl.textContent = '';
    if(!name || !email){ errEl.textContent = t('errNameOrEmail'); return; }
    try{
      const { url } = await apiFetch('/api/invites', { method:'POST', body: JSON.stringify({ roleInDeal, name, email }) });
      const linkInput = inviteCard.querySelector('#team-inv-link');
      linkInput.value = window.location.origin + url;
      inviteCard.querySelector('#team-inv-result').style.display = 'block';
    }catch(e){ errEl.textContent = e.message; }
  };
  inviteCard.querySelector('#team-inv-copy').onclick = () => {
    const linkInput = inviteCard.querySelector('#team-inv-link');
    linkInput.select();
    navigator.clipboard.writeText(linkInput.value);
  };

  const integrationsTitle = document.createElement('div');
  integrationsTitle.className = 'section-title'; integrationsTitle.textContent = t('integrationsTitle');
  wrap.appendChild(integrationsTitle);
  wrap.appendChild(buildIntegrationsSection());

  if(currentUser.role === 'admin'){
    const notaryTitle = document.createElement('div');
    notaryTitle.className = 'section-title'; notaryTitle.textContent = t('notaryPaymentNoteLabel');
    wrap.appendChild(notaryTitle);
    wrap.appendChild(buildNotaryPaymentNoteSection());
  }

  return wrap;
}

// Base de contactos de comprador/vendedor — separado del Equipo (que es
// staff: agentes/abogados/admin) porque un cliente no es parte del equipo,
// pero admin necesita poder volver a contactarlo (ej. recordatorio anual de
// predial) incluso después de que su operación ya cerró.
function buildClientsSection(){
  const wrap = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'section-title'; title.textContent = t('navClients');
  wrap.appendChild(title);
  const card = document.createElement('div'); card.className = 'card';

  if(clientsCache === undefined){
    card.innerHTML = `<div class="field-hint" style="margin:0;">${t('loading')}</div>`;
    loadClients();
    wrap.appendChild(card);
    return wrap;
  }
  if(clientsCache.error){
    card.innerHTML = `<div class="field-hint" style="margin:0;">${escapeHtml(clientsCache.error)}</div>`;
    wrap.appendChild(card);
    return wrap;
  }

  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex; gap:8px; margin-bottom:10px; flex-wrap:wrap; align-items:center;';
  controls.innerHTML = `
    <input type="text" id="clients-search" placeholder="${t('searchByName')}" value="${escapeHtml(clientsSearch)}" style="flex:1; min-width:180px; font-size:13px; padding:7px 10px;">
    <select id="clients-role-filter" style="font-size:13px; padding:7px 10px;">
      <option value="all" ${clientsRoleFilter==='all'?'selected':''}>${t('allRoles')}</option>
      <option value="buyer" ${clientsRoleFilter==='buyer'?'selected':''}>${t('buyerLabel2')}</option>
      <option value="seller" ${clientsRoleFilter==='seller'?'selected':''}>${t('sellerLabel2')}</option>
    </select>
    <button class="btn" id="clients-download"><i class="ti ti-download" aria-hidden="true"></i> ${t('downloadCsv')}</button>
  `;
  wrap.appendChild(controls);
  controls.querySelector('#clients-search').oninput = (e) => {
    clientsSearch = e.target.value;
    const cursor = e.target.selectionStart;
    render();
    // render() reconstruye todo el DOM (incluido este input) — sin esto, el
    // foco y la posición del cursor se pierden en cada tecla mientras buscas.
    const el = document.getElementById('clients-search');
    if(el){ el.focus(); el.setSelectionRange(cursor, cursor); }
  };
  controls.querySelector('#clients-role-filter').onchange = (e) => { clientsRoleFilter = e.target.value; render(); };

  const search = clientsSearch.trim().toLowerCase();
  const filtered = clientsCache.filter(c =>
    (clientsRoleFilter === 'all' || c.role === clientsRoleFilter) &&
    (!search || c.name.toLowerCase().includes(search))
  );
  controls.querySelector('#clients-download').onclick = () => downloadClientsCsv(filtered);

  if(!clientsCache.length){
    card.innerHTML = `<div class="field-hint" style="margin:0;">${t('noClientsYet')}</div>`;
    wrap.appendChild(card);
    return wrap;
  }
  if(!filtered.length){
    card.innerHTML = `<div class="field-hint" style="margin:0;">${t('noClientsMatch')}</div>`;
    wrap.appendChild(card);
    return wrap;
  }

  card.style.overflowX = 'auto';
  const table = document.createElement('table');
  table.className = 'data-table';
  table.innerHTML = `<thead><tr>
    <th>${t('nameLabel')}</th><th>${t('emailLabel')}</th><th>${t('phonePh')}</th><th>${t('roleLabel')}</th><th>${t('dealSingular')}</th><th></th>
  </tr></thead>`;
  const tbody = document.createElement('tbody');
  filtered.forEach(c => {
    const tr = document.createElement('tr');
    const dealsLabel = c.deals.map(d => escapeHtml(d.property)).join(', ') || t('noDealsYet');
    const roleLabel = c.role === 'buyer' ? t('buyerLabel2') : t('sellerLabel2');
    tr.innerHTML = `
      <td></td>
      <td></td>
      <td></td>
      <td><span class="role-badge ${c.role}">${roleLabel}</span></td>
      <td>${dealsLabel}</td>
      <td></td>
    `;
    const nameCell = tr.children[0];
    const nameInput = document.createElement('input');
    nameInput.type = 'text'; nameInput.value = c.name; nameInput.placeholder = t('namePh');
    nameInput.style.cssText = 'font-size:12px; padding:4px 8px; width:140px;';
    nameCell.appendChild(nameInput);
    const emailCell = tr.children[1];
    const emailInput = document.createElement('input');
    emailInput.type = 'email'; emailInput.value = c.email; emailInput.placeholder = t('emailPh');
    emailInput.style.cssText = 'font-size:12px; padding:4px 8px; width:180px;';
    emailCell.appendChild(emailInput);
    const actionsCell = tr.children[5];
    const profileErr = document.createElement('div');
    profileErr.className = 'gate-error'; profileErr.style.cssText = 'margin:0 0 4px; font-size:11px;';
    const profileSaveBtn = document.createElement('button');
    profileSaveBtn.className = 'btn'; profileSaveBtn.style.cssText = 'font-size:11px; margin-right:6px;'; profileSaveBtn.textContent = t('save');
    profileSaveBtn.onclick = async () => {
      profileErr.textContent = '';
      const name = nameInput.value.trim();
      const email = emailInput.value.trim();
      if(!name || !email){ profileErr.textContent = t('errNameOrEmail'); return; }
      profileSaveBtn.disabled = true;
      try{
        await apiFetch(`/api/users/${c.id}/profile`, { method:'PATCH', body: JSON.stringify({ name, email }) });
        c.name = name; c.email = email;
        profileSaveBtn.textContent = t('saved');
        setTimeout(() => { profileSaveBtn.textContent = t('save'); }, 1200);
      }catch(e){ profileErr.textContent = e.message; }
      profileSaveBtn.disabled = false;
    };
    actionsCell.appendChild(profileErr);
    actionsCell.appendChild(profileSaveBtn);
    const reset2faBtn = document.createElement('button');
    reset2faBtn.className = 'btn'; reset2faBtn.style.fontSize = '11px'; reset2faBtn.textContent = t('reset2fa');
    reset2faBtn.title = t('reset2faTitle');
    reset2faBtn.onclick = async () => {
      if(!await confirmDialog(t('reset2faConfirm', { name: c.name }))) return;
      reset2faBtn.disabled = true;
      try{
        await apiFetch(`/api/users/${c.id}/reset-2fa`, { method:'POST' });
        showToast(t('reset2faDone'), 'success');
      }catch(e){ showToast(e.message, 'error'); }
      reset2faBtn.disabled = false;
    };
    actionsCell.appendChild(reset2faBtn);
    const phoneCell = tr.children[2];
    const phoneInput = document.createElement('input');
    phoneInput.type = 'text'; phoneInput.value = c.phone || ''; phoneInput.placeholder = t('phonePh');
    phoneInput.style.cssText = 'font-size:12px; padding:4px 8px; width:120px;';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn'; saveBtn.style.cssText = 'font-size:11px; margin-left:6px;'; saveBtn.textContent = t('save');
    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      try{
        await apiFetch(`/api/users/${c.id}/phone`, { method:'PATCH', body: JSON.stringify({ phone: phoneInput.value.trim() }) });
        c.phone = phoneInput.value.trim() || null;
        saveBtn.textContent = t('saved');
        setTimeout(() => { saveBtn.textContent = t('save'); }, 1200);
      }catch(e){ showToast(e.message, 'error'); }
      saveBtn.disabled = false;
    };
    phoneCell.appendChild(phoneInput);
    phoneCell.appendChild(saveBtn);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  card.innerHTML = '';
  card.appendChild(table);
  wrap.appendChild(card);
  return wrap;
}

async function loadClients(){
  try{
    clientsCache = await apiFetch('/api/users/clients');
  }catch(e){
    clientsCache = { error: e.message };
  }
  render();
}

// Papelera — operaciones borradas (DELETE /api/deals/:id ya no las borra de
// una vez, ver routes/deals.js) que un admin puede restaurar o eliminar
// para siempre. Se agregó después de que un abogado interno borró una
// operación real sin querer y no había forma de recuperarla.
function buildTrashSection(){
  const wrap = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'section-title'; title.textContent = t('trashTitle');
  wrap.appendChild(title);
  const card = document.createElement('div'); card.className = 'card';

  if(trashedDeals === null){
    card.innerHTML = `<div class="field-hint" style="margin:0;">${t('loading')}</div>`;
    loadTrash();
    wrap.appendChild(card);
    return wrap;
  }
  if(!trashedDeals.length){
    card.innerHTML = `<div class="field-hint" style="margin:0;">${t('trashEmpty')}</div>`;
    wrap.appendChild(card);
    return wrap;
  }

  card.innerHTML = '';
  trashedDeals.forEach(d => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; padding:10px 0; border-bottom:0.5px solid var(--line);';
    const deletedAt = d.deleted_at ? new Date(d.deleted_at.replace(' ', 'T') + 'Z').toLocaleString(lang === 'en' ? 'en-US' : 'es-MX') : '';
    row.innerHTML = `
      <div>
        <div style="font-weight:600; font-size:13.5px;">${escapeHtml(d.property)}</div>
        <div class="field-hint" style="margin:2px 0 0;">${t('trashDeletedBy')} ${escapeHtml(d.deleted_by_name || '—')} ${t('trashDeletedAt')} ${escapeHtml(deletedAt)}</div>
      </div>
      <div style="display:flex; gap:8px;">
        <button class="btn success" id="restore-${d.id}"><i class="ti ti-rotate" aria-hidden="true"></i> ${t('restoreDeal')}</button>
        <button class="btn danger" id="purge-${d.id}"><i class="ti ti-trash" aria-hidden="true"></i> ${t('deletePermanently')}</button>
      </div>
    `;
    card.appendChild(row);
    row.querySelector(`#restore-${d.id}`).onclick = async () => {
      try{
        await apiFetch(`/api/deals/${d.id}/restore`, { method: 'POST' });
        trashedDeals = trashedDeals.filter(x => x.id !== d.id);
        deals = [];
        render();
        loadData();
      }catch(e){ showToast(e.message, 'error'); }
    };
    row.querySelector(`#purge-${d.id}`).onclick = async () => {
      if(!await confirmDialog(t('confirmDeletePermanently'), { danger: true })) return;
      try{
        await apiFetch(`/api/deals/${d.id}/permanent`, { method: 'DELETE' });
        trashedDeals = trashedDeals.filter(x => x.id !== d.id);
        render();
      }catch(e){ showToast(e.message, 'error'); }
    };
  });
  wrap.appendChild(card);
  return wrap;
}

function downloadClientsCsv(clients){
  const header = ['Nombre', 'Correo', 'Teléfono', 'Rol', 'Operaciones'];
  const csvEscape = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const rows = clients.map(c => [c.name, c.email, c.phone || '', c.role === 'buyer' ? t('buyerLabel2') : t('sellerLabel2'), c.deals.map(d => d.property).join('; ')]);
  const csv = [header, ...rows].map(r => r.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `clientes-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// Nota de referencia (texto libre) de a qué cuenta se transfieren los
// costos de cierre del notario — es siempre la misma cuenta sin importar la
// operación, así que se configura una sola vez aquí en vez de repetirla en
// cada deal (routes/settings.js, se muestra de solo lectura junto al
// documento "Costos de cierre" en cada operación).
function buildNotaryPaymentNoteSection(){
  const card = document.createElement('div'); card.className = 'card';
  if(notaryPaymentNote === undefined){
    card.innerHTML = `<div class="field-hint" style="margin:0;">${t('loading')}</div>`;
    loadNotaryPaymentNote();
    return card;
  }
  card.innerHTML = `
    <div class="field-hint" style="margin:0 0 8px;">${t('notaryPaymentNoteHint')}</div>
    <textarea id="notary-note-input" rows="3" style="width:100%; margin-bottom:8px;">${escapeHtml(notaryPaymentNote)}</textarea>
    <button class="btn primary" id="notary-note-save">${t('save')}</button>
    <span class="field-hint" id="notary-note-saved" style="margin-left:8px; display:none; color:var(--jade);">${t('saved')}</span>
  `;
  card.querySelector('#notary-note-save').onclick = async () => {
    const note = card.querySelector('#notary-note-input').value;
    try{
      await apiFetch('/api/settings/notary-payment-note', { method:'PUT', body: JSON.stringify({ note }) });
      notaryPaymentNote = note;
      const savedEl = card.querySelector('#notary-note-saved');
      savedEl.style.display = '';
      setTimeout(() => { savedEl.style.display = 'none'; }, 2000);
    }catch(e){ showToast(e.message, 'error'); }
  };
  return card;
}

function buildIntegrationsSection(){
  const card = document.createElement('div'); card.className = 'card';
  if(driveStatus === null){
    card.innerHTML = `<div class="field-hint" style="margin:0;">${t('loading')}</div>`;
    loadDriveStatus();
    return card;
  }
  if(driveStatus.error){
    card.innerHTML = `<div class="field-hint" style="margin:0;">${escapeHtml(driveStatus.error)}</div>`;
    return card;
  }
  const row = document.createElement('div');
  row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:10px;';
  const label = document.createElement('div');
  label.innerHTML = `<div style="font-weight:500; font-size:13px;">Google Drive</div><div class="field-hint" style="margin:2px 0 0;">${t('driveHint', { year: new Date().getFullYear() })}</div>`;
  row.appendChild(label);
  if(!driveStatus.configured){
    const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = t('driveNotConfigured');
    row.appendChild(badge);
  } else if(driveStatus.connected){
    const actions = document.createElement('div'); actions.style.cssText = 'display:flex; align-items:center; gap:8px;';
    actions.innerHTML = `<span class="badge" style="background:var(--jade-soft); color:var(--jade);">${t('driveConnected')}</span>`;
    const disconnectBtn = document.createElement('button');
    disconnectBtn.className = 'btn'; disconnectBtn.style.fontSize = '11px'; disconnectBtn.textContent = t('disconnect');
    disconnectBtn.onclick = async () => {
      try{ await apiFetch('/api/google-drive/disconnect', { method:'POST' }); driveStatus = null; render(); }catch(e){ showToast(e.message, 'error'); }
    };
    actions.appendChild(disconnectBtn);
    row.appendChild(actions);
  } else {
    const connectBtn = document.createElement('a');
    connectBtn.className = 'btn primary'; connectBtn.href = '/api/google-drive/connect'; connectBtn.textContent = t('connectDrive');
    row.appendChild(connectBtn);
  }
  card.appendChild(row);
  return card;
}

async function loadDriveStatus(){
  try{ driveStatus = await apiFetch('/api/google-drive/status'); }
  catch(e){ driveStatus = { error: e.message }; }
  render();
}
