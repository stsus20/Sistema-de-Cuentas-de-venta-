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
// La sesión se guarda en una cookie HttpOnly emitida por el servidor.
// Este valor anterior ya no se utiliza y se elimina para no dejar rastros.
localStorage.removeItem("cuentas_token");
let currentUser = null; // Guarda { id, username, name, email, role }
let clients = [];
let historyClients = [];
let products = [];
let promotions = [];
let providers = [];
let investmentProducts = [];
let expenses = [];
let usersList = [];
let usersTotal = 0;
let usersCurrentPage = 1;
const USERS_PAGE_SIZE = 10;
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

// Cliente HTTP centralizado: envía la cookie de sesión y traduce errores de la API.
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (
    response.status === 401 &&
    url !== "/api/login" &&
    url !== "/api/register" &&
    url !== "/api/session"
  ) {
    logout();
  }
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
  notify.timer = setTimeout(() => (toast.className = "toast"), 3200);
}

// Cambia de la pantalla de acceso al panel principal y configura permisos según el rol
function showApp(user) {
  currentUser = user;

  // ── Control de acceso por rol ──────────────────────────────
  // Los usuarios normales van directamente a la tienda, conservando su ruta de retorno.
  if (user.role !== "suprem") {
    const requestedReturn = new URLSearchParams(location.search).get("returnTo") || "/";
    const destination = new URL(requestedReturn, location.origin);
    const returnPath = requestedReturn.startsWith("/") && destination.origin === location.origin
      ? `${destination.pathname}${destination.search}${destination.hash}`
      : "/";
    location.replace(returnPath);
    return;
  }

  $("#loginView").classList.add("hidden");
  $("#appView").classList.remove("hidden");

  // Configurar etiquetas de usuario y avatar
  const displayName = user.name || user.username || "Usuario";
  $("#userLabel").textContent = displayName;
  $("#userAvatar").textContent = displayName.charAt(0).toUpperCase();

  const isSuprem = user.role === "suprem";
  const badge = $("#userRoleBadge");
  if (badge) {
    badge.textContent = isSuprem ? "Suprem (Admin)" : "Usuario";
    badge.className = isSuprem ? "badge-role suprem" : "";
  }

  // La gestión de usuarios queda limitada a la cuenta suprem "jesus".
  const usersNavBtn = $("#usersNav");
  const canManageUsers = isSuprem && String(user.username || "").toLowerCase() === "jesus";
  if (usersNavBtn) usersNavBtn.classList.toggle("hidden", !canManageUsers);

  loadClients();
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}


// Cierra la sesión en el servidor y vuelve a la tienda, limpiando las colecciones en memoria.
async function logout() {
  currentUser = null;

  // Limpiar completamente el estado y cachés en memoria para aislamiento estricto
  clients = [];
  historyClients = [];
  products = [];
  promotions = [];
  providers = [];
  investmentProducts = [];
  expenses = [];
  usersList = [];
  usersTotal = 0;
  usersCurrentPage = 1;
  selectedId = null;
  detail = null;

  // Limpiar campos de búsqueda e inputs
  if ($("#searchInput")) $("#searchInput").value = "";
  if ($("#historySearch")) $("#historySearch").value = "";
  if ($("#productSearch")) $("#productSearch").value = "";
  if ($("#providerSearch")) $("#providerSearch").value = "";
  if ($("#userSearchInput")) $("#userSearchInput").value = "";

  $("#appView").classList.add("hidden");
  try {
    await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
  } catch {
    // Aunque falle la red, la interfaz vuelve al estado no autenticado.
  }
  location.replace("/");
}

// Alternar entre Login y Registro
$("#showRegisterBtn").addEventListener("click", () => {
  $("#loginForm").classList.add("hidden");
  $("#registerForm").classList.remove("hidden");
});
$("#showLoginBtn").addEventListener("click", () => {
  $("#registerForm").classList.add("hidden");
  $("#loginForm").classList.remove("hidden");
});

// Envía las credenciales; el servidor responde con la cookie de sesión HttpOnly.
$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const submitBtn = event.currentTarget.querySelector('button[type="submit"]');
  const originalText = submitBtn.innerHTML;
  submitBtn.disabled = true;
  submitBtn.innerHTML = "Entrando...";
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(form)),
    });
    showApp(data);
    if (data.role === "suprem") notify(`Bienvenido, ${data.name || data.username}`);
  } catch (error) {
    notify(error.message, true);
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalText;
  }
});

