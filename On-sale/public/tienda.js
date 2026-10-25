/* tienda.js — Lógica de la tienda pública centralizada */

// ─── Helpers ──────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const fmt = (val) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(Number(val || 0));

function toast(msg, isError = false) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = msg;
  el.className = "b-toast show" + (isError ? " error" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.className = "b-toast"), 3000);
}

// ─── Tema ──────────────────────────────────────────────────────
(function initTheme() {
  const saved = localStorage.getItem("cuentas_theme");
  if (saved === "dark" || (!saved && matchMedia("(prefers-color-scheme: dark)").matches)) {
    document.documentElement.dataset.theme = "dark";
  }
  const btn = $("#themeBtn");
  if (btn) {
    btn.addEventListener("click", () => {
      const dark = document.documentElement.dataset.theme !== "dark";
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      localStorage.setItem("cuentas_theme", dark ? "dark" : "light");
    });
  }
})();

// El botón del encabezado refleja y controla la sesión desde la cookie HttpOnly.
async function initSessionButton() {
  const button = $("#sessionBtn");
  if (!button) return;

  try {
    const response = await fetch("/api/session", { credentials: "same-origin" });
    if (!response.ok) return;
    await response.json().catch(() => ({}));
    button.textContent = "Cerrar sesión";
    button.href = "#";
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      button.disabled = true;
      await fetch("/api/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
      location.reload();
    });
  } catch {
    // Si no se puede validar la sesión, se conserva el enlace para iniciar sesión.
  }
}

// Aviso accesible cuando un visitante anónimo intenta usar el carrito.
function showAuthRequired() {
  const dialog = $("#authRequiredDialog");
  const login = $("#authRequiredLogin");
  const returnTo = `${location.pathname}${location.search}${location.hash}`;
  if (login) login.href = `/login?returnTo=${encodeURIComponent(returnTo)}`;
  if (dialog && typeof dialog.showModal === "function") {
    dialog.showModal();
  } else if (login) {
    location.href = login.href;
  }
}

$("#authRequiredCancel")?.addEventListener("click", () => $("#authRequiredDialog")?.close());
$("#authRequiredDialog")?.addEventListener("click", (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});

// ─── Microanimaciones del carrito ──────────────────────────────
const prefersReducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

function cartPieceCount(items) {
  return (Array.isArray(items) ? items : []).reduce(
    (total, item) => total + (Number(item.cantidad) || 0),
    0,
  );
}

function setCartCount(pieces) {
  const el = $("#cartCount");
  if (el) el.textContent = String(pieces);
}

// Hace "saltar" el contador y dibuja un anillo alrededor del botón del carrito.
function bumpCart() {
  const cart = $("#cartBtn");
  const count = $("#cartCount");
  if (cart) {
    cart.classList.remove("is-receiving");
    void cart.offsetWidth; // reinicia la animación si se agrega varias veces seguidas
    cart.classList.add("is-receiving");
    clearTimeout(bumpCart._timer);
    bumpCart._timer = setTimeout(() => cart.classList.remove("is-receiving"), 760);
  }
  if (count) {
    count.classList.remove("is-bumping");
    void count.offsetWidth;
    count.classList.add("is-bumping");
    clearTimeout(bumpCart._countTimer);
    bumpCart._countTimer = setTimeout(() => count.classList.remove("is-bumping"), 600);
  }
}

// Vuela una miniatura del producto hasta el botón del carrito siguiendo un arco.
function flyToCart(btn) {
  const cart = $("#cartBtn");
  if (!cart) return;
  if (prefersReducedMotion()) {
    bumpCart();
    return;
  }

  const card = btn.closest(".b-card");
  const image = card?.querySelector(".b-card__img");
  const source = (image || btn).getBoundingClientRect();
  const target = cart.getBoundingClientRect();
  const startX = source.left + source.width / 2;
  const startY = source.top + source.height / 2;
  const endX = target.left + target.width / 2;
  const endY = target.top + target.height / 2;
  const size = 62;

  const chip = document.createElement("div");
  chip.className = "b-fly";
  chip.setAttribute("aria-hidden", "true");
  chip.style.left = `${startX - size / 2}px`;
  chip.style.top = `${startY - size / 2}px`;

  if (image && image.currentSrc) {
    const copy = document.createElement("img");
    copy.src = image.currentSrc;
    copy.alt = "";
    chip.appendChild(copy);
  } else {
    chip.classList.add("b-fly--glyph");
    chip.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 7h12l1 13H5L6 7Z"/><path d="M9 7a3 3 0 0 1 6 0"/></svg>';
  }

  document.body.appendChild(chip);

  const dx = endX - startX;
  const dy = endY - startY;
  const animation = chip.animate(
    [
      { transform: "translate3d(0, 0, 0) scale(1) rotate(0deg)", opacity: 1, offset: 0 },
      {
        transform: `translate3d(${dx * 0.5}px, ${dy * 0.5 - 70}px, 0) scale(.72) rotate(-8deg)`,
        opacity: 1,
        offset: 0.55,
      },
      {
        transform: `translate3d(${dx}px, ${dy}px, 0) scale(.15) rotate(6deg)`,
        opacity: 0,
        offset: 1,
      },
    ],
    { duration: 820, easing: "cubic-bezier(.24,.66,.25,1)", fill: "forwards" },
  );

  const finish = () => {
    if (finish._done) return;
    finish._done = true;
    animation.cancel();
    chip.remove();
    bumpCart();
  };

  animation.finished.then(finish).catch(() => {});
  // El temporizador garantiza que el contador reaccione aunque el navegador
  // pause las animaciones (pestaña oculta o en segundo plano).
  setTimeout(finish, 900);
}

