const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const fmt = value => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(value || 0));
const dateFmt = value => new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium' }).format(new Date(value));
let token = localStorage.getItem('cuentas_token');
let clients = [];
let historyClients = [];
let selectedId = null;
let detail = null;
let activeTab = 'purchases';
let movementType = 'purchase';
let detailReadonly = false;

const savedTheme = localStorage.getItem('cuentas_theme');
if (savedTheme === 'dark' || (!savedTheme && matchMedia('(prefers-color-scheme: dark)').matches)) document.documentElement.dataset.theme = 'dark';
$('#themeBtn').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  localStorage.setItem('cuentas_theme', dark ? 'dark' : 'light');
});

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && url !== '/api/login') logout();
  if (!response.ok) throw new Error(data.error || 'No fue posible completar la operación.');
  return data;
}

function notify(message, error = false) {
  const toast = $('#toast'); toast.textContent = message; toast.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(notify.timer); notify.timer = setTimeout(() => toast.className = 'toast', 2800);
}

function showApp(username) {
  $('#loginView').classList.add('hidden'); $('#appView').classList.remove('hidden');
  $('#userLabel').textContent = username || 'Admin'; loadClients();
}

function logout() { token = null; localStorage.removeItem('cuentas_token'); $('#appView').classList.add('hidden'); $('#loginView').classList.remove('hidden'); }

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = new FormData(event.currentTarget);
  try { const data = await api('/api/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) }); token = data.token; localStorage.setItem('cuentas_token', token); showApp(data.username); }
  catch (error) { notify(error.message, true); }
});
$('#logoutBtn').addEventListener('click', logout);

async function loadClients(query = '') {
  try { clients = await api(`/api/clientes?q=${encodeURIComponent(query)}`); renderClients(); } catch (error) { notify(error.message, true); }
}

async function loadHistory(query = '') {
  try { historyClients = await api(`/api/historial?q=${encodeURIComponent(query)}`); renderHistory(); } catch (error) { notify(error.message, true); }
}

function renderHistory() {
  $('#historyBody').innerHTML = historyClients.map(client => `<tr><td><strong>${escapeHtml(client.nombre)}</strong><small>${escapeHtml(client.telefono || 'Sin teléfono')}</small></td><td>${fmt(client.totalCompras)}</td><td>${fmt(client.totalEnganches)}</td><td class="paid">${fmt(client.totalAbonos)}</td><td><span class="history-status">Saldada</span></td><td><div class="row-actions"><button class="icon-btn history-detail" data-id="${client._id}" title="Ver historial">⌕</button></div></td></tr>`).join('');
  $('#historyCount').textContent = `${historyClients.length} ${historyClients.length === 1 ? 'registro' : 'registros'}`;
  $('#historyEmpty').classList.toggle('hidden', historyClients.length > 0);
  $('#historyTableWrap').classList.toggle('hidden', historyClients.length === 0);
}

function switchView(view) {
  const history = view === 'history';
  $('#clientsView').classList.toggle('hidden', history); $('#historyView').classList.toggle('hidden', !history);
  $('#clientsNav').classList.toggle('nav-active', !history); $('#historyNav').classList.toggle('nav-active', history);
  const target = history ? $('#historyView') : $('#clientsView'); target.classList.remove('view-enter'); requestAnimationFrame(() => target.classList.add('view-enter'));
  if (history) loadHistory($('#historySearch').value); else loadClients($('#searchInput').value);
}

