// Atajos para consultar uno o varios elementos del DOM.
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const fmt = (value) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(
    Number(value || 0),
  );
const dateFmt = (value) =>
  new Intl.DateTimeFormat("es-MX", { dateStyle: "medium" }).format(
    new Date(value),
  );
let token = localStorage.getItem("cuentas_token");
let clients = [];
let historyClients = [];
let products = [];
let promotions = [];
let providers = [];
let investmentProducts = [];
let expenses = [];
const pages = {};
const PAGE_SIZE = 9;

function pageItems(items, key) {
  const max = Math.max(1, Math.ceil(items.length / PAGE_SIZE)); pages[key] = Math.min(Math.max(1, pages[key] || 1), max);
  return items.slice((pages[key] - 1) * PAGE_SIZE, pages[key] * PAGE_SIZE);
}
function renderPagination(wrapId, key, total, rerender) {
  const wrap = $(`#${wrapId}`); if (!wrap) return; let bar = $(`#pagination-${key}`);
  if (!bar) { bar = document.createElement("div"); bar.id = `pagination-${key}`; bar.className = "pagination"; wrap.insertAdjacentElement("afterend", bar); }
  const max = Math.max(1, Math.ceil(total / PAGE_SIZE)), current = pages[key] || 1;
  const start = total ? (current - 1) * PAGE_SIZE + 1 : 0, end = Math.min(current * PAGE_SIZE, total);
  const numbers = Array.from({ length: max }, (_, index) => index + 1).filter((page) => max <= 7 || page === 1 || page === max || Math.abs(page-current) <= 1);
  bar.innerHTML = `<small>Mostrando ${start}–${end} de ${total}</small><button data-page="${current-1}" ${current === 1 ? "disabled" : ""}>‹</button>${numbers.map((page, index) => `${index && page - numbers[index-1] > 1 ? "<span>…</span>" : ""}<button data-page="${page}" class="${page === current ? "active" : ""}">${page}</button>`).join("")}<button data-page="${current+1}" ${current === max ? "disabled" : ""}>›</button>`;
  bar.querySelectorAll("button:not([disabled])").forEach((button) => button.addEventListener("click", () => { pages[key] = Number(button.dataset.page); rerender(); }));
}
let selectedId = null;
let detail = null;
let activeTab = "purchases";
let movementType = "purchase";
let detailReadonly = false;

// Recupera el tema guardado y permite alternarlo desde el botón flotante.
const savedTheme = localStorage.getItem("cuentas_theme");
if (
  savedTheme === "dark" ||
  (!savedTheme && matchMedia("(prefers-color-scheme: dark)").matches)
)
  document.documentElement.dataset.theme = "dark";
$("#themeBtn").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme !== "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  localStorage.setItem("cuentas_theme", dark ? "dark" : "light");
});

// Cliente HTTP centralizado: agrega autenticación y traduce errores de la API.
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && url !== "/api/login") logout();
  if (!response.ok)
    throw new Error(data.error || "No fue posible completar la operación.");
  return data;
}

