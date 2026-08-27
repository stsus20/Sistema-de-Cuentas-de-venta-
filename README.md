# Cuentas

Aplicación web para administrar clientes, ventas a pagos, enganches y abonos. Cada compra aumenta la deuda del cliente y cada enganche o abono la reduce.

## Ejecutar

1. Asegúrate de que MongoDB esté activo en `mongodb://127.0.0.1:27017`.
2. Copia `.env.example` como `.env` y cambia las credenciales y `SESSION_SECRET`.
3. Instala y arranca:

```powershell
npm install
npm start
```

Abre `http://localhost:3000`. Sin archivo `.env`, el acceso principal es `jesus` / `garm196cv`.

La aplicación crea automáticamente la base `cuentas`, las colecciones `usuarios`, `clientes`, `compras` y `abonos`, además de sus índices.
