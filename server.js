require("dotenv").config();

// Dependencias del servidor, generación de PDF y conexión con MongoDB.
const crypto = require("crypto");
const express = require("express");
const PDFDocument = require("pdfkit");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const DB_NAME = process.env.DB_NAME || "cuentas";
const SESSION_SECRET =
  process.env.SESSION_SECRET || "cambia-esta-clave-en-produccion";
const mongo = new MongoClient(
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017",
);
let db;

// Middleware global: recibe JSON y publica los archivos de la interfaz.
app.use(express.json({ limit: "50kb" }));
app.use(express.static(path.join(__dirname, "public")));

const clean = (value) => String(value ?? "").trim();
const money = (value) =>
  Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const validId = (id) => ObjectId.isValid(id);
const b64 = (value) => Buffer.from(value).toString("base64url");

function passwordHash(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") };
}

function passwordMatches(password, user) {
  const calculated = Buffer.from(passwordHash(password, user.salt).hash, "hex");
  const stored = Buffer.from(user.passwordHash, "hex");
  return (
    calculated.length === stored.length &&
    crypto.timingSafeEqual(calculated, stored)
  );
}

// Crea tokens de sesión firmados que caducan después de doce horas.
function signToken(user) {
  const payload = b64(
    JSON.stringify({
      sub: String(user._id),
      username: user.username,
      exp: Date.now() + 12 * 60 * 60 * 1000,
    }),
  );
  const signature = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function readToken(token) {
  try {
    const [payload, signature] = String(token).split(".");
    const expected = crypto
      .createHmac("sha256", SESSION_SECRET)
      .update(payload)
      .digest("base64url");
    if (
      !signature ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

// Protege las rutas que necesitan un usuario autenticado.
function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const session = readToken(token);
  if (!session)
    return res.status(401).json({ error: "Sesión inválida o vencida." });
  req.user = session;
  next();
}

// Centraliza la respuesta de errores y evita exponer detalles internos.
function handleError(res, error) {
  console.error(error);
  if (error?.code === 11000)
    return res
      .status(409)
      .json({ error: "Ya existe un registro con ese nombre." });
  res.status(500).json({ error: "Ocurrió un error en el servidor." });
}

// Arranca el servidor y busca el siguiente puerto libre si es necesario.
function listenOnAvailablePort(startPort, attempts = 10) {
  const server = app.listen(startPort);
  server.once("listening", () =>
    console.log(`Cuentas disponible en http://localhost:${startPort}`),
  );
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attempts > 0) {
      console.warn(
        `El puerto ${startPort} está ocupado; intentando con ${startPort + 1}...`,
      );
      listenOnAvailablePort(startPort + 1, attempts - 1);
      return;
    }
    console.error(
      "No fue posible abrir un puerto para la aplicación:",
      error.message,
    );
    mongo.close().finally(() => process.exit(1));
  });
}

// Construye los totales de cada cliente para la vista activa o el historial.
function clientSummaryPipeline(search, history = false) {
  const match = search
    ? {
        nombre: {
          $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          $options: "i",
        },
      }
    : {};
  return [
    { $match: match },
    {
      $lookup: {
        from: "compras",
        localField: "_id",
        foreignField: "clienteId",
        as: "compras",
      },
    },
    {
      $lookup: {
        from: "abonos",
        localField: "_id",
        foreignField: "clienteId",
        as: "abonos",
      },
    },
    {
      $addFields: {
        totalCompras: { $sum: "$compras.precio" },
        totalEnganches: { $sum: "$compras.enganche" },
        totalAbonos: { $sum: "$abonos.cantidad" },
        numeroCompras: { $size: "$compras" },
      },
    },
    {
      $addFields: {
        deuda: {
          $max: [
            0,
            {
              $subtract: [
                { $subtract: ["$totalCompras", "$totalEnganches"] },
                "$totalAbonos",
              ],
            },
          ],
        },
      },
    },
    {
      $match: history
        ? { numeroCompras: { $gt: 0 }, deuda: { $lte: 0 } }
        : { $or: [{ numeroCompras: 0 }, { deuda: { $gt: 0 } }] },
    },
    { $project: { compras: 0, abonos: 0 } },
    {
      $sort: history
        ? { actualizadoEn: -1, nombre: 1 }
        : { deuda: -1, nombre: 1 },
    },
  ];
}