function resetAddButton(btn) {
  clearTimeout(btn._loadTimer);
  clearTimeout(btn._doneTimer);
  delete btn.dataset.state;
  btn.removeAttribute("aria-busy");
  btn.removeAttribute("aria-label");
}

// Secuencia completa: espera breve -> spinner -> check + vuelo + contador.
async function addToCart(btn) {
  const pid = btn.getAttribute("data-id");
  if (!pid || btn.disabled) return;

  resetAddButton(btn);
  const before = Number($("#cartCount")?.textContent) || 0;
  btn.disabled = true;
  btn.dataset.state = "pending";
  btn._loadTimer = setTimeout(() => {
    if (btn.dataset.state === "pending") {
      btn.dataset.state = "loading";
      btn.setAttribute("aria-busy", "true");
    }
  }, 140);

  try {
    const res = await fetch("/api/carrito", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productoId: pid, cantidad: 1 }),
    });
    if (res.status === 401) {
      // Sin sesión no se agrega nada: no se guarda en localStorage, sessionStorage ni cookies.
      resetAddButton(btn);
      showAuthRequired();
      return;
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "No se pudo agregar al carrito.");

    clearTimeout(btn._loadTimer);
    btn.removeAttribute("aria-busy");

    const items = Array.isArray(data.items) ? data.items : null;
    const after = items ? cartPieceCount(items) : before + 1;

    // El servidor limita la cantidad al stock: si no cambió nada, se avisa.
    if (data.cambio === false) {
      resetAddButton(btn);
      toast("Ya tienes el máximo disponible de este producto.", true);
      return;
    }

    btn.dataset.state = "done";
    btn.setAttribute("aria-label", "Producto agregado al carrito");
    flyToCart(btn);
    setCartCount(after);
    toast("Producto agregado al carrito.");
    btn._doneTimer = setTimeout(() => resetAddButton(btn), 1500);
  } catch (err) {
    resetAddButton(btn);
    toast(err.message || "No se pudo agregar al carrito.", true);
  } finally {
    btn.disabled = false;
  }
}

// ─── Estado de la aplicación ───────────────────────────────────
let state = {
  tienda: null,
  productos: [],
  total: 0,
  page: 1,
  pages: 1,
  limit: 24,
  query: "",
  sort: "nombre",
};

// ─── API ────────────────────────────────────────────────────────
async function apiGet(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Error al cargar datos.");
  return data;
}

// ─── Renderizado ───────────────────────────────────────────────
function renderStore(tienda) {
  // Aplicar el color de acento configurado para la tienda si existe.
  if (tienda.colorAcento) {
    document.documentElement.style.setProperty("--b-accent", tienda.colorAcento);
  }

  // Header / logo
  const logoText = $("#logoText");
  if (logoText) logoText.textContent = tienda.nombre || "On - sale";
  const tagline = $("#storeTagline");
  if (tagline) tagline.textContent = "Catálogo oficial";
  document.title = `${tienda.nombre || "On - sale"} · Catálogo`;

  // Hero
  const storeName = $("#storeName");
  if (storeName) storeName.textContent = tienda.nombre;

  const storeDesc = $("#storeDesc");
  if (storeDesc) storeDesc.textContent = tienda.descripcion || "";

  // La imagen configurada por entorno funciona como fondo del encabezado.
  const hero = $("#storeHero");
  const heroImage = $("#storeHeroImage");
  if (hero && heroImage) {
    hero.classList.remove("has-image");
    heroImage.classList.add("hidden");
    heroImage.onload = () => {
      heroImage.classList.remove("hidden");
      hero.classList.add("has-image");
    };
    heroImage.onerror = () => {
      heroImage.removeAttribute("src");
      heroImage.classList.add("hidden");
      hero.classList.remove("has-image");
    };
    if (tienda.logoUrl) heroImage.src = tienda.logoUrl;
    else heroImage.removeAttribute("src");
  }
}