$('#clientsNav').addEventListener('click', () => switchView('clients'));
$('#historyNav').addEventListener('click', () => switchView('history'));
let historySearchTimer;
$('#historySearch').addEventListener('input', event => { clearTimeout(historySearchTimer); historySearchTimer = setTimeout(() => loadHistory(event.target.value), 250); });
$('#historyBody').addEventListener('click', event => { const button = event.target.closest('.history-detail'); if (button) openDetail(button.dataset.id, true); });
$('#downloadPdfBtn').addEventListener('click', async () => {
  try {
    const response = await fetch(`/api/historial/pdf?q=${encodeURIComponent($('#historySearch').value)}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error('No fue posible generar el PDF.');
    const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = $('#historySearch').value ? 'historial-filtrado.pdf' : 'historial.pdf'; link.click(); URL.revokeObjectURL(url);
    notify('PDF descargado correctamente.');
  } catch (error) { notify(error.message, true); }
});

function renderClients() {
  $('#clientsBody').innerHTML = clients.map(client => `<tr><td><strong>${escapeHtml(client.nombre)}</strong><small>${escapeHtml(client.telefono || 'Sin teléfono')}</small></td><td>${fmt(client.totalCompras)}</td><td>${fmt(client.totalEnganches)}</td><td class="paid">${fmt(client.totalAbonos)}</td><td class="debt">${fmt(client.deuda)}</td><td><div class="row-actions"><button class="icon-btn detail" data-id="${client._id}" title="Ver movimientos">⌕</button><button class="icon-btn edit" data-id="${client._id}" title="Editar">✎</button><button class="icon-btn delete" data-id="${client._id}" title="Eliminar">×</button></div></td></tr>`).join('');
  $('#clientCount').textContent = `${clients.length} ${clients.length === 1 ? 'registro' : 'registros'}`;
  $('#totalDebt').textContent = fmt(clients.reduce((s, x) => s + x.deuda, 0));
  $('#totalPaid').textContent = fmt(clients.reduce((s, x) => s + x.totalAbonos + x.totalEnganches, 0));
  $('#activeClients').textContent = clients.filter(x => x.deuda > 0).length;
  $('#emptyState').classList.toggle('hidden', clients.length > 0); $('.table-wrap').classList.toggle('hidden', clients.length === 0);
}

function escapeHtml(value) { const div = document.createElement('div'); div.textContent = value ?? ''; return div.innerHTML; }
let searchTimer;
$('#searchInput').addEventListener('input', event => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadClients(event.target.value), 250); });
$('#newClientBtn').addEventListener('click', () => openClient());

function openClient(client = null) {
  const form = $('#clientForm'); form.reset(); form.id.value = client?._id || ''; form.nombre.value = client?.nombre || ''; form.telefono.value = client?.telefono || '';
  $('#clientTitle').textContent = client ? 'Editar cliente' : 'Nuevo cliente'; $('#clientDialog').showModal();
}

$('#clientForm').addEventListener('submit', async event => {
  event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); const id = values.id; delete values.id;
  try { await api(id ? `/api/clientes/${id}` : '/api/clientes', { method: id ? 'PUT' : 'POST', body: JSON.stringify(values) }); $('#clientDialog').close(); notify(id ? 'Cliente actualizado.' : 'Cliente agregado.'); loadClients($('#searchInput').value); }
  catch (error) { notify(error.message, true); }
});

$('#clientsBody').addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return; const client = clients.find(x => x._id === button.dataset.id);
  if (button.classList.contains('detail')) openDetail(client._id, false);
  if (button.classList.contains('edit')) openClient(client);
  if (button.classList.contains('delete') && confirm(`¿Eliminar a ${client.nombre} y todo su historial? Esta acción no se puede deshacer.`)) {
    try { await api(`/api/clientes/${client._id}`, { method: 'DELETE' }); notify('Cliente eliminado.'); loadClients($('#searchInput').value); } catch (error) { notify(error.message, true); }
  }
});

async function openDetail(id, readonly = false) {
  selectedId = id;
  detailReadonly = readonly;
  try { detail = await api(`/api/clientes/${id}/movimientos`); $('#detailName').textContent = detail.cliente.nombre; $('#detailPhone').textContent = detail.cliente.telefono || 'Sin teléfono'; $('#detailDebt').textContent = readonly ? 'SALDADA' : fmt(detail.deuda); $('.detail-actions').classList.toggle('hidden', readonly); renderMovements(); if (!$('#detailDialog').open) $('#detailDialog').showModal(); }
  catch (error) { notify(error.message, true); }
}

function renderMovements() {
  const items = activeTab === 'purchases' ? detail.compras : detail.abonos;
  $('#movementsList').innerHTML = items.length ? items.map(item => activeTab === 'purchases'
    ? `<article class="movement"><span class="movement-icon">▣</span><div class="movement-info"><strong>${escapeHtml(item.producto)}</strong><small>${dateFmt(item.fecha)} · Enganche ${fmt(item.enganche)}</small></div><div class="movement-amount"><strong>${fmt(item.precio)}</strong><small>Deuda +${fmt(item.precio-item.enganche)}</small></div></article>`
    : `<article class="movement"><span class="movement-icon positive">✓</span><div class="movement-info"><strong>Abono recibido</strong><small>${dateFmt(item.fecha)}${item.nota ? ` · ${escapeHtml(item.nota)}` : ''}</small></div><div class="movement-amount"><strong class="positive">−${fmt(item.cantidad)}</strong><small>${escapeHtml(item.creadoPor)}</small></div></article>`).join('')
    : `<div class="empty"><span>◎</span><h3>Sin ${activeTab === 'purchases' ? 'compras' : 'abonos'}</h3><p>Los movimientos aparecerán aquí.</p></div>`;
}

$$('.tab').forEach(tab => tab.addEventListener('click', () => { $$('.tab').forEach(x => x.classList.remove('active')); tab.classList.add('active'); activeTab = tab.dataset.tab; renderMovements(); }));
$('#purchaseBtn').addEventListener('click', () => openMovement('purchase'));
$('#paymentBtn').addEventListener('click', () => { if (detail.deuda <= 0) return notify('Esta cuenta no tiene saldo pendiente.', true); openMovement('payment'); });

function openMovement(type) {
  movementType = type; $('#movementForm').reset(); $('#purchaseFields').style.display = type === 'purchase' ? 'block' : 'none'; $('#paymentFields').style.display = type === 'payment' ? 'block' : 'none';
  $('#movementTitle').textContent = type === 'purchase' ? 'Nueva compra' : 'Registrar abono'; $('#movementEyebrow').textContent = type === 'purchase' ? 'VENTA A CRÉDITO' : `SALDO: ${fmt(detail.deuda)}`; $('#movementDialog').showModal();
}

$('#movementForm').addEventListener('submit', async event => {
  event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget));
  if (movementType === 'purchase' && (!values.producto || !values.precio)) return notify('Completa el producto y el precio.', true);
  if (movementType === 'payment' && !values.cantidad) return notify('Indica la cantidad del abono.', true);
  try {
    const result = await api(`/api/clientes/${selectedId}/${movementType === 'purchase' ? 'compras' : 'abonos'}`, { method: 'POST', body: JSON.stringify(values) });
    $('#movementDialog').close();
    if (movementType === 'payment' && result.deudaRestante === 0) {
      $('#detailDialog').close();
      await loadClients($('#searchInput').value);
      switchView('history');
      notify('¡Cuenta saldada! Se movió al historial.');
      return;
    }
    notify(movementType === 'purchase' ? 'Compra agregada.' : 'Abono registrado.');
    await openDetail(selectedId, false); await loadClients($('#searchInput').value);
  }
  catch (error) { notify(error.message, true); }
});

$$('dialog .close').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); }));

(async () => { if (!token) return; try { const session = await api('/api/session'); showApp(session.username); } catch { logout(); } })();