// Autentica al administrador y devuelve un token para las siguientes peticiones.
app.post("/api/login", async (req, res) => {
  const username = clean(req.body.username).toLowerCase();
  const password = String(req.body.password || "");
  const user = await db.collection("usuarios").findOne({ username });
  if (!user || !passwordMatches(password, user))
    return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
  res.json({ token: signToken(user), username: user.username });
});

// Confirma que el token almacenado por el navegador sigue siendo válido.
app.get("/api/session", auth, (req, res) =>
  res.json({ username: req.user.username }),
);

app.get("/api/proveedores", auth, async (req, res) => {
  try { const q = clean(req.query.q), match = q ? { nombre: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } } : {}; res.json(await db.collection("proveedores").find(match).sort({ nombre: 1 }).toArray()); }
  catch (error) { handleError(res, error); }
});
app.post("/api/proveedores", auth, async (req, res) => {
  try { const nombre = clean(req.body.nombre), contacto = clean(req.body.contacto), telefono = clean(req.body.telefono); if (nombre.length < 2) return res.status(400).json({ error: "Escribe el nombre del proveedor." }); const data = { nombre, nombreNormalizado: nombre.toLowerCase(), contacto, telefono, fechaRegistro: new Date(), actualizadoEn: new Date() }; const result = await db.collection("proveedores").insertOne(data); res.status(201).json({ _id: result.insertedId, ...data }); }
  catch (error) { handleError(res, error); }
});
app.put("/api/proveedores/:id", auth, async (req, res) => {
  try { if (!validId(req.params.id)) return res.status(400).json({ error: "Proveedor inválido." }); const nombre = clean(req.body.nombre), contacto = clean(req.body.contacto), telefono = clean(req.body.telefono); if (nombre.length < 2) return res.status(400).json({ error: "Escribe el nombre del proveedor." }); const result = await db.collection("proveedores").updateOne({ _id: new ObjectId(req.params.id) }, { $set: { nombre, nombreNormalizado: nombre.toLowerCase(), contacto, telefono, actualizadoEn: new Date() } }); if (!result.matchedCount) return res.status(404).json({ error: "Proveedor no encontrado." }); res.json({ ok: true }); }
  catch (error) { handleError(res, error); }
});
app.delete("/api/proveedores/:id", auth, async (req, res) => {
  try { if (!validId(req.params.id)) return res.status(400).json({ error: "Proveedor inválido." }); const proveedorId = new ObjectId(req.params.id); if (await db.collection("productos").findOne({ proveedorId })) return res.status(409).json({ error: "No puedes eliminar un proveedor que tiene productos asignados." }); await db.collection("proveedores").deleteOne({ _id: proveedorId }); res.json({ ok: true }); }
  catch (error) { handleError(res, error); }
});

app.get("/api/productos", auth, async (req, res) => {
  try {
    const q = clean(req.query.q);
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = q ? { $or: [{ nombre: { $regex: escaped, $options: "i" } }, { codigo: { $regex: escaped, $options: "i" } }] } : {};
    if (validId(req.query.proveedorId)) match.proveedorId = new ObjectId(req.query.proveedorId);
    if (clean(req.query.codigo)) match.codigo = clean(req.query.codigo);
    const productos = await db.collection("productos").aggregate([{ $match: match }, { $lookup: { from: "proveedores", localField: "proveedorId", foreignField: "_id", as: "proveedor" } }, { $addFields: { proveedor: { $arrayElemAt: ["$proveedor", 0] } } }, { $sort: { codigo: 1, nombre: 1 } }]).toArray();
    res.json(productos);
  } catch (error) { handleError(res, error); }
});

