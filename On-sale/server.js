require("dotenv").config();

// Dependencias del servidor, seguridad, generación de PDF y conexión con MongoDB.
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
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

// Seguridad HTTP mediante Helmet (con CSP adaptado para fuentes de Google, estilos locales y Google Identity Services)
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://accounts.google.com/gsi/client"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://accounts.google.com/gsi/style"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "https://accounts.google.com/gsi/"],
        frameSrc: ["'self'", "https://accounts.google.com/gsi/", "https://accounts.google.com/"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);

// Middleware global: recibe JSON con tamaño controlado y sirve interfaz estática
app.use(express.json({ limit: "10mb" }));
// La portada pública es el catálogo. El panel de acceso queda disponible en /login.
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "tienda.html")));
app.get("/login", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// Rate limiting para login y registro (previene ataques de fuerza bruta y abusos)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 20, // 20 intentos por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiados intentos. Por favor espera unos minutos e inténtalo de nuevo." },
});

// Rate limiting para operaciones administrativas sensibles
const adminLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiadas peticiones. Por favor inténtalo más tarde." },
});

const clean = (value) => String(value ?? "").trim();
const validProductImage = (value) => !value || (
  value.length <= 4_200_000 &&
  (/^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/]+={0,2}$/.test(value) ||
    /^https?:\/\/[^\s<>"']+$/i.test(value) ||
    /^\/(?!\/)[^\s<>"']*$/.test(value))
);
function parseProductImage(value) {
  const image = clean(value);
  return validProductImage(image) && (!image.startsWith("data:") || image.length <= 2_800_000) ? image : null;
}

// Identidad de la única tienda pública. Se configura por entorno y no depende
// de que un administrador cree, publique o configure una tienda en la base.
const publicStore = {
  nombre: clean(process.env.STORE_NAME || "On - sale").slice(0, 80) || "On - sale",
  descripcion: clean(process.env.STORE_DESCRIPTION || "Catálogo oficial · Descubre los productos disponibles.").slice(0, 300),
  logoUrl: (() => {
    const hero = clean(process.env.STORE_HERO_URL);
    return hero && !hero.startsWith("data:") && validProductImage(hero) ? hero : "";
  })(),
  colorAcento: /^#[0-9a-fA-F]{3,8}$/.test(clean(process.env.STORE_ACCENT_COLOR))
    ? clean(process.env.STORE_ACCENT_COLOR)
    : "",
};

const money = (value) =>
  Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const validId = (id) => typeof id === "string" && /^[0-9a-fA-F]{24}$/.test(id) && ObjectId.isValid(id);
const b64 = (value) => Buffer.from(value).toString("base64url");

// Expresión regular para validar formato de correo electrónico
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Nombre de usuario alfanumérico seguro
const USERNAME_REGEX = /^[a-zA-Z0-9._-]{3,30}$/;

// Hasheo seguro con bcrypt (cost factor 10)
async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

// Verificación de contraseñas con soporte retrocompatible (bcrypt o scrypt previo)
async function verifyPassword(password, user) {
  if (!user || !user.passwordHash) return false;
  // Si el usuario utiliza bcrypt
  if (user.passwordHash.startsWith("$2a$") || user.passwordHash.startsWith("$2b$") || user.passwordHash.startsWith("$2y$")) {
    return bcrypt.compare(password, user.passwordHash);
  }
  // Retrocompatibilidad segura para usuarios heredados generados con scrypt
  if (user.salt) {
    try {
      const calculated = Buffer.from(
        crypto.scryptSync(password, user.salt, 64).toString("hex"),
        "hex",
      );
      const stored = Buffer.from(user.passwordHash, "hex");
      if (calculated.length === stored.length && crypto.timingSafeEqual(calculated, stored)) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

// Genera un token firmado con HMAC-SHA256 con ID de sesión único
function signToken(user) {
  const payload = b64(
    JSON.stringify({
      sub: String(user._id),
      username: user.username,
      role: user.role || "user",
      jti: crypto.randomBytes(16).toString("hex"),
      exp: Date.now() + 12 * 60 * 60 * 1000, // 12 horas de caducidad
    }),
  );
  const signature = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

// Lee y verifica la integridad y vigencia del token
function readToken(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length !== 2) return null;
    const [payload, signature] = parts;
    const expected = crypto
      .createHmac("sha256", SESSION_SECRET)
      .update(payload)
      .digest("base64url");
    if (
      !signature ||
      signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
      return null;
    }
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    return data && data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

// Middleware de autenticación: verifica token y consulta base de datos para rol y estado activo en tiempo real
async function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const session = readToken(token);
  if (!session || !validId(session.sub)) {
    return res.status(401).json({ error: "Sesión inválida o vencida." });
  }

  try {
    const user = await db.collection("usuarios").findOne({ _id: new ObjectId(session.sub) });
    if (!user) {
      return res.status(401).json({ error: "Cuenta no encontrada o sesión revocada." });
    }
    if (user.isActive === false) {
      return res.status(403).json({ error: "Esta cuenta está desactivada. Contacta al administrador." });
    }

    // Inyecta el usuario con datos validados directamente desde Atlas en cada solicitud
    req.user = {
      _id: user._id,
      id: String(user._id),
      username: user.username,
      name: user.name || user.username,
      email: user.email || "",
      role: user.role === "suprem" ? "suprem" : "user",
      isActive: user.isActive !== false,
    };
    next();
  } catch (error) {
    return res.status(500).json({ error: "Error al validar la sesión." });
  }
}

// Solo la cuenta suprem cuyo username es "jesus" administra las cuentas del sistema.
function requireUserManager(req, res, next) {
  if (!req.user || req.user.role !== "suprem" || String(req.user.username || "").toLowerCase() !== "jesus") {
    return res.status(403).json({ error: "Solo el administrador jesus puede gestionar usuarios." });
  }
  next();
}

// Centraliza la respuesta de errores y evita exponer detalles internos
function handleError(res, error) {
  console.error(error);
  if (error?.code === 11000) {
    const field = Object.keys(error.keyPattern || {})[0] || "campo";
    return res
      .status(409)
      .json({ error: `Ya existe un registro con ese ${field === "email" ? "correo electrónico" : field === "username" ? "nombre de usuario" : field}.` });
  }
  res.status(500).json({ error: "Ocurrió un error en el servidor." });
}

// Inicia el servidor HTTP
function startServer() {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor iniciado en el puerto ${PORT}`);
  });
}

// Construye los totales de cada cliente para la vista activa o el historial, aislando por propietario.
function clientSummaryPipeline(ownerId, search, history = false) {
  const match = { ownerId: new ObjectId(ownerId) };
  if (search) {
    match.nombre = {
      $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      $options: "i",
    };
  }
  return [
    { $match: match },
    {
      $lookup: {
        from: "compras",
        let: { cId: "$_id", owner: "$ownerId" },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ["$clienteId", "$$cId"] }, { $eq: ["$ownerId", "$$owner"] }] } } },
        ],
        as: "compras",
      },
    },
    {
      $lookup: {
        from: "abonos",
        let: { cId: "$_id", owner: "$ownerId" },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ["$clienteId", "$$cId"] }, { $eq: ["$ownerId", "$$owner"] }] } } },
        ],
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

// Registro público de nuevas cuentas: siempre asigna rol 'user' y registra automáticamente en clientes
app.post("/api/register", authLimiter, async (req, res) => {
  try {
    const name = clean(req.body.name);
    const username = clean(req.body.username).toLowerCase();
    const email = clean(req.body.email).toLowerCase();
    const telefono = clean(req.body.telefono);
    const password = String(req.body.password || "");
    const confirmPassword = String(req.body.confirmPassword || "");

    // Validaciones estrictas
    if (name.length < 2 || name.length > 80) {
      return res.status(400).json({ error: "El nombre completo debe tener entre 2 y 80 caracteres." });
    }
    if (!telefono || telefono.length < 7 || telefono.length > 25) {
      return res.status(400).json({ error: "Proporciona un número de celular o teléfono válido (mínimo 7 dígitos)." });
    }
    if (!USERNAME_REGEX.test(username)) {
      return res.status(400).json({ error: "El usuario debe tener entre 3 y 30 caracteres alfanuméricos (letras, números, puntos, guiones)." });
    }
    if (!EMAIL_REGEX.test(email) || email.length > 100) {
      return res.status(400).json({ error: "Proporciona un correo electrónico válido." });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres." });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ error: "Las contraseñas no coinciden." });
    }

    // Verificar si username o email ya existen
    const existing = await db.collection("usuarios").findOne({
      $or: [{ username }, { email }],
    });
    if (existing) {
      if (existing.username === username) {
        return res.status(409).json({ error: "El nombre de usuario ya está registrado." });
      }
      return res.status(409).json({ error: "El correo electrónico ya está registrado." });
    }

    const passwordHashValue = await hashPassword(password);
    const now = new Date();

    // ROL ESTABLECIDO EXCLUSIVAMENTE EN EL SERVIDOR: 'user'
    // Ignora o rechaza cualquier campo adicional o rol enviado por el cliente
    const newUser = {
      name,
      username,
      email,
      telefono,
      passwordHash: passwordHashValue,
      role: "user",
      isActive: true,
      creadoEn: now,
      actualizadoEn: now,
    };

    const result = await db.collection("usuarios").insertOne(newUser);
    newUser._id = result.insertedId;

    res.status(201).json({
      message: "Cuenta creada exitosamente. Ya puedes iniciar sesión.",
      user: {
        _id: newUser._id,
        name: newUser.name,
        username: newUser.username,
        email: newUser.email,
        telefono: newUser.telefono,
        role: newUser.role,
      },
    });
  } catch (error) {
    handleError(res, error);
  }
});

// Autentica contra usuarios en MongoDB Atlas y devuelve un token firmado con rol verificado
app.post("/api/login", authLimiter, async (req, res) => {
  try {
    const identifier = clean(req.body.username || req.body.identifier).toLowerCase();
    const password = String(req.body.password || "");

    if (!identifier || !password) {
      return res.status(400).json({ error: "Ingresa tu usuario/correo y contraseña." });
    }

    // Permitir iniciar sesión con nombre de usuario o correo
    const user = await db.collection("usuarios").findOne({
      $or: [{ username: identifier }, { email: identifier }],
    });

    if (!user) {
      return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
    }

    if (user.isActive === false) {
      return res.status(403).json({ error: "Esta cuenta se encuentra desactivada. Contacta al administrador." });
    }

    const matches = await verifyPassword(password, user);
    if (!matches) {
      return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
    }

    // Si el usuario tenía el hash antiguo de scrypt, actualizamos a bcrypt de forma transparente
    if (user.salt && !user.passwordHash.startsWith("$2")) {
      try {
        const upgradedHash = await hashPassword(password);
        await db.collection("usuarios").updateOne(
          { _id: user._id },
          { $set: { passwordHash: upgradedHash }, $unset: { salt: "" } },
        );
      } catch (err) {
        console.error("Error al migrar hash a bcrypt:", err);
      }
    }

    const role = user.role === "suprem" ? "suprem" : "user";
    const token = signToken({ ...user, role });

    res.json({
      token,
      username: user.username,
      name: user.name || user.username,
      email: user.email || "",
      role,
    });
  } catch (error) {
    handleError(res, error);
  }
});

// Endpoint público para obtener el Google Client ID configurado (si existe)
app.get("/api/auth/google-config", (_req, res) => {
  res.json({ clientId: process.env.GOOGLE_CLIENT_ID || "" });
});

// Autenticación o registro con Google ("Continuar con Google")
app.post("/api/auth/google", authLimiter, async (req, res) => {
  try {
    const credential = clean(req.body.credential);
    const telefono = clean(req.body.telefono);

    if (!credential) {
      return res.status(400).json({ error: "No se recibió la credencial de Google." });
    }

    // Decodificar el JWT de Google ID Token (header.payload.signature)
    const parts = credential.split(".");
    if (parts.length !== 3) {
      return res.status(400).json({ error: "Token de Google inválido." });
    }

    let payload;
    try {
      const decodedJson = Buffer.from(parts[1], "base64url").toString("utf8");
      payload = JSON.parse(decodedJson);
    } catch {
      return res.status(400).json({ error: "Formato de token de Google corrupto." });
    }

    // Validar expiración y campos básicos
    const nowEpoch = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < nowEpoch) {
      return res.status(401).json({ error: "El token de Google ha expirado." });
    }
    if (!payload.email || !payload.email_verified) {
      return res.status(400).json({ error: "La cuenta de Google debe tener un correo electrónico verificado." });
    }

    // Validar Audience si GOOGLE_CLIENT_ID está configurado
    if (process.env.GOOGLE_CLIENT_ID && payload.aud !== process.env.GOOGLE_CLIENT_ID) {
      return res.status(401).json({ error: "El token no corresponde al identificador de la aplicación." });
    }

    const email = clean(payload.email).toLowerCase();
    const name = clean(payload.name || payload.given_name || email.split("@")[0]);
    const googleId = clean(payload.sub);
    const picture = clean(payload.picture || "");

    // Buscar si ya existe el usuario por googleId o por correo
    let user = await db.collection("usuarios").findOne({
      $or: [{ googleId }, { email }],
    });

    const now = new Date();

    if (user) {
      if (user.isActive === false) {
        return res.status(403).json({ error: "Esta cuenta se encuentra desactivada. Contacta al administrador." });
      }

      // Actualizar datos de Google si no los tenía
      const updateFields = { actualizadoEn: now };
      if (!user.googleId) updateFields.googleId = googleId;
      if (picture && !user.picture) updateFields.picture = picture;
      if (telefono && !user.telefono) updateFields.telefono = telefono;

      await db.collection("usuarios").updateOne({ _id: user._id }, { $set: updateFields });
      user = await db.collection("usuarios").findOne({ _id: user._id });
    } else {
      // Si es un usuario nuevo, generar un username único basado en su email o nombre
      let baseUsername = email.split("@")[0].replace(/[^a-zA-Z0-9._-]/g, "").toLowerCase();
      if (baseUsername.length < 3) baseUsername = "user" + Math.floor(1000 + Math.random() * 9000);
      let username = baseUsername;
      let counter = 1;
      while (await db.collection("usuarios").findOne({ username })) {
        username = `${baseUsername}${counter++}`;
      }

      const assignedPhone = telefono || "Sin teléfono";

      // Siempre rol 'user' para registros por Google
      user = {
        name,
        username,
        email,
        telefono: assignedPhone,
        googleId,
        picture,
        role: "user",
        isActive: true,
        creadoEn: now,
        actualizadoEn: now,
      };

      const result = await db.collection("usuarios").insertOne(user);
      user._id = result.insertedId;
    }

    const role = user.role === "suprem" ? "suprem" : "user";
    const appToken = signToken({ ...user, role });

    res.json({
      token: appToken,
      username: user.username,
      name: user.name || user.username,
      email: user.email || "",
      telefono: user.telefono || "",
      role,
    });
  } catch (error) {
    handleError(res, error);
  }
});

// Confirma que el token y la cuenta siguen vigentes, devolviendo el rol actualizado
app.get("/api/session", auth, (req, res) => {
  res.json({
    id: req.user.id,
    username: req.user.username,
    name: req.user.name,
    email: req.user.email,
    role: req.user.role,
  });
});

// Cierre de sesión (el cliente elimina el token local)
app.post("/api/logout", auth, (_req, res) => {
  res.json({ ok: true, message: "Sesión cerrada correctamente." });
});

// ==========================================
// CRUD ADMINISTRATIVO DE USUARIOS (ROL: SUPREM)
// ==========================================

// READ: Listado paginado de usuarios con buscador y filtros
app.get("/api/usuarios", auth, requireUserManager, async (req, res) => {
  try {
    const q = clean(req.query.q);
    const roleFilter = clean(req.query.role);
    const statusFilter = clean(req.query.status);
    const sortBy = clean(req.query.sortBy) || "creadoEn";
    const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const skip = (page - 1) * limit;

    const match = {};

    // Buscador por nombre, usuario y correo electrónico (sin operador vulnerable de inyección)
    if (q) {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      match.$or = [
        { name: { $regex: escaped, $options: "i" } },
        { username: { $regex: escaped, $options: "i" } },
        { email: { $regex: escaped, $options: "i" } },
      ];
    }

    // Filtro por rol ('user' o 'suprem')
    if (roleFilter === "user" || roleFilter === "suprem") {
      match.role = roleFilter;
    }

    // Filtro por estado activo/inactivo
    if (statusFilter === "active") {
      match.isActive = true;
    } else if (statusFilter === "inactive") {
      match.isActive = false;
    }

    // Mapeo seguro de campos de ordenación
    const validSortFields = {
      name: "name",
      username: "username",
      email: "email",
      role: "role",
      creadoEn: "creadoEn",
      actualizadoEn: "actualizadoEn",
    };
    const sortField = validSortFields[sortBy] || "creadoEn";
    const sortObj = { [sortField]: sortOrder };

    // Conteo total y registros paginados con exclusión segura de hashes
    const [total, usuarios] = await Promise.all([
      db.collection("usuarios").countDocuments(match),
      db
        .collection("usuarios")
        .find(match, {
          projection: {
            passwordHash: 0,
            salt: 0,
          },
        })
        .collation({ locale: "es", strength: 1 })
        .sort(sortObj)
        .skip(skip)
        .limit(limit)
        .toArray(),
    ]);

    res.json({
      usuarios,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

// READ ONE: Consultar un usuario individual
app.get("/api/usuarios/:id", auth, requireUserManager, async (req, res) => {
  try {
    if (!validId(req.params.id)) {
      return res.status(400).json({ error: "Identificador de usuario inválido." });
    }
    const user = await db.collection("usuarios").findOne(
      { _id: new ObjectId(req.params.id) },
      { projection: { passwordHash: 0, salt: 0 } },
    );
    if (!user) {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }
    res.json(user);
  } catch (error) {
    handleError(res, error);
  }
});

// CREATE: Crear cuenta desde el panel administrativo (permite rol user o suprem)
app.post("/api/usuarios", auth, requireUserManager, adminLimiter, async (req, res) => {
  try {
    const name = clean(req.body.name);
    const username = clean(req.body.username).toLowerCase();
    const email = clean(req.body.email).toLowerCase();
    const password = String(req.body.password || "");
    const requestedRole = clean(req.body.role).toLowerCase();
    const isActive = req.body.isActive !== false;

    if (name.length < 2 || name.length > 80) {
      return res.status(400).json({ error: "El nombre debe tener entre 2 y 80 caracteres." });
    }
    if (!USERNAME_REGEX.test(username)) {
      return res.status(400).json({ error: "El usuario debe tener entre 3 y 30 caracteres válidos." });
    }
    if (!EMAIL_REGEX.test(email) || email.length > 100) {
      return res.status(400).json({ error: "Proporciona un correo electrónico válido." });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres." });
    }

    // Solo se aceptan exactamente 'user' o 'suprem'
    const role = requestedRole === "suprem" ? "suprem" : "user";

    // Comprobar duplicados
    const existing = await db.collection("usuarios").findOne({
      $or: [{ username }, { email }],
    });
    if (existing) {
      if (existing.username === username) {
        return res.status(409).json({ error: "El nombre de usuario ya está registrado." });
      }
      return res.status(409).json({ error: "El correo electrónico ya está registrado." });
    }

    const passwordHashValue = await hashPassword(password);
    const now = new Date();

    const newUser = {
      name,
      username,
      email,
      passwordHash: passwordHashValue,
      role,
      isActive,
      creadoEn: now,
      actualizadoEn: now,
    };

    const result = await db.collection("usuarios").insertOne(newUser);
    res.status(201).json({
      _id: result.insertedId,
      name: newUser.name,
      username: newUser.username,
      email: newUser.email,
      role: newUser.role,
      isActive: newUser.isActive,
      creadoEn: newUser.creadoEn,
    });
  } catch (error) {
    handleError(res, error);
  }
});

// UPDATE: Modificar datos de usuario, estado o rol con protecciones de último suprem
app.put("/api/usuarios/:id", auth, requireUserManager, adminLimiter, async (req, res) => {
  try {
    if (!validId(req.params.id)) {
      return res.status(400).json({ error: "Identificador de usuario inválido." });
    }
    const targetId = new ObjectId(req.params.id);
    const targetUser = await db.collection("usuarios").findOne({ _id: targetId });
    if (!targetUser) {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }

    const name = clean(req.body.name);
    const email = clean(req.body.email).toLowerCase();
    const newPassword = String(req.body.password || "").trim();

    if (name.length < 2 || name.length > 80) {
      return res.status(400).json({ error: "El nombre debe tener entre 2 y 80 caracteres." });
    }
    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: "Proporciona un correo electrónico válido." });
    }

    // Verificar si el correo ya está en uso por otra cuenta
    const emailConflict = await db.collection("usuarios").findOne({
      email,
      _id: { $ne: targetId },
    });
    if (emailConflict) {
      return res.status(409).json({ error: "El correo electrónico ya está registrado en otra cuenta." });
    }

    const updateFields = {
      name,
      email,
      actualizadoEn: new Date(),
    };

    // Actualización de contraseña si se proporcionó una nueva
    if (newPassword) {
      if (newPassword.length < 8) {
        return res.status(400).json({ error: "La nueva contraseña debe tener al menos 8 caracteres." });
      }
      updateFields.passwordHash = await hashPassword(newPassword);
      // Elimina sal heredada en caso de actualización
      updateFields.salt = null;
    }

    // Si se modifica el estado activo/inactivo
    if (typeof req.body.isActive === "boolean") {
      const willBeActive = req.body.isActive;
      // Prohibir desactivar si es una cuenta suprem activa y es la última en el sistema
      if (!willBeActive && targetUser.role === "suprem" && targetUser.isActive !== false) {
        const activeSupremsCount = await db.collection("usuarios").countDocuments({
          role: "suprem",
          isActive: true,
        });
        if (activeSupremsCount <= 1) {
          return res.status(400).json({
            error: "No puedes desactivar la última cuenta 'suprem' activa del sistema.",
          });
        }
      }
      updateFields.isActive = willBeActive;
    }

    // Si se modifica el rol
    if (req.body.role !== undefined) {
      const newRole = clean(req.body.role).toLowerCase();
      if (newRole !== "user" && newRole !== "suprem") {
        return res.status(400).json({ error: "El rol asignado debe ser 'user' o 'suprem'." });
      }

      // Protección: un administrador no puede degradarse a sí mismo
      if (String(req.user._id) === String(targetId) && newRole !== "suprem") {
        return res.status(400).json({
          error: "Por seguridad, no puedes quitarte tus propios privilegios de administrador.",
        });
      }

      // Protección: no degradar al último suprem activo
      if (targetUser.role === "suprem" && newRole === "user") {
        const activeSupremsCount = await db.collection("usuarios").countDocuments({
          role: "suprem",
          isActive: true,
        });
        if (activeSupremsCount <= 1) {
          return res.status(400).json({
            error: "No puedes cambiar el rol de la última cuenta 'suprem' activa.",
          });
        }
      }
      updateFields.role = newRole;
    }

    await db.collection("usuarios").updateOne(
      { _id: targetId },
      { $set: updateFields, ...(updateFields.salt === null ? { $unset: { salt: "" } } : {}) },
    );

    const updated = await db.collection("usuarios").findOne(
      { _id: targetId },
      { projection: { passwordHash: 0, salt: 0 } },
    );
    res.json({ ok: true, user: updated });
  } catch (error) {
    handleError(res, error);
  }
});

// DELETE: Eliminar una cuenta de usuario
app.delete("/api/usuarios/:id", auth, requireUserManager, adminLimiter, async (req, res) => {
  try {
    if (!validId(req.params.id)) {
      return res.status(400).json({ error: "Identificador de usuario inválido." });
    }
    const targetId = new ObjectId(req.params.id);

    // Evitar que el administrador se elimine a sí mismo
    if (String(req.user._id) === String(targetId)) {
      return res.status(400).json({ error: "Por seguridad, no puedes eliminar tu propia cuenta en sesión." });
    }

    const targetUser = await db.collection("usuarios").findOne({ _id: targetId });
    if (!targetUser) {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }

    // Evitar eliminar el último suprem
    if (targetUser.role === "suprem") {
      const supremsCount = await db.collection("usuarios").countDocuments({
        role: "suprem",
      });
      if (supremsCount <= 1) {
        return res.status(400).json({
          error: "No se puede eliminar la única cuenta con rol 'suprem' del sistema.",
        });
      }
    }

    // Eliminar exclusivamente de la colección de usuarios, conservando integridad histórica
    await db.collection("usuarios").deleteOne({ _id: targetId });
    res.json({ ok: true, message: "Usuario eliminado correctamente." });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/proveedores", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    const q = clean(req.query.q);
    const match = { ownerId };
    if (q) {
      match.nombre = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    }
    res.json(await db.collection("proveedores").find(match).sort({ nombre: 1 }).toArray());
  } catch (error) { handleError(res, error); }
});

app.post("/api/proveedores", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    const nombre = clean(req.body.nombre), contacto = clean(req.body.contacto), telefono = clean(req.body.telefono);
    if (nombre.length < 2) return res.status(400).json({ error: "Escribe el nombre del proveedor." });
    const data = {
      ownerId,
      nombre,
      nombreNormalizado: nombre.toLowerCase(),
      contacto,
      telefono,
      fechaRegistro: new Date(),
      actualizadoEn: new Date(),
    };
    const result = await db.collection("proveedores").insertOne(data);
    res.status(201).json({ _id: result.insertedId, ...data });
  } catch (error) { handleError(res, error); }
});

app.put("/api/proveedores/:id", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    if (!validId(req.params.id)) return res.status(400).json({ error: "Proveedor inválido." });
    const nombre = clean(req.body.nombre), contacto = clean(req.body.contacto), telefono = clean(req.body.telefono);
    if (nombre.length < 2) return res.status(400).json({ error: "Escribe el nombre del proveedor." });
    const result = await db.collection("proveedores").updateOne(
      { _id: new ObjectId(req.params.id), ownerId },
      { $set: { nombre, nombreNormalizado: nombre.toLowerCase(), contacto, telefono, actualizadoEn: new Date() } },
    );
    if (!result.matchedCount) return res.status(404).json({ error: "Proveedor no encontrado." });
    res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

app.delete("/api/proveedores/:id", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    if (!validId(req.params.id)) return res.status(400).json({ error: "Proveedor inválido." });
    const proveedorId = new ObjectId(req.params.id);
    if (await db.collection("productos").findOne({ proveedorId, ownerId })) {
      return res.status(409).json({ error: "No puedes eliminar un proveedor que tiene productos asignados." });
    }
    const result = await db.collection("proveedores").deleteOne({ _id: proveedorId, ownerId });
    if (!result.deletedCount) return res.status(404).json({ error: "Proveedor no encontrado." });
    res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

app.get("/api/productos", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    const q = clean(req.query.q);
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = { ownerId };
    if (q) {
      match.$or = [{ nombre: { $regex: escaped, $options: "i" } }, { codigo: { $regex: escaped, $options: "i" } }];
    }
    if (validId(req.query.proveedorId)) match.proveedorId = new ObjectId(req.query.proveedorId);
    if (clean(req.query.codigo)) match.codigo = clean(req.query.codigo);
    const productos = await db.collection("productos").aggregate([
      { $match: match },
      {
        $lookup: {
          from: "proveedores",
          let: { pId: "$proveedorId", owner: "$ownerId" },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ["$_id", "$$pId"] }, { $eq: ["$ownerId", "$$owner"] }] } } },
          ],
          as: "proveedor",
        },
      },
      { $addFields: { proveedor: { $arrayElemAt: ["$proveedor", 0] } } },
      { $sort: { codigo: 1, nombre: 1 } },
    ]).toArray();
    res.json(productos);
  } catch (error) { handleError(res, error); }
});

app.post("/api/productos", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    const nombre = clean(req.body.nombre), precioCompra = money(req.body.precioCompra), precioVenta = money(req.body.precioVenta), stock = Number.parseInt(req.body.stock, 10);
    const imagenUrl = parseProductImage(req.body.imagenUrl || req.body.imagenes?.[0]);
    if (imagenUrl === null) return res.status(400).json({ error: "Selecciona una imagen válida de máximo 2 MB." });
    if (nombre.length < 2 || !Number.isFinite(precioCompra) || precioCompra < 0 || !Number.isFinite(precioVenta) || precioVenta <= 0 || !Number.isInteger(stock) || stock < 0 || !validId(req.body.proveedorId)) {
      return res.status(400).json({ error: "Completa correctamente el proveedor, nombre, precios y stock." });
    }
    const proveedorId = new ObjectId(req.body.proveedorId);
    // Verificar que el proveedor exista y pertenezca al mismo negocio
    if (!await db.collection("proveedores").findOne({ _id: proveedorId, ownerId })) {
      return res.status(404).json({ error: "Proveedor no encontrado o no pertenece a tu negocio." });
    }
    // Secuencia de código aislada por propietario
    const counter = await db.collection("contadores").findOneAndUpdate(
      { _id: `productos_${ownerId}` },
      { $inc: { secuencia: 1 } },
      { upsert: true, returnDocument: "after" },
    );
    const codigo = `PROD-${counter.secuencia}`;
    const producto = {
      ownerId,
      codigo,
      proveedorId,
      nombre,
      nombreNormalizado: nombre.toLowerCase(),
      precioCompra,
      precioVenta,
      stock,
      stockInicial: stock,
      ...(imagenUrl ? { imagenUrl } : {}),
      fechaRegistro: new Date(),
      actualizadoEn: new Date(),
    };
    const result = await db.collection("productos").insertOne(producto);
    res.status(201).json({ _id: result.insertedId, ...producto });
  } catch (error) { handleError(res, error); }
});

app.put("/api/productos/:id", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    if (!validId(req.params.id)) return res.status(400).json({ error: "Producto inválido." });
    const nombre = clean(req.body.nombre), codigo = clean(req.body.codigo).toUpperCase(), precioCompra = money(req.body.precioCompra), precioVenta = money(req.body.precioVenta), stock = Number.parseInt(req.body.stock, 10);
    const imagenUrl = parseProductImage(req.body.imagenUrl || req.body.imagenes?.[0]);
    if (imagenUrl === null) return res.status(400).json({ error: "Selecciona una imagen válida de máximo 2 MB." });
    if (nombre.length < 2 || precioCompra < 0 || precioVenta <= 0 || !Number.isInteger(stock) || stock < 0 || !validId(req.body.proveedorId)) {
      return res.status(400).json({ error: "Completa correctamente el proveedor, nombre, precios y stock." });
    }
    const proveedorId = new ObjectId(req.body.proveedorId);
    if (!await db.collection("proveedores").findOne({ _id: proveedorId, ownerId })) {
      return res.status(404).json({ error: "Proveedor no encontrado o no pertenece a tu negocio." });
    }
    if (codigo && !/^PROD-\d+$/.test(codigo)) return res.status(400).json({ error: "El código debe tener el formato PROD-1, PROD-2, etc." });
    const changes = { proveedorId, nombre, nombreNormalizado: nombre.toLowerCase(), precioCompra, precioVenta, stock, imagenUrl, actualizadoEn: new Date() };
    if (codigo) changes.codigo = codigo;
    const unset = { imagenes: "" };
    if (!codigo) unset.codigo = "";
    const update = { $set: changes, $unset: unset };
    const result = await db.collection("productos").updateOne({ _id: new ObjectId(req.params.id), ownerId }, update);
    if (!result.matchedCount) return res.status(404).json({ error: "Producto no encontrado." });
    res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

app.delete("/api/productos/:id", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    if (!validId(req.params.id)) return res.status(400).json({ error: "Producto inválido." });
    const productoId = new ObjectId(req.params.id);
    if (await db.collection("compras").findOne({ productoId, ownerId })) {
      return res.status(409).json({ error: "No puedes eliminar un producto que ya tiene ventas. Puedes dejar su stock en 0." });
    }
    const result = await db.collection("productos").deleteOne({ _id: productoId, ownerId });
    if (!result.deletedCount) return res.status(404).json({ error: "Producto no encontrado." });
    await db.collection("promociones").deleteMany({ productoId, ownerId });
    res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

app.get("/api/promociones", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    const promociones = await db.collection("promociones").aggregate([
      { $match: { ownerId } },
      {
        $lookup: {
          from: "productos",
          let: { pId: "$productoId", owner: "$ownerId" },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ["$_id", "$$pId"] }, { $eq: ["$ownerId", "$$owner"] }] } } },
          ],
          as: "producto",
        },
      },
      { $unwind: "$producto" },
      { $sort: { "producto.nombre": 1 } },
    ]).toArray();
    res.json(promociones);
  } catch (error) { handleError(res, error); }
});

async function promotionData(ownerId, body, res) {
  if (!validId(body.productoId)) { res.status(400).json({ error: "Selecciona un producto." }); return null; }
  const productoId = new ObjectId(body.productoId);
  const producto = await db.collection("productos").findOne({ _id: productoId, ownerId });
  const precioPromocion = money(body.precioPromocion);
  if (!producto) { res.status(404).json({ error: "Producto no encontrado o no pertenece a tu negocio." }); return null; }
  if (!Number.isFinite(precioPromocion) || precioPromocion <= 0 || precioPromocion >= producto.precioVenta) {
    res.status(400).json({ error: "El precio de promoción debe ser mayor a $0 y menor al precio de venta." });
    return null;
  }
  return { ownerId, productoId, precioPromocion, actualizadoEn: new Date() };
}

app.post("/api/promociones", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    const data = await promotionData(ownerId, req.body, res);
    if (!data) return;
    const result = await db.collection("promociones").insertOne({ ...data, fechaRegistro: new Date() });
    res.status(201).json({ _id: result.insertedId, ...data });
  } catch (error) { handleError(res, error); }
});

app.put("/api/promociones/:id", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    if (!validId(req.params.id)) return res.status(400).json({ error: "Promoción inválida." });
    const data = await promotionData(ownerId, req.body, res);
    if (!data) return;
    const result = await db.collection("promociones").updateOne(
      { _id: new ObjectId(req.params.id), ownerId },
      { $set: data },
    );
    if (!result.matchedCount) return res.status(404).json({ error: "Promoción no encontrada." });
    res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

app.delete("/api/promociones/:id", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    if (!validId(req.params.id)) return res.status(400).json({ error: "Promoción inválida." });
    const result = await db.collection("promociones").deleteOne({ _id: new ObjectId(req.params.id), ownerId });
    if (!result.deletedCount) return res.status(404).json({ error: "Promoción no encontrada." });
    res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

app.get("/api/gastos", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    res.json(await db.collection("gastos").find({ ownerId }).sort({ fechaRegistro: -1 }).toArray());
  } catch (error) { handleError(res, error); }
});

function expenseData(body, res) {
  const tipo = clean(body.tipo), descripcion = clean(body.descripcion), cantidad = money(body.cantidad);
  if (tipo.length < 2 || !Number.isFinite(cantidad) || cantidad <= 0) {
    res.status(400).json({ error: "Indica el tipo de gasto y una cantidad válida." });
    return null;
  }
  return { tipo, descripcion, cantidad, actualizadoEn: new Date() };
}

app.post("/api/gastos", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    const data = expenseData(req.body, res);
    if (!data) return;
    const gasto = { ...data, ownerId, fechaRegistro: new Date(), creadoPor: req.user.username };
    const result = await db.collection("gastos").insertOne(gasto);
    res.status(201).json({ _id: result.insertedId, ...gasto });
  } catch (error) { handleError(res, error); }
});

app.put("/api/gastos/:id", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    if (!validId(req.params.id)) return res.status(400).json({ error: "Gasto inválido." });
    const data = expenseData(req.body, res);
    if (!data) return;
    const result = await db.collection("gastos").updateOne(
      { _id: new ObjectId(req.params.id), ownerId },
      { $set: data },
    );
    if (!result.matchedCount) return res.status(404).json({ error: "Gasto no encontrado." });
    res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

app.delete("/api/gastos/:id", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    if (!validId(req.params.id)) return res.status(400).json({ error: "Gasto inválido." });
    const result = await db.collection("gastos").deleteOne({ _id: new ObjectId(req.params.id), ownerId });
    if (!result.deletedCount) return res.status(404).json({ error: "Gasto no encontrado." });
    res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

app.get("/api/inversion", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    const productos = await db.collection("productos").aggregate([
      { $match: { ownerId } },
      {
        $lookup: {
          from: "compras",
          let: { prodId: "$_id", owner: "$ownerId" },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ["$productoId", "$$prodId"] }, { $eq: ["$ownerId", "$$owner"] }] } } },
          ],
          as: "ventas",
        },
      },
      {
        $lookup: {
          from: "promociones",
          let: { prodId: "$_id", owner: "$ownerId" },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ["$productoId", "$$prodId"] }, { $eq: ["$ownerId", "$$owner"] }] } } },
          ],
          as: "promociones",
        },
      },
      { $addFields: { promocion: { $arrayElemAt: ["$promociones", 0] } } },
      { $addFields: { precioInventario: { $cond: [{ $and: [{ $gt: ["$promocion.precioPromocion", 0] }, { $lt: ["$promocion.precioPromocion", "$precioVenta"] }] }, "$promocion.precioPromocion", "$precioVenta"] } } },
      { $addFields: { unidadesVendidas: { $sum: "$ventas.cantidad" }, ingresosVentas: { $sum: "$ventas.precio" }, costoVendido: { $sum: { $map: { input: "$ventas", as: "v", in: { $multiply: [{ $ifNull: ["$$v.costoUnitario", 0] }, { $ifNull: ["$$v.cantidad", 1] }] } } } }, gananciaRealizada: { $sum: { $map: { input: "$ventas", as: "v", in: { $subtract: ["$$v.precio", { $multiply: [{ $ifNull: ["$$v.costoUnitario", 0] }, { $ifNull: ["$$v.cantidad", 1] }] }] } } } } } },
      { $project: { ventas: 0, promociones: 0, promocion: 0 } },
      { $sort: { gananciaRealizada: -1, nombre: 1 } },
    ]).toArray();
    const gastosTotales = money((await db.collection("gastos").aggregate([{ $match: { ownerId } }, { $group: { _id: null, total: { $sum: "$cantidad" } } }]).toArray())[0]?.total || 0);
    const inversionCompra = money(productos.reduce((s, p) => s + p.precioCompra * p.stock, 0));
    res.json({
      productos,
      inversionCompra,
      gastosTotales,
      inversionTotal: money(inversionCompra + gastosTotales),
      valorVentaInventario: money(productos.reduce((s, p) => s + p.precioInventario * p.stock, 0)),
      gananciasTotales: money(productos.reduce((s, p) => s + p.gananciaRealizada, 0)),
      unidadesVendidas: productos.reduce((s, p) => s + (p.unidadesVendidas || 0), 0),
    });
  } catch (error) { handleError(res, error); }
});

// Devuelve clientes con saldo pendiente y sus totales calculados para el propietario.
app.get("/api/clientes", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    const search = clean(req.query.q);
    const clientes = await db
      .collection("clientes")
      .aggregate(clientSummaryPipeline(ownerId, search, false))
      .toArray();
    res.json(clientes);
  } catch (error) {
    handleError(res, error);
  }
});

// Devuelve las cuentas que ya fueron saldadas para el propietario.
app.get("/api/historial", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    const clientes = await db
      .collection("clientes")
      .aggregate(clientSummaryPipeline(ownerId, clean(req.query.q), true))
      .toArray();
    res.json(clientes);
  } catch (error) {
    handleError(res, error);
  }
});

// Genera el PDF del historial aplicando el filtro de búsqueda del negocio.
app.get("/api/historial/pdf", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    const search = clean(req.query.q);
    const clientes = await db
      .collection("clientes")
      .aggregate(clientSummaryPipeline(ownerId, search, true))
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
          .find({ clienteId, ownerId })
          .sort({ fecha: 1 })
          .toArray(),
        db
          .collection("abonos")
          .find({ clienteId, ownerId })
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

// Crea un cliente nuevo en el negocio del propietario autenticado.
app.post("/api/clientes", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    const nombre = clean(req.body.nombre);
    const telefono = clean(req.body.telefono);
    if (nombre.length < 2)
      return res.status(400).json({ error: "Escribe el nombre del cliente." });
    const now = new Date();
    const result = await db.collection("clientes").insertOne({
      ownerId,
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

// Actualiza los datos básicos de un cliente de su negocio.
app.put("/api/clientes/:id", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    if (!validId(req.params.id))
      return res.status(400).json({ error: "Cliente inválido." });
    const nombre = clean(req.body.nombre);
    const telefono = clean(req.body.telefono);
    if (nombre.length < 2)
      return res.status(400).json({ error: "Escribe el nombre del cliente." });
    const result = await db.collection("clientes").updateOne(
      { _id: new ObjectId(req.params.id), ownerId },
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

// Elimina al cliente junto con sus compras y abonos relacionados, respetando el stock de su negocio.
app.delete("/api/clientes/:id", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    if (!validId(req.params.id))
      return res.status(400).json({ error: "Cliente inválido." });
    const clienteId = new ObjectId(req.params.id);
    const cliente = await db.collection("clientes").findOne({ _id: clienteId, ownerId });
    if (!cliente) return res.status(404).json({ error: "Cliente no encontrado." });

    const ventasCatalogo = await db.collection("compras").find({ clienteId, ownerId, productoId: { $exists: true } }).toArray();
    for (const venta of ventasCatalogo) {
      await db.collection("productos").updateOne({ _id: venta.productoId, ownerId }, { $inc: { stock: venta.cantidad || 1 } });
    }
    await Promise.all([
      db.collection("clientes").deleteOne({ _id: clienteId, ownerId }),
      db.collection("compras").deleteMany({ clienteId, ownerId }),
      db.collection("abonos").deleteMany({ clienteId, ownerId }),
    ]);
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error);
  }
});

// Obtiene el detalle de una cuenta y calcula su deuda actual garantizando propiedad.
app.get("/api/clientes/:id/movimientos", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    if (!validId(req.params.id))
      return res.status(400).json({ error: "Cliente inválido." });
    const clienteId = new ObjectId(req.params.id);
    const [cliente, compras, abonos] = await Promise.all([
      db.collection("clientes").findOne({ _id: clienteId, ownerId }),
      db
        .collection("compras")
        .find({ clienteId, ownerId })
        .sort({ fecha: -1 })
        .toArray(),
      db.collection("abonos").find({ clienteId, ownerId }).sort({ fecha: -1 }).toArray(),
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

// Registra una compra financiada para un cliente comprobando que cliente y producto pertenezcan al mismo propietario.
app.post("/api/clientes/:id/compras", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    if (!validId(req.params.id))
      return res.status(400).json({ error: "Cliente inválido." });
    const clienteId = new ObjectId(req.params.id);
    if (!validId(req.body.productoId)) return res.status(400).json({ error: "Selecciona un producto del catálogo." });
    const productoId = new ObjectId(req.body.productoId), cantidad = 1;

    // Verificar y descontar stock únicamente si el producto pertenece al propietario
    const catalogItem = await db.collection("productos").findOneAndUpdate(
      { _id: productoId, ownerId, stock: { $gte: cantidad } },
      { $inc: { stock: -cantidad }, $set: { actualizadoEn: new Date() } },
      { returnDocument: "after" },
    );
    if (!catalogItem) return res.status(400).json({ error: "El producto no existe, no pertenece a tu negocio o no tiene stock disponible." });

    const producto = catalogItem.nombre;
    const promocion = await db.collection("promociones").findOne({ productoId, ownerId });
    const precioUnitario = promocion?.precioPromocion > 0 && promocion.precioPromocion < catalogItem.precioVenta ? promocion.precioPromocion : catalogItem.precioVenta;
    const precio = money(precioUnitario * cantidad);
    const enganche = money(req.body.enganche || 0);

    if (!Number.isFinite(enganche) || enganche < 0 || enganche > precio) {
      await db.collection("productos").updateOne({ _id: productoId, ownerId }, { $inc: { stock: cantidad } });
      return res.status(400).json({ error: "El enganche debe estar entre $0 y el precio." });
    }

    if (!(await db.collection("clientes").findOne({ _id: clienteId, ownerId }))) {
      await db.collection("productos").updateOne({ _id: productoId, ownerId }, { $inc: { stock: cantidad } });
      return res.status(404).json({ error: "Cliente no encontrado o no pertenece a tu negocio." });
    }

    const compra = {
      ownerId,
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
    try {
      result = await db.collection("compras").insertOne(compra);
    } catch (error) {
      await db.collection("productos").updateOne({ _id: productoId, ownerId }, { $inc: { stock: cantidad } });
      throw error;
    }
    res.status(201).json({ _id: result.insertedId, ...compra });
  } catch (error) {
    handleError(res, error);
  }
});

// Registra un abono sin permitir que supere la deuda disponible, asegurando propiedad.
app.post("/api/clientes/:id/abonos", auth, async (req, res) => {
  try {
    const ownerId = req.user._id;
    if (!validId(req.params.id))
      return res.status(400).json({ error: "Cliente inválido." });
    const clienteId = new ObjectId(req.params.id);
    const cantidad = money(req.body.cantidad);
    const nota = clean(req.body.nota);
    if (!Number.isFinite(cantidad) || cantidad <= 0)
      return res.status(400).json({ error: "Indica una cantidad válida." });

    if (!(await db.collection("clientes").findOne({ _id: clienteId, ownerId }))) {
      return res.status(404).json({ error: "Cliente no encontrado o no pertenece a tu negocio." });
    }

    const [compras, abonos] = await Promise.all([
      db.collection("compras").find({ clienteId, ownerId }).toArray(),
      db.collection("abonos").find({ clienteId, ownerId }).toArray(),
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
      ownerId,
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

// ==========================================
// CATÁLOGO PÚBLICO CENTRALIZADO
// ==========================================

// Identidad de la tienda única (sin autenticación y sin datos de administradores).
app.get("/api/tienda", (_req, res) => {
  res.json(publicStore);
});

// Catálogo único con los productos disponibles de todos los administradores supremos.
// La fuente de verdad sigue siendo la colección "productos" y su aislamiento por ownerId.
app.get("/api/tienda/productos", async (req, res) => {
  try {
    const q = clean(req.query.q);
    const sortBy = clean(req.query.sort) || "nombre";
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 24));
    const skip = (page - 1) * limit;

    // Solo se publican productos de cuentas supremas; los usuarios normales conservan su inventario privado.
    const supremos = await db.collection("usuarios")
      .find({ role: "suprem" }, { projection: { _id: 1 } })
      .toArray();

    if (!supremos.length) {
      return res.json({ productos: [], total: 0, page, limit, pages: 0 });
    }

    // Se conserva la regla de negocio existente: stock > 0 es lo que hace visible un producto.
    const match = {
      ownerId: { $in: supremos.map((user) => user._id) },
      stock: { $gt: 0 },
    };
    if (q) {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      match.nombre = { $regex: escaped, $options: "i" };
    }

    const sortMap = {
      nombre: { nombre: 1 },
      precio_asc: { precioVenta: 1 },
      precio_desc: { precioVenta: -1 },
    };
    const sort = sortMap[sortBy] || { nombre: 1 };

    // Pipeline: buscar producto, añadir precio de promoción si existe
    const pipeline = [
      { $match: match },
      {
        $lookup: {
          from: "promociones",
          let: { pId: "$_id", owner: "$ownerId" },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ["$productoId", "$$pId"] }, { $eq: ["$ownerId", "$$owner"] }] } } },
          ],
          as: "promo",
        },
      },
      { $addFields: { promo: { $arrayElemAt: ["$promo", 0] } } },
      {
        $addFields: {
          precioFinal: {
            $cond: [
              { $and: [{ $gt: ["$promo.precioPromocion", 0] }, { $lt: ["$promo.precioPromocion", "$precioVenta"] }] },
              "$promo.precioPromocion",
              "$precioVenta",
            ],
          },
          enPromocion: {
            $cond: [
              { $and: [{ $gt: ["$promo.precioPromocion", 0] }, { $lt: ["$promo.precioPromocion", "$precioVenta"] }] },
              true,
              false,
            ],
          },
        },
      },
      // Solo exponer campos necesarios para el catálogo público.
      {
        $project: {
          nombre: 1,
          precioVenta: 1,
          precioFinal: 1,
          enPromocion: 1,
          stock: 1,
          imagenUrl: 1,
          imagenes: 1,
          codigo: 1,
        },
      },
      { $sort: sort },
      { $skip: skip },
      { $limit: limit },
    ];

    const [productos, total] = await Promise.all([
      db.collection("productos").aggregate(pipeline).toArray(),
      db.collection("productos").countDocuments(match),
    ]);

    res.json({ productos, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (error) { handleError(res, error); }
});

// Las URLs antiguas por tienda siguen siendo válidas, pero llevan al catálogo único.
app.get("/tienda", (_req, res) => res.redirect(301, "/"));
app.get("/tienda/:slug", (_req, res) => res.redirect(301, "/"));

// ==========================================
// BOOTSTRAP: Conexión y arranque del servidor
// ==========================================

// Conecta la base de datos, asegura índices multiempresa aislados por ownerId y arranca el servidor.
async function bootstrap() {
  await mongo.connect();
  db = mongo.db(DB_NAME);

  // Intentar eliminar índices globales antiguos si existen para evitar conflictos de unicidad inter-empresa
  const oldIndexesToDrop = [
    { col: "clientes", index: "nombreNormalizado_1" },
    { col: "productos", index: "nombreNormalizado_1" },
    { col: "productos", index: "codigo_1" },
    { col: "proveedores", index: "nombreNormalizado_1" },
    { col: "promociones", index: "productoId_1" },
  ];
  for (const item of oldIndexesToDrop) {
    try {
      await db.collection(item.col).dropIndex(item.index);
    } catch {
      // Ignorar si el índice no existía
    }
  }

  // Asegurar índices compuestos con aislamiento estricto por ownerId
  await Promise.all([
    // Colección de usuarios: global única por login/identificador
    db.collection("usuarios").createIndex({ username: 1 }, { unique: true }),
    db.collection("usuarios").createIndex({ email: 1 }, { unique: true, sparse: true }),
    db.collection("usuarios").createIndex({ role: 1 }),

    // Colecciones de negocio: unicidad e índices compuestos estrictamente por ownerId
    db.collection("clientes").createIndex({ ownerId: 1, nombreNormalizado: 1 }, { unique: true }),
    db.collection("clientes").createIndex({ ownerId: 1, creadoEn: -1 }),

    db.collection("proveedores").createIndex({ ownerId: 1, nombreNormalizado: 1 }, { unique: true }),

    db.collection("productos").createIndex({ ownerId: 1, nombreNormalizado: 1 }, { unique: true }),
    db.collection("productos").createIndex({ ownerId: 1, codigo: 1 }, { unique: true, sparse: true }),

    db.collection("promociones").createIndex({ ownerId: 1, productoId: 1 }, { unique: true }),

    db.collection("gastos").createIndex({ ownerId: 1, fechaRegistro: -1 }),

    db.collection("compras").createIndex({ ownerId: 1, clienteId: 1, fecha: -1 }),
    db.collection("compras").createIndex({ ownerId: 1, productoId: 1, fecha: -1 }),

    db.collection("abonos").createIndex({ ownerId: 1, clienteId: 1, fecha: -1 }),
  ]);

  console.log("Conexión con MongoDB Atlas establecida e índices multi-tenant asegurados.");
  startServer();
}

bootstrap().catch((error) => {
  console.error("No fue posible iniciar:", error);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await mongo.close();
  process.exit(0);
});

