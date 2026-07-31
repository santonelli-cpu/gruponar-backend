// Estado, API, adaptadores, menú lateral y render
// Parte de la interfaz de Grupo NAR — ver public/index.html para el orden
// en que se cargan estos archivos (todos comparten el mismo ámbito global).

const API_BASE = '';

let deals = [];
let mainTab = 'admin';
let adminView = 'dashboard';
let dealsListFilter = 'active';
let dashboardData = null;
let pendingUsers = null;
let activeTeamMembers = null;
let clientsCache = undefined;
let clientsSearch = '';
let clientsRoleFilter = 'all';
let kycCache = {};
let kycFormOpenFor = null;

// Agregar/quitar un agente (o cambiar a qué lado representa) puede cambiar
// si una parte necesita el expediente extra de LPR Luxury (ver
// dealAgentIsLprAgency en routes/kyc.js) — sin esto, buildKycSection sigue
// sirviendo el kycCache viejo (sin lprRequired) hasta un refresh manual.
function clearKycCacheForDeal(dealId){
  const prefix = dealId + '-';
  Object.keys(kycCache).forEach(k => { if(k.startsWith(prefix)) delete kycCache[k]; });
}
let contractCache = {};
let availableAgentsCache = {};
let notaryPaymentNote = undefined;
// Cuáles tarjetas de "Pendientes por operación" del Dashboard están
// desplegadas — sin entrada todavía, una tarjeta con pocos pendientes
// arranca abierta y una con muchos arranca cerrada (ver buildDashboard).
let dashboardExpandedGroups = {};
let docChecklistExpanded = {};
let waitingOnYouExpanded = {};
let docActionsMenuFor = null;
let dealsSearch = '';
let dealDetailTab = 'parties';
let dealDetailTabDeal = null;
// Pestaña activa del Portal cliente/agente (espejo de dealDetailTab pero
// para renderPortal) — se resetea al cambiar de operación o de "ver como".
let portalTab = 'docs';
let portalTabKey = null;
// Con más de una operación, el Portal abre en un panel con todas (igual que
// el Dashboard del admin, pero solo con lo suyo) en vez de meterse directo
// a una: un agente con cinco cierres necesita ver primero el conjunto.
let portalView = 'overview';
// Campana de notificaciones (ver módulo al final del script).
let notifData = null;
let notifOpen = false;
let notifFilter = 'all';
let teamAssigneesCache = undefined;
let activityCache = {};

// Toast (esquina inferior derecha, se va solo) — reemplaza alert() para
// confirmaciones y errores; los errores duran más para alcanzar a leerlos.
// Vive fuera de #body para sobrevivir a los render().
function showToast(message, type = 'info'){
  let stack = document.getElementById('toast-stack');
  if(!stack){
    stack = document.createElement('div');
    stack.id = 'toast-stack';
    document.body.appendChild(stack);
  }
  const toast = document.createElement('div');
  toast.className = 'toast ' + (type === 'error' ? 'error' : type === 'success' ? 'success' : '');
  const icon = type === 'error' ? 'ti-alert-circle' : type === 'success' ? 'ti-circle-check' : 'ti-info-circle';
  toast.innerHTML = `<i class="ti ${icon}" aria-hidden="true"></i><span></span>`;
  toast.querySelector('span').textContent = message;
  stack.appendChild(toast);
  const ttl = type === 'error' ? 6000 : 3500;
  setTimeout(() => {
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 300);
  }, ttl);
}