app.post("/api/productos", auth, async (req, res) => {
  try {
    const nombre = clean(req.body.nombre), precioCompra = money(req.body.precioCompra), precioVenta = money(req.body.precioVenta), stock = Number.parseInt(req.body.stock, 10);
    if (nombre.length < 2 || !Number.isFinite(precioCompra) || precioCompra < 0 || !Number.isFinite(precioVenta) || precioVenta <= 0 || !Number.isInteger(stock) || stock < 0 || !validId(req.body.proveedorId)) return res.status(400).json({ error: "Completa correctamente el proveedor, nombre, precios y stock." });
    const proveedorId = new ObjectId(req.body.proveedorId);
    if (!await db.collection("proveedores").findOne({ _id: proveedorId })) return res.status(404).json({ error: "Proveedor no encontrado." });
    const counter = await db.collection("contadores").findOneAndUpdate({ _id: "productos" }, { $inc: { secuencia: 1 } }, { upsert: true, returnDocument: "after" });
    const codigo = `PROD-${counter.secuencia}`;
    const producto = { codigo, proveedorId, nombre, nombreNormalizado: nombre.toLowerCase(), precioCompra, precioVenta, stock, stockInicial: stock, fechaRegistro: new Date(), actualizadoEn: new Date() };
    const result = await db.collection("productos").insertOne(producto);
    res.status(201).json({ _id: result.insertedId, ...producto });
  } catch (error) { handleError(res, error); }
});

app.put("/api/productos/:id", auth, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ error: "Producto inválido." });
    const nombre = clean(req.body.nombre), codigo = clean(req.body.codigo).toUpperCase(), precioCompra = money(req.body.precioCompra), precioVenta = money(req.body.precioVenta), stock = Number.parseInt(req.body.stock, 10);
    if (nombre.length < 2 || precioCompra < 0 || precioVenta <= 0 || !Number.isInteger(stock) || stock < 0 || !validId(req.body.proveedorId)) return res.status(400).json({ error: "Completa correctamente el proveedor, nombre, precios y stock." });
    if (codigo && !/^PROD-\d+$/.test(codigo)) return res.status(400).json({ error: "El código debe tener el formato PROD-1, PROD-2, etc." });
    const changes = { proveedorId: new ObjectId(req.body.proveedorId), nombre, nombreNormalizado: nombre.toLowerCase(), precioCompra, precioVenta, stock, actualizadoEn: new Date() };
    if (codigo) changes.codigo = codigo;
    const update = codigo ? { $set: changes } : { $set: changes, $unset: { codigo: "" } };
    const result = await db.collection("productos").updateOne({ _id: new ObjectId(req.params.id) }, update);
    if (!result.matchedCount) return res.status(404).json({ error: "Producto no encontrado." });
    res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

app.delete("/api/productos/:id", auth, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ error: "Producto inválido." });
    const productoId = new ObjectId(req.params.id);
    if (await db.collection("compras").findOne({ productoId })) return res.status(409).json({ error: "No puedes eliminar un producto que ya tiene ventas. Puedes dejar su stock en 0." });
    await Promise.all([db.collection("productos").deleteOne({ _id: productoId }), db.collection("promociones").deleteMany({ productoId })]);
    res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

app.get("/api/promociones", auth, async (_req, res) => {
  try {
    const promociones = await db.collection("promociones").aggregate([
      { $lookup: { from: "productos", localField: "productoId", foreignField: "_id", as: "producto" } },
      { $unwind: "$producto" }, { $sort: { "producto.nombre": 1 } }
    ]).toArray();
    res.json(promociones);
  } catch (error) { handleError(res, error); }
});