function renderProducts() {
  const grid = $("#productsGrid");
  const empty = $("#emptyState");
  const pag = $("#pagination");
  const count = $("#resultsCount");
  if (!grid) return;

  grid.innerHTML = "";
  const { productos, total, page, pages } = state;

  if (count) {
    count.textContent = total
      ? `${total} producto${total !== 1 ? "s" : ""}`
      : "";
  }

  if (!productos.length) {
    if (empty) empty.classList.remove("hidden");
    const emptyText = $("#emptyText");
    if (emptyText) {
      emptyText.textContent = state.query
        ? "No hay artículos que coincidan con tu búsqueda."
        : "No hay productos disponibles por el momento.";
    }
    if (pag) pag.classList.add("hidden");
    return;
  }
  if (empty) empty.classList.add("hidden");

  grid.innerHTML = productos.map((p) => cardHTML(p)).join("");
  // Botones agregar al carrito
  grid.querySelectorAll(".b-add-cart").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      addToCart(btn);
    });
  });
  grid.querySelectorAll(".b-card__img").forEach((img) => {
    img.addEventListener("error", () => {
      const placeholder = document.createElement("div");
      placeholder.className = "b-card__img-placeholder";
      placeholder.textContent = "🏷️";
      img.replaceWith(placeholder);
      const card = placeholder.closest(".b-card");
      if (card) {
        card.removeAttribute("data-image");
        card.removeAttribute("role");
        card.removeAttribute("tabindex");
        card.removeAttribute("aria-label");
        card.classList.remove("b-card--zoomable");
      }
    }, { once: true });
  });

  grid.querySelectorAll(".b-card[data-image]").forEach((card) => {
    const openImage = (ev) => {
      if (ev.target && ev.target.classList && ev.target.classList.contains("b-add-cart")) return;
      if (!card.dataset.image) return;
      const dialog = $("#productImageDialog");
      const image = $("#productImageLarge");
      image.src = card.dataset.image;
      image.alt = card.dataset.name;
      $("#productImageCaption").textContent = card.dataset.name;
      if (dialog && typeof dialog.showModal === "function") dialog.showModal();
    };
    card.addEventListener("click", openImage);
    card.addEventListener("keydown", (event) => {
      if (event.target && event.target.classList && event.target.classList.contains("b-add-cart")) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openImage(event);
      }
    });
  });

  // Paginación
  if (pag) {
    if (pages <= 1) {
      pag.classList.add("hidden");
    } else {
      pag.classList.remove("hidden");
      pag.innerHTML = buildPagination(page, pages);
      pag.querySelectorAll("button:not(:disabled)").forEach((btn) => {
        btn.addEventListener("click", () => {
          state.page = Number(btn.dataset.page);
          fetchProducts();
        });
      });
    }
  }
}

function cardHTML(p) {
  const imageUrl = p.imagenUrl || p.imagenes?.[0] || "";
  const imgContent = !imageUrl
    ? `<div class="b-card__img-placeholder">🏷️</div>`
    : `<img class="b-card__img" src="${escHtml(imageUrl)}" alt="${escHtml(p.nombre)}" loading="lazy" />`;

  const badge = p.enPromocion
    ? `<span class="b-card__badge">Oferta</span>` : "";

  const prices = p.enPromocion
    ? `<span class="b-card__price b-card__price--sale">${fmt(p.precioFinal)}</span>
       <span class="b-card__price--original">${fmt(p.precioVenta)}</span>`
    : `<span class="b-card__price">${fmt(p.precioFinal || p.precioVenta)}</span>`;

  const stockNote = p.stock <= 3
    ? `<span class="b-card__stock b-card__stock--low">¡Solo ${p.stock} disponibles!</span>`
    : `<span class="b-card__stock">${p.stock} en existencia</span>`;

  const pid = p._id ? escHtml(String(p._id)) : "";

  return `
    <article class="b-card${imageUrl ? " b-card--zoomable" : ""}"${imageUrl ? ` data-image="${escHtml(imageUrl)}" data-name="${escHtml(p.nombre)}" role="button" tabindex="0" aria-label="Ampliar imagen de ${escHtml(p.nombre)}"` : ""}>
      <div class="b-card__img-wrap">
        ${imgContent}
        ${badge}
      </div>
      <div class="b-card__body">
        ${p.codigo ? `<span class="b-card__code">${escHtml(p.codigo)}</span>` : ""}
        <h2 class="b-card__name">${escHtml(p.nombre)}</h2>
        <div class="b-card__prices">${prices}</div>
        ${stockNote}
        <button class="b-btn b-btn--primary b-add-cart" type="button" data-id="${pid}" style="margin-top:10px; align-self:flex-start;">
          <span class="b-add-cart__label">Agregar al carrito</span>
          <span class="b-add-cart__state" aria-hidden="true">
            <span class="b-add-cart__spinner"></span>
            <svg class="b-add-cart__check" viewBox="0 0 24 24"><path d="M5 12.5l4.2 4.2L19 6.8"/></svg>
            <span class="b-add-cart__done">Agregado</span>
          </span>
        </button>
      </div>
    </article>`;
}

