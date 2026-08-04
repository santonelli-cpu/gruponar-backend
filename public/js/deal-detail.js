// Detalle de la operación: partes, KYC y documentos
// Parte de la interfaz de Grupo NAR — ver public/index.html para el orden
// en que se cargan estos archivos (todos comparten el mismo ámbito global).

const MAX_PARTIES_PER_SIDE = 4;

// Widget reutilizable de una parte (vendedor o comprador): nombre, tipo, y
// si es entidad (corporation/llc) su estructura de propiedad — hasta 2
// niveles (socios directos / entidad padre con o sin trust arriba / trust
// directo). Se usa tanto al crear una operación (buildNewDealForm) como al
// agregar/editar una parte de una ya existente (buildPartiesSection).
function buildPartyFieldsBlock(allowedTypes, existing, dealId){
  const box = document.createElement('div');
  box.style.cssText = 'border:0.5px solid var(--line); border-radius:10px; padding:12px; margin-bottom:10px; background:var(--stone-card);';
  const typeOptions = allowedTypes.map(ty => `<option value="${ty}">${TYPE_LABEL[ty]}</option>`).join('');
  const linkedUser = existing && existing.linkedUser;
  box.innerHTML = `
    <div class="form-row">
      <label>${t('name')} <input type="text" class="pf-name" placeholder="${t('partyNamePh')}"></label>
      <label>${t('type')} <select class="pf-type">${typeOptions}</select></label>
      <label>${t('partyEmailLabel')} <input type="email" class="pf-email" placeholder="${t('partyEmailPh')}" ${linkedUser ? 'disabled' : ''}></label>
    </div>
    <div class="field-hint" style="margin-top:-6px;">${linkedUser ? t('partyEmailLinkedHint', { email: linkedUser.email }) : t('partyEmailHint')}</div>
    ${existing ? `
      <div class="pf-attorney-wrap" style="margin-top:10px; padding-top:10px; border-top:0.5px dashed var(--line);">
        ${existing.linkedAttorney ? `
          <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
            <div class="field-hint" style="margin:0;">${t('attorneyLinkedHint', { name: existing.linkedAttorney.name, email: existing.linkedAttorney.email })}</div>
            <button type="button" class="btn pf-attorney-remove" style="font-size:11px;">${t('attorneyRemove')}</button>
          </div>
        ` : `
          <label style="display:flex; align-items:center; gap:6px; font-size:12.5px;">
            <input type="checkbox" class="pf-has-attorney"> ${t('hasAttorneyToggle')}
          </label>
          <div class="field-hint" style="margin:2px 0 0;">${t('attorneyHint')}</div>
          <div class="pf-attorney-fields form-row" style="display:none; margin-top:6px;">
            <label>${t('attorneyNameLabel')} <input type="text" class="pf-attorney-name" placeholder="${t('attorneyNamePh')}"></label>
            <label>${t('attorneyEmailLabel')} <input type="email" class="pf-attorney-email" placeholder="${t('partyEmailPh')}"></label>
          </div>
        `}
      </div>
    ` : ''}
    <div class="pf-ownership" style="display:none;">
      <label>${t('ownershipStructure')} <select class="pf-mode">
        <option value="direct_owners">${t('modeDirectOwners')}</option>
        <option value="parent_entity">${t('modeParentEntity')}</option>
        <option value="direct_trust">${t('modeDirectTrust')}</option>
      </select></label>
      <div class="pf-mode-owners">
        <div class="field-hint" style="margin:6px 0 4px;">${t('directOwners')}</div>
        <input type="text" class="pf-owner1" placeholder="${t('owner1Ph')}">
        <input type="text" class="pf-owner2" placeholder="${t('owner2Ph')}" style="margin-top:6px;">
      </div>
      <div class="pf-mode-parent" style="display:none;">
        <div class="form-row" style="margin-top:6px;">
          <label>${t('parentEntityName')} <input type="text" class="pf-parent-name"></label>
          <label>${t('type')} <select class="pf-parent-type">
            <option value="corporation">${t('corpMx')}</option>
            <option value="llc">${t('llcForeign')}</option>
          </select></label>
        </div>
        <label style="display:flex; align-items:center; gap:6px; font-size:12.5px; margin-top:6px;">
          <input type="checkbox" class="pf-parent-trust"> ${t('parentHasTrust')}
        </label>
        <input type="text" class="pf-parent-trust-name" placeholder="${t('trustNamePh')}" style="display:none; margin-top:6px;">
      </div>
      <div class="pf-mode-trust" style="display:none; margin-top:6px;">
        <input type="text" class="pf-trust-name" placeholder="${t('directTrustNamePh')}">
      </div>
    </div>
  `;
  const typeSel = box.querySelector('.pf-type');
  const ownershipBlock = box.querySelector('.pf-ownership');
  const modeSel = box.querySelector('.pf-mode');
  const ownersBlock = box.querySelector('.pf-mode-owners');
  const parentBlock = box.querySelector('.pf-mode-parent');
  const trustBlock = box.querySelector('.pf-mode-trust');
  const parentTrustCheck = box.querySelector('.pf-parent-trust');
  const parentTrustName = box.querySelector('.pf-parent-trust-name');

  function updateVisibility(){
    ownershipBlock.style.display = typeSel.value === 'individual' ? 'none' : 'block';
    ownersBlock.style.display = modeSel.value === 'direct_owners' ? 'block' : 'none';
    parentBlock.style.display = modeSel.value === 'parent_entity' ? 'block' : 'none';
    trustBlock.style.display = modeSel.value === 'direct_trust' ? 'block' : 'none';
    parentTrustName.style.display = parentTrustCheck.checked ? 'block' : 'none';
  }
  typeSel.onchange = updateVisibility;
  modeSel.onchange = updateVisibility;
  parentTrustCheck.onchange = updateVisibility;

  const hasAttorneyCheck = box.querySelector('.pf-has-attorney');
  const attorneyFields = box.querySelector('.pf-attorney-fields');
  if(hasAttorneyCheck){
    hasAttorneyCheck.onchange = () => { attorneyFields.style.display = hasAttorneyCheck.checked ? 'flex' : 'none'; };
  }
  const attorneyRemoveBtn = box.querySelector('.pf-attorney-remove');
  if(attorneyRemoveBtn){
    attorneyRemoveBtn.onclick = async () => {
      if(!await confirmDialog(t('confirmRemoveAttorney'), { danger: true })) return;
      attorneyRemoveBtn.disabled = true;
      try{
        await apiFetch(`/api/deals/${dealId}/parties/${existing.id}`, { method:'PATCH', body: JSON.stringify({ removeAttorney: true }) });
        await openDeal(dealId);
      }catch(e){ showToast(e.message, 'error'); attorneyRemoveBtn.disabled = false; }
    };
  }

  if(existing){
    box.querySelector('.pf-name').value = existing.name || '';
    if(linkedUser) box.querySelector('.pf-email').value = linkedUser.email;
    if(allowedTypes.includes(existing.partyType)) typeSel.value = existing.partyType;
    if(existing.ownershipMode) modeSel.value = existing.ownershipMode;
    if(existing.owners && existing.owners[0]) box.querySelector('.pf-owner1').value = existing.owners[0].name;
    if(existing.owners && existing.owners[1]) box.querySelector('.pf-owner2').value = existing.owners[1].name;
    if(existing.parentEntityName) box.querySelector('.pf-parent-name').value = existing.parentEntityName;
    if(existing.parentEntityType) box.querySelector('.pf-parent-type').value = existing.parentEntityType;
    if(existing.parentHasTrustAbove) parentTrustCheck.checked = true;
    if(existing.parentTrustName) parentTrustName.value = existing.parentTrustName;
    if(existing.directTrustName) box.querySelector('.pf-trust-name').value = existing.directTrustName;
  }
  updateVisibility();

  box.collectParty = function(side){
    const partyType = typeSel.value;
    const name = box.querySelector('.pf-name').value.trim();
    const emailInput = box.querySelector('.pf-email');
    const email = emailInput.disabled ? '' : emailInput.value.trim();
    const p = { side, partyType, name };
    if(email) p.email = email;
    if(hasAttorneyCheck && hasAttorneyCheck.checked){
      const attorneyName = box.querySelector('.pf-attorney-name').value.trim();
      const attorneyEmail = box.querySelector('.pf-attorney-email').value.trim();
      if(attorneyName && attorneyEmail){ p.attorneyName = attorneyName; p.attorneyEmail = attorneyEmail; }
    }
    if(partyType !== 'individual'){
      p.ownershipMode = modeSel.value;
      if(modeSel.value === 'direct_owners'){
        const o1 = box.querySelector('.pf-owner1').value.trim();
        const o2 = box.querySelector('.pf-owner2').value.trim();
        p.owners = [o1, o2].filter(Boolean).map(name => ({ name }));
      } else if(modeSel.value === 'parent_entity'){
        p.parentEntityName = box.querySelector('.pf-parent-name').value.trim();
        p.parentEntityType = box.querySelector('.pf-parent-type').value;
        p.parentHasTrustAbove = parentTrustCheck.checked;
        if(parentTrustCheck.checked) p.parentTrustName = parentTrustName.value.trim();
      } else if(modeSel.value === 'direct_trust'){
        p.directTrustName = box.querySelector('.pf-trust-name').value.trim();
      }
    }
    return p;
  };

  return box;
}

