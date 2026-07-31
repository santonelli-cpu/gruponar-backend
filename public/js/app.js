// Versión, notificaciones y arranque
// Parte de la interfaz de Grupo NAR — ver public/index.html para el orden
// en que se cargan estos archivos (todos comparten el mismo ámbito global).

let _appVersion = null;
async function checkAppVersion(){
  try{
    const res = await fetch(API_BASE + '/api/health', { cache: 'no-store' });
    const j = await res.json();
    if(!j.version) return;
    if(_appVersion === null){ _appVersion = j.version; return; }
    if(j.version !== _appVersion) showUpdateBanner();
  }catch(e){ /* sin red — el aviso puede esperar al siguiente intento */ }
}
function showUpdateBanner(){
  if(document.getElementById('update-banner')) return;
  const bar = document.createElement('div');
  bar.id = 'update-banner';
  bar.style.cssText = 'position:fixed; bottom:18px; left:50%; transform:translateX(-50%); z-index:2100;'
    + 'display:flex; align-items:center; gap:12px; padding:11px 16px; border-radius:24px;'
    + 'background:var(--oxblood-deep); color:#F6F4F0; font-size:13px; box-shadow:0 6px 24px rgba(33,22,19,0.35); max-width:calc(100vw - 36px);';
  bar.innerHTML = `<i class="ti ti-refresh" aria-hidden="true"></i><span>${t('newVersionAvailable')}</span>`;
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.style.cssText = 'font-size:12px; background:#F6F4F0; color:var(--oxblood-deep); border:0; white-space:nowrap;';
  btn.textContent = t('reloadNow');
  btn.onclick = () => location.reload();
  bar.appendChild(btn);
  document.body.appendChild(bar);
}
checkAppVersion();
setInterval(checkAppVersion, 5 * 60 * 1000);

// ---------- NOTIFICACIONES (campana del navbar, estilo Stripe) ----------
// Todo derivado del estado real (tareas asignadas, documentos por revisar
// o subir, firmas abiertas, actividad reciente) — se recalcula al cargar y
// al abrir el panel, sin estado por notificación en la base de datos.
// (El estado notifData/notifOpen/notifFilter vive junto a los demás
// globals, arriba, para que render() pueda tocarlo desde el principio.)
async function loadNotifications(){
  if(!authenticated){ updateNotifBadge(); return; }
  try{
    const r = await fetch(API_BASE + '/api/dashboard/notifications', { credentials:'include' });
    if(r.ok) notifData = await r.json();
  }catch(e){ /* sin red: la campana se queda como estaba */ }
  updateNotifBadge();
  if(notifOpen) renderNotifPanel();
}

function updateNotifBadge(){
  const bell = document.getElementById('notif-bell');
  const badge = document.getElementById('notif-badge');
  bell.style.display = authenticated ? '' : 'none';
  const n = notifData ? notifData.actionRequired.length : 0;
  badge.style.display = n ? '' : 'none';
  badge.textContent = n > 9 ? '9+' : String(n);
}

const NOTIF_TYPE_META = {
  task_assigned: { icon: 'ti-user-check',  key: 'notifTaskAssigned' },
  doc_review:    { icon: 'ti-eye-check',   key: 'notifDocReview' },
  doc_upload:    { icon: 'ti-upload',      key: 'notifDocUpload' },
  sign_pending:  { icon: 'ti-signature',   key: 'notifSignPending' }
};

function notifItemHtml(item){
  const name = lang === 'es' ? (item.labelEs || '') : (item.labelEn || item.labelEs || '');
  let icon, text;
  if(item.type === 'activity'){
    const meta = ACTIVITY_META[item.action] || { icon: 'ti-point', key: null };
    icon = meta.icon;
    const al = meta.key ? t(meta.key) : item.action;
    text = `${item.userName ? `<b>${escapeHtml(item.userName)}</b> ` : ''}${al}${item.detail ? ` — ${escapeHtml(item.detail)}` : ''}`;
  } else if(item.type === 'doc_reviewed'){
    icon = item.reviewStatus === 'approved' ? 'ti-check' : 'ti-x';
    text = `${item.reviewStatus === 'approved' ? t('notifDocApproved') : t('notifDocRejected')}: <b>${escapeHtml(name)}</b>`;
  } else {
    const meta = NOTIF_TYPE_META[item.type] || { icon: 'ti-point', key: null };
    icon = meta.icon;
    text = `${meta.key ? t(meta.key) : ''}: <b>${escapeHtml(name)}</b>${item.partyName ? ` — ${escapeHtml(item.partyName)}` : ''}`;
  }
  return `
    <span style="width:26px; height:26px; border-radius:50%; background:var(--stone); display:flex; align-items:center; justify-content:center; flex-shrink:0; color:var(--ink-soft);"><i class="ti ${icon}" aria-hidden="true" style="font-size:13px;"></i></span>
    <span style="flex:1; min-width:0;">
      <div style="font-size:12.5px;">${text}</div>
      <div class="field-hint" style="margin:1px 0 0;">${escapeHtml(item.property || '')}${item.at ? ' · ' + escapeHtml(String(item.at).replace('T',' ').slice(0,16)) : ''}</div>
    </span>`;
}