// Reemplazo estilizado de confirm() — devuelve una promesa true/false.
// `danger: true` pinta el botón de confirmar en rojo (borrar, quitar...).
function confirmDialog(message, { danger = false, confirmLabel } = {}){
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.innerHTML = `
      <div class="dialog-box">
        <p></p>
        <div class="dialog-actions">
          <button class="btn dlg-cancel">${t('cancel')}</button>
          <button class="btn ${danger ? 'danger' : 'primary'} dlg-ok">${confirmLabel || t('confirmLabel')}</button>
        </div>
      </div>
    `;
    overlay.querySelector('p').textContent = message;
    const close = (val) => { overlay.remove(); window.removeEventListener('keydown', onKey); resolve(val); };
    const onKey = (e) => { if(e.key === 'Escape') close(false); if(e.key === 'Enter') close(true); };
    overlay.onclick = (e) => { if(e.target === overlay) close(false); };
    overlay.querySelector('.dlg-cancel').onclick = () => close(false);
    overlay.querySelector('.dlg-ok').onclick = () => close(true);
    window.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    overlay.querySelector('.dlg-ok').focus();
  });
}

// Estado de carga en botones de acciones lentas (generar PDF, mandar a
// firma): deshabilita, muestra spinner conservando el ancho, y restaura al
// terminar — el usuario ve que algo está pasando y no puede dar doble clic.
async function withButtonLoading(btn, fn){
  const original = btn.innerHTML;
  const width = btn.offsetWidth;
  btn.disabled = true;
  btn.style.minWidth = width + 'px';
  btn.innerHTML = '<span class="btn-spinner"></span>';
  try{
    return await fn();
  } finally {
    btn.disabled = false;
    btn.style.minWidth = '';
    btn.innerHTML = original;
  }
}

async function loadTeamAssignees(dealId){
  teamAssigneesCache = null; // en vuelo — no volver a pedir en cada render
  try{ teamAssigneesCache = await apiFetch(`/api/deals/${dealId}/team-assignees`); }
  catch(e){ teamAssigneesCache = []; }
  render();
}

async function loadActivity(dealId){
  try{ activityCache[dealId] = await apiFetch(`/api/deals/${dealId}/activity`); }
  catch(e){ activityCache[dealId] = { error: e.message }; }
  render();
}
let driveStatus = null;
let escrowFormOpenFor = null;
let activeDealId = null;
let trashedDeals = null;
let dealMenuOpenFor = null;
let portalRole = 'agent'; // solo se usa en isPreview para elegir "Agente" vs una parte específica
let portalPartyId = null; // qué deal_party_entities.id está previsualizando el staff
let portalDealId = null;
let newDealDraft = null;
let authenticated = false;
let currentUser = null;
let loginError = '';
let loginLoading = false;
let checkingSession = true;
let authView = 'login';
let registerError = '';
let registerLoading = false;
let registerSuccess = '';
let forgotLoading = false;
let forgotMessage = '';
// Segundo factor obligatorio (ver POST /api/auth/login y /api/auth/totp) —
// pendingTotp queda null hasta que la contraseña ya se validó; method es
// 'choose' (cuenta nueva, sin 2FA todavía — se le ofrecen las dos opciones),
// 'totp' (ya usa la app) o 'email' (ya usa correo, o lo acaba de elegir en
// la pantalla de 'choose').
let pendingTotp = null; // { method, qrCode, secret }
let totpCode = '';
let totpError = '';
let totpLoading = false;
let totpEmailSending = false;
let totpRemember = true;


async function apiFetch(path, options={}){
  let res;
  try{
    res = await fetch(API_BASE + path, {
      credentials: 'include',
      headers: {'Content-Type':'application/json'},
      ...options
    });
  }catch(e){
    // fetch solo lanza por red caída/servidor inalcanzable — "Failed to
    // fetch" crudo no le dice nada a nadie; esto sí.
    throw new Error(t('networkError'));
  }
  let body = null;
  try{ body = await res.json(); }catch(e){}
  if(!res.ok) throw new Error((body && body.error) || `Error ${res.status}`);
  return body;
}