// Muestra mensajes temporales de éxito o error al usuario.
function notify(message, error = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast show${error ? " error" : ""}`;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => (toast.className = "toast"), 2800);
}

// Cambia de la pantalla de acceso al panel principal.
function showApp(username) {
  $("#loginView").classList.add("hidden");
  $("#appView").classList.remove("hidden");
  $("#userLabel").textContent = username || "Admin";
  loadClients();
}

// Cierra la sesión local y devuelve al formulario de acceso.
function logout() {
  token = null;
  localStorage.removeItem("cuentas_token");
  $("#appView").classList.add("hidden");
  $("#loginView").classList.remove("hidden");
}

// Envía las credenciales y guarda el token de sesión.
$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(form)),
    });
    token = data.token;
    localStorage.setItem("cuentas_token", token);
    showApp(data.username);
  } catch (error) {
    notify(error.message, true);
  }
});
$("#logoutBtn").addEventListener("click", logout);

// Carga y pinta la lista de clientes con saldo pendiente.
async function loadClients(query = "") {
  try {
    clients = await api(`/api/clientes?q=${encodeURIComponent(query)}`);
    renderClients();
  } catch (error) {
    notify(error.message, true);
  }
}

// Carga y pinta las cuentas que ya fueron saldadas.
async function loadHistory(query = "") {
  try {
    historyClients = await api(`/api/historial?q=${encodeURIComponent(query)}`);
    renderHistory();
  } catch (error) {
    notify(error.message, true);
  }
}

// Renderiza las filas de la vista de historial.
function renderHistory() {
  $("#historyBody").innerHTML = pageItems(historyClients, "history")
    .map(
      (client) =>
        `<tr><td><strong>${escapeHtml(client.nombre)}</strong><small>${escapeHtml(client.telefono || "Sin teléfono")}</small></td><td>${fmt(client.totalCompras)}</td><td>${fmt(client.totalEnganches)}</td><td class="paid">${fmt(client.totalAbonos)}</td><td><span class="history-status">Saldada</span></td><td><div class="row-actions"><button class="icon-btn history-detail" data-id="${client._id}" title="Ver historial">⌕</button></div></td></tr>`,
    )
    .join("");
  renderPagination("historyTableWrap", "history", historyClients.length, renderHistory);
  $("#historyCount").textContent =
    `${historyClients.length} ${historyClients.length === 1 ? "registro" : "registros"}`;
  $("#historyEmpty").classList.toggle("hidden", historyClients.length > 0);
  $("#historyTableWrap").classList.toggle(
    "hidden",
    historyClients.length === 0,
  );
}

// Cambia entre clientes e historial y vuelve a cargar la vista seleccionada.
function switchView(view) {
  const views = ["clients", "products", "providers", "promotions", "investment", "history"];
  views.forEach((name) => {
    $(`#${name}View`).classList.toggle("hidden", name !== view);
    $(`#${name}Nav`).classList.toggle("nav-active", name === view);
  });
  const target = $(`#${view}View`);
  target.classList.remove("view-enter");
  requestAnimationFrame(() => target.classList.add("view-enter"));
  if (view === "history") loadHistory($("#historySearch").value);
  if (view === "clients") loadClients($("#searchInput").value);
  if (view === "products") { refreshProductFilters(); loadProducts(); }
  if (view === "providers") loadProviders($("#providerSearch").value);
  if (view === "promotions") loadPromotions();
  if (view === "investment") loadInvestment();
}

$("#clientsNav").addEventListener("click", () => switchView("clients"));
$("#productsNav").addEventListener("click", () => switchView("products"));
$("#providersNav").addEventListener("click", () => switchView("providers"));
$("#promotionsNav").addEventListener("click", () => switchView("promotions"));
$("#investmentNav").addEventListener("click", () => switchView("investment"));
$("#historyNav").addEventListener("click", () => switchView("history"));

async function loadProducts() {
  try { const params = new URLSearchParams({ q: $("#productSearch").value, proveedorId: $("#providerFilter").value, codigo: $("#codeFilter").value }); products = await api(`/api/productos?${params}`); renderProducts(); }
  catch (error) { notify(error.message, true); }
}

async function refreshProductFilters() {
  try { const [allProducts, allProviders] = await Promise.all([api("/api/productos"), api("/api/proveedores")]); const selectedProvider = $("#providerFilter").value, selectedCode = $("#codeFilter").value; $("#providerFilter").innerHTML = `<option value="">Todos los proveedores</option>${allProviders.map((provider) => `<option value="${provider._id}">${escapeHtml(provider.nombre)}</option>`).join("")}`; $("#codeFilter").innerHTML = `<option value="">Todos los códigos</option>${allProducts.filter((product) => product.codigo).map((product) => `<option value="${escapeHtml(product.codigo)}">${escapeHtml(product.codigo)}</option>`).join("")}`; $("#providerFilter").value = selectedProvider; $("#codeFilter").value = selectedCode; }
  catch (error) { notify(error.message, true); }
}