function buildNewDealForm(){
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="section-title">${t('newDealTitle')}</div>`;
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="form-row">
      <label>${t('scenarioType')}
        <select id="nd-scenario">
          <option value="purchase">${SCENARIOS.purchase.label}</option>
          <option value="trust">${SCENARIOS.trust.label}</option>
          <option value="transfer">${SCENARIOS.transfer.label}</option>
          <option value="trust_termination">${SCENARIOS.trust_termination.label}</option>
        </select>
      </label>
    </div>
    <div class="form-row">
      <label>${t('development')} <select id="nd-development">${developmentOptionsHtml('punta_mita')}</select></label>
      <label>${t('property')} <input type="text" id="nd-property" placeholder="${t('propertyPh')}"></label>
    </div>
    <div class="form-row">
      <label>${t('propertyPrice')} <input type="text" id="nd-price" placeholder="3100000"></label>
      <label>${t('furniturePrice')} <input type="text" id="nd-furniture" placeholder="0"></label>
      <label>${t('currency')} <select id="nd-currency"><option>USD</option><option>MXN</option></select></label>
    </div>
    <div class="grid2">
      <div>
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div class="field-hint" style="margin:0;">${t('sellers')}</div>
          <button class="btn" id="nd-add-seller" style="font-size:11px;" type="button">${t('addSeller')}</button>
        </div>
        <div id="nd-sellers"></div>
      </div>
      <div>
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div class="field-hint" style="margin:0;">${t('buyers')}</div>
          <button class="btn" id="nd-add-buyer" style="font-size:11px;" type="button">${t('addBuyer')}</button>
        </div>
        <div id="nd-buyers"></div>
      </div>
    </div>
    <div class="form-row">
      <label>${t('offerSignedDate')} <input type="date" id="nd-start"></label>
      <label>${t('escrowCompany')} <select id="nd-escrow-company">
        <option value="armour">Armour Secure</option>
        <option value="tla">TLA Financial Services</option>
        <option value="none">${t('escrowNone')}</option>
      </select></label>
    </div>
    <div class="gate-error" id="nd-error"></div>
    <div class="form-actions" style="display:flex; gap:8px; justify-content:flex-end;">
      <button class="btn" id="nd-cancel">${t('cancel')}</button>
      <button class="btn primary" id="nd-create">${t('createDeal')}</button>
    </div>
  `;
  wrap.appendChild(card);

  const sellersWrap = card.querySelector('#nd-sellers');
  const buyersWrap = card.querySelector('#nd-buyers');

  function addPartyBlock(container, side){
    if(container.children.length >= MAX_PARTIES_PER_SIDE) return;
    const scen = card.querySelector('#nd-scenario').value;
    const allowed = side === 'seller' ? SCENARIOS[scen].sellerTypes : SCENARIOS[scen].buyerTypes;
    const block = buildPartyFieldsBlock(allowed);
    if(container.children.length > 0){
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn'; removeBtn.style.cssText = 'font-size:11px; margin-top:-6px; margin-bottom:8px;'; removeBtn.type = 'button';
      removeBtn.textContent = t('remove');
      removeBtn.onclick = () => block.remove();
      block.appendChild(removeBtn);
    }
    container.appendChild(block);
  }
  card.querySelector('#nd-add-seller').onclick = () => addPartyBlock(sellersWrap, 'seller');
  card.querySelector('#nd-add-buyer').onclick = () => addPartyBlock(buyersWrap, 'buyer');
  addPartyBlock(sellersWrap, 'seller');
  addPartyBlock(buyersWrap, 'buyer');

  card.querySelector('#nd-scenario').onchange = () => {
    sellersWrap.innerHTML = ''; buyersWrap.innerHTML = '';
    addPartyBlock(sellersWrap, 'seller');
    addPartyBlock(buyersWrap, 'buyer');
  };

  wrap.querySelector('#nd-cancel').onclick = () => { adminView='list'; render(); };
  wrap.querySelector('#nd-create').onclick = async () => {
    const errEl = card.querySelector('#nd-error');
    errEl.textContent = '';
    const scenario = card.querySelector('#nd-scenario').value;
    const property = card.querySelector('#nd-property').value.trim();
    if(!property){ errEl.textContent = t('errMissingPropertyName'); return; }
    const sellers = Array.from(sellersWrap.children).map(b => b.collectParty('seller'));
    const buyers = Array.from(buyersWrap.children).map(b => b.collectParty('buyer'));
    if(sellers.some(p=>!p.name) || buyers.some(p=>!p.name)){ errEl.textContent = t('errMissingPartyName'); return; }
    const development = card.querySelector('#nd-development').value;
    const body = {
      scenario, development, property,
      price: Number(card.querySelector('#nd-price').value) || 0,
      furniturePrice: Number(card.querySelector('#nd-furniture').value) || 0,
      currency: card.querySelector('#nd-currency').value,
      parties: [...sellers, ...buyers],
      startDate: card.querySelector('#nd-start').value || new Date().toISOString().slice(0,10),
      escrowCompany: card.querySelector('#nd-escrow-company').value
    };
    try{
      const { id, partyResults } = await apiFetch('/api/deals', { method:'POST', body: JSON.stringify(body) });
      if(partyResults && partyResults.length){
        const lines = partyResults.map(r => {
          if(r.linkedExisting) return t('partyLinkedExistingLine', { name: r.partyName, email: r.email });
          if(!r.temporaryPassword) return t('partyRegisterFailedLine', { name: r.partyName, error: r.error });
          let line = t('partyRegisteredLine', { name: r.partyName, email: r.email, password: r.temporaryPassword });
          line += r.welcomeEmailSent ? t('welcomeEmailSentNote') : t('welcomeEmailFailedNote', { error: r.welcomeEmailError || '' });
          return line;
        });
        alert(lines.join('\n\n'));
      }
      adminView = 'list';
      activeDealId = id;
      await loadData();
      await openDeal(id);
    }catch(e){ errEl.textContent = e.message; }
  };
  return wrap;
}

// Resumen corto de la estructura de propiedad de una entidad, para mostrar
// junto a su nombre sin tener que abrir el editor.
function partyOwnershipSummary(p){
  if(p.partyType === 'individual') return '';
  if(p.ownershipMode === 'direct_owners') return `${t('partners')}: ${p.owners.map(o=>o.name).join(', ') || t('noName')}`;
  if(p.ownershipMode === 'parent_entity'){
    let s = `${t('parentEntity')}: ${p.parentEntityName} (${TYPE_LABEL[p.parentEntityType]||p.parentEntityType})`;
    if(p.parentHasTrustAbove) s += ` · ${t('trustAbove')}: ${p.parentTrustName}`;
    return s;
  }
  if(p.ownershipMode === 'direct_trust') return `${t('directTrust')}: ${p.directTrustName}`;
  return t('incompleteOwnership');
}

function buildPartiesSection(deal){
  const wrap = document.createElement('div');
  const addFormFor = { seller: null, buyer: null }; // toggles, no estado global
  // Los correos de las partes solo los ve quien coordina la operación: si un
  // agente o la contraparte pueden leerlos, la conversación se sale de la
  // plataforma y se pierde el rastro de qué se entregó y cuándo.
  const verContactos = ['admin','lawyer'].includes(currentUser.role);
  // Dar de alta, editar o quitar partes también es de admin/abogado interno
  // (el backend ya lo exige; esto evita ofrecer botones que rebotan).
  const puedeEditarPartes = verContactos;

  // Clientes de operaciones anteriores — se cargan al abrir "Agregar" y se
  // enganchan con un clic, trayendo (si se quiere) los documentos que ya
  // habían entregado, para solo actualizar los que caducaron.
  function buildPastClientPicker(deal, side){
    const box = document.createElement('div');
    box.style.cssText = 'margin-top:10px; padding:12px 14px; background:var(--stone); border-radius:10px;';
    box.innerHTML = `<div class="field-hint" style="margin:0;">${t('pastClientsLoading')}</div>`;

    apiFetch(`/api/deals/${deal.id}/past-clients?side=${side}`).then(({ clients }) => {
      if(!clients.length){
        box.innerHTML = `<div class="field-hint" style="margin:0;">${t('pastClientsEmpty')}</div>`;
        return;
      }
      box.innerHTML = `
        <div style="font-weight:600; font-size:12.5px; margin-bottom:4px;">${t('pastClientsTitle')}</div>
        <div class="field-hint" style="margin:0 0 8px;">${t('pastClientsHint')}</div>
        <input type="text" id="past-client-q-${side}" placeholder="${t('pastClientsSearchPh')}" style="width:100%; font-size:12.5px; margin-bottom:8px;">
        <div id="past-client-list-${side}"></div>
      `;
      const list = box.querySelector(`#past-client-list-${side}`);
      const draw = (filter) => {
        list.innerHTML = '';
        const q = (filter || '').trim().toLowerCase();
        const shown = clients.filter(c => !q || c.partyName.toLowerCase().includes(q) || c.email.toLowerCase().includes(q));
        if(!shown.length){
          list.innerHTML = `<div class="field-hint" style="margin:0;">${t('pastClientsNoMatch')}</div>`;
          return;
        }
        shown.slice(0, 8).forEach(c => {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:10px; padding:7px 0; border-bottom:0.5px solid var(--line); flex-wrap:wrap;';
          row.innerHTML = `
            <span style="min-width:0;">
              <div style="font-size:13px; font-weight:500;">${escapeHtml(c.partyName)} <span class="field-hint" style="margin:0; display:inline;">${escapeHtml(c.email)}</span></div>
              <div class="field-hint" style="margin:1px 0 0;">${t('pastClientFrom', { property: escapeHtml(c.lastDealProperty) })}${c.reusableDocs ? ` · ${t('pastClientDocs', { count: c.reusableDocs })}` : ''}</div>
            </span>
            <span style="display:flex; gap:8px; align-items:center; flex-shrink:0;">
              ${c.reusableDocs ? `<label class="field-hint" style="margin:0; display:inline-flex; gap:5px; align-items:center;"><input type="checkbox" class="copy-docs" checked> ${t('pastClientCopyDocs')}</label>` : ''}
              <button class="btn primary" style="font-size:11px;">${t('pastClientAdd')}</button>
            </span>
          `;
          const btn = row.querySelector('button');
          btn.onclick = () => withButtonLoading(btn, async () => {
            const copyBox = row.querySelector('.copy-docs');
            try{
              const r = await apiFetch(`/api/deals/${deal.id}/parties/from-client`, {
                method: 'POST',
                body: JSON.stringify({ side, userId: c.userId, copyDocuments: !!(copyBox && copyBox.checked) })
              });
              showToast(r.documentsCopied
                ? t('pastClientAddedWithDocs', { name: c.partyName, count: r.documentsCopied })
                : t('pastClientAdded', { name: c.partyName }), 'success');
              if(r.copyError) showToast(r.copyError, 'error');
              await openDeal(deal.id);
            }catch(e){ showToast(e.message, 'error'); }
          });
          list.appendChild(row);
        });
      };
      draw('');
      const search = box.querySelector(`#past-client-q-${side}`);
      search.oninput = (e) => draw(e.target.value);
    }).catch(() => { box.remove(); });

    return box;
  }

  function renderSide(side, label){
    const card = document.createElement('div'); card.className = 'card';
    const header = document.createElement('div');
    header.className = 'party-card-head';
    const parties = deal.parties.filter(p => p.side === side);
    header.innerHTML = `<span class="party-name">${label} (${parties.length})</span>`;
    const addBtn = document.createElement('button');
    addBtn.className = 'btn'; addBtn.style.fontSize = '12px'; addBtn.innerHTML = `<i class="ti ti-plus" aria-hidden="true"></i> ${t('add')}`;
    addBtn.disabled = parties.length >= MAX_PARTIES_PER_SIDE;
    if(puedeEditarPartes) header.appendChild(addBtn);
    card.appendChild(header);

    parties.forEach(p => {
      const row = document.createElement('div');
      row.className = 'party-card-row';
      row.innerHTML = `
        <div>
          <p class="party-name">${escapeHtml(p.name)} <span>(${TYPE_LABEL[p.partyType]})</span>${p.linkedUser ? ` <span class="badge" style="background:var(--jade-soft); color:var(--jade); margin:0 0 0 4px;">${t('accountLinked')}${verContactos ? ': ' + escapeHtml(p.linkedUser.email) : ''}</span>` : ''}${p.linkedAttorney ? ` <span class="badge" style="background:var(--gold-soft); color:#6B4E1E; margin:0 0 0 4px;">${t('attorneyBadge')}: ${escapeHtml(p.linkedAttorney.name)}${verContactos ? ' (' + escapeHtml(p.linkedAttorney.email) + ')' : ''}</span>` : ''}</p>
          ${p.partyType !== 'individual' ? `<p class="party-meta">${escapeHtml(partyOwnershipSummary(p))}</p>` : ''}
        </div>
        ${puedeEditarPartes ? `<span style="display:flex; gap:6px; flex-shrink:0;">
          <button class="btn pty-edit" style="font-size:11px;">${t('edit')}</button>
          ${parties.length > 1 ? `<button class="btn danger pty-remove" style="font-size:11px;">${t('remove')}</button>` : ''}
        </span>` : ''}
      `;
      const editSlot = document.createElement('div');
      editSlot.style.flexBasis = '100%';
      row.appendChild(editSlot);

      if(puedeEditarPartes){
      row.querySelector('.pty-edit').onclick = () => {
        if(editSlot.childElementCount){ editSlot.innerHTML = ''; return; }
        const scen = deal.scenario;
        const allowed = side === 'seller' ? SCENARIOS[scen].sellerTypes : SCENARIOS[scen].buyerTypes;
        const block = buildPartyFieldsBlock(allowed, p, deal.id);
        block.style.marginTop = '8px';
        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn primary'; saveBtn.style.fontSize = '11px'; saveBtn.textContent = t('save');
        const errEl = document.createElement('div');
        errEl.className = 'gate-error';
        saveBtn.onclick = async () => {
          errEl.textContent = '';
          try{
            const result = await apiFetch(`/api/deals/${deal.id}/parties/${p.id}`, { method:'PATCH', body: JSON.stringify(block.collectParty(side)) });
            if(result.temporaryPassword){
              let msg = t('partyRegisteredAlert', { password: result.temporaryPassword });
              msg += result.welcomeEmailSent ? t('welcomeEmailSentNote') : t('welcomeEmailFailedNote', { error: result.welcomeEmailError || '' });
              alert(msg);
            } else if(result.emailError){
              showToast(t('partyRegisterFailedAlert', { error: result.emailError }), 'error');
            }
            if(result.attorneyTemporaryPassword){
              let msg = t('attorneyRegisteredAlert', { password: result.attorneyTemporaryPassword });
              msg += result.attorneyWelcomeEmailSent ? t('welcomeEmailSentNote') : t('welcomeEmailFailedNote', { error: result.attorneyWelcomeEmailError || '' });
              alert(msg);
            } else if(result.attorneyError){
              showToast(t('partyRegisterFailedAlert', { error: result.attorneyError }), 'error');
            }
            await openDeal(deal.id);
          }catch(e){ errEl.textContent = e.message; }
        };
        block.appendChild(saveBtn);
        block.appendChild(errEl);
        editSlot.appendChild(block);
      };
      }
      const removeBtn = puedeEditarPartes ? row.querySelector('.pty-remove') : null;
      if(removeBtn) removeBtn.onclick = async () => {
        if(!await confirmDialog(t('confirmRemoveParty', { name: p.name }), { danger: true })) return;
        try{
          await apiFetch(`/api/deals/${deal.id}/parties/${p.id}`, { method:'DELETE' });
          await openDeal(deal.id);
        }catch(e){ showToast(e.message, 'error'); }
      };
      card.appendChild(row);
    });

    const addSlot = document.createElement('div');
    card.appendChild(addSlot);
    addBtn.onclick = () => {
      if(addSlot.childElementCount){ addSlot.innerHTML = ''; return; }
      const allowed = side === 'seller' ? SCENARIOS[deal.scenario].sellerTypes : SCENARIOS[deal.scenario].buyerTypes;
      // Antes del formulario en blanco: los clientes que ya pasaron por
      // otra operación. Los mismos compradores/vendedores se repiten, y
      // volver a teclear su nombre y su correo exacto (y volver a pedirle
      // los mismos documentos) era trabajo de más para todos.
      addSlot.appendChild(buildPastClientPicker(deal, side));
      const block = buildPartyFieldsBlock(allowed);
      block.style.marginTop = '8px';
      const saveBtn = document.createElement('button');
      saveBtn.className = 'btn primary'; saveBtn.style.fontSize = '11px'; saveBtn.textContent = t('addPlain');
      const errEl = document.createElement('div');
      errEl.className = 'gate-error';
      saveBtn.onclick = async () => {
        errEl.textContent = '';
        try{
          const result = await apiFetch(`/api/deals/${deal.id}/parties`, { method:'POST', body: JSON.stringify(block.collectParty(side)) });
          if(result.temporaryPassword){
            let msg = t('partyRegisteredAlert', { password: result.temporaryPassword });
            msg += result.welcomeEmailSent ? t('welcomeEmailSentNote') : t('welcomeEmailFailedNote', { error: result.welcomeEmailError || '' });
            alert(msg);
          } else if(result.emailError){
            showToast(t('partyRegisterFailedAlert', { error: result.emailError }), 'error');
          }
          await openDeal(deal.id);
        }catch(e){ errEl.textContent = e.message; }
      };
      block.appendChild(saveBtn);
      block.appendChild(errEl);
      addSlot.appendChild(block);
    };

    return card;
  }

  wrap.appendChild(renderSide('seller', t('sellers')));
  wrap.appendChild(renderSide('buyer', t('buyers')));
  return wrap;
}