// Como apiFetch, pero para subir archivos (FormData) — no fuerza
// Content-Type: application/json, así el navegador pone el boundary de
// multipart automáticamente.
async function apiUpload(path, formData){
  let res;
  try{
    res = await fetch(API_BASE + path, { method:'POST', credentials:'include', body: formData });
  }catch(e){
    throw new Error(t('networkError'));
  }
  let body = null;
  try{ body = await res.json(); }catch(e){}
  if(!res.ok) throw new Error((body && body.error) || `Error ${res.status}`);
  return body;
}

async function checkSession(){
  try{
    const user = await apiFetch('/api/auth/me');
    currentUser = user;
    authenticated = true;
    mainTab = (user.role === 'buyer' || user.role === 'seller') ? 'portal' : 'admin';
  }catch(e){
    authenticated = false;
    currentUser = null;
  }
  checkingSession = false;
}

// --- Adaptadores: el backend devuelve filas planas/snake_case (deals,
// documents, tasks); el resto del código de esta página ya espera la forma
// anidada/camelCase de abajo — un solo lugar traduce entre ambas.
function adaptDoc(d){
  return {
    id: d.id, name: d.name, subLabel: d.sub_label, status: d.status,
    fileUrl: d.file_url, originalName: d.original_name, partyId: d.deal_party_entity_id,
    section: d.section || null,
    subChecks: d.sub_checks_json ? JSON.parse(d.sub_checks_json) : {},
    reviewStatus: d.review_status || 'pending', reviewNote: d.review_note || null
  };
}
const AGENCIES = ['LPR Luxury', 'Applegate Realtors', 'JPM Real Estate', 'Interamerican'];
// Estos documentos de LLC llegan primero como copia escaneada simple y
// después con estos requisitos ya cumplidos, cada uno por separado (Good
// Standing no se notariza, por eso no lo tiene) — mismos nombres/listas que
// routes/deals.js SUB_CHECKS_BY_DOC.
const SUB_CHECKS_BY_DOC = {
  'Good Standing': ['Apostilled', 'Translated'],
  'Operating Agreement': ['Notarized', 'Apostilled', 'Translated'],
  'Articles of organization': ['Notarized', 'Apostilled', 'Translated']
};
function adaptTask(t){
  return {
    id: t.id, en: t.label_en, es: t.label_es, status: t.status, sign: !!t.requires_signature,
    docType: t.doc_type || 'manual', signSide: t.sign_side || null,
    docusignStatus: t.docusign_status, documentOriginalName: t.document_original_name,
    docusignEnvelopeId: t.docusign_envelope_id || null,
    assignedTo: t.assigned_to || null, assignedToName: t.assigned_to_name || null
  };
}
// Un vendedor/comprador individual, o una entidad (LLC/persona moral) con su
// estructura de propiedad — reemplaza el viejo .seller/.buyer singular.
function adaptParty(p){
  return {
    id: p.id, side: p.side, sortOrder: p.sort_order, name: p.name, partyType: p.party_type,
    ownershipMode: p.ownership_mode,
    parentEntityName: p.parent_entity_name, parentEntityType: p.parent_entity_type,
    parentHasTrustAbove: !!p.parent_has_trust_above, parentTrustName: p.parent_trust_name,
    directTrustName: p.direct_trust_name,
    owners: (p.owners || []).map(o => ({ id: o.id, name: o.name })),
    linkedUser: p.linkedUser || null,
    linkedAttorney: p.linkedAttorney || null,
    linkedUserIds: p.linkedUserIds || []
  };
}
function sellerParties(deal){ return deal.parties.filter(p => p.side === 'seller'); }
function buyerParties(deal){ return deal.parties.filter(p => p.side === 'buyer'); }
function dealPartyNames(deal, side){ return deal.parties.filter(p => p.side === side).map(p => p.name).join(' y '); }

