/* carrito.js — Vista del carrito. La sesión vive en una cookie HttpOnly. */
const $ = (sel) => document.querySelector(sel);
const VENDEDOR_WHATSAPP = "7227509506";

function toast(msg, isError = false) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = msg;
  el.className = "b-toast show" + (isError ? " error" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.className = "b-toast"), 3200);
}

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

function redirectToLogin() {
  const returnTo = `${location.pathname}${location.search}${location.hash}`;
  location.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
}

async function initSessionButton() {
  const button = $("#sessionBtn");
  if (!button) return;
  try {
    const response = await fetch("/api/session", { credentials: "same-origin" });
    if (!response.ok) return;
    button.textContent = "Cerrar sesión";
    button.href = "#";
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      button.disabled = true;
      await fetch("/api/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
      location.replace("/");
    });
  } catch {}
}

async function fetchCart() {
  const res = await fetch("/api/carrito", { credentials: "same-origin" });
  if (res.status === 401) return { needAuth: true, items: [], removed: [] };
  if (!res.ok) throw new Error("No se pudo cargar el carrito.");
  const data = await res.json().catch(() => ({ items: [], removed: [] }));
  return {
    items: Array.isArray(data.items) ? data.items : [],
    removed: Array.isArray(data.removed) ? data.removed : [],
    needAuth: false,
  };
}

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderCart() {
  const list = $("#cartList");
  const empty = $("#cartEmpty");
  const summaryPieces = $("#summaryPieces");
  const summaryItems = $("#summaryItems");
  const cartCountHeader = $("#cartCountHeader");
  if (!list) return;

  const items = window.__cartItems || [];
  list.innerHTML = "";

  if (!items.length) {
    if (empty) empty.classList.remove("hidden");
    if (summaryPieces) summaryPieces.textContent = "0";
    if (summaryItems) summaryItems.textContent = "0";
    if (cartCountHeader) cartCountHeader.textContent = "0 piezas";
    return;
  }
  if (empty) empty.classList.add("hidden");

  let pieces = 0;
  items.forEach((it) => {
    pieces += Number(it.cantidad) || 0;
  });
  if (summaryPieces) summaryPieces.textContent = String(pieces);
  if (summaryItems) summaryItems.textContent = String(items.length);
  if (cartCountHeader) cartCountHeader.textContent = `${pieces} pieza${pieces === 1 ? "" : "s"}`;

  items.forEach((it) => {
    const id = String(it.productoId);
    const img = it.imagenUrl || it.imagenes?.[0] || "";
    const imgHtml = img
      ? `<img class="b-cart-item__img" src="${escHtml(img)}" alt="${escHtml(it.nombre)}" />`
      : `<div class="b-cart-item__img-ph">🏷️</div>`;
    const el = document.createElement("article");
    el.className = "b-cart-item";
    el.innerHTML = `
      ${imgHtml}
      <div class="b-cart-item__meta">
        ${it.codigo ? `<span class="b-cart-item__code">${escHtml(it.codigo)}</span>` : ""}
        <h3 class="b-cart-item__name">${escHtml(it.nombre)}</h3>
      </div>
      <div class="b-cart-item__actions">
        <div class="b-cart-qty">
          <button class="b-cart-qty__btn" data-act="dec" data-id="${escHtml(id)}" aria-label="Disminuir">-</button>
          <span class="b-cart-qty__num">${Number(it.cantidad) || 1}</span>
          <button class="b-cart-qty__btn" data-act="inc" data-id="${escHtml(id)}" aria-label="Aumentar">+</button>
        </div>
        <button class="b-cart-remove" data-act="remove" data-id="${escHtml(id)}">Eliminar</button>
      </div>
    `;
    list.appendChild(el);
  });

  list.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      const act = btn.getAttribute("data-act");
      const id = btn.getAttribute("data-id");
      try {
        if (act === "inc" || act === "dec") {
          const cur = (window.__cartItems || []).find((x) => String(x.productoId) === String(id));
          const next = (Number(cur?.cantidad) || 1) + (act === "inc" ? 1 : -1);
          const res = await fetch("/api/carrito/item", {
            method: "PUT",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ productoId: id, cantidad: next }),
          });
          if (res.status === 401) return redirectToLogin();
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || "No se pudo actualizar la cantidad.");
          }
        } else if (act === "remove") {
          const res = await fetch(`/api/carrito/item/${encodeURIComponent(id)}`, {
            method: "DELETE",
            credentials: "same-origin",
          });
          if (res.status === 401) return redirectToLogin();
          if (!res.ok) throw new Error("No se pudo eliminar el producto.");
        }
        await loadCart();
      } catch (err) {
        toast(err.message || "No se pudo actualizar el carrito.", true);
        btn.disabled = false;
      }
    });
  });
}