function buildAdminDealDetail(deal){
  const s = SCENARIOS[deal.scenario];
  const wrap = document.createElement('div');
  const back = document.createElement('button');
  back.className = 'crumb';
  back.innerHTML = `<i class="ti ti-chevron-left" aria-hidden="true"></i> ${t('allDeals')}`;
  back.onclick = () => { activeDealId=null; render(); };
  wrap.appendChild(back);

  // Pestañas reales — el encabezado de la operación (título, avance,
  // acciones) siempre visible, y abajo UNA sección a la vez en vez de las
  // 12 apiladas de antes. Al abrir OTRA operación se regresa a la primera
  // pestaña; dentro de la misma, la pestaña activa sobrevive a los render().
  if(dealDetailTabDeal !== deal.id){ dealDetailTabDeal = deal.id; dealDetailTab = ['admin','lawyer'].includes(currentUser.role) ? 'general' : 'parties'; }
  const pendingDocsCount = deal.documents.filter(d => d.status !== 'done').length;
  const pendingTasksCount = deal.tasks.filter(tk => tk.status !== 'done').length;
  // Editar la operación (datos, partes, agentes, fechas, cerrarla,
  // eliminarla) es de admin y abogado interno. Un agente coordina y sube
  // cosas, pero no cambia la operación misma — el backend lo bloquea igual,
  // esto es para no ofrecerle botones que le van a rebotar.
  const canEditDeal = ['admin','lawyer'].includes(currentUser.role);
  const TABS = [
    // "General" guarda lo editable y las acciones. Antes vivían pegadas al
    // encabezado, así que el selector de escrow, las dos fechas y los cuatro
    // botones se veían en TODAS las pestañas, empujando hacia abajo lo que
    // de verdad se venía a ver.
    ...(canEditDeal ? [['general', t('navSecGeneral'), 0]] : []),
    ['parties', t('navSecParties'), 0],
    ['docs', t('navSecDocs'), pendingDocsCount],
    ['kyc', t('tabKycSignatures'), 0],
    ['tracker', t('navSecTracker'), pendingTasksCount],
    // "Personas" es quién tiene acceso a la operación — se administra desde
    // admin/abogado interno, no desde un agente.
    ...(canEditDeal ? [['people', t('navSecPeople'), 0]] : []),
    ['contract', t('navSecContract'), 0],
    // La bitácora nombra partes y documentos de los dos lados — solo
    // admin/abogado interno (mismo criterio que el endpoint).
    ...(canEditDeal ? [['activity', t('navSecActivity'), 0]] : [])
  ];
  // Si la pestaña recordada ya no aplica a este rol, se cae a la primera.
  if(!TABS.some(([id]) => id === dealDetailTab)) dealDetailTab = TABS[0][0];
  sidebarSections(TABS, dealDetailTab, (id) => { dealDetailTab = id; render(); });
  const tab = dealDetailTab;
  // Los IDs siguen sirviendo como anclas DENTRO de su pestaña (ej. el link
  // "ir a la sección de KYC" del tracker cambia de pestaña y luego scrollea).
  function sectionAnchor(el, id){ el.id = id; el.style.scrollMarginTop = '46px'; return el; }

  // Encabezado: SOLO la identidad de la operación y su avance. Cada parte en
  // su propio renglón con su tipo (antes iban apretadas en una línea con una
  // flecha en medio, ilegible en celular con nombres de empresa largos), y
  // los agentes agrupados por despacho — importa de qué firma es cada quien.
  const header = document.createElement('div');
  header.className = 'card js-pills-anchor';
  const partyLineHtml = (p, withArrow) => `
    <div class="party-line">
      ${withArrow ? '<i class="ti ti-arrow-down-right" aria-hidden="true"></i>' : ''}
      <b>${escapeHtml(p.name)}</b> <span class="tag">${TYPE_LABEL[p.partyType]}</span>
    </div>`;
  const agentsByFirm = {};
  (deal.agents || []).forEach(a => {
    const firm = a.agency || t('noAgencyLabel');
    (agentsByFirm[firm] = agentsByFirm[firm] || []).push(a.name);
  });
  const docsPct = pctDocs(deal), tasksPct = pctTasks(deal);
  header.innerHTML = `
    <div class="deal-head-row">
      <div class="deal-title${canEditDeal ? ' field-editable' : ''}" id="deal-title-display"${canEditDeal ? ` title="${t('clickToEdit')}"` : ''} style="font-size:22px; margin:0;">${escapeHtml(deal.property)}</div>
      <span class="badge ${s.badgeClass}">${s.labelShort}</span>
      ${deal.status==='completed' ? `<span class="badge" style="background:var(--jade-soft); color:var(--jade);">${t('dealCompletedBadge')}</span>` : ''}
    </div>
    <div class="party-stack">
      ${sellerParties(deal).map(p => partyLineHtml(p, false)).join('')}
      ${buyerParties(deal).map((p, i) => partyLineHtml(p, i === 0)).join('')}
    </div>
    <div class="location-line"><i class="ti ti-map-pin" aria-hidden="true"></i> <span class="${canEditDeal ? 'field-editable' : ''}" id="deal-development-display"${canEditDeal ? ` title="${t('clickToEdit')}"` : ''}>${DEVELOPMENT_LABEL[deal.development||'punta_mita']}</span></div>
    ${Object.keys(agentsByFirm).length ? `
      <div class="agents-block">
        ${Object.entries(agentsByFirm).map(([firm, names]) =>
          `<div><span class="firm">${escapeHtml(firm)}</span> · ${escapeHtml(names.join(', '))}</div>`).join('')}
      </div>
    ` : ''}

    <div class="head-divider"></div>

    <div class="escrow-block">
      <div class="k">${t('escrowCompany')}</div>
      <div class="v">${escrowCompanyLabel(deal.escrowCompany)}</div>
    </div>

    <div class="stat-grid" style="margin-top:12px;">
      <div class="stat-tile"><p class="label">${t('propertyLabelColon')}</p><p class="value${canEditDeal ? ' field-editable' : ''}" id="deal-price-display"${canEditDeal ? ` title="${t('clickToEdit')}"` : ''}>${deal.currency||'USD'} ${Number(deal.price||0).toLocaleString()}${deal.furniturePrice ? ' + '+t('furnitureLabel')+' '+Number(deal.furniturePrice).toLocaleString() : ''}</p></div>
      <div class="stat-tile"><p class="label">${t('startLabel')}</p><p class="value${canEditDeal ? ' field-editable' : ''}" id="deal-startdate-display"${canEditDeal ? ` title="${t('clickToEdit')}"` : ''}>${deal.startDate || '—'}</p></div>
      <div class="stat-tile"><p class="label">${t('closingDateLabel')}</p><p class="value${deal.closingDate ? '' : ' value-empty'}">${deal.closingDate || '—'}</p></div>
      <div class="stat-tile"><p class="label">${t('ddEndLabel')}</p><p class="value${deal.dueDiligenceEndDate ? '' : ' value-empty'}">${deal.dueDiligenceEndDate || '—'}</p></div>
    </div>

    <div class="progress-row" style="margin-top:16px; margin-bottom:0;">
      <div class="progress-block">
        <div class="progress-top"><span class="progress-name">${t('documentsLabel')}</span><span class="progress-pct">${docsPct}%</span></div>
        <div class="progress-track"><div class="progress-fill" style="width:${docsPct}%"></div></div>
      </div>
      <div class="progress-block">
        <div class="progress-top"><span class="progress-name">${t('trackerLabel')}</span><span class="progress-pct">${tasksPct}%</span></div>
        <div class="progress-track"><div class="progress-fill" style="width:${tasksPct}%"></div></div>
      </div>
    </div>
  `;
  wrap.appendChild(header);

  // Pestaña "General": lo editable y las acciones, ya no pegadas al
  // encabezado en todas las pestañas.
  let generalPanel = null;
  if(tab === 'general' && canEditDeal){
    generalPanel = document.createElement('div');
    generalPanel.className = 'card';
    generalPanel.innerHTML = `
      <div class="field-row-clean" style="margin-bottom:18px;">
        <label>${t('escrowCompany')}
          <select id="escrow-company-select">
            <option value="armour" ${deal.escrowCompany==='armour'?'selected':''}>Armour Secure</option>
            <option value="tla" ${deal.escrowCompany==='tla'?'selected':''}>TLA Financial Services</option>
            <option value="none" ${deal.escrowCompany==='none'?'selected':''}>${t('escrowNone')}</option>
          </select>
        </label>
        <label>${t('closingDateLabel')} <input type="date" id="closing-date-input" value="${deal.closingDate}"></label>
        <label>${t('ddEndLabel')} <input type="date" id="dd-end-date-input" value="${deal.dueDiligenceEndDate}"></label>
      </div>

      <div class="action-row" style="display:flex; gap:8px; flex-wrap:wrap;">
        ${deal.driveFolderUrl
          ? `<a class="btn" href="${deal.driveFolderUrl}" target="_blank"><i class="ti ti-folder" aria-hidden="true"></i> ${t('openInDrive')}</a>`
          : `<button class="btn" id="create-drive-folder-btn"><i class="ti ti-folder-plus" aria-hidden="true"></i> ${t('createDriveFolder')}</button>`}
        ${['admin','lawyer'].includes(currentUser.role) ? `<a class="btn" href="/api/deals/${deal.id}/export" title="${t('exportZipTitle')}"><i class="ti ti-file-zip" aria-hidden="true"></i> ${t('exportZip')}</a>` : ''}
        <button class="btn ${deal.status==='completed' ? '' : 'success'}" id="toggleDealStatusBtn">${deal.status==='completed' ? `<i class="ti ti-rotate" aria-hidden="true"></i> ${t('reopenDeal')}` : `<i class="ti ti-check" aria-hidden="true"></i> ${t('markDealCompleted')}`}</button>
        <button class="btn danger" id="delDeal"><i class="ti ti-trash" aria-hidden="true"></i> ${t('deleteDeal')}</button>
      </div>
    `;
    wrap.appendChild(generalPanel);
  }

  // Edición directa en el lugar (título, desarrollo, precio/muebles/moneda,
  // fecha de inicio) — antes había que abrir un formulario aparte más abajo
  // para tocar cualquiera de estos campos, que quedaba lejos de lo que se
  // estaba viendo. Cada campo se guarda solo al confirmar (blur/Enter/change),
  // mismo patrón que Actos jurídicos y las fechas de cierre/due diligence.
  async function saveDealField(body, revert){
    try{
      await apiFetch('/api/deals/' + deal.id, { method:'PATCH', body: JSON.stringify(body) });
      await openDeal(deal.id);
    }catch(e){ showToast(e.message, 'error'); if(revert) revert(); else render(); }
  }
  if(canEditDeal){
  header.querySelector('#deal-title-display').onclick = function(){
    if(this.querySelector('input')) return;
    const current = deal.property;
    this.innerHTML = `<input type="text" class="inline-edit-input" style="font:inherit; font-size:22px; width:min(420px,90%);" value="${escapeHtml(current)}">`;
    const input = this.querySelector('input');
    input.focus(); input.select();
    const commit = () => {
      const next = input.value.trim();
      if(!next || next === current){ render(); return; }
      saveDealField({ property: next }, () => render());
    };
    input.onblur = commit;
    input.onkeydown = (e) => { if(e.key==='Enter') input.blur(); if(e.key==='Escape'){ input.onblur=null; render(); } };
  };
  header.querySelector('#deal-development-display').onclick = function(){
    if(this.querySelector('select')) return;
    const current = deal.development || 'punta_mita';
    this.innerHTML = `<select class="inline-edit-input" style="font-size:13px;">${developmentOptionsHtml(current)}</select>`;
    const select = this.querySelector('select');
    select.focus();
    select.onchange = () => saveDealField({ development: select.value });
    select.onblur = () => { if(this.querySelector('select')) render(); };
  };
  header.querySelector('#deal-price-display').onclick = function(){
    if(this.querySelector('input')) return;
    this.innerHTML = `
      <input type="number" step="0.01" min="0" class="inline-edit-input pd-price" style="width:110px; font-size:13px;" value="${deal.price||0}">
      <input type="text" class="inline-edit-input pd-currency" style="width:44px; font-size:13px; text-transform:uppercase;" maxlength="3" value="${escapeHtml(deal.currency||'USD')}">
      <span class="field-hint" style="margin:0 2px;">+</span>
      <input type="number" step="0.01" min="0" class="inline-edit-input pd-furniture" style="width:90px; font-size:13px;" value="${deal.furniturePrice||0}" placeholder="${t('furnitureLabel')}">
      <button type="button" class="btn primary pd-confirm" style="font-size:11px; padding:3px 8px;"><i class="ti ti-check" aria-hidden="true"></i></button>
    `;
    const priceInput = this.querySelector('.pd-price');
    priceInput.focus(); priceInput.select();
    const commit = () => saveDealField({
      price: Number(this.querySelector('.pd-price').value) || 0,
      currency: this.querySelector('.pd-currency').value.trim().toUpperCase() || 'USD',
      furniturePrice: Number(this.querySelector('.pd-furniture').value) || 0
    });
    this.querySelector('.pd-confirm').onclick = commit;
    [priceInput, this.querySelector('.pd-currency'), this.querySelector('.pd-furniture')].forEach(el => {
      el.onkeydown = (e) => { if(e.key==='Enter') commit(); if(e.key==='Escape') render(); };
    });
  };
  header.querySelector('#deal-startdate-display').onclick = function(){
    if(this.querySelector('input')) return;
    const current = deal.startDate || '';
    this.innerHTML = `<input type="date" class="inline-edit-input" value="${current}">`;
    const input = this.querySelector('input');
    if(input.showPicker){ try{ input.showPicker(); }catch(e){} }
    input.focus();
    input.onchange = () => saveDealField({ startDate: input.value || null });
    input.onblur = () => { if(input.value === current) render(); };
  };
  }
  // Los campos editables y las acciones ahora viven en la pestaña General,
  // así que solo hay que conectarlos cuando esa pestaña está abierta.
  if(generalPanel){
    generalPanel.querySelector('#toggleDealStatusBtn').onclick = async () => {
      const nextStatus = deal.status === 'completed' ? 'active' : 'completed';
      if(nextStatus === 'completed' && !await confirmDialog(t('confirmMarkCompleted'))) return;
      try{
        await apiFetch(`/api/deals/${deal.id}`, { method:'PATCH', body: JSON.stringify({ status: nextStatus }) });
        await openDeal(deal.id);
      }catch(e){ showToast(e.message, 'error'); }
    };
    const driveFolderBtn = generalPanel.querySelector('#create-drive-folder-btn');
    if(driveFolderBtn){
      driveFolderBtn.onclick = async () => {
        driveFolderBtn.disabled = true; driveFolderBtn.textContent = t('driveFolderCreating');
        try{
          await apiFetch(`/api/deals/${deal.id}/drive-folder`, { method:'POST' });
          await openDeal(deal.id);
        }catch(e){ showToast(e.message, 'error'); driveFolderBtn.disabled = false; driveFolderBtn.innerHTML = `<i class="ti ti-folder-plus" aria-hidden="true"></i> ${t('createDriveFolder')}`; }
      };
    }
    generalPanel.querySelector('#escrow-company-select').onchange = async (e) => {
      const next = e.target.value;
      if(!await confirmDialog(t('confirmChangeEscrow', { company: escrowCompanyLabel(next) }))){
        e.target.value = deal.escrowCompany;
        return;
      }
      try{
        await apiFetch('/api/deals/' + deal.id, { method:'PATCH', body: JSON.stringify({ escrowCompany: next }) });
        await openDeal(deal.id);
      }catch(err){ showToast(err.message, 'error'); e.target.value = deal.escrowCompany; }
    };
    generalPanel.querySelector('#closing-date-input').onchange = async (e) => {
      try{
        await apiFetch('/api/deals/' + deal.id, { method:'PATCH', body: JSON.stringify({ closingDate: e.target.value || null }) });
        deal.closingDate = e.target.value;
        render();
      }catch(err){ showToast(err.message, 'error'); e.target.value = deal.closingDate; }
    };
    generalPanel.querySelector('#dd-end-date-input').onchange = async (e) => {
      try{
        await apiFetch('/api/deals/' + deal.id, { method:'PATCH', body: JSON.stringify({ dueDiligenceEndDate: e.target.value || null }) });
        deal.dueDiligenceEndDate = e.target.value;
        render();
      }catch(err){ showToast(err.message, 'error'); e.target.value = deal.dueDiligenceEndDate; }
    };
    generalPanel.querySelector('#delDeal').onclick = async () => {
      if(!await confirmDialog(t('confirmDeleteDeal'), { danger: true })) return;
      try{
        await apiFetch('/api/deals/' + deal.id, { method: 'DELETE' });
        deals = deals.filter(d=>d.id!==deal.id);
        activeDealId = null; render();
      }catch(e){ showToast(e.message, 'error'); }
    };
  }

  // Actos jurídicos — texto libre que redacta admin/abogado interno con el
  // acto exacto de esta operación (lo que se lleva a la notaría). Se
  // guarda solo, sin botón, al salir del textarea (mismo patrón que las
  // fechas de arriba) — nunca se muestra vacío a comprador/vendedor.
  if(tab === 'parties' && (['admin','lawyer'].includes(currentUser.role) || (deal.legalActs && deal.legalActs.trim()))){
    const legalActsCard = document.createElement('div'); legalActsCard.className = 'card';
    const canEditLegalActs = ['admin','lawyer'].includes(currentUser.role);
    legalActsCard.innerHTML = `
      <div class="section-title" style="margin-top:0;">${t('legalActsTitle')}</div>
      ${canEditLegalActs
        ? `<textarea id="legal-acts-input" rows="3" placeholder="${t('legalActsPh')}" style="width:100%;">${escapeHtml(deal.legalActs || '')}</textarea>
           <div class="field-hint" id="legal-acts-saved" style="margin:4px 0 0; opacity:0;">${t('legalActsSaved')}</div>`
        : `<div style="font-size:13px; white-space:pre-wrap;">${escapeHtml(deal.legalActs)}</div>`}
    `;
    wrap.appendChild(legalActsCard);
    const legalActsInput = legalActsCard.querySelector('#legal-acts-input');
    if(legalActsInput) legalActsInput.onblur = async (e) => {
      const next = e.target.value.trim();
      if(next === (deal.legalActs || '')) return;
      try{
        await apiFetch('/api/deals/' + deal.id, { method:'PATCH', body: JSON.stringify({ legalActs: next || null }) });
        deal.legalActs = next;
        const savedHint = legalActsCard.querySelector('#legal-acts-saved');
        savedHint.style.transition = 'none'; savedHint.style.opacity = '1';
        requestAnimationFrame(() => { savedHint.style.transition = 'opacity 1.5s'; savedHint.style.opacity = '0'; });
      }catch(err){ showToast(err.message, 'error'); }
    };
  }

  if(tab === 'parties'){
    const partiesTitle = document.createElement('div');
    partiesTitle.className = 'section-title'; partiesTitle.textContent = t('sellersAndBuyers');
    wrap.appendChild(sectionAnchor(partiesTitle, 'sec-parties'));
    wrap.appendChild(buildPartiesSection(deal));
  }

  if(tab === 'docs'){
    const propTitle = document.createElement('div');
    propTitle.className = 'section-title'; propTitle.textContent = t('propertySection');
    wrap.appendChild(sectionAnchor(propTitle, 'sec-docs'));
    const propCard = document.createElement('div');
    propCard.className = 'card';
    propCard.appendChild(buildPropertyDocsSection(deal, true));
    wrap.appendChild(propCard);

    const notaryTitle = document.createElement('div');
    notaryTitle.className = 'section-title'; notaryTitle.textContent = t('notaryClosingCostsSection');
    wrap.appendChild(notaryTitle);
    const notaryCard = document.createElement('div'); notaryCard.className = 'card';
    notaryCard.appendChild(buildNotaryClosingCostsSection(deal, true));
    wrap.appendChild(notaryCard);

    // Gestoría y Banco — solo escenarios con fideicomiso y solo
    // admin/abogados (a comprador/vendedor/agente el backend ni les manda
    // estos documentos). Cada una se refleja en su subcarpeta de Drive.
    if(['admin','lawyer','external_lawyer'].includes(currentUser.role) && deal.scenario !== 'purchase'){
      [['gestoria', t('gestoriaSection')], ['banco', t('bancoSection')]].forEach(([section, label]) => {
        if(!deal.documents.some(d => d.section === section)) return;
        const secTitle = document.createElement('div');
        secTitle.className = 'section-title'; secTitle.textContent = label;
        wrap.appendChild(secTitle);
        const secCard = document.createElement('div'); secCard.className = 'card';
        secCard.appendChild(buildSectionDocsCard(deal, section));
        wrap.appendChild(secCard);
      });
    }

    const docsTitle = document.createElement('div');
    docsTitle.className = 'section-title'; docsTitle.textContent = t('docsChecklist');
    wrap.appendChild(sectionAnchor(docsTitle, 'sec-kyc'));
    const docsCard = document.createElement('div');
    docsCard.className = 'card';
    docsCard.appendChild(buildDocsBySideGrouping(deal, true));
    wrap.appendChild(docsCard);
  }

  if(tab === 'kyc'){
    const kycTitle = document.createElement('div');
    kycTitle.className = 'section-title'; kycTitle.textContent = t('kycFile');
    wrap.appendChild(sectionAnchor(kycTitle, 'admin-kyc-section'));
    const kycCard = document.createElement('div'); kycCard.className = 'card';
    deal.parties.forEach(p => kycCard.appendChild(buildKycSection(deal, p, true)));
    wrap.appendChild(kycCard);

    buildSignatureTasksSection(deal, wrap, true);
  }

  if(tab === 'tracker'){
    const tasksTitle = document.createElement('div');
    tasksTitle.className = 'section-title'; tasksTitle.textContent = t('closingTracker');
    wrap.appendChild(sectionAnchor(tasksTitle, 'sec-tracker'));
    const tasksCard = document.createElement('div');
    tasksCard.className = 'card';
    tasksCard.appendChild(buildTaskList(deal, ['admin','lawyer'].includes(currentUser.role)));
    wrap.appendChild(tasksCard);
  }

  if(tab === 'people'){
    const agentsTitle = document.createElement('div');
    agentsTitle.className = 'section-title'; agentsTitle.textContent = t('agentsInDeal');
    wrap.appendChild(sectionAnchor(agentsTitle, 'sec-people'));
    wrap.appendChild(buildDealAgentsSection(deal));
  }

  if(tab === 'contract'){
    const contractTitle = document.createElement('div');
    contractTitle.className = 'section-title'; contractTitle.textContent = t('contractPromise');
    wrap.appendChild(sectionAnchor(contractTitle, 'sec-contract'));
    const contractCard = document.createElement('div'); contractCard.className = 'card';
    // Generar/editar el contrato es trabajo exclusivo de admin/abogado — el
    // agente ve la misma vista de solo lectura que comprador/vendedor (ver
    // PDF + firmar si le toca), nunca el machote en blanco.
    contractCard.appendChild(buildContractSection(deal, ['admin', 'lawyer'].includes(currentUser.role)));
    wrap.appendChild(contractCard);
  }

  if(tab === 'activity'){
    const activityTitle = document.createElement('div');
    activityTitle.className = 'section-title'; activityTitle.textContent = t('activityTitle');
    wrap.appendChild(sectionAnchor(activityTitle, 'sec-activity'));
    wrap.appendChild(buildActivitySection(deal));
  }

  return wrap;
}