function renderProducts() {
  $("#productsBody").innerHTML = pageItems(products, "products").map((product) => `<tr><td><strong class="product-code">${escapeHtml(product.codigo || "Sin código")}</strong></td><td><strong>${escapeHtml(product.nombre)}</strong></td><td><span class="provider-name">${escapeHtml(product.proveedor?.nombre || "Sin asignar")}</span></td><td>${fmt(product.precioCompra)}</td><td>${fmt(product.precioVenta)}</td><td class="profit">${fmt(product.precioVenta-product.precioCompra)}</td><td><span class="stock-badge${product.stock <= 2 ? " low" : ""}">${product.stock} disponibles</span></td><td>${dateFmt(product.fechaRegistro)}</td><td><div class="row-actions"><button class="icon-btn product-edit" data-id="${product._id}" title="Editar">✎</button><button class="icon-btn product-delete" data-id="${product._id}" title="Eliminar">×</button></div></td></tr>`).join("");
  renderPagination("productsTableWrap", "products", products.length, renderProducts);
  $("#productCount").textContent = `${products.length} ${products.length === 1 ? "producto" : "productos"}`;
  $("#productsEmpty").classList.toggle("hidden", products.length > 0); $("#productsTableWrap").classList.toggle("hidden", products.length === 0);
}

async function loadInvestment() {
  try {
    const data = await api("/api/inversion");
    investmentProducts = data.productos; $("#purchaseInvestment").textContent = fmt(data.inversionCompra); $("#totalExpenses").textContent = fmt(data.gastosTotales); $("#totalInvestment").textContent = fmt(data.inversionTotal); $("#retailInvestment").textContent = fmt(data.valorVentaInventario); $("#totalProfit").textContent = fmt(data.gananciasTotales); $("#soldUnits").textContent = `${data.unidadesVendidas} unidades vendidas`; renderInvestmentRows(); await loadExpenses();
  } catch (error) { notify(error.message, true); }
}
function renderInvestmentRows() { $("#investmentBody").innerHTML = pageItems(investmentProducts, "investment").map((product) => { const cost = (product.costoVendido ?? product.precioCompra * (product.unidadesVendidas || 0)); return `<tr><td><strong>${escapeHtml(product.nombre)}</strong></td><td>${product.unidadesVendidas || 0}</td><td>${fmt(product.ingresosVentas)}</td><td>${fmt(cost)}</td><td class="profit">${fmt(product.gananciaRealizada)}</td></tr>`; }).join("") || `<tr><td colspan="5"><div class="empty"><p>Aún no hay productos registrados.</p></div></td></tr>`; renderPagination("investmentTableWrap", "investment", investmentProducts.length, renderInvestmentRows); }

async function loadExpenses() { try { expenses = await api("/api/gastos"); renderExpenses(); } catch (error) { notify(error.message, true); } }
function renderExpenses() { $("#expensesBody").innerHTML = pageItems(expenses, "expenses").map((expense) => `<tr><td>${dateFmt(expense.fechaRegistro)}</td><td><strong>${escapeHtml(expense.tipo)}</strong></td><td>${escapeHtml(expense.descripcion || "—")}</td><td class="debt">${fmt(expense.cantidad)}</td><td><div class="row-actions"><button class="icon-btn expense-edit" data-id="${expense._id}">✎</button><button class="icon-btn expense-delete" data-id="${expense._id}">×</button></div></td></tr>`).join(""); renderPagination("expensesTableWrap", "expenses", expenses.length, renderExpenses); $("#expenseCount").textContent = `${expenses.length} ${expenses.length === 1 ? "gasto registrado" : "gastos registrados"}`; $("#expensesEmpty").classList.toggle("hidden", expenses.length > 0); $("#expensesTableWrap").classList.toggle("hidden", expenses.length === 0); }
$("#newExpenseBtn").addEventListener("click", () => openExpense());
function openExpense(expense = null) { const form = $("#expenseForm"); form.reset(); form.id.value = expense?._id || ""; form.tipo.value = expense?.tipo || ""; form.descripcion.value = expense?.descripcion || ""; form.cantidad.value = expense?.cantidad ?? ""; $("#expenseTitle").textContent = expense ? "Editar gasto" : "Registrar gasto"; $("#expenseDialog").showModal(); }
$("#expenseForm").addEventListener("submit", async (event) => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); const id = values.id; delete values.id; try { await api(id ? `/api/gastos/${id}` : "/api/gastos", { method: id ? "PUT" : "POST", body: JSON.stringify(values) }); $("#expenseDialog").close(); notify(id ? "Gasto actualizado." : "Gasto registrado."); loadInvestment(); } catch (error) { notify(error.message, true); } });
$("#expensesBody").addEventListener("click", async (event) => { const button = event.target.closest("button"); if (!button) return; const expense = expenses.find((item) => item._id === button.dataset.id); if (button.classList.contains("expense-edit")) openExpense(expense); if (button.classList.contains("expense-delete") && confirm(`¿Eliminar el gasto de ${fmt(expense.cantidad)}?`)) { try { await api(`/api/gastos/${expense._id}`, { method: "DELETE" }); notify("Gasto eliminado."); loadInvestment(); } catch (error) { notify(error.message, true); } } });