async function promotionData(body, res) {
  if (!validId(body.productoId)) { res.status(400).json({ error: "Selecciona un producto." }); return null; }
  const productoId = new ObjectId(body.productoId), producto = await db.collection("productos").findOne({ _id: productoId });
  const precioPromocion = money(body.precioPromocion);
  if (!producto) { res.status(404).json({ error: "Producto no encontrado." }); return null; }
  if (!Number.isFinite(precioPromocion) || precioPromocion <= 0 || precioPromocion >= producto.precioVenta) { res.status(400).json({ error: "El precio de promoción debe ser mayor a $0 y menor al precio de venta." }); return null; }
  return { productoId, precioPromocion, actualizadoEn: new Date() };
}

app.post("/api/promociones", auth, async (req, res) => {
  try { const data = await promotionData(req.body, res); if (!data) return; const result = await db.collection("promociones").insertOne({ ...data, fechaRegistro: new Date() }); res.status(201).json({ _id: result.insertedId, ...data }); }
  catch (error) { handleError(res, error); }
});

app.put("/api/promociones/:id", auth, async (req, res) => {
  try { if (!validId(req.params.id)) return res.status(400).json({ error: "Promoción inválida." }); const data = await promotionData(req.body, res); if (!data) return; const result = await db.collection("promociones").updateOne({ _id: new ObjectId(req.params.id) }, { $set: data }); if (!result.matchedCount) return res.status(404).json({ error: "Promoción no encontrada." }); res.json({ ok: true }); }
  catch (error) { handleError(res, error); }
});

app.delete("/api/promociones/:id", auth, async (req, res) => {
  try { if (!validId(req.params.id)) return res.status(400).json({ error: "Promoción inválida." }); await db.collection("promociones").deleteOne({ _id: new ObjectId(req.params.id) }); res.json({ ok: true }); }
  catch (error) { handleError(res, error); }
});

app.get("/api/gastos", auth, async (_req, res) => {
  try { res.json(await db.collection("gastos").find({}).sort({ fechaRegistro: -1 }).toArray()); }
  catch (error) { handleError(res, error); }
});
function expenseData(body, res) {
  const tipo = clean(body.tipo), descripcion = clean(body.descripcion), cantidad = money(body.cantidad);
  if (tipo.length < 2 || !Number.isFinite(cantidad) || cantidad <= 0) { res.status(400).json({ error: "Indica el tipo de gasto y una cantidad válida." }); return null; }
  return { tipo, descripcion, cantidad, actualizadoEn: new Date() };
}
app.post("/api/gastos", auth, async (req, res) => {
  try { const data = expenseData(req.body, res); if (!data) return; const gasto = { ...data, fechaRegistro: new Date(), creadoPor: req.user.username }; const result = await db.collection("gastos").insertOne(gasto); res.status(201).json({ _id: result.insertedId, ...gasto }); }
  catch (error) { handleError(res, error); }
});
app.put("/api/gastos/:id", auth, async (req, res) => {
  try { if (!validId(req.params.id)) return res.status(400).json({ error: "Gasto inválido." }); const data = expenseData(req.body, res); if (!data) return; const result = await db.collection("gastos").updateOne({ _id: new ObjectId(req.params.id) }, { $set: data }); if (!result.matchedCount) return res.status(404).json({ error: "Gasto no encontrado." }); res.json({ ok: true }); }
  catch (error) { handleError(res, error); }
});
app.delete("/api/gastos/:id", auth, async (req, res) => {
  try { if (!validId(req.params.id)) return res.status(400).json({ error: "Gasto inválido." }); await db.collection("gastos").deleteOne({ _id: new ObjectId(req.params.id) }); res.json({ ok: true }); }
  catch (error) { handleError(res, error); }
});