const ACTIVITY_META = {
  deal_created:          { icon: 'ti-flag',        key: 'actDealCreated' },
  deal_trashed:          { icon: 'ti-trash',       key: 'actDealTrashed' },
  deal_restored:         { icon: 'ti-rotate',      key: 'actDealRestored' },
  doc_uploaded:          { icon: 'ti-upload',      key: 'actDocUploaded' },
  doc_replaced:          { icon: 'ti-history',     key: 'actDocReplaced' },
  doc_file_removed:      { icon: 'ti-eraser',      key: 'actDocFileRemoved' },
  doc_approved:          { icon: 'ti-check',       key: 'actDocApproved' },
  doc_rejected:          { icon: 'ti-x',           key: 'actDocRejected' },
  task_done:             { icon: 'ti-circle-check', key: 'actTaskDone' },
  task_reopened:         { icon: 'ti-rotate-2',    key: 'actTaskReopened' },
  task_assigned:         { icon: 'ti-user-check',  key: 'actTaskAssigned' },
  task_signed_offline:   { icon: 'ti-checks',      key: 'actTaskSignedOffline' },
  person_added:          { icon: 'ti-user-plus',   key: 'actPersonAdded' },
  kyc_sent:              { icon: 'ti-signature',   key: 'actKycSent' },
  contract_sent:         { icon: 'ti-file-text',   key: 'actContractSent' },
  progress_summary_sent: { icon: 'ti-mail-forward', key: 'actProgressSummarySent' },
  expediente_exported:   { icon: 'ti-file-zip',    key: 'actExpedienteExported' },
  docs_copied_from_past_deal: { icon: 'ti-copy',   key: 'actDocsCopied' }
};

