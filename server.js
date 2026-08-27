require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const DB_NAME = process.env.DB_NAME || 'cuentas';
const SESSION_SECRET = process.env.SESSION_SECRET || 'cambia-esta-clave-en-produccion';
const mongo = new MongoClient(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017');
let db;

app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const clean = value => String(value ?? '').trim();
const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const validId = id => ObjectId.isValid(id);
const b64 = value => Buffer.from(value).toString('base64url');

function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function passwordMatches(password, user) {
  const calculated = Buffer.from(passwordHash(password, user.salt).hash, 'hex');
  const stored = Buffer.from(user.passwordHash, 'hex');
  return calculated.length === stored.length && crypto.timingSafeEqual(calculated, stored);
}

function signToken(user) {
  const payload = b64(JSON.stringify({ sub: String(user._id), username: user.username, exp: Date.now() + 12 * 60 * 60 * 1000 }));
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readToken(token) {
  try {
    const [payload, signature] = String(token).split('.');
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch { return null; }
}

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const session = readToken(token);
  if (!session) return res.status(401).json({ error: 'Sesión inválida o vencida.' });
  req.user = session;
  next();
}

function handleError(res, error) {
  console.error(error);
  if (error?.code === 11000) return res.status(409).json({ error: 'Ya existe un cliente con ese nombre.' });
  res.status(500).json({ error: 'Ocurrió un error en el servidor.' });
}

app.post('/api/login', async (req, res) => {
  const username = clean(req.body.username).toLowerCase();
  const password = String(req.body.password || '');
  const user = await db.collection('usuarios').findOne({ username });
  if (!user || !passwordMatches(password, user)) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  res.json({ token: signToken(user), username: user.username });
});

app.get('/api/session', auth, (req, res) => res.json({ username: req.user.username }));

app.get('/api/clientes', auth, async (req, res) => {
  try {
    const search = clean(req.query.q);
    const match = search ? { nombre: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } } : {};
    const clientes = await db.collection('clientes').aggregate([
      { $match: match },
      { $lookup: { from: 'compras', localField: '_id', foreignField: 'clienteId', as: 'compras' } },
      { $lookup: { from: 'abonos', localField: '_id', foreignField: 'clienteId', as: 'abonos' } },
      { $addFields: {
        totalCompras: { $sum: '$compras.precio' }, totalEnganches: { $sum: '$compras.enganche' }, totalAbonos: { $sum: '$abonos.cantidad' }
      } },
      { $addFields: { deuda: { $max: [0, { $subtract: [{ $subtract: ['$totalCompras', '$totalEnganches'] }, '$totalAbonos'] }] } } },
      { $project: { compras: 0, abonos: 0 } },
      { $sort: { deuda: -1, nombre: 1 } }
    ]).toArray();
    res.json(clientes);
  } catch (error) { handleError(res, error); }
});

app.post('/api/clientes', auth, async (req, res) => {
  try {
    const nombre = clean(req.body.nombre);
    const telefono = clean(req.body.telefono);
    if (nombre.length < 2) return res.status(400).json({ error: 'Escribe el nombre del cliente.' });
    const now = new Date();
    const result = await db.collection('clientes').insertOne({ nombre, nombreNormalizado: nombre.toLowerCase(), telefono, creadoEn: now, actualizadoEn: now });
    res.status(201).json({ _id: result.insertedId, nombre, telefono, deuda: 0, totalCompras: 0, totalEnganches: 0, totalAbonos: 0 });
  } catch (error) { handleError(res, error); }
});

app.put('/api/clientes/:id', auth, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Cliente inválido.' });
    const nombre = clean(req.body.nombre);
    const telefono = clean(req.body.telefono);
    if (nombre.length < 2) return res.status(400).json({ error: 'Escribe el nombre del cliente.' });
    const result = await db.collection('clientes').updateOne({ _id: new ObjectId(req.params.id) }, { $set: { nombre, nombreNormalizado: nombre.toLowerCase(), telefono, actualizadoEn: new Date() } });
    if (!result.matchedCount) return res.status(404).json({ error: 'Cliente no encontrado.' });
    res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

app.delete('/api/clientes/:id', auth, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Cliente inválido.' });
    const clienteId = new ObjectId(req.params.id);
    await Promise.all([
      db.collection('clientes').deleteOne({ _id: clienteId }),
      db.collection('compras').deleteMany({ clienteId }),
      db.collection('abonos').deleteMany({ clienteId })
    ]);
    res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

app.get('/api/clientes/:id/movimientos', auth, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Cliente inválido.' });
    const clienteId = new ObjectId(req.params.id);
    const [cliente, compras, abonos] = await Promise.all([
      db.collection('clientes').findOne({ _id: clienteId }),
      db.collection('compras').find({ clienteId }).sort({ fecha: -1 }).toArray(),
      db.collection('abonos').find({ clienteId }).sort({ fecha: -1 }).toArray()
    ]);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado.' });
    const totalCompras = compras.reduce((sum, item) => sum + item.precio, 0);
    const totalEnganches = compras.reduce((sum, item) => sum + item.enganche, 0);
    const totalAbonos = abonos.reduce((sum, item) => sum + item.cantidad, 0);
    res.json({ cliente, compras, abonos, deuda: money(Math.max(0, totalCompras - totalEnganches - totalAbonos)) });
  } catch (error) { handleError(res, error); }
});

app.post('/api/clientes/:id/compras', auth, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Cliente inválido.' });
    const clienteId = new ObjectId(req.params.id);
    const producto = clean(req.body.producto);
    const precio = money(req.body.precio);
    const enganche = money(req.body.enganche || 0);
    if (!producto || !Number.isFinite(precio) || precio <= 0) return res.status(400).json({ error: 'Indica un producto y un precio válido.' });
    if (!Number.isFinite(enganche) || enganche < 0 || enganche > precio) return res.status(400).json({ error: 'El enganche debe estar entre $0 y el precio.' });
    if (!await db.collection('clientes').findOne({ _id: clienteId })) return res.status(404).json({ error: 'Cliente no encontrado.' });
    const compra = { clienteId, producto, precio, enganche, fecha: new Date(), creadoPor: req.user.username };
    const result = await db.collection('compras').insertOne(compra);
    res.status(201).json({ _id: result.insertedId, ...compra });
  } catch (error) { handleError(res, error); }
});