app.get("/api/inversion", auth, async (_req, res) => {
  try {
    const productos = await db.collection("productos").aggregate([
      { $lookup: { from: "compras", localField: "_id", foreignField: "productoId", as: "ventas" } },
      { $lookup: { from: "promociones", localField: "_id", foreignField: "productoId", as: "promociones" } },
      { $addFields: { promocion: { $arrayElemAt: ["$promociones", 0] } } },
      { $addFields: { precioInventario: { $cond: [{ $and: [{ $gt: ["$promocion.precioPromocion", 0] }, { $lt: ["$promocion.precioPromocion", "$precioVenta"] }] }, "$promocion.precioPromocion", "$precioVenta"] } } },
      { $addFields: { unidadesVendidas: { $sum: "$ventas.cantidad" }, ingresosVentas: { $sum: "$ventas.precio" }, costoVendido: { $sum: { $map: { input: "$ventas", as: "v", in: { $multiply: [{ $ifNull: ["$$v.costoUnitario", 0] }, { $ifNull: ["$$v.cantidad", 1] }] } } } }, gananciaRealizada: { $sum: { $map: { input: "$ventas", as: "v", in: { $subtract: ["$$v.precio", { $multiply: [{ $ifNull: ["$$v.costoUnitario", 0] }, { $ifNull: ["$$v.cantidad", 1] }] }] } } } } } },
      { $project: { ventas: 0, promociones: 0, promocion: 0 } }, { $sort: { gananciaRealizada: -1, nombre: 1 } }
    ]).toArray();
    const gastosTotales = money((await db.collection("gastos").aggregate([{ $group: { _id: null, total: { $sum: "$cantidad" } } }]).toArray())[0]?.total || 0);
    const inversionCompra = money(productos.reduce((s, p) => s + p.precioCompra * p.stock, 0));
    res.json({ productos, inversionCompra, gastosTotales, inversionTotal: money(inversionCompra + gastosTotales), valorVentaInventario: money(productos.reduce((s, p) => s + p.precioInventario * p.stock, 0)), gananciasTotales: money(productos.reduce((s, p) => s + p.gananciaRealizada, 0)), unidadesVendidas: productos.reduce((s, p) => s + (p.unidadesVendidas || 0), 0) });
  } catch (error) { handleError(res, error); }
});

// Devuelve clientes con saldo pendiente y sus totales calculados.
app.get("/api/clientes", auth, async (req, res) => {
  try {
    const search = clean(req.query.q);
    const clientes = await db
      .collection("clientes")
      .aggregate(clientSummaryPipeline(search, false))
      .toArray();
    res.json(clientes);
  } catch (error) {
    handleError(res, error);
  }
});

// Devuelve las cuentas que ya fueron saldadas.
app.get("/api/historial", auth, async (req, res) => {
  try {
    const clientes = await db
      .collection("clientes")
      .aggregate(clientSummaryPipeline(clean(req.query.q), true))
      .toArray();
    res.json(clientes);
  } catch (error) {
    handleError(res, error);
  }
});