async function loadCart() {
  let data;
  try {
    data = await fetchCart();
  } catch (err) {
    toast(err.message || "No se pudo cargar el carrito.", true);
    return;
  }
  if (data.needAuth) {
    window.__cartItems = [];
    redirectToLogin();
    return;
  }
  window.__cartItems = data.items || [];
  renderCart();
  if (data.removed && data.removed.length) {
    toast("Algunos productos ya no están disponibles y se quitaron del carrito.", true);
  }
}

function initClear() {
  const btn = $("#clearCartBtn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const res = await fetch("/api/carrito", { method: "DELETE", credentials: "same-origin" });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error("No se pudo vaciar el carrito.");
      await loadCart();
    } catch (err) {
      toast(err.message || "No se pudo vaciar el carrito.", true);
    } finally {
      btn.disabled = false;
    }
  });
}

function initWhatsapp() {
  const btn = $("#whatsappBtn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    // La ventana se abre dentro del gesto del usuario para evitar bloqueos de pop-up.
    const waWindow = window.open("", "_blank");
    if (waWindow) {
      try {
        waWindow.opener = null;
      } catch {}
    }
    btn.disabled = true;
    try {
      const res = await fetch("/api/carrito/validar", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
      });
      if (res.status === 401) {
        if (waWindow) waWindow.close();
        return redirectToLogin();
      }
      const data = await res.json().catch(() => ({ items: [], removed: [] }));
      if (!res.ok) throw new Error(data.error || "No se pudo validar el carrito.");

      const removed = Array.isArray(data.removed) ? data.removed : [];
      if (removed.length) {
        if (waWindow) waWindow.close();
        toast("Algunos productos ya no están disponibles y se quitaron del carrito.", true);
        await loadCart();
        return;
      }

      const items = Array.isArray(data.items) ? data.items : [];
      if (!items.length) {
        if (waWindow) waWindow.close();
        toast("Tu carrito está vacío.", true);
        await loadCart();
        return;
      }

      // Obtener información del usuario autenticado
      let userInfo = {};
      try {
        const sessRes = await fetch("/api/session", { credentials: "same-origin" });
        if (sessRes.ok) {
          userInfo = await sessRes.json().catch(() => ({}));
        }
      } catch {}

      const lines = ["Compra:"];
      const userId = userInfo.id || userInfo._id || "";
      const username = userInfo.username || userInfo.name || "";
      if (userId || username) {
        lines.push(`- Identificador de usuario: ${userId} | Usuario: ${username}`);
      }
      items.forEach((it) => {
        const identificador = it.codigo || it.productoId || "";
        lines.push(
          `- Identificador: ${identificador} | Producto: ${it.nombre} | Cantidad: ${it.cantidad}`,
        );
      });
      const url = `https://wa.me/52${VENDEDOR_WHATSAPP}?text=${encodeURIComponent(lines.join("\n"))}`;
      if (waWindow) waWindow.location.href = url;
      else location.href = url;
    } catch (err) {
      if (waWindow) waWindow.close();
      toast(err.message || "No se pudo preparar el pedido.", true);
    } finally {
      btn.disabled = false;
    }
  });
}

async function init() {
  // Migración: el token anterior de localStorage ya no se utiliza.
  localStorage.removeItem("cuentas_token");
  await initSessionButton();
  await loadCart();
  initClear();
  initWhatsapp();
}

init();