function buildActivitySection(deal){
  const card = document.createElement('div');
  card.className = 'card';
  const data = activityCache[deal.id];
  if(data === undefined){
    card.innerHTML = `<div class="field-hint" style="margin:0;">${t('loading')}</div>`;
    loadActivity(deal.id);
    return card;
  }
  if(data.error){
    card.innerHTML = `<div class="field-hint" style="margin:0;">${escapeHtml(data.error)}</div>`;
    return card;
  }
  if(!data.length){
    card.innerHTML = `<div class="field-hint" style="margin:0;">${t('activityEmpty')}</div>`;
    return card;
  }
  data.forEach((ev, i) => {
    const meta = ACTIVITY_META[ev.action] || { icon: 'ti-point', key: null };
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:flex-start; gap:10px; padding:7px 0;' + (i < data.length - 1 ? ' border-bottom:0.5px solid var(--line);' : '');
    const actionLabel = meta.key ? t(meta.key) : ev.action;
    row.innerHTML = `
      <span style="width:26px; height:26px; border-radius:50%; background:var(--stone); display:flex; align-items:center; justify-content:center; flex-shrink:0; color:var(--ink-soft);"><i class="ti ${meta.icon}" aria-hidden="true" style="font-size:13px;"></i></span>
      <span style="flex:1; min-width:0;">
        <div style="font-size:12.5px;">${ev.userName ? `<b>${escapeHtml(ev.userName)}</b> ` : ''}${actionLabel}${ev.detail ? ` — ${escapeHtml(ev.detail)}` : ''}</div>
        <div class="field-hint" style="margin:1px 0 0;">${escapeHtml((ev.created_at || '').replace('T', ' ').slice(0, 16))} UTC</div>
      </span>
    `;
    card.appendChild(row);
  });
  return card;
}

const KYC_STATUS_LABEL_I18N = {
  draft: { es: 'Sin generar', en: 'Not generated' }, generated: { es: 'Generado, sin enviar', en: 'Generated, not sent' },
  sent: { es: 'Enviado a firma', en: 'Sent for signature' }, signed: { es: 'Firmado', en: 'Signed' }
};
const KYC_STATUS_LABEL = new Proxy(KYC_STATUS_LABEL_I18N, {
  get(target, key){ const e = target[key]; return e ? (e[lang] || e.es) : undefined; }
});