// Procesa el registro de una nueva cuenta
$("#registerForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));

  if (values.password !== values.confirmPassword) {
    return notify("Las contraseñas no coinciden.", true);
  }
  if (values.password.length < 8) {
    return notify("La contraseña debe tener al menos 8 caracteres.", true);
  }

  const submitBtn = form.querySelector('button[type="submit"]');
  const originalText = submitBtn.innerHTML;
  submitBtn.disabled = true;
  submitBtn.innerHTML = "Registrando...";

  try {
    const data = await api("/api/register", {
      method: "POST",
      body: JSON.stringify(values),
    });
    notify(data.message || "¡Cuenta creada! Ya puedes iniciar sesión.");
    form.reset();
    // Cambiar a formulario de login y prellenar usuario
    $("#registerForm").classList.add("hidden");
    $("#loginForm").classList.remove("hidden");
    $("#loginForm").username.value = values.username;
    $("#loginForm").password.focus();
  } catch (error) {
    notify(error.message, true);
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalText;
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

// Cambia entre vistas y vuelve a cargar los datos correspondientes.
function switchView(view) {
  // Solo la cuenta suprem "jesus" puede gestionar usuarios.
  if (view === "users" && (!currentUser || currentUser.role !== "suprem" || String(currentUser.username || "").toLowerCase() !== "jesus")) {
    notify("Solo el administrador jesus puede gestionar usuarios.", true);
    view = "clients";
  }
  const views = ["clients", "products", "providers", "promotions", "investment", "history", "users"];
  views.forEach((name) => {
    const el = $(`#${name}View`);
    if (el) el.classList.toggle("hidden", name !== view);
    const navBtn = $(`#${name}Nav`);
    if (navBtn) navBtn.classList.toggle("nav-active", name === view);
  });
  const target = $(`#${view}View`);
  if (target) {
    target.classList.remove("view-enter");
    requestAnimationFrame(() => target.classList.add("view-enter"));
  }
  if (view === "history") loadHistory($("#historySearch").value);
  if (view === "clients") loadClients($("#searchInput").value);
  if (view === "products") { refreshProductFilters(); loadProducts(); }
  if (view === "providers") loadProviders($("#providerSearch").value);
  if (view === "promotions") loadPromotions();
  if (view === "investment") loadInvestment();
  if (view === "users") { usersCurrentPage = 1; loadUsers(); }
}

function showView(viewId) {
  switchView(viewId.replace("View", ""));
}


$("#clientsNav").addEventListener("click", () => switchView("clients"));
$("#productsNav").addEventListener("click", () => switchView("products"));
$("#providersNav").addEventListener("click", () => switchView("providers"));
$("#promotionsNav").addEventListener("click", () => switchView("promotions"));
$("#investmentNav").addEventListener("click", () => switchView("investment"));
$("#historyNav").addEventListener("click", () => switchView("history"));
$("#usersNav").addEventListener("click", () => switchView("users"));

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
  const allProviders = await api("/api/proveedores"); const form = $("#productForm"); form.reset(); $("#productProvider").innerHTML = `<option value="">Selecciona un proveedor...</option>${allProviders.map((provider) => `<option value="${provider._id}">${escapeHtml(provider.nombre)}</option>`).join("")}`; form.id.value = product?._id || ""; form.codigo.value = product?.codigo || ""; form.codigo.readOnly = !product; form.proveedorId.value = product?.proveedorId || ""; form.nombre.value = product?.nombre || ""; form.precioCompra.value = product?.precioCompra ?? ""; form.precioVenta.value = product?.precioVenta ?? ""; form.stock.value = product?.stock ?? 1; const image = product?.imagenUrl || product?.imagenes?.[0] || ""; form.imagenUrl.value = image; $("#productImageFile").value = ""; renderProductImagePreview(image); $("#productTitle").textContent = product ? "Editar producto" : "Nuevo producto"; if (!allProviders.length) notify("Primero agrega un proveedor.", true); $("#productDialog").showModal();
}
function renderProductImagePreview(sources) {
  const preview = $("#productImagePreview");
  if (!preview) return;
  const imageSource = Array.isArray(sources) ? sources[0] : sources;
  preview.replaceChildren();
  if (!imageSource) {
    const hint = document.createElement("span");
    hint.textContent = "La vista previa aparecerá aquí";
    preview.appendChild(hint);
  } else {
    const image = document.createElement("img");
    image.src = imageSource;
    image.alt = "Vista previa de la imagen del producto";
    preview.appendChild(image);
  }
}
function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`No se pudo leer ${file.name}.`));
    reader.readAsDataURL(file);
  });
}
$("#productImageFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 2 * 1024 * 1024) {
    notify("Selecciona una imagen PNG, JPG, WebP o GIF de máximo 2 MB.", true);
    event.target.value = "";
    return;
  }
  try {
    const image = await readImageFile(file);
    $("#productForm").imagenUrl.value = image;
    renderProductImagePreview(image);
  } catch (error) {
    notify(error.message || "No se pudieron leer las imágenes.", true);
    event.target.value = "";
  }
});
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
      { credentials: "same-origin" },
    );
    if (response.status === 401) {
      logout();
      throw new Error("Sesión vencida. Inicia sesión de nuevo.");
    }
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
  $("#purchaseFields").querySelectorAll("input, select").forEach((field) => { field.disabled = type !== "purchase"; });
  $("#paymentFields").querySelectorAll("input, select").forEach((field) => { field.disabled = type !== "payment"; });
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