// Genera el PDF del historial aplicando el filtro de búsqueda actual.
app.get("/api/historial/pdf", auth, async (req, res) => {
  try {
    const search = clean(req.query.q);
    const clientes = await db
      .collection("clientes")
      .aggregate(clientSummaryPipeline(search, true))
      .toArray();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="historial${search ? "-filtrado" : ""}.pdf"`,
    );
    const doc = new PDFDocument({ margin: 46, size: "LETTER" });
    doc.pipe(res);
    doc.fillColor("#7546c7").fontSize(23).text("Historial de cuentas saldadas");
    doc
      .moveDown(0.3)
      .fillColor("#6f657d")
      .fontSize(10)
      .text(
        `Generado: ${new Date().toLocaleString("es-MX")}${search ? `  |  Filtro: ${search}` : ""}`,
      );
    doc.moveDown(1.2);
    if (!clientes.length)
      doc
        .fillColor("#332842")
        .fontSize(12)
        .text("No hay cuentas saldadas que coincidan con el filtro.");
    for (const cliente of clientes) {
      if (doc.y > 650) doc.addPage();
      const boxY = doc.y;
      doc.roundedRect(46, boxY, 520, 56, 7).fillAndStroke("#f6f0ff", "#e2d5f5");
      const y = boxY + 10;
      doc.fillColor("#2d2040").fontSize(13).text(cliente.nombre, 58, y);
      doc
        .fillColor("#756985")
        .fontSize(9)
        .text(cliente.telefono || "Sin teléfono", 58, y + 19);
      doc
        .fillColor("#2d2040")
        .fontSize(10)
        .text(
          `Compras: $${money(cliente.totalCompras).toFixed(2)}   Enganches: $${money(cliente.totalEnganches).toFixed(2)}   Abonos: $${money(cliente.totalAbonos).toFixed(2)}`,
          210,
          y + 10,
          { width: 340, align: "right" },
        );
      doc.y = boxY + 68;
      const clienteId = new ObjectId(cliente._id);
      const [compras, abonos] = await Promise.all([
        db
          .collection("compras")
          .find({ clienteId })
          .sort({ fecha: 1 })
          .toArray(),
        db
          .collection("abonos")
          .find({ clienteId })
          .sort({ fecha: 1 })
          .toArray(),
      ]);
      doc.fillColor("#7546c7").fontSize(9).text("COMPRAS");
      for (const item of compras)
        doc
          .fillColor("#4c4258")
          .fontSize(9)
          .text(
            `${new Date(item.fecha).toLocaleDateString("es-MX")}  ${item.producto} — $${money(item.precio).toFixed(2)} (enganche $${money(item.enganche).toFixed(2)})`,
            { indent: 8 },
          );
      doc.moveDown(0.35).fillColor("#21906b").fontSize(9).text("ABONOS");
      for (const item of abonos)
        doc
          .fillColor("#4c4258")
          .fontSize(9)
          .text(
            `${new Date(item.fecha).toLocaleDateString("es-MX")}  $${money(item.cantidad).toFixed(2)}${item.nota ? ` — ${item.nota}` : ""}`,
            { indent: 8 },
          );
      doc.moveDown(1.1);
    }
    doc.end();
  } catch (error) {
    if (!res.headersSent) handleError(res, error);
    else res.end();
  }
});

// Crea un cliente nuevo y normaliza el nombre para evitar duplicados.
app.post("/api/clientes", auth, async (req, res) => {
  try {
    const nombre = clean(req.body.nombre);
    const telefono = clean(req.body.telefono);
    if (nombre.length < 2)
      return res.status(400).json({ error: "Escribe el nombre del cliente." });
    const now = new Date();
    const result = await db.collection("clientes").insertOne({
      nombre,
      nombreNormalizado: nombre.toLowerCase(),
      telefono,
      creadoEn: now,
      actualizadoEn: now,
    });
    res.status(201).json({
      _id: result.insertedId,
      nombre,
      telefono,
      deuda: 0,
      totalCompras: 0,
      totalEnganches: 0,
      totalAbonos: 0,
    });
  } catch (error) {
    handleError(res, error);
  }
});

// Actualiza los datos básicos de un cliente existente.
app.put("/api/clientes/:id", auth, async (req, res) => {
  try {
    if (!validId(req.params.id))
      return res.status(400).json({ error: "Cliente inválido." });
    const nombre = clean(req.body.nombre);
    const telefono = clean(req.body.telefono);
    if (nombre.length < 2)
      return res.status(400).json({ error: "Escribe el nombre del cliente." });
    const result = await db.collection("clientes").updateOne(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
          nombre,
          nombreNormalizado: nombre.toLowerCase(),
          telefono,
          actualizadoEn: new Date(),
        },
      },
    );
    if (!result.matchedCount)
      return res.status(404).json({ error: "Cliente no encontrado." });
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error);
  }
});

// Elimina al cliente junto con sus compras y abonos relacionados.
app.delete("/api/clientes/:id", auth, async (req, res) => {
  try {
    if (!validId(req.params.id))
      return res.status(400).json({ error: "Cliente inválido." });
    const clienteId = new ObjectId(req.params.id);
    const ventasCatalogo = await db.collection("compras").find({ clienteId, productoId: { $exists: true } }).toArray();
    for (const venta of ventasCatalogo) await db.collection("productos").updateOne({ _id: venta.productoId }, { $inc: { stock: venta.cantidad || 1 } });
    await Promise.all([
      db.collection("clientes").deleteOne({ _id: clienteId }),
      db.collection("compras").deleteMany({ clienteId }),
      db.collection("abonos").deleteMany({ clienteId }),
    ]);
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error);
  }
});

// Obtiene el detalle de una cuenta y calcula su deuda actual.
app.get("/api/clientes/:id/movimientos", auth, async (req, res) => {
  try {
    if (!validId(req.params.id))
      return res.status(400).json({ error: "Cliente inválido." });
    const clienteId = new ObjectId(req.params.id);
    const [cliente, compras, abonos] = await Promise.all([
      db.collection("clientes").findOne({ _id: clienteId }),
      db
        .collection("compras")
        .find({ clienteId })
        .sort({ fecha: -1 })
        .toArray(),
      db.collection("abonos").find({ clienteId }).sort({ fecha: -1 }).toArray(),
    ]);
    if (!cliente)
      return res.status(404).json({ error: "Cliente no encontrado." });
    const totalCompras = compras.reduce((sum, item) => sum + item.precio, 0);
    const totalEnganches = compras.reduce(
      (sum, item) => sum + item.enganche,
      0,
    );
    const totalAbonos = abonos.reduce((sum, item) => sum + item.cantidad, 0);
    res.json({
      cliente,
      compras,
      abonos,
      deuda: money(Math.max(0, totalCompras - totalEnganches - totalAbonos)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

// Registra una compra financiada para un cliente.
app.post("/api/clientes/:id/compras", auth, async (req, res) => {
  try {
    if (!validId(req.params.id))
      return res.status(400).json({ error: "Cliente inválido." });
    const clienteId = new ObjectId(req.params.id);
    if (!validId(req.body.productoId)) return res.status(400).json({ error: "Selecciona un producto del catálogo." });
    const productoId = new ObjectId(req.body.productoId), cantidad = 1;
    const catalogItem = await db.collection("productos").findOneAndUpdate({ _id: productoId, stock: { $gte: cantidad } }, { $inc: { stock: -cantidad }, $set: { actualizadoEn: new Date() } }, { returnDocument: "after" });
    if (!catalogItem) return res.status(400).json({ error: "El producto no existe o ya no tiene stock." });
    const producto = catalogItem.nombre;
    const promocion = await db.collection("promociones").findOne({ productoId });
    const precioUnitario = promocion?.precioPromocion > 0 && promocion.precioPromocion < catalogItem.precioVenta ? promocion.precioPromocion : catalogItem.precioVenta;
    const precio = money(precioUnitario * cantidad);
    const enganche = money(req.body.enganche || 0);
    if (!Number.isFinite(enganche) || enganche < 0 || enganche > precio)
      { await db.collection("productos").updateOne({ _id: productoId }, { $inc: { stock: cantidad } }); return res.status(400).json({ error: "El enganche debe estar entre $0 y el precio." }); }
    if (!(await db.collection("clientes").findOne({ _id: clienteId }))) {
      await db.collection("productos").updateOne({ _id: productoId }, { $inc: { stock: cantidad } });
      return res.status(404).json({ error: "Cliente no encontrado." });
    }
    const compra = {
      clienteId,
      productoId,
      producto,
      precio,
      cantidad,
      costoUnitario: catalogItem.precioCompra,
      enganche,
      fecha: new Date(),
      creadoPor: req.user.username,
    };
    let result;
    try { result = await db.collection("compras").insertOne(compra); }
    catch (error) { await db.collection("productos").updateOne({ _id: productoId }, { $inc: { stock: cantidad } }); throw error; }
    res.status(201).json({ _id: result.insertedId, ...compra });
  } catch (error) {
    handleError(res, error);
  }
});

// Registra un abono sin permitir que supere la deuda disponible.
app.post("/api/clientes/:id/abonos", auth, async (req, res) => {
  try {
    if (!validId(req.params.id))
      return res.status(400).json({ error: "Cliente inválido." });
    const clienteId = new ObjectId(req.params.id);
    const cantidad = money(req.body.cantidad);
    const nota = clean(req.body.nota);
    if (!Number.isFinite(cantidad) || cantidad <= 0)
      return res.status(400).json({ error: "Indica una cantidad válida." });
    const [compras, abonos] = await Promise.all([
      db.collection("compras").find({ clienteId }).toArray(),
      db.collection("abonos").find({ clienteId }).toArray(),
    ]);
    const deuda = money(
      compras.reduce((s, x) => s + x.precio - x.enganche, 0) -
        abonos.reduce((s, x) => s + x.cantidad, 0),
    );
    if (cantidad > deuda)
      return res.status(400).json({
        error: `El abono supera la deuda actual de $${deuda.toFixed(2)}.`,
      });
    const abono = {
      clienteId,
      cantidad,
      nota,
      fecha: new Date(),
      creadoPor: req.user.username,
    };
    const result = await db.collection("abonos").insertOne(abono);
    res.status(201).json({
      _id: result.insertedId,
      ...abono,
      deudaRestante: money(deuda - cantidad),
    });
  } catch (error) {
    handleError(res, error);
  }
});

// Conecta la base de datos, crea índices y prepara el usuario principal.
async function bootstrap() {
  await mongo.connect();
  db = mongo.db(DB_NAME);
  await Promise.all([
    db.collection("usuarios").createIndex({ username: 1 }, { unique: true }),
    db
      .collection("clientes")
      .createIndex({ nombreNormalizado: 1 }, { unique: true }),
    db.collection("compras").createIndex({ clienteId: 1, fecha: -1 }),
    db.collection("compras").createIndex({ productoId: 1, fecha: -1 }),
    db.collection("abonos").createIndex({ clienteId: 1, fecha: -1 }),
    db.collection("productos").createIndex({ nombreNormalizado: 1 }, { unique: true }),
    db.collection("productos").createIndex({ codigo: 1 }, { unique: true, sparse: true }),
    db.collection("promociones").createIndex({ productoId: 1 }, { unique: true }),
    db.collection("proveedores").createIndex({ nombreNormalizado: 1 }, { unique: true }),
    db.collection("gastos").createIndex({ fechaRegistro: -1 }),
  ]);
  const codedProducts = await db.collection("productos").find({ codigo: /^PROD-\d+$/i }, { projection: { codigo: 1 } }).toArray();
  const highestCode = codedProducts.reduce((max, product) => Math.max(max, Number(product.codigo.split("-")[1]) || 0), 0);
  await db.collection("contadores").updateOne({ _id: "productos" }, { $max: { secuencia: Math.max(4, highestCode) } }, { upsert: true });
  const username = clean(process.env.ADMIN_USER || "jesus").toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "garm196cv";
  const secured = passwordHash(password);
  await db.collection("usuarios").updateOne(
    { username },
    {
      $set: {
        passwordHash: secured.hash,
        salt: secured.salt,
        actualizadoEn: new Date(),
      },
      $setOnInsert: { creadoEn: new Date() },
    },
    { upsert: true },
  );
  if (username !== "admin")
    await db.collection("usuarios").deleteMany({ username: "admin" });
  console.log(`Usuario principal configurado: ${username}`);
  listenOnAvailablePort(PORT);
}

bootstrap().catch((error) => {
  console.error("No fue posible iniciar:", error);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await mongo.close();
  process.exit(0);
});