function buildPagination(current, total) {
  const range = [];
  for (let i = 1; i <= total; i++) {
    if (i === 1 || i === total || Math.abs(i - current) <= 1) range.push(i);
    else if (range[range.length - 1] !== "…") range.push("…");
  }
  const prev = `<button data-page="${current - 1}" ${current === 1 ? "disabled" : ""} aria-label="Anterior">‹</button>`;
  const next = `<button data-page="${current + 1}" ${current === total ? "disabled" : ""} aria-label="Siguiente">›</button>`;
  const nums = range.map((r) =>
    r === "…"
      ? `<span style="padding:0 4px;color:var(--b-muted)">…</span>`
      : `<button data-page="${r}" class="${r === current ? "active" : ""}">${r}</button>`
  ).join("");
  return prev + nums + next;
}

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const productImageDialog = $("#productImageDialog");
$("#closeProductImage")?.addEventListener("click", () => productImageDialog.close());
productImageDialog?.addEventListener("click", (event) => {
  if (event.target === productImageDialog) productImageDialog.close();
});

// Movimiento sutil del fondo al desplazarse, respetando movimiento reducido.
let heroFrame = 0;
window.addEventListener("scroll", () => {
  if (heroFrame) return;
  heroFrame = requestAnimationFrame(() => {
    heroFrame = 0;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const image = $("#storeHeroImage");
    if (image && !image.classList.contains("hidden")) {
      const offset = Math.min(window.scrollY * 0.16, 74);
      image.style.transform = `translate3d(0, ${offset}px, 0) scale(1.09)`;
    }
  });
}, { passive: true });

// ─── Vistas ─────────────────────────────────────────────────────
function showView(name) {
  ["loadingView", "notFoundView", "catalogView"].forEach((id) => {
    const el = $(`#${id}`);
    if (!el) return;
    el.classList.toggle("hidden", id !== name);
  });
}

// ─── Fetches ─────────────────────────────────────────────────────
async function fetchCatalog() {
  showView("loadingView");
  try {
    state.tienda = await apiGet("/api/tienda");
    renderStore(state.tienda);
    await fetchProducts({ propagate: true });
    showView("catalogView");
  } catch {
    showView("notFoundView");
  }
}

async function fetchProducts({ propagate = false } = {}) {
  const params = new URLSearchParams({
    page: state.page,
    limit: state.limit,
    sort: state.sort,
  });
  if (state.query) params.set("q", state.query);

  try {
    const data = await apiGet(`/api/tienda/productos?${params}`);
    state.productos = data.productos || [];
    state.total = data.total || 0;
    state.pages = data.pages || 1;
    renderProducts();
  } catch (err) {
    toast(err.message || "No se pudieron cargar los productos.", true);
    if (propagate) throw err;
  }
}

// ─── Controles ────────────────────────────────────────────────────
function initControls() {
  let debounceTimer;
  const searchInput = $("#searchInput");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        state.query = e.target.value.trim();
        state.page = 1;
        fetchProducts();
      }, 350);
    });
  }

  const sortSelect = $("#sortSelect");
  if (sortSelect) {
    sortSelect.addEventListener("change", (e) => {
      state.sort = e.target.value;
      state.page = 1;
      fetchProducts();
    });
  }
}

async function updateCartCount() {
  const el = $("#cartCount");
  if (!el) return;
  try {
    const res = await fetch("/api/carrito", { credentials: "same-origin" });
    if (res.status === 401) {
      setCartCount(0);
      return;
    }
    const data = await res.json().catch(() => ({ items: [] }));
    setCartCount(cartPieceCount(data.items));
  } catch {
    setCartCount(0);
  }
}

// ─── Init ────────────────────────────────────────────────────────
async function init() {
  // Migración: las versiones anteriores guardaban un token en localStorage.
  // La sesión ahora vive en una cookie HttpOnly y ese valor ya no se usa.
  localStorage.removeItem("cuentas_token");
  initControls();
  $("#retryCatalogBtn")?.addEventListener("click", fetchCatalog);
  await initSessionButton();
  await updateCartCount();
  await fetchCatalog();
}

init();