function adaptDealSummary(row){
  return {
    id: row.id, scenario: row.scenario, development: row.development, property: row.property,
    price: row.price, furniturePrice: row.furniture_price, currency: row.currency, startDate: row.start_date,
    escrowCompany: row.escrow_company || 'armour',
    closingDate: row.closing_date || '', dueDiligenceEndDate: row.due_diligence_end_date || '',
    status: row.status || 'active', closedAt: row.closed_at || null, legalActs: row.legal_acts || '',
    lastProgressEmailAt: row.last_progress_email_at || null,
    driveFolderId: row.drive_folder_id || null, driveFolderUrl: row.drive_folder_url || null,
    parties: (row.parties || []).map(adaptParty),
    agents: row.agents || [],
    documents: [], tasks: [], _loaded: false,
    _counts: {
      documentsTotal: row.documents_total || 0, documentsDone: row.documents_done || 0,
      tasksTotal: row.tasks_total || 0, tasksDone: row.tasks_done || 0
    }
  };
}
function adaptDealDetail(row){
  const base = adaptDealSummary(row);
  base.documents = row.documents.map(adaptDoc);
  base.tasks = row.tasks.map(adaptTask);
  base._loaded = true;
  return base;
}

// Mismo criterio que defaultKycLang en routes/kyc.js (duplicado a propósito,
// como AGENCIES — no hay endpoint de catálogos): compraventa directa, ambos
// mexicanos; fideicomiso, vendedor mexicano y comprador extranjero; cesión
// de derechos, ambos extranjeros; extinción de fideicomiso, vendedor
// extranjero y comprador mexicano. Se usa para que el portal le aparezca ya
// en su idioma a un comprador/vendedor extranjero desde el primer login, en
// vez de asumir español siempre.
const DEFAULT_LANG_BY_SCENARIO_SIDE = {
  purchase: { seller: 'es', buyer: 'es' },
  trust: { seller: 'es', buyer: 'en' },
  transfer: { seller: 'en', buyer: 'en' },
  trust_termination: { seller: 'en', buyer: 'es' }
};

async function loadData(){
  await checkSession();
  if(!authenticated){ deals = []; render(); return; }
  try{
    const rows = await apiFetch('/api/deals');
    deals = rows.map(adaptDealSummary);
  }catch(e){ deals = []; }
  // Solo si nunca eligió idioma a mano (el toggle ES/EN sí queda guardado
  // permanentemente en cuanto lo usan una vez) y es comprador/vendedor —
  // admin/agente/abogado coordinan en varios idiomas, no tiene sentido
  // adivinarles uno.
  if(!localStorage.getItem('nar_lang') && ['buyer','seller'].includes(currentUser.role)){
    const myDeal = deals.find(d => d.parties.some(p => p.linkedUserIds.includes(currentUser.id)));
    const myParty = myDeal && myDeal.parties.find(p => p.linkedUserIds.includes(currentUser.id));
    if(myDeal && myParty){
      const bySide = DEFAULT_LANG_BY_SCENARIO_SIDE[myDeal.scenario];
      if(bySide && bySide[myParty.side]) lang = bySide[myParty.side];
    }
  }
  if(['admin','agent','lawyer','external_lawyer'].includes(currentUser.role)) loadDashboard();
  if(currentUser.role === 'admin'){ loadPendingUsers(); loadTrash(); }
  loadNotifications();
  // Link directo a una operación (ej. desde el correo de "te agregamos a
  // esta operación") — ?dealId=123 en la URL la abre de una vez.
  const linkedDealId = Number(new URLSearchParams(window.location.search).get('dealId'));
  if(linkedDealId && ['admin','agent','lawyer','external_lawyer'].includes(currentUser.role)){
    mainTab = 'admin'; adminView = 'list'; activeDealId = linkedDealId;
    openDeal(linkedDealId);
  }
  render();
}

async function loadDashboard(){
  try{ dashboardData = await apiFetch('/api/dashboard'); }
  catch(e){ dashboardData = null; }
  render();
}

