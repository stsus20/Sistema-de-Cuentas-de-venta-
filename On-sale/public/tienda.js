/* tienda.js — Lógica del catálogo público boutique */

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

// El botón del encabezado refleja y controla la sesión directamente desde la tienda.
async function initSessionButton() {
  const button = $("#sessionBtn");
  if (!button) return;
  const token = localStorage.getItem("cuentas_token");
  if (!token) return;

  try {
    const response = await fetch("/api/session", { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      localStorage.removeItem("cuentas_token");
      return;
    }
    const session = await response.json();
    // En la portada, un administrador ve su propia tienda; una visita pública ve la destacada.
    if (!state.slug && session.role === "suprem") {
      const storeResponse = await fetch("/api/tiendas/mi-tienda", { headers: { Authorization: `Bearer ${token}` } });
      if (storeResponse.ok) {
        const ownStore = await storeResponse.json();
        if (ownStore.slug) state.slug = ownStore.slug;
      }
    }
    button.textContent = "Cerrar sesión";
    button.href = "#";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      localStorage.removeItem("cuentas_token");
      button.textContent = "Iniciar sesión";
      const returnTo = `${location.pathname}${location.search}${location.hash}`;
      button.href = `/login?returnTo=${encodeURIComponent(returnTo)}`;
      fetch("/api/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    });
  } catch {
    // Si no se puede validar la sesión, se conserva el enlace para iniciar sesión.
  }
}

// ─── Obtener slug de la URL ────────────────────────────────────
function getSlug() {
  const parts = location.pathname.split("/").filter(Boolean);
  // /tienda/:slug
  if (parts[0] === "tienda" && parts[1]) return parts[1];
  return null;
}

// ─── Estado de la aplicación ───────────────────────────────────
let state = {
  slug: null,
  tienda: null,
  productos: [],
  total: 0,
  page: 1,
  pages: 1,
  limit: 24,
  query: "",
  sort: "nombre",
  loading: false,
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
  // Aplicar color de acento personalizado si existe
  if (tienda.colorAcento) {
    document.documentElement.style.setProperty("--b-accent", tienda.colorAcento);
  }

  // Header / logo
  const logoText = $("#logoText");
  if (logoText) logoText.textContent = "On - sale";
  document.title = `${tienda.nombre} · On - sale`;

  // Hero
  const storeName = $("#storeName");
  if (storeName) storeName.textContent = tienda.nombre;

  const storeDesc = $("#storeDesc");
  if (storeDesc) storeDesc.textContent = tienda.descripcion || "";

  // La imagen configurada en el panel funciona como fondo del encabezado.
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
    if (pag) pag.classList.add("hidden");
    return;
  }
  if (empty) empty.classList.add("hidden");

  grid.innerHTML = productos.map((p) => cardHTML(p)).join("");
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
    const openImage = () => {
      if (!card.dataset.image) return;
      const dialog = $("#productImageDialog");
      const image = $("#productImageLarge");
      image.src = card.dataset.image;
      image.alt = card.dataset.name;
      $("#productImageCaption").textContent = card.dataset.name;
      dialog.showModal();
    };
    card.addEventListener("click", openImage);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openImage();
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
async function fetchStore() {
  showView("loadingView");
  try {
    if (!state.slug) {
      const featured = await apiGet("/api/tienda-destacada");
      state.slug = featured.slug;
    }
    state.tienda = await apiGet(`/api/tiendas/${state.slug}`);
    renderStore(state.tienda);
    await fetchProducts();
    showView("catalogView");
  } catch {
    showView("notFoundView");
  }
}

async function fetchProducts() {
  const params = new URLSearchParams({
    page: state.page,
    limit: state.limit,
    sort: state.sort,
  });
  if (state.query) params.set("q", state.query);

  try {
    const data = await apiGet(`/api/tiendas/${state.slug}/productos?${params}`);
    state.productos = data.productos || [];
    state.total = data.total || 0;
    state.pages = data.pages || 1;
    renderProducts();
  } catch (err) {
    toast(err.message || "No se pudieron cargar los productos.", true);
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

// ─── Init ────────────────────────────────────────────────────────
async function init() {
  state.slug = getSlug();
  initControls();
  await initSessionButton();
  await fetchStore();
}

init();