// ===============================================
// ADMINISTRACIÓN DE USUARIOS (CRUD, BUSCADOR, FILTROS)
// ===============================================

let userSearchTimer;
$("#userSearchInput").addEventListener("input", () => {
  clearTimeout(userSearchTimer);
  userSearchTimer = setTimeout(() => {
    usersCurrentPage = 1;
    loadUsers();
  }, 250);
});
$("#userRoleFilter").addEventListener("change", () => {
  usersCurrentPage = 1;
  loadUsers();
});
$("#userStatusFilter").addEventListener("change", () => {
  usersCurrentPage = 1;
  loadUsers();
});
$("#userSortFilter").addEventListener("change", () => {
  usersCurrentPage = 1;
  loadUsers();
});

// Carga de usuarios desde el backend con paginación, filtros y orden
async function loadUsers() {
  if (!currentUser || currentUser.role !== "suprem" || String(currentUser.username || "").toLowerCase() !== "jesus") return;
  try {
    const q = $("#userSearchInput").value;
    const role = $("#userRoleFilter").value;
    const status = $("#userStatusFilter").value;
    const [sortBy, sortOrder] = ($("#userSortFilter").value || "creadoEn-desc").split("-");

    const params = new URLSearchParams({
      q,
      role,
      status,
      sortBy: sortBy || "creadoEn",
      sortOrder: sortOrder || "desc",
      page: usersCurrentPage,
      limit: USERS_PAGE_SIZE,
    });

    const data = await api(`/api/usuarios?${params}`);
    usersList = data.usuarios || [];
    usersTotal = data.total || 0;
    renderUsers(data);
  } catch (error) {
    notify(error.message, true);
  }
}