async function loadTrash(){
  try{ trashedDeals = await apiFetch('/api/deals/trash'); }
  catch(e){ trashedDeals = []; }
  render();
}

async function loadPendingUsers(){
  try{
    const all = await apiFetch('/api/users');
    pendingUsers = all.filter(u => u.status === 'pending');
    activeTeamMembers = all.filter(u => u.status === 'active' && ['agent','lawyer','external_lawyer'].includes(u.role));
  }catch(e){ pendingUsers = null; activeTeamMembers = null; }
  render();
}

async function openDeal(dealId){
  try{
    const full = await apiFetch('/api/deals/' + dealId);
    const adapted = adaptDealDetail(full);
    const idx = deals.findIndex(d=>d.id===dealId);
    if(idx>=0) deals[idx] = adapted; else deals.push(adapted);
    // La línea de tiempo se refresca junto con la operación — casi
    // cualquier acción que dispara openDeal también generó actividad nueva.
    delete activityCache[dealId];
  }catch(e){
    showToast(e.message, 'error');
    // La operación ya no existe (alguien más la borró) o ya no la puedes
    // ver — antes se quedaba la copia vieja en `deals` (de cuando sí
    // existía) y el detalle se seguía mostrando con esos datos viejos
    // justo después del aviso de error. Se quita de la lista en memoria y
    // se regresa a la lista, en vez de dejar la operación "fantasma"
    // abierta.
    deals = deals.filter(d => d.id !== dealId);
    if(activeDealId === dealId) activeDealId = null;
  }
  render();
}

async function loadKyc(dealId, partyId, lang, kind){
  kind = kind || 'escrow';
  const key = dealId + '-' + partyId + '-' + kind;
  try{
    const params = new URLSearchParams();
    if(lang) params.set('lang', lang);
    if(kind === 'lpr') params.set('kind', 'lpr');
    const qs = params.toString() ? '?' + params.toString() : '';
    kycCache[key] = await apiFetch(`/api/deals/${dealId}/kyc/${partyId}${qs}`);
  }catch(e){
    kycCache[key] = { error: e.message };
  }
  render();
}

async function loadContract(dealId){
  try{
    contractCache[dealId] = await apiFetch(`/api/deals/${dealId}/contract`);
  }catch(e){
    contractCache[dealId] = { error: e.message };
  }
  render();
}

async function loadNotaryPaymentNote(){
  try{
    const { note } = await apiFetch('/api/settings/notary-payment-note');
    notaryPaymentNote = note || '';
  }catch(e){
    notaryPaymentNote = '';
  }
  render();
}

async function loadAvailableAgents(dealId){
  try{
    availableAgentsCache[dealId] = await apiFetch(`/api/deals/${dealId}/available-agents`);
  }catch(e){
    availableAgentsCache[dealId] = { error: e.message };
  }
  render();
}

