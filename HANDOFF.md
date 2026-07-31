# HANDOFF — Plataforma de cierres Grupo NAR

> Documento de traspaso técnico y operativo. Última actualización: 2026-07-31.
> Producción: **https://portal.gruponar.com** (Render, auto-deploy desde `main` de GitHub).

---

## 1. Qué es

Plataforma de coordinación de cierres inmobiliarios: centraliza en un solo lugar a admin, abogados internos, abogados externos, agentes, compradores y vendedores. Checklists de documentos por parte, expedientes KYC con firma electrónica (DocuSign), contratos de promesa generados desde machotes .docx, escrow agreements, tracker de cierre paso a paso, carpetas espejo en Google Drive, y correos transaccionales (Resend). **Sin dependencia de ningún LLM en producción** — todo es lógica determinista.

## 2. Stack y arquitectura

| Capa | Tecnología | Notas |
|---|---|---|
| Backend | Node 22 + Express | `server.js` monta todo; apagado limpio en SIGTERM |
| Base de datos | better-sqlite3 (WAL) | `db/schema.sql` (instalación desde cero) + migraciones idempotentes en `db/index.js` (corren en cada arranque) |
| Sesiones | connect-sqlite3 | `sessions.db` en el Disk persistente |
| Frontend | SPA vanilla JS en **un solo archivo**: `public/index.html` (~6,500 líneas) | i18n ES/EN inline, `render()` reconstruye el DOM completo (preserva scroll en la misma vista) |
| Archivos | Google Cloud Storage, bucket `gruponar-documentos` | Claves `<dealId>/<hex>.ext`; machotes bajo `contract-templates/`; respaldos bajo `_backups/` |
| Firmas | DocuSign eSignature (JWT grant) | Llave privada **solo** en Render; anchors `/sig1/` (comprador) `/sig2/` (vendedor), sufijos `_2/_3` para multi-firmante |
| Drive | OAuth del admin (refresh token en `app_settings`) | Carpetas por deal: Propiedad/Vendedor/Comprador/Escrow/Gestoría/Banco (se crean solas) |
| Correo | Resend | `lib/email.js` — plantilla visual compartida (`renderShell`), bilingüe por escenario/lado |
| PDF | LibreOffice (`soffice`) headless | Convierte .docx llenado → PDF (`lib/kycFill/docxFillEngine.js`) |
| Validación | zod `.strict()` en cada endpoint de escritura | `lib/validateBody.js` |
| Rate limiting | En memoria, por usuario/IP en 4 niveles | `lib/rateLimit.js` + `lib/apiRateLimits.js`; barrido periódico anti-fuga |

**Deploy**: `render.yaml`. Disk persistente montado en `DATA_DIR` (ahí viven `gruponar.db`, `sessions.db`, `uploads/` legado). Auto-deploy al pushear a `main`.

## 3. Modelo de roles y acceso (lib/access.js)

- **admin** — ve y toca todo (`UNRESTRICTED_ROLES`).
- **lawyer** (abogado interno) — **solo** las operaciones que creó (`deals.created_by`) o donde un admin lo agregó (fila en `deal_parties`). Dentro de una operación con acceso, ve todo (ambos lados).
- **external_lawyer / agent** — ligados por `deal_parties`; si eligieron lado (`represents_side`), solo ven partes/documentos de ese lado.
- **buyer / seller** — solo su(s) operación(es); solo tocan documentos de SU parte (`canTouchDoc`).
- **Apoderado** — `deal_parties.relationship = 'attorney_in_fact'`: hasta un titular + un apoderado por parte, con facultades idénticas sobre esa parte. El apoderado **no** firma contratos/escrow (solo el titular) para no duplicar sobres.
- Secciones **Gestoría/Banco** (`documents.section`) — solo admin/lawyer/external_lawyer; el backend ni las devuelve a clientes/agentes.
- 2FA obligatorio (TOTP o código por correo); regeneración de session ID en cada login (anti-fixation); "recordar dispositivo" 30 días.

## 4. Flujos clave

