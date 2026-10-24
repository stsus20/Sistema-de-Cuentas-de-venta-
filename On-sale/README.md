# On-sale

Aplicación web para administrar clientes, ventas a pagos, enganches y abonos, con un catálogo público centralizado. Cada compra aumenta la deuda del cliente y cada enganche o abono la reduce.

## Arquitectura actual

- `GET /` sirve `public/tienda.html`: la única tienda pública, sin autenticación.
- `GET /login` sirve `public/index.html`: acceso al panel administrativo.
- Las rutas administrativas (`/api/productos`, `/api/clientes`, etc.) siguen protegidas con token y aíslan los datos por `ownerId`.
- El catálogo público (`GET /api/tienda/productos`) reúne los productos con `stock > 0` de todas las cuentas con rol `suprem`.
- Ya no existen tiendas individuales, slugs, publicación ni creación de tiendas. Las URLs antiguas `/tienda/:slug` redirigen a `/`.

## Ejecutar

1. Asegúrate de tener acceso a MongoDB (local o Atlas).
2. Copia `.env.example` como `.env` y completa `MONGODB_URI`, `DB_NAME` y `SESSION_SECRET`.
3. Instala y arranca:

```powershell
npm install
npm start
```

Abre `http://localhost:5000`. El catálogo público está en `/` y el acceso administrativo en `/login`.

## Variables de entorno

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `PORT` | No | Puerto HTTP. Render lo asigna automáticamente. |
| `MONGODB_URI` | Sí | Cadena de conexión de MongoDB. |
| `DB_NAME` | No | Nombre de la base. Por defecto `cuentas`. |
| `SESSION_SECRET` | Sí en producción | Clave larga y aleatoria para firmar sesiones. |
| `STORE_NAME` | No | Nombre visible de la tienda pública. |
| `STORE_DESCRIPTION` | No | Descripción del hero de la tienda. |
| `STORE_HERO_URL` | No | Imagen de fondo del hero (URL http(s) o ruta local). |
| `STORE_ACCENT_COLOR` | No | Color de acento en formato hexadecimal. |
| `GOOGLE_CLIENT_ID` | No | Habilita “Continuar con Google”. |

## Base de datos

La colección `productos` sigue siendo la fuente de verdad y conserva su aislamiento por `ownerId`. La antigua colección `tiendas` ya no se consulta; no es necesario eliminarla ni migrar los productos.

## Pruebas

```powershell
npm test
```

El proyecto no incluye pruebas automatizadas de integración. Para verificar el catálogo se recomienda arrancar el servidor y consultar `GET /api/tienda` y `GET /api/tienda/productos`.