function renderNotifPanel(){
  const panel = document.getElementById('notif-panel');
  if(!notifOpen){ panel.style.display = 'none'; return; }
  panel.style.display = '';
  const action = notifData ? notifData.actionRequired : [];
  const updates = notifData ? notifData.updates : [];
  const CHIPS = [
    ['all', t('notifAll'), action.length + updates.length],
    ['action', t('notifAction'), action.length],
    ['updates', t('notifUpdates'), updates.length]
  ];
  const items = notifFilter === 'action' ? action : (notifFilter === 'updates' ? updates : [...action, ...updates]);
  panel.innerHTML = `
    <div style="font-weight:600; font-size:15px; margin-bottom:12px;">${t('notifTitle')}</div>
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px;">
      ${CHIPS.map(([id, label, count]) => `<button type="button" class="notif-chip ${notifFilter===id?'active':''}" data-filter="${id}">${escapeHtml(label)}${count ? ` <span class="tab-count">${count}</span>` : ''}</button>`).join('')}
    </div>
    ${!items.length ? `<div class="field-hint" style="margin:10px 0 4px;">${t('notifEmpty')}</div>` : ''}
    <div id="notif-list"></div>
  `;
  panel.querySelectorAll('.notif-chip').forEach(chip => {
    chip.onclick = (e) => { e.stopPropagation(); notifFilter = chip.dataset.filter; renderNotifPanel(); };
  });
  const list = panel.querySelector('#notif-list');
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'notif-item';
    row.innerHTML = notifItemHtml(item);
    row.onclick = () => {
      notifOpen = false; renderNotifPanel();
      if(['admin','agent','lawyer','external_lawyer'].includes(currentUser.role)){
        mainTab = 'admin'; adminView = 'list'; activeDealId = item.dealId; openDeal(item.dealId);
      } else {
        mainTab = 'portal'; portalDealId = item.dealId;
      }
      render();
    };
    list.appendChild(row);
  });
}

document.getElementById('notif-bell').addEventListener('click', (e) => {
  e.stopPropagation();
  notifOpen = !notifOpen;
  if(notifOpen) loadNotifications();
  renderNotifPanel();
});
document.addEventListener('click', (e) => {
  if(notifOpen && !e.target.closest('#notif-panel')){ notifOpen = false; renderNotifPanel(); }
});

// ---------- NAVEGACIÓN DE CELULAR ----------
// El menú lateral es de escritorio. En celular la misma navegación se
// re-dibuja donde el pulgar alcanza: una barra fija abajo con lo principal
// (siempre a la vista, sin tener que descubrir un ícono) y, dentro de una
// operación, un carrusel de píldoras con sus secciones. Todo sale de los
// mismos datos que arma buildSidebar, no hay una segunda lista que
// mantener.
function isNarrow(){ return window.matchMedia('(max-width:900px)').matches; }

function buildMobileNav(){
  const nav = document.getElementById('bottom-nav');
  nav.innerHTML = '';
  if(!authenticated){ nav.style.display = 'none'; return; }
  nav.style.display = '';

  // En el Portal el "nivel superior" del cliente son las secciones de SU
  // operación: es toda su app. En Admin son las áreas de la plataforma.
  const inPortalDeal = mainTab === 'portal' && _sidebarSectionItems.length;
  const source = inPortalDeal ? _sidebarSectionItems : _sidebarAppItems;
  const ICONS = ['ti-home', 'ti-file-text', 'ti-id', 'ti-signature', 'ti-list-check', 'ti-folder'];

  const items = source.slice(0, 4).map((it, i) => ({ ...it, icon: it.icon || ICONS[i] || 'ti-point' }));
  items.push({
    label: t('menuMore'), icon: 'ti-dots',
    active: false,
    onClick: () => setSidebarOpen(true)
  });

  const inner = document.createElement('div');
  inner.className = 'bottom-nav-inner';
  items.forEach(it => {
    const btn = document.createElement('button');
    btn.type = 'button';
    if(it.active) btn.classList.add('active');
    btn.innerHTML = `<i class="ti ${it.icon}" aria-hidden="true"></i><span>${escapeHtml(it.label)}</span>`
      + (it.count ? `<span class="nav-count">${it.count > 9 ? '9+' : it.count}</span>` : '');
    btn.onclick = () => { closeSidebarOnNarrow(); it.onClick(); };
    inner.appendChild(btn);
  });
  nav.appendChild(inner);
}

// Las secciones de la operación abierta, como carrusel arriba del
// contenido — solo cuando la barra inferior NO las está mostrando ya.
function buildMobileSectionPills(){
  if(!authenticated || !isNarrow()) return;
  if(mainTab === 'portal') return;              // ahí ya viven en la barra inferior
  if(!_sidebarSectionItems.length) return;
  const body = document.getElementById('body');
  const pills = document.createElement('nav');
  pills.className = 'section-pills';
  // Van DEBAJO de la tarjeta de resumen, no arriba: primero se ve de qué
  // operación se trata y cómo va, y ya con eso se navega.
  const anchor = body.querySelector('.js-pills-anchor');
  _sidebarSectionItems.forEach(it => {
    const btn = document.createElement('button');
    btn.type = 'button';
    if(it.active) btn.classList.add('active');
    btn.innerHTML = escapeHtml(it.label) + (it.count ? ` <span class="pill-count">${it.count}</span>` : '');
    btn.onclick = it.onClick;
    pills.appendChild(btn);
  });
  if(anchor) anchor.after(pills); else body.insertBefore(pills, body.firstChild);
  const activo = pills.querySelector('button.active');
  if(activo) activo.scrollIntoView({ block: 'nearest', inline: 'center' });
}

// Instalable en la pantalla de inicio y capaz de abrir con mala señal (ver
// public/sw.js). Va al final y sin bloquear: si el navegador no lo soporta
// o el registro falla, la aplicación funciona exactamente igual.
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// --- Modal de firma embebida (DocuSign) ---
loadData();