### Operación (deal)
`POST /api/deals` crea deal + partes (con estructura de propiedad para entidades) + checklist por escenario (`data/scenario-docs.json`) + tracker (`data/scenario-tasks.json`) + docs de Gestoría/Banco (escenarios de fideicomiso). Escenarios: `purchase`, `trust`, `transfer`, `trust_termination`. **El escenario NO es editable** después de crear (rearmaría checklists — pendiente #43). Borrado = papelera (`deleted_at`); restaurar o borrar-para-siempre es solo admin (esto último sí purga GCS).

### Documentos
Subida → GCS + copia a Drive best-effort. **Versionado**: al reemplazar o quitar un archivo, la versión anterior se archiva en `document_versions` (el objeto en GCS se conserva); historial visible para staff (botón reloj / menú "···"). Revisión aprobar/rechazar por admin/lawyer. Vista staff: acción principal + menú "···"; vista cliente: botones directos.

### KYC
Plantillas por escrow company (Armour/TLA) + LPR si hay agente de LPR Luxury; individual/moral; ES/EN auto por escenario+lado (`data/kyc-templates/`, `lib/kycFill/*`). Si quien llena es el propio firmante → firma **embebida** en el portal; si lo llenó staff → sobre por correo. Agente/abogado externo genera pero NO envía (lo revisa admin/lawyer — tarea `kyc_review` en el tracker).

### Contratos (PSA) y escrow
Machotes .docx con `{{PLACEHOLDERS}}` subidos por admin/lawyer (varios por escenario, se elige al generar). Extracción de campos automática, campos "smart" (`lib/contractFill/smartContractFields.js`), llenado → PDF → DocuSign. Escrow agreement (Armour) se genera desde formulario. **"Firmado fuera de la plataforma"**: si el doc se subió ya firmado, se marca completado sin DocuSign (reversible; nunca pisa un sobre real).

### Estado DocuSign
Por **polling manual** ("Verificar estado") — no hay webhook Connect (decisión consciente; el webhook es mejora futura).

### Comunicación
- "Te toca a ti (N)" en el portal del cliente (firmas llegadas + KYC por firmar + docs por subir, desplegable).
- "Mis tareas (N)" en el Dashboard (tareas del tracker asignadas a mí).
- Resumen de avance por correo a las partes (botón en el tracker, admin/lawyer).
- Correo automático al asignar tarea a un abogado.
- Recordatorios automáticos: docs pendientes (diario con cooldown), fechas límite a 7 y 2 días (cierre/due diligence, al equipo), predial anual (enero, a compradores cerrados).
- Línea de tiempo por operación (`deal_activity`) — solo staff.

## 5. Jobs automáticos (server.js)

| Job | Frecuencia | Módulo |
|---|---|---|
| Recordatorio de documentos pendientes | 24 h | `lib/reminders.js` |
| Recordatorio anual de predial | Diario (actúa solo 1ª semana de enero) | `lib/predialReminder.js` |
| Fechas límite a 7/2 días | Diario, anti-duplicado en DB | `lib/deadlineReminders.js` |
| **Respaldo de la base a GCS** | Diario, retención 14 días, **solo en Render** | `lib/dbBackup.js` → `_backups/` |
| Aviso "versión nueva" en el frontend | Poll cada 5 min a `/api/health` | banner con botón Recargar |

## 6. Variables de entorno

| Variable | Uso |
|---|---|
| `SESSION_SECRET` | **Obligatoria** (el server no arranca sin ella) |
| `DATA_DIR` | Disk persistente en Render (DB + sesiones + uploads) |
| `DATABASE_PATH` | Override directo de la ruta de la DB (tests) |
| `GCS_BUCKET_NAME`, `GCS_SERVICE_ACCOUNT_JSON` | Cloud Storage (el SA solo tiene permisos de objetos, no de bucket) |
| `DOCUSIGN_INTEGRATION_KEY`, `DOCUSIGN_USER_ID`, `DOCUSIGN_ACCOUNT_ID`, `DOCUSIGN_PRIVATE_KEY` o `_PATH` | JWT grant; **la llave privada solo existe en Render** |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | Correos; sin la key todo sigue funcionando (los correos se saltan con aviso) |
| `PORTAL_URL` / `APP_BASE_URL` | URLs absolutas en correos |
| `FRONTEND_ORIGIN` | Solo si el frontend viviera en otro origen (hoy no) |
| `RENDER` | La pone Render sola; habilita el respaldo diario |
| `DISABLE_RATE_LIMITS=1` | **Solo la suite de tests** — jamás en producción |
| `FORCE_DB_BACKUP=1` | Forzar respaldo manual en local |

## 7. Tests

```bash
npm test        # node:test integrado — 11 pruebas, sin dependencias nuevas
```
Levanta el servidor real con DB temporal y cubre: health/404/JSON-malformado, login 2FA **con verificación de regeneración de sesión**, scoping de abogado interno, ciclo papelera/restaurar, filtrado Gestoría/Banco a clientes (lista y acceso directo por ID), asignación de tareas + actividad, versiones de documentos, edición de perfil (conflicto de correo, admin protegido). La suite ya cazó un bug real: la migración de `external_lawyer` tiraba las columnas de 2FA en instalaciones desde cero (arreglado — `schema.sql` trae hoy la definición completa de `users`).

**Patrón para pruebas manuales locales**: crear usuario `devtest-*@example.com` vía sqlite3 CLI con hash bcrypt pregenerado + secreto TOTP, generar códigos con `otplib` (ojo: ventana de 30 s — generar al inicio de ventana), limpiar al final (`DELETE ... email LIKE 'devtest-%'` + `PRAGMA foreign_key_check`). Correos a `@example.com` fallan en Resend por diseño (dominio de prueba).

## 8. Trampas conocidas (leer antes de tocar)

1. **El bucket de GCS es COMPARTIDO entre local y producción.** La DB local y la de producción son distintas, pero ambas apuntan al mismo bucket — un deal local con id 10 escribe bajo el prefijo `10/` igual que el deal 10 de producción. No subir archivos de prueba sin limpiar.
2. **Node local**: los módulos nativos (better-sqlite3, bcrypt) están compilados para el node de Homebrew `node@22` (`/opt/homebrew/opt/node@22/bin/node`, el mismo de `.claude/launch.json`). El node default de la máquina es v26 y truena con `NODE_MODULE_VERSION`. Para inspección de DB usar `sqlite3` CLI.
3. **Orden de rutas Express**: `GET /trash` está declarada ANTES de `GET /:id` a propósito — no moverla.
4. **`render()` reconstruye todo el DOM**: cualquier input con estado necesita el patrón de preservar foco/cursor (ver `clientsSearch` o el buscador del modal de personas).
5. Los `alert()` que quedan son **deliberados**: muestran contraseñas temporales que hay que copiar (deben bloquear).
6. El machote de contrato registrado en la DB local apunta a un archivo que solo existe en el bucket... subido desde producción. Normal (bases divergentes).
7. `escrowFormOpenFor`, `kycFormOpenFor`, etc. son estado global del SPA — se resetean en cada `render()` según sus condiciones.

## 9. Checklist de lanzamiento — QUIÉN hace QUÉ

### Pendiente del dueño (consolas externas, ~1 tarde)
- [ ] **Prueba DocuSign end-to-end en producción**: deal de prueba → generar contrato → enviarse el sobre a un correo propio → firmar → "Verificar estado". Es el único subsistema no verificado con credenciales reales (la llave vive solo en Render). *Bloqueador #1.*
- [ ] **Object Versioning del bucket**: consola GCS → bucket `gruponar-documentos` → Protection → Object versioning → ON. (El service account no tiene permiso para activarlo por API — se intentó.)
- [ ] **Snapshots del Disk en Render**: verificar en el dashboard que están activos.
- [ ] **Dominio de Resend verificado**: mandar una invitación real a un correo propio y confirmar que llega.
- [ ] **Ensayo de cierre completo**: admin + un colega como comprador desde su teléfono (invitación → registro → 2FA → docs → KYC → firma).

### Ya cubierto por código (verificado)
- [x] Respaldo diario automático de la DB a GCS (retención 14 días).
- [x] Seguridad de sesión (regeneración anti-fixation, 2FA, cookies seguras, rate limiting).
- [x] Manejo global de errores JSON, apagado limpio, aviso de versión nueva.
- [x] Autorización por deal/parte/sección en todos los endpoints de archivos.
- [x] Versionado de documentos (nada se pierde al reemplazar/quitar).
- [x] Suite de smoke tests (11/11).

## 10. Roadmap sugerido (en orden de valor)

1. **Pestañas dentro del deal** — convertir la barra de secciones en pestañas reales (Resumen / Documentos / KYC / Firmas / Tracker / Personas / Contrato / Actividad). Las secciones ya son funciones independientes; es cambiar cuáles se montan. ~Medio día, el mayor salto de percepción "enterprise" restante.
2. **Búsqueda global** (operación/cliente/dirección) — el patrón typeahead ya existe en el modal de personas.
3. **Exportar expediente (ZIP)** por operación — los archivos ya están bajo un solo prefijo GCS.
4. **Plantillas de operación** (pre-carga de machote/notario/escrow típicos por desarrollo).
5. **Webhook DocuSign Connect** con HMAC — elimina el clic de "Verificar estado".
6. Pendientes menores del backlog: #34 (unificar KYC Armour/TLA+LPR), #35 (rediseño de costos de cierre), #40 ("Sign now" vs "Send" en vista cliente), #42 (estado del dropdown de notaría), #43 (escenario editable post-creación), #44 (dashboard multi-deal del agente en Portal).
7. **Deuda técnica**: partir `public/index.html` en módulos; consolidar migraciones viejas de `db/index.js` en el schema base (los tests ya las cubren).

### White-label (si se retoma)
No multi-tenantizar el código todavía. Etapa 1: una instancia de Render por cliente (el `render.yaml` ya es infra-as-code; la paleta son variables CSS; cada instancia con su DocuSign/Drive/Resend). Multi-tenant real solo cuando duela administrar 3+ instancias. Cobrar **por cierre**, no por usuario.

## 11. Mapa de archivos

```
server.js                  Bootstrap, middleware, jobs, error handling, shutdown
render.yaml                Deploy en Render (Disk persistente)
db/schema.sql              Schema completo para instalación desde cero
db/index.js                Migraciones idempotentes (corren en cada arranque)
routes/auth.js             Login + 2FA (TOTP/email) + remember-device + reset password
routes/deals.js            Deals, partes, documentos (+versiones), tareas, agentes,
                           papelera, actividad, resumen de avance, Gestoría/Banco
routes/kyc.js              Expedientes KYC (plantillas, llenado, generación, firma)
routes/contracts.js        Machotes y contrato de promesa (PSA)
routes/docusign.js         Tareas de firma, escrow agreement, estado de sobres
routes/users.js            Equipo, clientes, perfiles, agencias, reset-2FA
routes/invites.js          Invitaciones (deal y equipo)
routes/dashboard.js        Métricas, pendientes por deal, "Mis tareas"
routes/googleDrive.js      OAuth de Drive
lib/access.js              TODO el modelo de autorización — leer antes de tocar permisos
lib/gcsStorage.js          Cloud Storage (upload/stream/list/delete)
lib/dbBackup.js            Respaldo diario de la DB
lib/email.js               Todas las plantillas de correo (Resend)
lib/activity.js            logActivity() → línea de tiempo
lib/deadlineReminders.js   Fechas límite 7/2 días
lib/docusignClient.js      JWT + descubrimiento de base URI
lib/kycFill/, lib/contractFill/   Motores de llenado docx + anchors de firma
data/scenario-docs.json    Checklists por escenario (property/gestoria/banco/por-parte)
data/scenario-tasks.json   Tracker por escenario
data/kyc-templates/        Definiciones de campos KYC
templates/                 .docx fuente de KYC/escrow
public/index.html          TODO el frontend (SPA, i18n ES/EN inline)
test/smoke.test.js         Suite completa (npm test)
```

## 12. Comandos útiles

```bash
npm test                                  # suite completa (11 pruebas)
node --check routes/deals.js              # sintaxis de un archivo
sqlite3 db/gruponar.db "PRAGMA foreign_key_check;"   # integridad
FORCE_DB_BACKUP=1 node -e "require('dotenv').config(); require('./lib/dbBackup').runDailyDbBackup('_backups-test/')"
git log --oneline -15                     # historia reciente (mensajes en español, detallados)
```

---
*Los mensajes de commit de este repo son la bitácora real del proyecto — están escritos para explicar el porqué de cada decisión.*
