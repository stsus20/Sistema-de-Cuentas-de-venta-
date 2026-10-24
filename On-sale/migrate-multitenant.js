const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();

async function migrate() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.DB_NAME || "cuentas";

  console.log("=== INICIANDO SCRIPT DE MIGRACIÓN Y VERIFICACIÓN MULTIEMPRESA ===");
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  // 1. Identificar administradores suprem existentes
  const suprems = await db.collection("usuarios").find({ role: "suprem" }).toArray();
  console.log(`Administradores 'suprem' encontrados: ${suprems.length}`);
  suprems.forEach((s) => console.log(`- ${s.username} (_id: ${s._id})`));

  const collections = [
    "clientes",
    "productos",
    "proveedores",
    "promociones",
    "gastos",
    "compras",
    "abonos",
  ];

  let unassignedTotal = 0;
  for (const col of collections) {
    const withoutOwner = await db.collection(col).countDocuments({ ownerId: { $exists: false } });
    const total = await db.collection(col).countDocuments();
    console.log(`Colección '${col}': total = ${total}, sin ownerId = ${withoutOwner}`);
    unassignedTotal += withoutOwner;
  }

  if (unassignedTotal === 0) {
    console.log("No hay documentos históricos huérfanos sin ownerId. La base de datos está consistente.");
  } else {
    console.log(`Se detectaron ${unassignedTotal} documentos sin ownerId.`);
    // Si hay un único administrador suprem (ej. jesus), se pueden asociar de forma segura si se autoriza
    if (suprems.length === 1) {
      const primaryOwner = suprems[0]._id;
      console.log(`Asignando registros históricos huérfanos al único administrador suprem existente: ${suprems[0].username} (${primaryOwner})`);
      for (const col of collections) {
        const res = await db.collection(col).updateMany(
          { ownerId: { $exists: false } },
          { $set: { ownerId: primaryOwner } },
        );
        if (res.modifiedCount > 0) {
          console.log(` -> Actualizados ${res.modifiedCount} registros en '${col}'.`);
        }
      }
    } else {
      console.log("ADVERTENCIA: Existen múltiples o ningún administrador suprem. Se requiere confirmación manual para asignar registros huérfanos.");
    }
  }

  await client.close();
  console.log("=== MIGRACIÓN FINALIZADA CON ÉXITO ===");
}

migrate().catch((err) => {
  console.error("Error durante la migración:", err);
  process.exit(1);
});