let productSearchTimer;
$("#productSearch").addEventListener("input", () => { clearTimeout(productSearchTimer); productSearchTimer = setTimeout(loadProducts, 250); });
$("#providerFilter").addEventListener("change", loadProducts); $("#codeFilter").addEventListener("change", loadProducts);
$("#newProductBtn").addEventListener("click", () => openProduct());
async function openProduct(product = null) {
  const allProviders = await api("/api/proveedores"); const form = $("#productForm"); form.reset(); $("#productProvider").innerHTML = `<option value="">Selecciona un proveedor...</option>${allProviders.map((provider) => `<option value="${provider._id}">${escapeHtml(provider.nombre)}</option>`).join("")}`; form.id.value = product?._id || ""; form.codigo.value = product?.codigo || ""; form.codigo.readOnly = !product; form.proveedorId.value = product?.proveedorId || ""; form.nombre.value = product?.nombre || ""; form.precioCompra.value = product?.precioCompra ?? ""; form.precioVenta.value = product?.precioVenta ?? ""; form.stock.value = product?.stock ?? 1; $("#productTitle").textContent = product ? "Editar producto" : "Nuevo producto"; if (!allProviders.length) notify("Primero agrega un proveedor.", true); $("#productDialog").showModal();
}
$("#productForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); const id = values.id; delete values.id;
  try { await api(id ? `/api/productos/${id}` : "/api/productos", { method: id ? "PUT" : "POST", body: JSON.stringify(values) }); $("#productDialog").close(); notify(id ? "Producto actualizado." : "Producto agregado."); refreshProductFilters(); loadProducts(); }
  catch (error) { notify(error.message, true); }
});