app.post('/api/clientes/:id/abonos', auth, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Cliente inválido.' });
    const clienteId = new ObjectId(req.params.id);
    const cantidad = money(req.body.cantidad);
    const nota = clean(req.body.nota);
    if (!Number.isFinite(cantidad) || cantidad <= 0) return res.status(400).json({ error: 'Indica una cantidad válida.' });
    const [compras, abonos] = await Promise.all([
      db.collection('compras').find({ clienteId }).toArray(), db.collection('abonos').find({ clienteId }).toArray()
    ]);
    const deuda = money(compras.reduce((s, x) => s + x.precio - x.enganche, 0) - abonos.reduce((s, x) => s + x.cantidad, 0));
    if (cantidad > deuda) return res.status(400).json({ error: `El abono supera la deuda actual de $${deuda.toFixed(2)}.` });
    const abono = { clienteId, cantidad, nota, fecha: new Date(), creadoPor: req.user.username };
    const result = await db.collection('abonos').insertOne(abono);
    res.status(201).json({ _id: result.insertedId, ...abono, deudaRestante: money(deuda - cantidad) });
  } catch (error) { handleError(res, error); }
});

async function bootstrap() {
  await mongo.connect();
  db = mongo.db(DB_NAME);
  await Promise.all([
    db.collection('usuarios').createIndex({ username: 1 }, { unique: true }),
    db.collection('clientes').createIndex({ nombreNormalizado: 1 }, { unique: true }),
    db.collection('compras').createIndex({ clienteId: 1, fecha: -1 }),
    db.collection('abonos').createIndex({ clienteId: 1, fecha: -1 })
  ]);
  const username = clean(process.env.ADMIN_USER || 'jesus').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'garm196cv';
  const secured = passwordHash(password);
  await db.collection('usuarios').updateOne(
    { username },
    { $set: { passwordHash: secured.hash, salt: secured.salt, actualizadoEn: new Date() }, $setOnInsert: { creadoEn: new Date() } },
    { upsert: true }
  );
  if (username !== 'admin') await db.collection('usuarios').deleteMany({ username: 'admin' });
  console.log(`Usuario principal configurado: ${username}`);
  app.listen(PORT, () => console.log(`Cuentas disponible en http://localhost:${PORT}`));
}

bootstrap().catch(error => { console.error('No fue posible iniciar:', error); process.exit(1); });

process.on('SIGINT', async () => { await mongo.close(); process.exit(0); });