function buildKycSection(deal, party, isStaffView, kind){
  kind = kind || 'escrow';
  const kindQs = kind === 'lpr' ? '?kind=lpr' : '';
  const role = party.id;
  const key = deal.id + '-' + role + '-' + kind;
  const roleLabel = `${party.name} (${party.side === 'seller' ? t('sellerLabel2') : t('buyerLabel2')} · ${TYPE_LABEL[party.partyType]})${kind === 'lpr' ? ' — LPR Luxury' : ''}`;
  const box = document.createElement('div');
  box.style.cssText = 'padding:10px 0; border-bottom:0.5px solid var(--line);';

  const data = kycCache[key];
  if(data === undefined){
    box.innerHTML = `<div class="field-hint" style="margin:0;">${escapeHtml(roleLabel)}: ${t('loadingEllipsis')}</div>`;
    loadKyc(deal.id, role, undefined, kind);
    return box;
  }
  if(data.error){
    box.innerHTML = `<div class="field-hint" style="margin:0;">${escapeHtml(roleLabel)}: ${escapeHtml(data.error)}</div>`;
    return box;
  }

  const statusLabel = KYC_STATUS_LABEL[data.status] || data.status;
  box.innerHTML = `<div style="font-weight:500; font-size:13px;">${escapeHtml(roleLabel)} <span class="badge" style="margin-left:6px; background:var(--stone); border:0.5px solid var(--line); color:var(--ink-soft);">${escapeHtml(statusLabel)}</span> <span class="field-hint" style="margin:0;">(${escapeHtml(data.templateKey||'')})</span></div>`;

  // Selector de idioma — solo tiene sentido antes de empezar a llenar (una
  // vez que hay respuestas guardadas, cambiar de idioma significa arrancar
  // un expediente distinto, así que se oculta para no perder el borrador).
  if(isStaffView && data.status === 'draft' && Object.keys(data.answers||{}).length === 0 && data.availableTemplates && data.availableTemplates.length > 1){
    const langRow = document.createElement('div');
    langRow.style.cssText = 'margin-top:4px;';
    langRow.innerHTML = `<label class="field-hint" style="margin:0; display:inline-flex; gap:6px; align-items:center;">${t('formLanguage')}
      <select id="kyc-lang-${key}" style="font-size:11px; padding:2px 6px;">
        <option value="es">${t('spanish')}</option>
        <option value="en">${t('english')}</option>
      </select>
    </label>`;
    langRow.querySelector('select').value = data.templateKey.endsWith('-en') ? 'en' : 'es';
    langRow.querySelector('select').onchange = (e) => loadKyc(deal.id, role, e.target.value, kind);
    box.appendChild(langRow);
  }

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex; gap:8px; margin-top:6px; flex-wrap:wrap;';

  // Este expediente se llena solo con el formulario de la escrow company
  // (mismos datos, otro formato) — no se ofrece un segundo formulario, solo
  // se avisa de dónde salen los datos.
  const isMirrored = !!data.mirroredFrom;
  if(isMirrored){
    const note = document.createElement('div');
    note.className = 'field-hint';
    note.style.cssText = 'margin:4px 0 0;';
    note.innerHTML = `<i class="ti ti-wand" aria-hidden="true"></i> ${t('kycAutoFilledFrom', { source: escapeHtml(data.mirroredFrom) })}`;
    box.appendChild(note);
  } else {
    const fillBtn = document.createElement('button');
    fillBtn.className = 'btn';
    fillBtn.textContent = data.status === 'draft' ? t('fillForm') : t('viewEditForm');
    fillBtn.onclick = () => { kycFormOpenFor = key; render(); };
    actions.appendChild(fillBtn);
  }

  if(data.generatedFileUrl){
    const viewLink = document.createElement('a');
    viewLink.href = `/api/deals/${deal.id}/kyc/${role}/file${kindQs}`;
    viewLink.target = '_blank';
    viewLink.className = 'btn';
    viewLink.textContent = t('viewDocument');
    actions.appendChild(viewLink);
  }

  if(isStaffView && ['admin','lawyer'].includes(currentUser.role) && data.status === 'generated'){
    const sendBtn = document.createElement('button');
    sendBtn.className = 'btn gold';
    sendBtn.textContent = t('sendForSignature');
    sendBtn.onclick = () => withButtonLoading(sendBtn, async () => {
      try{
        await apiFetch(`/api/deals/${deal.id}/kyc/${role}/send-for-signature${kindQs}`, { method:'POST' });
        await loadKyc(deal.id, role, undefined, kind);
      }catch(e){ showToast(e.message, 'error'); }
    });
    actions.appendChild(sendBtn);
  }

  if(isStaffView && ['draft','generated'].includes(data.status)){
    const resetBtn = document.createElement('button');
    resetBtn.className = 'btn'; resetBtn.style.fontSize = '11px';
    resetBtn.textContent = t('resetFile');
    resetBtn.title = t('resetFileTitle');
    resetBtn.onclick = async () => {
      if(!await confirmDialog(t('confirmResetFile'), { danger: true })) return;
      try{
        await apiFetch(`/api/deals/${deal.id}/kyc/${role}${kindQs}`, { method:'DELETE' });
        await loadKyc(deal.id, role, undefined, kind);
      }catch(e){ showToast(e.message, 'error'); }
    };
    actions.appendChild(resetBtn);
  }

  if(!isStaffView && data.status === 'sent'){
    // Si lo llenaste tú mismo, se mandó embebido — firma aquí mismo. Si lo
    // llenó staff a tu nombre, se mandó por correo normal y este botón
    // falla con un mensaje claro de que lo firmes desde tu correo.
    const signBtn = document.createElement('button');
    signBtn.className = 'btn gold';
    signBtn.textContent = t('signNow');
    signBtn.onclick = async () => {
      try{
        const { url } = await apiFetch(`/api/deals/${deal.id}/kyc/${role}/signing-url${kindQs}`, { method:'POST' });
        openKycSigningModal(url, deal.id, role, kind);
      }catch(e){ showToast(e.message, 'error'); }
    };
    actions.appendChild(signBtn);
  }

  if(isStaffView){
    const uploadSignedBtn = document.createElement('button');
    uploadSignedBtn.className = 'btn'; uploadSignedBtn.style.fontSize = '11px';
    uploadSignedBtn.title = t('uploadSignedKycTitle');
    uploadSignedBtn.innerHTML = `<i class="ti ti-upload" aria-hidden="true"></i> ${t('uploadSignedKyc')}`;
    const uploadSignedInput = document.createElement('input');
    uploadSignedInput.type = 'file'; uploadSignedInput.accept = '.pdf'; uploadSignedInput.style.display = 'none';
    uploadSignedBtn.onclick = () => uploadSignedInput.click();
    uploadSignedInput.onchange = async (e) => {
      const file = e.target.files[0];
      if(!file) return;
      const original = uploadSignedBtn.innerHTML;
      uploadSignedBtn.disabled = true; uploadSignedBtn.innerHTML = `<i class="ti ti-loader-2" aria-hidden="true"></i> ${t('uploading')}`;
      const fd = new FormData(); fd.append('file', file);
      try{
        await apiUpload(`/api/deals/${deal.id}/kyc/${role}/upload-signed${kindQs}`, fd);
        await loadKyc(deal.id, role, undefined, kind);
      }catch(err){ showToast(err.message, 'error'); uploadSignedBtn.disabled = false; uploadSignedBtn.innerHTML = original; }
    };
    actions.appendChild(uploadSignedBtn);
    actions.appendChild(uploadSignedInput);
  }

  box.appendChild(actions);

  if(kycFormOpenFor === key){
    box.appendChild(buildKycForm(deal, role, data, isStaffView, kind));
  }

  if(kind === 'escrow' && data.lprRequired){
    box.appendChild(buildKycSection(deal, party, isStaffView, 'lpr'));
  }

  return box;
}

// Marca visualmente si un campo es obligatorio (*) u opcional — antes no
// había ninguna diferencia visual entre ambos, así que campos que solo
// aplican a mexicanos/residentes (CURP, RFC, domicilio en México) se veían
// igual de "obligatorios" que el resto para un extranjero llenando el form.
function fieldLabelHtml(f){
  if(f.required) return `${escapeHtml(f.label)} <span style="color:var(--oxblood);">*</span>`;
  if(/opcional|optional/i.test(f.label)) return escapeHtml(f.label);
  return `${escapeHtml(f.label)} <span class="field-hint" style="margin:0; display:inline;">${t('optional')}</span>`;
}

function buildKycForm(deal, role, data, isStaffView, kind){
  kind = kind || 'escrow';
  const kindQs = kind === 'lpr' ? '?kind=lpr' : '';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-top:12px; padding:14px; background:var(--stone); border-radius:10px;';
  wrap.innerHTML = `<div class="field-hint" style="margin-top:0;">${escapeHtml(data.label)}</div>`;

  const answers = data.answers || {};
  data.sections.forEach(section => {
    const sTitle = document.createElement('div');
    sTitle.style.cssText = 'font-weight:600; font-size:12.5px; margin:12px 0 6px;';
    sTitle.textContent = section.title;
    wrap.appendChild(sTitle);

    section.fields.forEach(f => {
      const row = document.createElement('div');
      row.style.marginBottom = '8px';
      const val = answers[f.id] || '';
      if(f.type === 'radio'){
        row.innerHTML = `<div class="field-hint" style="margin:0 0 4px;">${fieldLabelHtml(f)}</div>` +
          f.options.map(o => `<label style="display:inline-flex; align-items:center; gap:4px; margin-right:14px; font-size:12.5px;">
            <input type="radio" name="kyc-${f.id}" value="${escapeHtml(o.value)}" ${val===o.value?'checked':''}> ${escapeHtml(o.label)}
          </label>`).join('');
      } else if(f.type === 'textarea'){
        row.innerHTML = `<label style="display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--ink-soft);">${fieldLabelHtml(f)}
          <textarea data-kyc-field="${f.id}" rows="2">${escapeHtml(val)}</textarea>
        </label>`;
      } else {
        const inputType = f.type === 'date' ? 'date' : (f.type === 'email' ? 'email' : 'text');
        row.innerHTML = `<label style="display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--ink-soft);">${fieldLabelHtml(f)}
          <input type="${inputType}" data-kyc-field="${f.id}" value="${escapeHtml(val)}" ${f.maxLength?`maxlength="${f.maxLength}"`:''}>
        </label>`;
      }
      wrap.appendChild(row);
    });
  });

  function collectAnswers(){
    const result = {};
    data.sections.forEach(section => section.fields.forEach(f => {
      if(f.type === 'radio'){
        const checked = wrap.querySelector(`input[name="kyc-${f.id}"]:checked`);
        result[f.id] = checked ? checked.value : '';
      } else {
        const el = wrap.querySelector(`[data-kyc-field="${f.id}"]`);
        result[f.id] = el ? el.value.trim() : '';
      }
    }));
    return result;
  }

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex; gap:8px; margin-top:12px;';
  const lang = (data.templateKey || '').endsWith('-en') ? 'en' : 'es';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn'; saveBtn.textContent = t('saveDraft');
  saveBtn.onclick = async () => {
    try{
      await apiFetch(`/api/deals/${deal.id}/kyc/${role}${kindQs}`, { method:'POST', body: JSON.stringify({ answers: collectAnswers(), lang }) });
      await loadKyc(deal.id, role, undefined, kind);
    }catch(e){ showToast(e.message, 'error'); }
  };
  const generateBtn = document.createElement('button');
  generateBtn.className = 'btn primary'; generateBtn.textContent = t('saveGenerateSend');
  generateBtn.onclick = () => withButtonLoading(generateBtn, async () => {
    try{
      await apiFetch(`/api/deals/${deal.id}/kyc/${role}${kindQs}`, { method:'POST', body: JSON.stringify({ answers: collectAnswers(), lang }) });
      const result = await apiFetch(`/api/deals/${deal.id}/kyc/${role}/generate${kindQs}`, { method:'POST' });
      kycFormOpenFor = null;
      await loadKyc(deal.id, role, undefined, kind);
      // Un formulario, dos expedientes: si además salió el de LPR Luxury, se
      // recarga también para que se vea generado/enviado en su propia fila.
      if(result.mirror && !result.mirror.error) await loadKyc(deal.id, role, undefined, 'lpr');
      if(result.sentForSignature && result.embedded){
        // Lo llenaste tú mismo, en tu propia sesión — se manda embebido, así
        // que puedes firmar de una vez sin ir a buscar un correo. Si hay un
        // segundo expediente (LPR), se encadena: al cerrar el primero se
        // abre el otro, para no dejarlo a medias sin que se dé cuenta.
        const signMirrorNext = result.mirror && result.mirror.sentForSignature && result.mirror.embedded
          ? async () => {
              try{
                const { url } = await apiFetch(`/api/deals/${deal.id}/kyc/${role}/signing-url?kind=lpr`, { method:'POST' });
                showToast(t('kycSecondSignature'));
                openKycSigningModal(url, deal.id, role, 'lpr');
              }catch(e){ /* queda el botón "Firmar ahora" en su fila como respaldo */ }
            }
          : null;
        try{
          const { url } = await apiFetch(`/api/deals/${deal.id}/kyc/${role}/signing-url${kindQs}`, { method:'POST' });
          openKycSigningModal(url, deal.id, role, kind, signMirrorNext);
        }catch(e){ /* si falla, se queda en la sección con el botón "Firmar ahora" como respaldo */ }
      } else if(result.sentForSignature){
        showToast(t('alertGeneratedSent'), 'success');
      } else if(result.pendingReview){
        // Agente/abogado externo — no se manda solo, admin/abogado interno
        // lo revisa y lo manda (ver tarea nueva en Seguimiento del cierre).
        showToast(t('alertPendingReview'));
      } else if(result.autoSendError){
        showToast(t('alertAutoSendFailed', { error: result.autoSendError }), 'error');
      }
    }catch(e){ showToast(e.message, 'error'); }
  });
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn'; closeBtn.textContent = t('close');
  closeBtn.onclick = () => { kycFormOpenFor = null; render(); };
  actions.appendChild(saveBtn); actions.appendChild(generateBtn); actions.appendChild(closeBtn);
  wrap.appendChild(actions);

  return wrap;
}