async function loadProviders(query = "") { try { providers = await api(`/api/proveedores?q=${encodeURIComponent(query)}`); renderProviders(); } catch (error) { notify(error.message, true); } }
function renderProviders() { $("#providersBody").innerHTML = pageItems(providers, "providers").map((provider) => `<tr><td><strong>${escapeHtml(provider.nombre)}</strong></td><td>${escapeHtml(provider.contacto || "—")}</td><td>${escapeHtml(provider.telefono || "—")}</td><td>${dateFmt(provider.fechaRegistro)}</td><td><div class="row-actions"><button class="icon-btn provider-edit" data-id="${provider._id}">✎</button><button class="icon-btn provider-delete" data-id="${provider._id}">×</button></div></td></tr>`).join(""); renderPagination("providersTableWrap", "providers", providers.length, renderProviders); $("#providerCount").textContent = `${providers.length} ${providers.length === 1 ? "proveedor" : "proveedores"}`; $("#providersEmpty").classList.toggle("hidden", providers.length > 0); $("#providersTableWrap").classList.toggle("hidden", providers.length === 0); }
let providerSearchTimer; $("#providerSearch").addEventListener("input", (event) => { clearTimeout(providerSearchTimer); providerSearchTimer = setTimeout(() => loadProviders(event.target.value), 250); }); $("#newProviderBtn").addEventListener("click", () => openProvider());
function openProvider(provider = null) { const form = $("#providerForm"); form.reset(); form.id.value = provider?._id || ""; form.nombre.value = provider?.nombre || ""; form.contacto.value = provider?.contacto || ""; form.telefono.value = provider?.telefono || ""; $("#providerTitle").textContent = provider ? "Editar proveedor" : "Nuevo proveedor"; $("#providerDialog").showModal(); }
$("#providerForm").addEventListener("submit", async (event) => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); const id = values.id; delete values.id; try { await api(id ? `/api/proveedores/${id}` : "/api/proveedores", { method: id ? "PUT" : "POST", body: JSON.stringify(values) }); $("#providerDialog").close(); notify(id ? "Proveedor actualizado." : "Proveedor agregado."); loadProviders($("#providerSearch").value); } catch (error) { notify(error.message, true); } });
$("#providersBody").addEventListener("click", async (event) => { const button = event.target.closest("button"); if (!button) return; const provider = providers.find((item) => item._id === button.dataset.id); if (button.classList.contains("provider-edit")) openProvider(provider); if (button.classList.contains("provider-delete") && confirm(`¿Eliminar a ${provider.nombre}?`)) { try { await api(`/api/proveedores/${provider._id}`, { method: "DELETE" }); notify("Proveedor eliminado."); loadProviders($("#providerSearch").value); } catch (error) { notify(error.message, true); } } });
$("#productsBody").addEventListener("click", async (event) => {
  const button = event.target.closest("button"); if (!button) return; const product = products.find((item) => item._id === button.dataset.id);
  if (button.classList.contains("product-edit")) openProduct(product);
  if (button.classList.contains("product-delete") && confirm(`¿Eliminar ${product.nombre}?`)) { try { await api(`/api/productos/${product._id}`, { method: "DELETE" }); notify("Producto eliminado."); loadProducts($("#productSearch").value); } catch (error) { notify(error.message, true); } }
});