function escapeHtml(str){
  if(str===undefined||str===null) return '';
  return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function pctDocs(deal){
  if(!deal._loaded) return deal._counts.documentsTotal ? Math.round(deal._counts.documentsDone/deal._counts.documentsTotal*100) : 0;
  const done = deal.documents.filter(d=>d.status==='done').length;
  return deal.documents.length ? Math.round(done/deal.documents.length*100) : 0;
}
function pctTasks(deal){
  if(!deal._loaded) return deal._counts.tasksTotal ? Math.round(deal._counts.tasksDone/deal._counts.tasksTotal*100) : 0;
  const done = deal.tasks.filter(t=>t.status==='done').length;
  return deal.tasks.length ? Math.round(done/deal.tasks.length*100) : 0;
}
// Un solo % que combina documentos + tracker — para la barra de una sola
// línea de las tarjetas de operación del Portal (ahí no hace falta el
// desglose en dos, solo un vistazo rápido de qué tan avanzada va).
function overallPct(deal){
  if(!deal._loaded){
    const total = deal._counts.documentsTotal + deal._counts.tasksTotal;
    const done = deal._counts.documentsDone + deal._counts.tasksDone;
    return total ? Math.round(done/total*100) : 0;
  }
  const total = deal.documents.length + deal.tasks.length;
  const done = deal.documents.filter(d=>d.status==='done').length + deal.tasks.filter(t=>t.status==='done').length;
  return total ? Math.round(done/total*100) : 0;
}
// La parte (deal_party_entity) de esta operación ligada a la cuenta actual
// — null si quien mira es staff sin parte transaccional propia (admin,
// agente, abogado). Se usa para la etiqueta BUYER/SELLER de cada tarjeta y
// para saber de qué lado calcular "waiting on you".
function myPartyInDeal(deal){
  return deal.parties.find(p => p.linkedUserIds.includes(currentUser.id)) || null;
}

// Cada render() reconstruye el DOM completo y el navegador brincaba al
// inicio de la página en CADA acción (marcar un documento, asignar una
// tarea...) — se preserva el scroll mientras sigas viendo la MISMA vista;
// al cambiar de vista (otra pestaña, abrir/cerrar una operación) sí se va
// arriba, que es lo esperado.
let _lastViewKey = null;
function currentViewKey(){
  return [authenticated, mainTab, adminView, activeDealId, dealDetailTab, portalRole, portalPartyId, portalTab, portalView, portalDealId].join('|');
}

// ---------- MENÚ LATERAL ----------
// Una sola columna fija a la izquierda con TODO lo navegable: las secciones
// de la plataforma y, cuando hay una operación abierta, sus secciones
// colgando debajo. Antes esto vivía en dos barras dentro del contenido, y
// cualquier cosa que creciera arriba (el aviso de "te toca a ti", por
// ejemplo) empujaba la navegación fuera de la pantalla.
// Cajón del menú en ventana angosta — abrir/cerrar y cerrarse solo al
// elegir una sección (si no, tapa justo lo que acabas de abrir).
let _activeSectionLabel = '';
// El menú lateral, como datos: secciones de la plataforma, operaciones del
// Portal y secciones de la operación abierta. En celular se re-dibujan como
// barra inferior y como píldoras (ver buildMobileNav en app.js).
let _sidebarAppItems = [];
let _sidebarDealItems = [];
let _sidebarSectionItems = [];

function setSidebarOpen(open){
  document.getElementById('sidebar').classList.toggle('open', open);
  document.getElementById('sidebar-scrim').classList.toggle('open', open);
}
function closeSidebarOnNarrow(){
  if(window.matchMedia('(max-width:900px)').matches) setSidebarOpen(false);
}

function sidebarGroup(title){
  const el = document.createElement('div');
  el.className = 'side-group';
  el.textContent = title;
  document.getElementById('sidebar').appendChild(el);
}

function sidebarItem({ label, icon, count, active, sub, group, onClick }){
  // La última sección activa que se agrega es la más específica (las de la
  // operación van después de las de la plataforma) — es la que el botón de
  // menú muestra en pantalla angosta.
  if(active) _activeSectionLabel = label;
  // El mismo menú alimenta, en celular, la barra inferior y el carrusel de
  // píldoras (ver buildMobileNav) — se guarda como datos para no tener que
  // escribir esa navegación por segunda vez en cada vista.
  (group === 'sections' ? _sidebarSectionItems : group === 'deals' ? _sidebarDealItems : _sidebarAppItems)
    .push({ label, icon, count, active, onClick });
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'side-item' + (active ? ' active' : '') + (sub ? ' side-sub' : '');
  btn.innerHTML = `${icon ? `<i class="ti ${icon}" aria-hidden="true"></i>` : ''}<span>${escapeHtml(label)}</span>${count ? `<span class="side-count">${count}</span>` : ''}`;
  btn.onclick = () => { closeSidebarOnNarrow(); onClick(); };
  document.getElementById('sidebar').appendChild(btn);
  return btn;
}

function sidebarDivider(){
  const el = document.createElement('div');
  el.className = 'side-divider';
  document.getElementById('sidebar').appendChild(el);
}

// Las secciones de una operación (admin o Portal) — se llaman desde la
// vista que las conoce, para no duplicar aquí la lógica de qué pestañas
// aplican a quién.
function sidebarSections(tabs, activeId, onSelect){
  sidebarGroup(t('sideSections'));
  tabs.forEach(([id, label, count]) => sidebarItem({
    label, count, sub: true, group: 'sections', active: activeId === id, onClick: () => onSelect(id)
  }));
}

// Pie del menú: quién está adentro, con acceso a su perfil y a salir —
// como el selector de cuenta de Stripe. Antes esto era una tarjeta grande
// arriba del contenido que había que saltarse en cada pantalla.
function buildSidebarAccount(){
  const el = document.getElementById('sidebar');
  const spacer = document.createElement('div');
  spacer.style.cssText = 'flex:1; min-height:16px;';
  el.appendChild(spacer);
  const box = document.createElement('div');
  box.className = 'side-account';
  box.innerHTML = `
    <div style="display:flex; align-items:center; gap:9px; min-width:0;">
      ${avatarHtml(currentUser, 30)}
      <div style="min-width:0;">
        <div style="font-size:12.5px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(currentUser.name)}</div>
        <div style="font-size:11px; color:var(--ink-faint);">${roleDisplayLabel(currentUser.role)}</div>
      </div>
    </div>
    <div style="display:flex; gap:6px; margin-top:8px;">
      <button class="btn" id="side-prof" style="font-size:11px; padding:5px 10px; flex:1;"><i class="ti ti-user-edit" aria-hidden="true"></i> ${t('editProfile')}</button>
      <button class="btn" id="side-logout" style="font-size:11px; padding:5px 10px;" title="${t('logout')}"><i class="ti ti-logout" aria-hidden="true"></i></button>
    </div>
  `;
  el.appendChild(box);
  box.querySelector('#side-logout').onclick = logout;
  box.querySelector('#side-prof').onclick = () => {
    profileEditOpen = !profileEditOpen;
    if(profileEditOpen && mainTab === 'admin' && (activeDealId || adminView === 'newDeal')){ activeDealId = null; adminView = 'list'; }
    render();
  };
}

function buildSidebar(){
  const el = document.getElementById('sidebar');
  el.innerHTML = '';
  el.style.display = authenticated ? '' : 'none';
  document.getElementById('menu-toggle').style.visibility = authenticated ? 'visible' : 'hidden';
  _activeSectionLabel = '';
  _sidebarAppItems = []; _sidebarDealItems = []; _sidebarSectionItems = [];
  if(!authenticated){ setSidebarOpen(false); return; }

  if(mainTab === 'admin'){
    sidebarGroup(t('sideMain'));
    sidebarItem({ label: t('navDashboard'), icon: 'ti-layout-dashboard', active: adminView === 'dashboard',
      onClick: () => { adminView='dashboard'; activeDealId=null; loadDashboard(); } });
    sidebarItem({ label: t('navOperations'), icon: 'ti-building-estate', active: adminView === 'list' || !!activeDealId || adminView === 'newDeal',
      onClick: () => { adminView='list'; activeDealId=null; render(); } });
    if(currentUser.role === 'admin'){
      sidebarItem({ label: t('navTeam'), icon: 'ti-users', count: pendingUsers && pendingUsers.length, active: adminView === 'team',
        onClick: () => { adminView='team'; activeDealId=null; render(); } });
      sidebarItem({ label: t('navClients'), icon: 'ti-address-book', active: adminView === 'clients',
        onClick: () => { adminView='clients'; activeDealId=null; render(); } });
      sidebarItem({ label: t('navTrash'), icon: 'ti-trash', count: trashedDeals && trashedDeals.length, active: adminView === 'trash',
        onClick: () => { adminView='trash'; activeDealId=null; loadTrash(); } });
    }
  }
}

function render(){
  const viewKey = currentViewKey();
  const sameView = viewKey === _lastViewKey;
  // El scroll ahora vive en la columna de contenido, no en la ventana (el
  // armazón es de altura fija para que el menú lateral llegue hasta abajo).
  const scroller = document.getElementById('body');
  const scrollY = scroller ? scroller.scrollTop : 0;
  _lastViewKey = viewKey;
  renderInner();
  if(sameView){
    if(scroller) scroller.scrollTop = scrollY;
  } else {
    if(scroller) scroller.scrollTop = 0;
  }
}

function renderInner(){
  document.getElementById('mainTabs').style.visibility = authenticated ? 'visible' : 'hidden';
  document.getElementById('header-logout').style.display = authenticated ? '' : 'none';
  updateNotifBadge();
  if(!authenticated && notifOpen){ notifOpen = false; renderNotifPanel(); }
  document.getElementById('tab-admin').textContent = currentUser && currentUser.role === 'admin' ? t('tabAdmin') : t('tabStaffOperations');
  document.getElementById('tab-portal').textContent = t('tabPortal');
  document.getElementById('navbar-caption').textContent = t('gateBrandEyebrow');
  document.getElementById('lang-toggle').textContent = lang === 'es' ? 'EN' : 'ES';
  document.getElementById('lang-toggle').onclick = () => setLang(lang === 'es' ? 'en' : 'es');
  document.documentElement.lang = lang;
  // La pantalla de login/registro/olvide-contrasena es de pantalla completa
  // (split-screen), sin el head-band de arriba ni el padding normal del
  // body-wrap -- se restauran en cuanto hay sesion.
  document.querySelector('.head-band').style.display = authenticated ? '' : 'none';
  const body = document.getElementById('body');
  body.style.padding = authenticated ? '' : '0';
  body.innerHTML = '';
  buildSidebar();
  if(checkingSession){
    body.innerHTML = `<div class="empty"><i class="ti ti-loader-2" aria-hidden="true"></i><div>${t('checkingSession')}</div></div>`;
    return;
  }
  if(!authenticated){
    renderLogin(body);
    return;
  }
  document.querySelectorAll('#mainTabs .tab-btn').forEach(b=>b.classList.toggle('active', b.dataset.tab===mainTab));
  // Admin/agente ven ambas pestañas; a un comprador/vendedor el selector
  // completo se le esconde: con una sola opción era una píldora que decía
  // "Portal cliente / agente" y no llevaba a ningún lado, ocupando media
  // barra en el celular.
  const staffView = ['admin','agent','lawyer','external_lawyer'].includes(currentUser.role);
  const adminTabBtn = document.querySelector('#mainTabs [data-tab="admin"]');
  if(adminTabBtn) adminTabBtn.style.display = staffView ? '' : 'none';
  document.getElementById('mainTabs').style.display = staffView ? '' : 'none';
  if(mainTab === 'admin') renderAdmin(body);
  else renderPortal(body);
  // Al final, para que quede hasta abajo del menú: las secciones de la
  // operación abierta se agregan durante renderAdmin/renderPortal.
  buildSidebarAccount();
  // El botón de menú (pantalla angosta) dice dónde estás — así se entiende
  // que hay más secciones y no solo la pantalla que se abrió.
  const menuLabel = document.querySelector('#menu-toggle .menu-label');
  if(menuLabel) menuLabel.textContent = _activeSectionLabel || t('menuLabel');
  // La misma navegación, re-dibujada para el pulgar (ver app.js).
  buildMobileNav();
  buildMobileSectionPills();
}

// Panel izquierdo de marca (logo + mensaje) compartido entre login/registro/
// olvide-contrasena -- solo cambia el contenido del panel derecho.