function openKycSigningModal(url, dealId, role, kind, onDone){
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(33,22,19,0.55); display:flex; align-items:center; justify-content:center; z-index:1000;';
  overlay.innerHTML = `
    <div style="background:#fff; border-radius:14px; width:min(900px,92vw); height:min(720px,88vh); display:flex; flex-direction:column; overflow:hidden;">
      <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 16px; border-bottom:0.5px solid var(--line);">
        <div class="section-title" style="margin:0;">${t('kycSignModalTitle')}</div>
        <button class="btn" id="kyc-sign-modal-close">${t('close')}</button>
      </div>
      <iframe src="${url}" style="flex:1; border:0;"></iframe>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#kyc-sign-modal-close').onclick = () => overlay.remove();

  const onMessage = async (e) => {
    if(e.origin !== window.location.origin) return;
    if(!e.data || e.data.type !== 'docusign-return') return;
    window.removeEventListener('message', onMessage);
    overlay.remove();
    try{
      const kindQs = kind === 'lpr' ? '?kind=lpr' : '';
      await apiFetch(`/api/deals/${dealId}/kyc/${role}/status${kindQs}`);
      await loadKyc(dealId, role, undefined, kind);
    }catch(err){ showToast(err.message, 'error'); }
    if(onDone) onDone();
  };
  window.addEventListener('message', onMessage);
}

// `readOnly` — para cuando alguien puede VER un documento pero no le toca a
// él subirlo (ej. el vendedor viendo los comprobantes de pago del
// comprador: puede consultarlos, pero no es requisito suyo y no debe poder
// subir/reemplazar/borrar ni marcarlo como hecho).
// Historial de versiones de un documento — quién subió qué y cuándo, con
// link para ver cada versión archivada. Al re-subir o quitar un archivo, la
// versión anterior se conserva (ver document_versions en el backend).
async function showVersionsDialog(deal, doc){
  let versions;
  try{
    versions = await apiFetch(`/api/deals/${deal.id}/documents/${doc.id}/versions`);
  }catch(e){ showToast(e.message, 'error'); return; }
  if(!versions.length && !doc.fileUrl){
    showToast(t('versionsEmpty'));
    return;
  }
  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';
  const box = document.createElement('div');
  box.className = 'dialog-box';
  box.style.maxHeight = '70vh';
  box.style.overflowY = 'auto';
  box.innerHTML = `<div class="section-title" style="margin-top:0;">${t('versionsTitle')} — ${escapeHtml(localizeDocName(doc.name))}</div>`;

  const rows = [];
  if(doc.fileUrl){
    rows.push({ current: true, original_name: doc.originalName, uploaded_at: null, uploadedByName: null,
      href: `/api/deals/${deal.id}/documents/${doc.id}/file` });
  }
  versions.forEach(v => rows.push({ current: false, original_name: v.original_name, uploaded_at: v.uploaded_at,
    uploadedByName: v.uploadedByName, archived_at: v.archived_at,
    href: `/api/deals/${deal.id}/documents/${doc.id}/versions/${v.id}/file` }));

  rows.forEach((r, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:10px; padding:8px 0;' + (i < rows.length - 1 ? ' border-bottom:0.5px solid var(--line);' : '');
    row.innerHTML = `
      <span style="flex:1; min-width:0;">
        <div style="font-size:13px; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(r.original_name || t('versionsUnnamed'))}
          ${r.current ? `<span class="badge" style="background:var(--jade-soft); color:var(--jade); margin:0 0 0 6px;">${t('versionCurrent')}</span>` : ''}</div>
        <div class="field-hint" style="margin:1px 0 0;">
          ${r.current ? '' : `${r.uploadedByName ? escapeHtml(r.uploadedByName) + ' · ' : ''}${escapeHtml((r.uploaded_at || r.archived_at || '').slice(0, 16).replace('T', ' '))}`}
        </div>
      </span>
      <a href="${r.href}" target="_blank" class="btn" style="font-size:11px; padding:4px 10px; flex-shrink:0;"><i class="ti ti-eye" aria-hidden="true"></i> ${t('viewFile')}</a>
    `;
    box.appendChild(row);
  });
  if(!versions.length){
    const hint = document.createElement('div');
    hint.className = 'field-hint'; hint.style.margin = '8px 0 0';
    hint.textContent = t('versionsOnlyCurrent');
    box.appendChild(hint);
  }
  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  actions.style.marginTop = '14px';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn'; closeBtn.textContent = t('close');
  closeBtn.onclick = () => overlay.remove();
  actions.appendChild(closeBtn);
  box.appendChild(actions);
  overlay.appendChild(box);
  overlay.onclick = (e) => { if(e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
}

function buildDocItemLi(deal, doc, isStaffView, readOnly){
  const li = document.createElement('li');
  li.className = 'doc-item';
  // El sub_label ya se muestra como encabezado de grupo en
  // buildDocListForParty — aquí solo el nombre del documento.
  const label = escapeHtml(localizeDocName(doc.name));
  const subCheckLabels = SUB_CHECKS_BY_DOC[doc.name] || [];
  const subChecksHtml = subCheckLabels.map(sc => `
    <label style="display:flex; align-items:center; gap:4px; font-size:11px; color:var(--ink-soft); cursor:pointer;">
      <input type="checkbox" class="sub-check" data-label="${escapeHtml(sc)}" ${doc.subChecks[sc]?'checked':''}> ${escapeHtml(sc)}
    </label>`).join('');
  // Aprobar/rechazar el archivo ya subido es solo de admin/abogado interno
  // (nunca agente/abogado externo, y nunca en la vista previa "como esta
  // parte" — isStaffView ya viene en false ahí). El badge de estado sí lo ve
  // todo el mundo, para que quien subió el documento sepa si quedó bien.
  const canReview = isStaffView && ['admin','lawyer'].includes(currentUser.role);
  const reviewBadgeHtml = doc.fileUrl
    ? `<span class="review-badge ${doc.reviewStatus}">${t(doc.reviewStatus === 'approved' ? 'reviewApproved' : doc.reviewStatus === 'rejected' ? 'reviewRejected' : 'reviewPending')}</span>`
    : '';
  // Vista de staff: UNA acción principal (Ver archivo, o Subir si no hay) y
  // el resto de acciones dentro del menú "···" — antes cada renglón traía
  // hasta 7 botones a la vista (Aprobar, Rechazar, Reemplazar, borrar,
  // historial, quitar...) y el checklist parecía un tablero de mandos.
  // La vista del cliente conserva sus 2-3 botones directos de siempre.
  const menuOpen = docActionsMenuFor === doc.id;
  const staffActionsHtml = `
      ${doc.fileUrl
        ? `<a href="/api/deals/${deal.id}/documents/${doc.id}/file" target="_blank" class="btn" style="font-size:11px; padding:4px 10px; display:inline-flex; align-items:center; gap:4px;"><i class="ti ti-eye" aria-hidden="true"></i> ${t('viewFile')}</a>`
        : `<button type="button" class="btn doc-upload-btn" style="font-size:11px; padding:4px 10px; display:inline-flex; align-items:center; gap:4px;" title="${t('attachDocument')}"><i class="ti ti-upload" aria-hidden="true"></i> ${t('upload')}</button>`}
      <button type="button" class="btn doc-kebab-btn" style="font-size:11px; padding:4px 8px;" title="${t('moreActions')}"><i class="ti ti-dots" aria-hidden="true"></i></button>
      ${menuOpen ? `
        <div class="doc-action-menu">
          ${doc.fileUrl ? `<button type="button" class="doc-upload-btn"><i class="ti ti-upload" aria-hidden="true"></i> ${t('replaceFile')}</button>` : ''}
          ${canReview && doc.fileUrl && doc.reviewStatus !== 'approved' ? `<button type="button" class="doc-approve-btn" style="color:var(--jade);"><i class="ti ti-check" aria-hidden="true"></i> ${t('approveDocument')}</button>` : ''}
          ${canReview && doc.fileUrl && doc.reviewStatus !== 'rejected' ? `<button type="button" class="doc-reject-btn"><i class="ti ti-x" aria-hidden="true"></i> ${t('rejectDocument')}</button>` : ''}
          <button type="button" class="doc-versions-btn"><i class="ti ti-history" aria-hidden="true"></i> ${t('versionsTitle')}</button>
          ${doc.fileUrl ? `<button type="button" class="doc-delete-btn danger"><i class="ti ti-trash" aria-hidden="true"></i> ${t('deleteFile')}</button>` : ''}
          <button type="button" class="doc-remove-req-btn danger"><i class="ti ti-playlist-x" aria-hidden="true"></i> ${t('removeChecklistItemTitle')}</button>
        </div>` : ''}`;
  const clientActionsHtml = `
      ${doc.fileUrl ? `<a href="/api/deals/${deal.id}/documents/${doc.id}/file" target="_blank" class="btn" style="font-size:11px; padding:4px 10px; display:inline-flex; align-items:center; gap:4px;"><i class="ti ti-eye" aria-hidden="true"></i> ${t('viewFile')}</a>` : (readOnly ? `<span class="field-hint" style="margin:0;">${t('notUploaded')}</span>` : '')}
      ${!readOnly ? `<button type="button" class="btn doc-upload-btn" style="font-size:11px; padding:4px 10px; display:inline-flex; align-items:center; gap:4px;" title="${t('attachDocument')}"><i class="ti ti-upload" aria-hidden="true"></i> ${doc.fileUrl ? t('replaceFile') : t('upload')}</button>` : ''}
      ${!readOnly && doc.fileUrl ? `<button type="button" class="btn doc-delete-btn" style="font-size:11px; padding:4px 10px; display:inline-flex; align-items:center; gap:4px; color:var(--oxblood);" title="${t('deleteFile')}"><i class="ti ti-trash" aria-hidden="true"></i></button>` : ''}`;
  li.innerHTML = `<span class="doc-check ${doc.status==='done'?'done':''}" ${readOnly ? 'style="cursor:default;"' : ''}>${doc.status==='done'?'<i class=\"ti ti-check\" aria-hidden=\"true\"></i>':''}</span><span>${label}</span>
    <span class="doc-item-actions" style="position:relative;">
      ${subChecksHtml}
      ${reviewBadgeHtml}
      ${isStaffView ? staffActionsHtml : clientActionsHtml}
      <input type="file" class="doc-file-input" style="display:none;" accept=".pdf,.jpg,.jpeg,.png,.heic">
    </span>
    ${doc.reviewStatus === 'rejected' && doc.reviewNote ? `<span class="doc-review-note"><b>${t('reviewRejectedNote')}:</b> ${escapeHtml(doc.reviewNote)}</span>` : ''}`;
  const kebabBtn = li.querySelector('.doc-kebab-btn');
  if(kebabBtn) kebabBtn.onclick = (e) => {
    e.stopPropagation();
    docActionsMenuFor = menuOpen ? null : doc.id;
    render();
  };
  const actionMenu = li.querySelector('.doc-action-menu');
  if(actionMenu) actionMenu.onclick = (e) => e.stopPropagation();
  if(!readOnly) li.querySelector('.doc-check').onclick = async () => {
    const next = doc.status==='done' ? 'pending' : 'done';
    try{
      await apiFetch(`/api/deals/${deal.id}/documents/${doc.id}`, { method:'PATCH', body: JSON.stringify({status: next}) });
      doc.status = next; render();
    }catch(e){ showToast(e.message, 'error'); }
  };
  li.querySelectorAll('.sub-check').forEach(checkEl => {
    checkEl.onchange = async (e) => {
      const scLabel = checkEl.dataset.label;
      const next = e.target.checked;
      try{
        await apiFetch(`/api/deals/${deal.id}/documents/${doc.id}`, { method:'PATCH', body: JSON.stringify({subChecks: {[scLabel]: next}}) });
        doc.subChecks[scLabel] = next;
      }catch(err){ showToast(err.message, 'error'); e.target.checked = !next; }
    };
  });
  const uploadBtn = li.querySelector('.doc-upload-btn');
  const fileInput = li.querySelector('.doc-file-input');
  const versionsBtn = li.querySelector('.doc-versions-btn');
  if(versionsBtn) versionsBtn.onclick = () => showVersionsDialog(deal, doc);
  const deleteBtn = li.querySelector('.doc-delete-btn');
  if(deleteBtn) deleteBtn.onclick = async () => {
    if(!await confirmDialog(t('deleteFileConfirm', { name: localizeDocName(doc.name) }), { danger: true })) return;
    deleteBtn.disabled = true;
    try{
      await apiFetch(`/api/deals/${deal.id}/documents/${doc.id}/file`, { method:'DELETE' });
      await openDeal(deal.id);
    }catch(err){ showToast(err.message, 'error'); deleteBtn.disabled = false; }
  };
  const approveBtn = li.querySelector('.doc-approve-btn');
  if(approveBtn) approveBtn.onclick = async () => {
    approveBtn.disabled = true;
    try{
      await apiFetch(`/api/deals/${deal.id}/documents/${doc.id}/review`, { method:'PATCH', body: JSON.stringify({ reviewStatus: 'approved' }) });
      await openDeal(deal.id);
    }catch(err){ showToast(err.message, 'error'); approveBtn.disabled = false; }
  };
  const rejectBtn = li.querySelector('.doc-reject-btn');
  if(rejectBtn) rejectBtn.onclick = async () => {
    const reviewNote = prompt(t('rejectReasonPrompt'), '');
    if(reviewNote === null) return;
    rejectBtn.disabled = true;
    try{
      await apiFetch(`/api/deals/${deal.id}/documents/${doc.id}/review`, { method:'PATCH', body: JSON.stringify({ reviewStatus: 'rejected', reviewNote }) });
      await openDeal(deal.id);
    }catch(err){ showToast(err.message, 'error'); rejectBtn.disabled = false; }
  };
  if(uploadBtn) uploadBtn.onclick = () => fileInput.click();
  fileInput.onchange = async (e) => {
    const file = e.target.files[0];
    if(!file) return;
    const originalHtml = uploadBtn.innerHTML;
    uploadBtn.disabled = true;
    uploadBtn.innerHTML = `<i class="ti ti-loader-2" aria-hidden="true"></i> ${t('uploading')}`;
    const fd = new FormData();
    fd.append('file', file);
    try{
      await apiUpload(`/api/deals/${deal.id}/documents/${doc.id}/file`, fd);
      await openDeal(deal.id);
    }catch(err){
      showToast(err.message, 'error');
      uploadBtn.disabled = false;
      uploadBtn.innerHTML = originalHtml;
    }
  };
  const removeReqBtn = li.querySelector('.doc-remove-req-btn');
  if(removeReqBtn) removeReqBtn.onclick = async () => {
    if(!await confirmDialog(t('removeChecklistItemConfirm', { name: localizeDocName(doc.name) }), { danger: true })) return;
    removeReqBtn.disabled = true;
    try{
      await apiFetch(`/api/deals/${deal.id}/documents/${doc.id}`, { method:'DELETE' });
      await openDeal(deal.id);
    }catch(err){ showToast(err.message, 'error'); removeReqBtn.disabled = false; }
  };
  return li;
}

// Formulario chico para agregar un requisito de documento custom al
// checklist — para property (dealPartyEntityId null) o para una parte
// específica. Solo staff (ver buildDocItemLi arriba, mismo criterio).
function buildAddDocumentRow(deal, dealPartyEntityId, section){
  const row = document.createElement('div');
  row.style.cssText = 'margin-top:6px;';
  row.innerHTML = `
    <button type="button" class="btn add-doc-toggle" title="${t('addChecklistItemTitle')}" style="font-size:13px; padding:4px 9px; line-height:1;"><i class="ti ti-plus" aria-hidden="true"></i></button>
    <div class="add-doc-form" style="display:none; gap:6px; align-items:center; margin-top:6px;">
      <input type="text" class="add-doc-name" placeholder="${t('newChecklistItemPh')}" style="flex:1; font-size:12px; padding:5px 8px;">
      <button type="button" class="btn primary add-doc-btn" style="font-size:11px; padding:4px 10px; white-space:nowrap;">${t('addChecklistItem')}</button>
      <button type="button" class="btn add-doc-cancel" title="${t('close')}" style="font-size:11px; padding:4px 8px;"><i class="ti ti-x" aria-hidden="true"></i></button>
    </div>
  `;
  const toggleBtn = row.querySelector('.add-doc-toggle');
  const form = row.querySelector('.add-doc-form');
  const nameInput = row.querySelector('.add-doc-name');
  const addBtn = row.querySelector('.add-doc-btn');
  const cancelBtn = row.querySelector('.add-doc-cancel');
  toggleBtn.onclick = () => {
    toggleBtn.style.display = 'none';
    form.style.display = 'flex';
    nameInput.focus();
  };
  cancelBtn.onclick = () => {
    form.style.display = 'none';
    toggleBtn.style.display = 'inline-flex';
    nameInput.value = '';
  };
  addBtn.onclick = async () => {
    const name = nameInput.value.trim();
    if(!name) return;
    addBtn.disabled = true;
    try{
      const body = { name, dealPartyEntityId: dealPartyEntityId || null };
      if(section) body.section = section;
      await apiFetch(`/api/deals/${deal.id}/documents`, { method:'POST', body: JSON.stringify(body) });
      await openDeal(deal.id);
    }catch(e){ showToast(e.message, 'error'); addBtn.disabled = false; }
  };
  nameInput.onkeydown = (e) => { if(e.key === 'Enter') addBtn.click(); if(e.key === 'Escape') cancelBtn.click(); };
  return row;
}

// Agrupa el checklist en Vendedores/Compradores — mismo orden en el que
// eventualmente se van a organizar las carpetas de Drive (Propiedad /
// Vendedor / Comprador / Escrow / Notaría), aunque esas dos últimas todavía
// no tienen un checklist de documentos propio en la plataforma.
function buildDocsBySideGrouping(deal, isStaffView){
  const wrap = document.createElement('div');
  [['seller', t('sellers')], ['buyer', t('buyers')]].forEach(([side, label]) => {
    const parties = deal.parties.filter(p => p.side === side);
    if (!parties.length) return;
    const sub = document.createElement('div');
    sub.style.cssText = 'font-family:\'Cormorant Garamond\',serif; font-weight:600; font-size:15px; color:var(--ink-soft); margin:4px 0 8px;';
    sub.textContent = label;
    wrap.appendChild(sub);
    parties.forEach(p => wrap.appendChild(buildDocListForParty(deal, p, isStaffView)));
  });
  return wrap;
}

function buildDocListForParty(deal, party, isStaffView){
  const box = document.createElement('div');
  box.style.marginBottom = '14px';
  const sideLabel = party.side === 'seller' ? t('sellerLabel2') : t('buyerLabel2');
  const docs = deal.documents.filter(d => d.partyId === party.id);
  const expandKey = deal.id + '-' + party.id;
  const isExpanded = docChecklistExpanded[expandKey] !== undefined ? docChecklistExpanded[expandKey] : true;
  const h = document.createElement('div');
  h.style.cssText = 'font-weight:500; font-size:13px; color:var(--ink-soft); margin-bottom:6px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;';
  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'icon-btn'; toggleBtn.style.cssText = 'width:22px; height:22px; flex-shrink:0;'; toggleBtn.title = t('toggleExpand');
  toggleBtn.innerHTML = `<i class="ti ti-chevron-${isExpanded?'down':'right'}" aria-hidden="true"></i>`;
  toggleBtn.onclick = () => { docChecklistExpanded[expandKey] = !isExpanded; render(); };
  h.appendChild(toggleBtn);
  const hLabel = document.createElement('span');
  hLabel.textContent = `${party.name} (${sideLabel} · ${TYPE_LABEL[party.partyType]}) — ${docs.length} ${t('docsCountLabel').toLowerCase()}`;
  h.appendChild(hLabel);
  if(isStaffView){
    const remindBtn = document.createElement('button');
    remindBtn.className = 'btn'; remindBtn.style.cssText = 'font-size:11px; padding:3px 10px;';
    remindBtn.textContent = t('remindDocuments');
    if(!party.linkedUser){
      // Sin cuenta ligada todavía no hay a quién mandarle el correo — se
      // deja visible pero deshabilitado (con el motivo en el título) en vez
      // de desaparecer sin explicación, que es justo lo que confundía antes.
      remindBtn.disabled = true;
      remindBtn.title = t('remindNoAccountYet');
    } else {
      remindBtn.onclick = async () => {
        remindBtn.disabled = true;
        try{
          const r = await apiFetch(`/api/deals/${deal.id}/parties/${party.id}/remind`, { method:'POST' });
          remindBtn.textContent = t('sentCount', { count: r.count });
        }catch(e){ showToast(e.message, 'error'); remindBtn.disabled = false; }
      };
    }
    h.appendChild(remindBtn);

    // Solo entidades (LLC/corporation) pueden tener el checklist mal
    // poblado por el bug ya corregido — operaciones creadas antes del fix
    // siguen con documentos de persona física pegados al de la entidad.
    if(party.partyType !== 'individual'){
      const fixBtn = document.createElement('button');
      fixBtn.className = 'btn'; fixBtn.style.cssText = 'font-size:11px; padding:3px 10px;';
      fixBtn.textContent = t('fixChecklist');
      fixBtn.title = t('fixChecklistTitle');
      fixBtn.onclick = async () => {
        if(!await confirmDialog(t('fixChecklistConfirm'))) return;
        fixBtn.disabled = true;
        try{
          const r = await apiFetch(`/api/deals/${deal.id}/parties/${party.id}/fix-entity-checklist`, { method:'POST' });
          // Quitar lo malo puede dejar huecos (ej. si nunca se insertó el
          // doc correcto de la entidad porque el bug lo tapó) — rebuild
          // agrega lo que falte según la estructura actual, sin duplicar.
          await apiFetch(`/api/deals/${deal.id}/parties/${party.id}/rebuild-checklist`, { method:'POST' });
          let msg = r.deleted.length ? t('fixChecklistDone', { count: r.deleted.length }) : t('fixChecklistNothing');
          if(r.flagged.length) msg += t('fixChecklistFlagged', { count: r.flagged.length, names: r.flagged.join(', ') });
          alert(msg);
          await openDeal(deal.id);
        }catch(e){ showToast(e.message, 'error'); fixBtn.disabled = false; }
      };
      h.appendChild(fixBtn);
    }
  }
  box.appendChild(h);

  if(party.partyType !== 'individual' && !party.ownershipMode){
    const warn = document.createElement('div');
    warn.className = 'field-hint'; warn.style.cssText = 'margin:0 0 8px; color:var(--oxblood);';
    warn.textContent = t('incompleteEntityWarning');
    box.appendChild(warn);
  }

  if(!isExpanded) return box;

  // Subagrupa por sub_label — cada grupo distinto (un socio, el trust)
  // corresponde a la subcarpeta propia que le tocaría dentro de la carpeta
  // de esta parte en Drive; los documentos sin sub_label son los de la
  // propia entidad/persona (party.name), sin subcarpeta.
  const groups = [];
  const groupIndex = {};
  docs.forEach(doc => {
    const key = doc.subLabel || '';
    if (!(key in groupIndex)) { groupIndex[key] = groups.length; groups.push({ label: doc.subLabel, docs: [] }); }
    groups[groupIndex[key]].docs.push(doc);
  });
  groups.forEach(g => {
    if (g.label) {
      const gLabel = document.createElement('div');
      gLabel.style.cssText = 'font-size:12px; font-weight:500; color:var(--ink-faint); margin:8px 0 2px;';
      gLabel.textContent = g.label;
      box.appendChild(gLabel);
    }
    const ul = document.createElement('ul');
    ul.className = 'doc-list';
    g.docs.forEach(doc => ul.appendChild(buildDocItemLi(deal, doc, isStaffView)));
    box.appendChild(ul);
  });
  // El "+" para agregar un requisito extra al checklist (ej. un comprobante
  // más que el machote no previó) también lo puede usar el propio
  // comprador/vendedor, no solo staff — antes solo isStaffView lo veía, y
  // la única forma de agregar algo era pedirle a un admin/agente que lo
  // hiciera por él.
  box.appendChild(buildAddDocumentRow(deal, party.id));
  return box;
}

// Documentos de LA PROPIEDAD (Escritura pública, Predial) — una sola vez
// por operación, no ligados a ningún vendedor/comprador en particular
// (documents.deal_party_entity_id es NULL para estos). El de costos de
// cierre del notario vive aparte, ver buildNotaryClosingCostsSection abajo
// — aquí se lo excluye para no mostrarlo dos veces.