async function loadPromotions() {
  try { promotions = await api("/api/promociones"); renderPromotions(); }
  catch (error) { notify(error.message, true); }
}
function renderPromotions() {
  $("#promotionsBody").innerHTML = pageItems(promotions, "promotions").map((promotion) => { const discount = Math.round((1 - promotion.precioPromocion / promotion.producto.precioVenta) * 100); return `<tr><td><strong class="product-code">${escapeHtml(promotion.producto.codigo || "Sin código")}</strong></td><td><strong>${escapeHtml(promotion.producto.nombre)}</strong></td><td class="old-price">${fmt(promotion.producto.precioVenta)}</td><td class="promo-price">${fmt(promotion.precioPromocion)}</td><td><span class="discount-badge">−${discount}%</span></td><td><div class="row-actions"><button class="icon-btn promotion-edit" data-id="${promotion._id}" title="Editar">✎</button><button class="icon-btn promotion-delete" data-id="${promotion._id}" title="Quitar">×</button></div></td></tr>`; }).join("");
  renderPagination("promotionsTableWrap", "promotions", promotions.length, renderPromotions);
  $("#promotionCount").textContent = `${promotions.length} ${promotions.length === 1 ? "promoción" : "promociones"}`; $("#promotionsEmpty").classList.toggle("hidden", promotions.length > 0); $("#promotionsTableWrap").classList.toggle("hidden", promotions.length === 0);
}
$("#newPromotionBtn").addEventListener("click", () => openPromotion());
async function openPromotion(promotion = null) {
  const catalog = await api("/api/productos"); const usedIds = new Set(promotions.filter((item) => !promotion || item._id !== promotion._id).map((item) => item.productoId));
  const available = catalog.filter((item) => !usedIds.has(item._id)); const form = $("#promotionForm"); form.reset(); form.id.value = promotion?._id || "";
  $("#promotionProduct").innerHTML = `<option value="">Selecciona un producto...</option>${available.map((item) => `<option value="${item._id}" data-price="${item.precioVenta}">${escapeHtml(item.codigo || "")} · ${escapeHtml(item.nombre)}</option>`).join("")}`;
  if (promotion) { form.productoId.value = promotion.productoId; form.precioPromocion.value = promotion.precioPromocion; $("#promotionRegularPrice").value = fmt(promotion.producto.precioVenta); }
  else $("#promotionRegularPrice").value = "";
  $("#promotionTitle").textContent = promotion ? "Editar promoción" : "Nueva promoción"; $("#promotionDialog").showModal();
}
$("#promotionProduct").addEventListener("change", (event) => { $("#promotionRegularPrice").value = event.target.selectedOptions[0]?.dataset.price ? fmt(event.target.selectedOptions[0].dataset.price) : ""; });
$("#promotionForm").addEventListener("submit", async (event) => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); const id = values.id; delete values.id; try { await api(id ? `/api/promociones/${id}` : "/api/promociones", { method: id ? "PUT" : "POST", body: JSON.stringify(values) }); $("#promotionDialog").close(); notify(id ? "Promoción actualizada." : "Promoción agregada."); loadPromotions(); } catch (error) { notify(error.message, true); } });
$("#promotionsBody").addEventListener("click", async (event) => { const button = event.target.closest("button"); if (!button) return; const promotion = promotions.find((item) => item._id === button.dataset.id); if (button.classList.contains("promotion-edit")) openPromotion(promotion); if (button.classList.contains("promotion-delete") && confirm(`¿Quitar la promoción de ${promotion.producto.nombre}?`)) { try { await api(`/api/promociones/${promotion._id}`, { method: "DELETE" }); notify("Promoción eliminada; vuelve a aplicar el precio normal."); loadPromotions(); } catch (error) { notify(error.message, true); } } });
let historySearchTimer;
$("#historySearch").addEventListener("input", (event) => {
  clearTimeout(historySearchTimer);
  historySearchTimer = setTimeout(() => loadHistory(event.target.value), 250);
});
$("#historyBody").addEventListener("click", (event) => {
  const button = event.target.closest(".history-detail");
  if (button) openDetail(button.dataset.id, true);
});
$("#downloadPdfBtn").addEventListener("click", async () => {
  try {
    const response = await fetch(
      `/api/historial/pdf?q=${encodeURIComponent($("#historySearch").value)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) throw new Error("No fue posible generar el PDF.");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = $("#historySearch").value
      ? "historial-filtrado.pdf"
      : "historial.pdf";
    link.click();
    URL.revokeObjectURL(url);
    notify("PDF descargado correctamente.");
  } catch (error) {
    notify(error.message, true);
  }
});

// Renderiza clientes, indicadores de deuda y estado vacío de la tabla.
function renderClients() {
  $("#clientsBody").innerHTML = pageItems(clients, "clients")
    .map((client) => {
      const financed = Math.max(0, client.totalCompras - client.totalEnganches);
      const pendingPercent =
        financed > 0
          ? Math.min(100, Math.max(0, (client.deuda / financed) * 100))
          : 0;
      const hue = Math.round((1 - pendingPercent / 100) * 120);
      return `<tr><td><strong>${escapeHtml(client.nombre)}</strong><small>${escapeHtml(client.telefono || "Sin teléfono")}</small></td><td>${fmt(client.totalCompras)}</td><td>${fmt(client.totalEnganches)}</td><td class="paid">${fmt(client.totalAbonos)}</td><td><span class="debt debt-progress" style="--debt-hue:${hue}" title="Queda ${pendingPercent.toFixed(0)}% de la deuda financiada">${fmt(client.deuda)}</span><small class="debt-caption">${pendingPercent.toFixed(0)}% pendiente</small></td><td><div class="row-actions"><button class="icon-btn detail" data-id="${client._id}" title="Ver movimientos">⌕</button><button class="icon-btn edit" data-id="${client._id}" title="Editar">✎</button><button class="icon-btn delete" data-id="${client._id}" title="Eliminar">×</button></div></td></tr>`;
    })
    .join("");
  renderPagination("clientsTableWrap", "clients", clients.length, renderClients);
  $("#clientCount").textContent =
    `${clients.length} ${clients.length === 1 ? "registro" : "registros"}`;
  $("#totalDebt").textContent = fmt(clients.reduce((s, x) => s + x.deuda, 0));
  $("#totalPaid").textContent = fmt(
    clients.reduce((s, x) => s + x.totalAbonos + x.totalEnganches, 0),
  );
  $("#activeClients").textContent = clients.filter((x) => x.deuda > 0).length;
  $("#emptyState").classList.toggle("hidden", clients.length > 0);
  $(".table-wrap").classList.toggle("hidden", clients.length === 0);
}

// Escapa texto antes de insertarlo en plantillas HTML.
function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value ?? "";
  return div.innerHTML;
}
let searchTimer;
$("#searchInput").addEventListener("input", (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadClients(event.target.value), 250);
});
$("#newClientBtn").addEventListener("click", () => openClient());

// Abre el formulario en modo creación o edición.
function openClient(client = null) {
  const form = $("#clientForm");
  form.reset();
  form.id.value = client?._id || "";
  form.nombre.value = client?.nombre || "";
  form.telefono.value = client?.telefono || "";
  $("#clientTitle").textContent = client ? "Editar cliente" : "Nuevo cliente";
  $("#clientDialog").showModal();
}

// Guarda los datos del cliente y actualiza la tabla.
$("#clientForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  const id = values.id;
  delete values.id;
  try {
    await api(id ? `/api/clientes/${id}` : "/api/clientes", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(values),
    });
    $("#clientDialog").close();
    notify(id ? "Cliente actualizado." : "Cliente agregado.");
    loadClients($("#searchInput").value);
  } catch (error) {
    notify(error.message, true);
  }
});

// Delegación de eventos para ver, editar o eliminar clientes.
$("#clientsBody").addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const client = clients.find((x) => x._id === button.dataset.id);
  if (button.classList.contains("detail")) openDetail(client._id, false);
  if (button.classList.contains("edit")) openClient(client);
  if (
    button.classList.contains("delete") &&
    confirm(
      `¿Eliminar a ${client.nombre} y todo su historial? Esta acción no se puede deshacer.`,
    )
  ) {
    try {
      await api(`/api/clientes/${client._id}`, { method: "DELETE" });
      notify("Cliente eliminado.");
      loadClients($("#searchInput").value);
    } catch (error) {
      notify(error.message, true);
    }
  }
});

// Obtiene el detalle de la cuenta y configura su modo de solo lectura.
async function openDetail(id, readonly = false) {
  selectedId = id;
  detailReadonly = readonly;
  try {
    detail = await api(`/api/clientes/${id}/movimientos`);
    $("#detailName").textContent = detail.cliente.nombre;
    $("#detailPhone").textContent = detail.cliente.telefono || "Sin teléfono";
    $("#detailDebt").textContent = readonly ? "SALDADA" : fmt(detail.deuda);
    $(".detail-actions").classList.toggle("hidden", readonly);
    renderMovements();
    if (!$("#detailDialog").open) $("#detailDialog").showModal();
  } catch (error) {
    notify(error.message, true);
  }
}

// Dibuja las compras o los abonos según la pestaña activa.
function renderMovements() {
  const items = activeTab === "purchases" ? detail.compras : detail.abonos;
  $("#movementsList").innerHTML = items.length
    ? items
        .map((item) =>
          activeTab === "purchases"
            ? `<article class="movement"><span class="movement-icon">▣</span><div class="movement-info"><strong>${escapeHtml(item.producto)}</strong><small>${dateFmt(item.fecha)} · Enganche ${fmt(item.enganche)}</small></div><div class="movement-amount"><strong>${fmt(item.precio)}</strong><small>Deuda +${fmt(item.precio - item.enganche)}</small></div></article>`
            : `<article class="movement"><span class="movement-icon positive">✓</span><div class="movement-info"><strong>Abono recibido</strong><small>${dateFmt(item.fecha)}${item.nota ? ` · ${escapeHtml(item.nota)}` : ""}</small></div><div class="movement-amount"><strong class="positive">−${fmt(item.cantidad)}</strong><small>${escapeHtml(item.creadoPor)}</small></div></article>`,
        )
        .join("")
    : `<div class="empty"><span>◎</span><h3>Sin ${activeTab === "purchases" ? "compras" : "abonos"}</h3><p>Los movimientos aparecerán aquí.</p></div>`;
}

$$(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    $$(".tab").forEach((x) => x.classList.remove("active"));
    tab.classList.add("active");
    activeTab = tab.dataset.tab;
    renderMovements();
  }),
);
$("#purchaseBtn").addEventListener("click", () => openMovement("purchase"));
$("#paymentBtn").addEventListener("click", () => {
  if (detail.deuda <= 0)
    return notify("Esta cuenta no tiene saldo pendiente.", true);
  openMovement("payment");
});

// Prepara el formulario para registrar una compra o un abono.
async function openMovement(type) {
  movementType = type;
  $("#movementForm").reset();
  $("#purchaseFields").style.display = type === "purchase" ? "block" : "none";
  $("#paymentFields").style.display = type === "payment" ? "block" : "none";
  $("#movementTitle").textContent =
    type === "purchase" ? "Nueva compra" : "Registrar abono";
  $("#movementEyebrow").textContent =
    type === "purchase" ? "VENTA A CRÉDITO" : `SALDO: ${fmt(detail.deuda)}`;
  if (type === "purchase") {
    const [available, activePromotions] = await Promise.all([api("/api/productos"), api("/api/promociones")]);
    const promoMap = new Map(activePromotions.map((item) => [item.productoId, item.precioPromocion]));
    $("#saleProduct").innerHTML = `<option value="">Selecciona un producto...</option>${available.filter((p) => p.stock > 0).map((p) => { const price = promoMap.get(p._id) || p.precioVenta; return `<option value="${p._id}" data-price="${price}">${escapeHtml(p.nombre)} · ${fmt(price)}${promoMap.has(p._id) ? " (promoción)" : ""} · ${p.stock} disponibles</option>`; }).join("")}`;
    $("#salePrice").value = "";
    if (!available.some((p) => p.stock > 0)) notify("No hay productos con stock. Agrega existencias primero.", true);
  }
  $("#movementDialog").showModal();
}
$("#saleProduct").addEventListener("change", (event) => { $("#salePrice").value = event.target.selectedOptions[0]?.dataset.price ? fmt(event.target.selectedOptions[0].dataset.price) : ""; });

// Envía el movimiento y refresca el detalle y los totales.
$("#movementForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  if (movementType === "purchase" && !values.productoId)
    return notify("Selecciona un producto disponible.", true);
  if (movementType === "payment" && !values.cantidad)
    return notify("Indica la cantidad del abono.", true);
  try {
    const result = await api(
      `/api/clientes/${selectedId}/${movementType === "purchase" ? "compras" : "abonos"}`,
      { method: "POST", body: JSON.stringify(values) },
    );
    $("#movementDialog").close();
    // Permite cerrar diálogos con sus botones o haciendo clic fuera de ellos.
    if (movementType === "payment" && result.deudaRestante === 0) {
      $("#detailDialog").close();
      await loadClients($("#searchInput").value);
      switchView("history");
      notify("¡Cuenta saldada! Se movió al historial.");
      return;
    }
    notify(
      movementType === "purchase" ? "Compra agregada." : "Abono registrado.",
    );
    await openDetail(selectedId, false);
    await loadClients($("#searchInput").value);
  } catch (error) {
    notify(error.message, true);
  }
});

$$("dialog .close").forEach((button) =>
  button.addEventListener("click", () => button.closest("dialog").close()),
);
$$("dialog").forEach((dialog) =>
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  }),
);

// Restaura la sesión existente cuando se recarga la página.
(async () => {
  if (!token) return;
  try {
    const session = await api("/api/session");
    showApp(session.username);
  } catch {
    logout();
  }
})();