// Renderiza la tabla de usuarios y controles de paginación
function renderUsers(meta) {
  const tbody = $("#usersBody");
  if (!usersList.length) {
    tbody.innerHTML = "";
    $("#usersEmpty").classList.remove("hidden");
    $("#usersTableWrap").classList.add("hidden");
  } else {
    $("#usersEmpty").classList.add("hidden");
    $("#usersTableWrap").classList.remove("hidden");
    tbody.innerHTML = usersList
      .map((u) => {
        const isCurrent = currentUser && String(currentUser.id) === String(u._id);
        const isSuprem = u.role === "suprem";
        const isActive = u.isActive !== false;

        return `
          <tr>
            <td>
              <strong>${escapeHtml(u.name || u.username)}</strong>
              ${isCurrent ? ' <small style="color:var(--blue); font-weight:800;">(Tú)</small>' : ""}
            </td>
            <td><code>${escapeHtml(u.username)}</code></td>
            <td>${escapeHtml(u.email || "—")}</td>
            <td>
              <span class="badge-role ${isSuprem ? "suprem" : "user"}">
                ${isSuprem ? "★ suprem" : "● user"}
              </span>
            </td>
            <td>
              <span class="badge-status ${isActive ? "active" : "inactive"}">
                ${isActive ? "✓ Activo" : "✕ Inactivo"}
              </span>
            </td>
            <td>${dateFmt(u.creadoEn || new Date())}</td>
            <td>
              <div class="row-actions">
                <button class="icon-btn user-edit" data-id="${u._id}" title="Editar usuario">✎</button>
                <button class="icon-btn user-role-toggle" data-id="${u._id}" title="${isSuprem ? "Cambiar a rol user" : "Ascender a suprem"}">⇋</button>
                <button class="icon-btn user-status-toggle" data-id="${u._id}" title="${isActive ? "Desactivar cuenta" : "Activar cuenta"}">${isActive ? "⊘" : "✓"}</button>
                <button class="icon-btn user-delete" data-id="${u._id}" title="Eliminar cuenta" ${isCurrent ? 'disabled style="opacity:0.3; cursor:not-allowed;"' : ""}>×</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  // Contador de registros
  $("#usersCount").textContent = `${usersTotal} ${usersTotal === 1 ? "usuario" : "usuarios"}`;

  // Paginación personalizada para usuarios
  renderUsersPagination(meta);
}

function renderUsersPagination(meta) {
  const wrap = $("#usersTableWrap");
  if (!wrap) return;
  let bar = $("#pagination-users");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "pagination-users";
    bar.className = "pagination";
    wrap.insertAdjacentElement("afterend", bar);
  }

  const total = meta.total || 0;
  const current = meta.page || 1;
  const max = meta.totalPages || 1;
  const start = total ? (current - 1) * USERS_PAGE_SIZE + 1 : 0;
  const end = Math.min(current * USERS_PAGE_SIZE, total);

  const numbers = Array.from({ length: max }, (_, index) => index + 1).filter(
    (page) => max <= 7 || page === 1 || page === max || Math.abs(page - current) <= 1,
  );

  bar.innerHTML = `
    <small>Mostrando ${start}–${end} de ${total}</small>
    <button data-page="${current - 1}" ${current === 1 ? "disabled" : ""}>‹</button>
    ${numbers
      .map(
        (page, index) =>
          `${index && page - numbers[index - 1] > 1 ? "<span>…</span>" : ""}<button data-page="${page}" class="${page === current ? "active" : ""}">${page}</button>`,
      )
      .join("")}
    <button data-page="${current + 1}" ${current === max ? "disabled" : ""}>›</button>
  `;

  bar.querySelectorAll("button:not([disabled])").forEach((btn) => {
    btn.addEventListener("click", () => {
      usersCurrentPage = Number(btn.dataset.page);
      loadUsers();
    });
  });
}

// Abrir modal de crear o editar usuario
$("#newUserBtn").addEventListener("click", () => openUserModal());

function openUserModal(user = null) {
  const form = $("#userForm");
  form.reset();
  form.id.value = user?._id || "";
  form.name.value = user?.name || "";
  form.username.value = user?.username || "";
  form.username.readOnly = !!user; // Nombre de usuario fijo una vez creado para coherencia de auditoría
  form.email.value = user?.email || "";
  form.role.value = user?.role || "user";
  form.isActive.value = String(user ? user.isActive !== false : "true");

  if (user) {
    $("#userModalTitle").textContent = "Editar usuario";
    form.password.required = false;
    $("#userPasswordHelp").textContent = "(deja en blanco para conservar la actual)";
  } else {
    $("#userModalTitle").textContent = "Nuevo usuario";
    form.password.required = true;
    $("#userPasswordHelp").textContent = "(mínimo 8 caracteres)";
  }

  $("#userDialog").showModal();
}

// Guardar usuario (Crear o Editar)
$("#userForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  const id = values.id;
  delete values.id;

  // Convertir isActive a booleano
  values.isActive = values.isActive === "true";

  // Si editamos y la contraseña está vacía, no enviarla
  if (id && !values.password) {
    delete values.password;
  }

  try {
    if (id) {
      await api(`/api/usuarios/${id}`, {
        method: "PUT",
        body: JSON.stringify(values),
      });
      notify("Usuario actualizado correctamente.");
    } else {
      await api("/api/usuarios", {
        method: "POST",
        body: JSON.stringify(values),
      });
      notify("Usuario creado correctamente.");
    }
    $("#userDialog").close();
    loadUsers();
  } catch (error) {
    notify(error.message, true);
  }
});

// Acciones en la tabla de usuarios: Editar, Alternar Rol, Alternar Estado, Eliminar
$("#usersBody").addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const id = button.dataset.id;
  const user = usersList.find((u) => u._id === id);
  if (!user) return;

  // 1. EDITAR
  if (button.classList.contains("user-edit")) {
    openUserModal(user);
    return;
  }

  // 2. ALTERNAR ROL (user <-> suprem)
  if (button.classList.contains("user-role-toggle")) {
    const isCurrent = currentUser && String(currentUser.id) === String(user._id);
    if (isCurrent && user.role === "suprem") {
      return notify("Por seguridad, no puedes quitarte tus propios privilegios de administrador.", true);
    }
    const newRole = user.role === "suprem" ? "user" : "suprem";
    const confirmMsg = user.role === "suprem"
      ? `¿Degradar a ${user.name || user.username} al rol 'user'? Perderá privilegios administrativos.`
      : `¿Ascender a ${user.name || user.username} al rol 'suprem'? Tendrá acceso total a la gestión de usuarios.`;

    if (!confirm(confirmMsg)) return;

    try {
      await api(`/api/usuarios/${id}`, {
        method: "PUT",
        body: JSON.stringify({ role: newRole, name: user.name, email: user.email }),
      });
      notify(`Rol actualizado a '${newRole}'.`);
      loadUsers();
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }

  // 3. ALTERNAR ESTADO ACTIVO/INACTIVO
  if (button.classList.contains("user-status-toggle")) {
    const isCurrent = currentUser && String(currentUser.id) === String(user._id);
    if (isCurrent) {
      return notify("No puedes desactivar tu propia cuenta en sesión.", true);
    }
    const newStatus = !(user.isActive !== false);
    const confirmMsg = newStatus
      ? `¿Reactivar la cuenta de ${user.name || user.username}?`
      : `¿Desactivar la cuenta de ${user.name || user.username}? El usuario no podrá iniciar sesión.`;

    if (!confirm(confirmMsg)) return;

    try {
      await api(`/api/usuarios/${id}`, {
        method: "PUT",
        body: JSON.stringify({ isActive: newStatus, name: user.name, email: user.email }),
      });
      notify(newStatus ? "Cuenta reactivada." : "Cuenta desactivada.");
      loadUsers();
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }

  // 4. ELIMINAR CUENTA
  if (button.classList.contains("user-delete")) {
    const isCurrent = currentUser && String(currentUser.id) === String(user._id);
    if (isCurrent) {
      return notify("Por seguridad, no puedes eliminar tu propia cuenta en sesión.", true);
    }

    if (!confirm(`¿Estás seguro de que deseas eliminar permanentemente al usuario ${user.name || user.username} (${user.email || user.username})?\n\nEsta acción no se puede deshacer.`)) {
      return;
    }

    try {
      await api(`/api/usuarios/${id}`, { method: "DELETE" });
      notify("Usuario eliminado correctamente.");
      loadUsers();
    } catch (error) {
      notify(error.message, true);
    }
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

// Restaura la sesión existente cuando se recarga la página. Sin cookie válida
// simplemente se mantiene el formulario de acceso.
(async () => {
  try {
    const session = await api("/api/session");
    showApp(session);
  } catch {
    // Sesión ausente o vencida: no se redirige desde el propio login.
  }
})();

// ══════════════════════════════════════════════
// GOOGLE SIGN-IN ("Continuar con Google")
// ══════════════════════════════════════════════

// Inicializar Google Identity Services cuando el script cargue
async function initGoogleAuth() {
  try {
    const config = await fetch("/api/auth/google-config").then((r) => r.json()).catch(() => ({}));
    if (!config.clientId) return; // Sin GOOGLE_CLIENT_ID configurado: no mostrar

    if (typeof google === "undefined" || !google.accounts) return;

    function handleGoogleCredential(response) {
      handleGoogleLogin(response.credential, false);
    }

    // Inicializar GSI
    google.accounts.id.initialize({
      client_id: config.clientId,
      callback: handleGoogleCredential,
    });

    // Renderizar botón en el formulario de login
    const loginContainer = $("#googleLoginBtnContainer");
    if (loginContainer) {
      google.accounts.id.renderButton(loginContainer, {
        type: "standard",
        shape: "pill",
        theme: document.documentElement.dataset.theme === "dark" ? "filled_black" : "outline",
        text: "continue_with",
        size: "large",
        locale: "es",
        width: "100%",
      });
    }

    // Renderizar botón en el formulario de registro
    const registerContainer = $("#googleRegisterBtnContainer");
    if (registerContainer) {
      google.accounts.id.renderButton(registerContainer, {
        type: "standard",
        shape: "pill",
        theme: document.documentElement.dataset.theme === "dark" ? "filled_black" : "outline",
        text: "signup_with",
        size: "large",
        locale: "es",
        width: "100%",
      });
    }
  } catch (err) {
    console.warn("Google Auth no pudo inicializarse:", err);
  }
}

async function handleGoogleLogin(credential, isRegister) {
  try {
    const data = await api("/api/auth/google", {
      method: "POST",
      body: JSON.stringify({ credential }),
    });
    showApp(data);
    notify(`Bienvenido, ${data.name || data.username}`);
  } catch (err) {
    notify(err.message || "No se pudo iniciar sesión con Google.", true);
  }
}

// Llamar cuando el script de Google cargue (puede tardar si es async)
if (document.readyState === "complete") {
  initGoogleAuth();
} else {
  window.addEventListener("load", initGoogleAuth);
}
