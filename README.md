# Grupo Nar — backend de la plataforma de cierre

Login real con correo + contraseña (bcrypt), sesiones seguras (cookie
httpOnly), roles (admin / agent / lawyer / buyer / seller), operaciones/
documentos/tareas en SQLite, expedientes KYC que se llenan y firman
electrónicamente, escrow agreement con firma secuencial, y todo listo para
funcionar en cuanto tengas credenciales de DocuSign. **No está desplegado en
ningún lado todavía** — corre en tu máquina o en el servidor donde lo pongas
a correr.

## Qué SÍ hace ahora mismo
- Login real por correo + contraseña, contraseñas nunca en texto plano.
- **Autoregistro de agentes/abogados** (`POST /api/auth/register`, link
  "Crear cuenta" en el login) — queda en estado pendiente hasta que un admin
  lo aprueba desde el dashboard (un abogado ve *todas* las operaciones, así
  que nadie entra sin que alguien lo revise primero).
- **Alta de clientes por invitación**: desde el detalle de una operación,
  genera un link para que el comprador o vendedor cree su propia cuenta
  (`public/invite.html`) — nadie más puede tomarla porque el link expira en 7
  días, es de un solo uso, y si el correo ya tiene cuenta se exige su
  contraseña real antes de vincularla.
- **Expedientes KYC digitales** — el comprador o vendedor llena un formulario
  web con las mismas preguntas de la plantilla oficial, se genera un PDF
  idéntico a esa plantilla con las respuestas ya colocadas, y se firma por
  DocuSign sin salir de la plataforma. El motor de llenado (`lib/kycFill/`)
  edita el `.docx` original directamente — no es un PDF genérico de
  preguntas y respuestas. Plantillas ya construidas:
  - Armour Secure — Persona Física, español.
  - TLA Financial Services — Individual (inglés y español) y Legal Entity
    (inglés; incluye las tablas de beneficiarios y de responsable de
    gestión, hasta 3 filas cada una — cubre el patrón usual de un revocable
    trust más 1-2 personas). Los tres incluyen la sección de instrucciones
    bancarias de la última página (a dónde debe mandar escrow los fondos que
    le correspondan a esa parte) — TLA además confirma estos datos por
    teléfono antes de disbursar, como capa extra contra fraude, pero el
    formulario ya no la deja en blanco.
  - Al crear una operación eliges la escrow company (Armour o TLA); al abrir
    el expediente, comprador/vendedor elige el idioma si la plantilla existe
    en ambos.
- **Escrow agreement con firma secuencial** (Armour Secure y TLA) —
  vendedor/comprador/propiedad se prellenan solos desde la operación;
  admin/agente/abogado completa depósito, fecha de cierre y de terminación,
  y el sistema genera el documento y lo manda a firmar — **comprador firma
  primero, vendedor después** (DocuSign no habilita la firma del vendedor
  hasta que el comprador termine la suya). El de TLA es un contrato en
  prosa mucho más largo que el de Armour; se llenan los campos que
  identifican la operación (partes, propiedad, montos, fechas) y se deja el
  resto del texto legal tal cual lo redactó TLA — un segundo monto (total
  del precio de compra, en una sección con un elemento gráfico embebido)
  queda pendiente de llenar a mano.
- **Subida real de archivos** del checklist KYC (PDF/JPG/PNG/HEIC, 15MB máx),
  servidos por una ruta autenticada que verifica que solo puedas ver/subir
  documentos de tu propia parte (comprador no ve documentos del vendedor y
  viceversa; admin/agente/abogado sin restricción).
- **DocuSign con firma embebida**: firma en un iframe dentro de la misma
  plataforma (sin salir a docusign.com ni necesitar cuenta de DocuSign
  propia). Funciona en cuanto pongas tus credenciales `DOCUSIGN_*` reales en
  `.env` (ver abajo) — sin ellas, cada botón de firma muestra un mensaje
  claro de "no configurado" en vez de fallar.
- **Contrato de promesa con machotes reales** (`lib/contractFill/mergeEngine.js`,
  `routes/contracts.js`) — el admin/agente/abogado sube el machote en `.docx`
  con los campos escritos como `{{CLAVE}}` (puedes subir varios por tipo de
  operación — compraventa, fideicomiso, cesión — y elegir cuál usar en cada
  caso). La plataforma detecta sola qué campos tiene el machote, sin que
  nadie tenga que mantener un JSON de definición aparte; se llenan aquí
  mismo, se genera el documento (con conversión a PDF), el admin lo descarga
  en `.docx` al instante, y cuando está listo lo manda a firma electrónica —
  comprador firma primero, vendedor después, mismo patrón que el escrow.
  Comprador y vendedor ven el contrato ya preparado desde su portal (nunca el
  machote en blanco) y firman ahí mismo cuando se envía.
- **Dashboard** con totales, desglose por escenario, y una sección "Necesita
  atención" con documentos/tareas pendientes hace más de 7 días.
- **Roles con alcance distinto**: admin y abogado (`lawyer`) ven todas las
  operaciones; agente, comprador y vendedor solo ven las suyas
  (`deal_parties` los liga a la operación correcta).
- Bitácora de accesos (`access_log`) con éxito/fallo de cada login.

## Qué falta (a propósito, para no fingir que ya funciona)
- **Cuenta sandbox de DocuSign.** El código está listo, pero necesitas crear
  tu propia cuenta developer y poner las 4 variables `DOCUSIGN_*` en `.env`
  (guía paso a paso más abajo).
- **Más plantillas KYC.** Armour Persona Física (EN) queda pendiente de
  replicar el mismo patrón (`lib/kycFill/armourIndividualEs.js` o
  `armourMoralEs.js`/`armourMoralEn.js` son la referencia). TLA Entity en
  español (persona moral) también falta — solo llegó como PDF, no como
  `.docx` editable.
- **Segundo monto del escrow de TLA** (precio total de compra, en una
  sección con un elemento gráfico embebido en el `.docx`) — se llena a mano.
- **Enviar el link de invitación por correo automáticamente** — hoy el admin
  lo copia y lo manda por el canal que prefiera (no hay cuenta de
  Resend/SendGrid conectada todavía).
- **Enviar la contraseña temporal de `POST /api/users`** por correo en vez de
  regresarla en la respuesta (mismo motivo: falta servicio de correo).
- **Machotes reales de contrato de promesa.** El sistema ya funciona de
  punta a punta (probado con un machote de prueba), pero todavía no tiene
  ningún machote real cargado — súbelos desde el detalle de cada operación
  ("Contrato de promesa" → "Subir machote nuevo") en cuanto los tengas
  listos en `.docx` con placeholders `{{CLAVE}}`.
- **Despliegue.** Esto vive en tu laptop hasta que lo subas a un servidor.

## Correrlo en tu máquina
```bash
npm install
cp .env.example .env
# edita .env: pon un SESSION_SECRET y los datos del admin
npm run seed        # crea tu primer usuario admin
npm start            # arranca en http://localhost:3000
```

Esto también necesita **LibreOffice** (`brew install --cask libreoffice`) y
**unzip/zip** (ya vienen en macOS) instalados en la máquina donde corra el
servidor — se usan para generar los PDF de los expedientes KYC y el escrow
agreement a partir de las plantillas `.docx` en `templates/`.

Abre **http://localhost:3000** en el navegador. Entra con el correo y
contraseña que pusiste en `.env` al correr el seed, crea una operación, y
desde su detalle genera una invitación para dar de alta al comprador o
vendedor.

## Configurar DocuSign (firma embebida real)
1. Crea una cuenta developer gratis en developers.docusign.com (esto es tu
   ambiente sandbox/demo).
2. En el admin console, crea una "Integration Key" (app) → anota el
   Integration Key y el Account ID (API Account ID).
3. En esa misma Integration Key, genera un par de llaves RSA para JWT — la
   llave privada se descarga una sola vez, guárdala local (nunca la subas a
   git) y apunta `DOCUSIGN_PRIVATE_KEY_PATH` ahí.
4. Anota tu API Username (`DOCUSIGN_USER_ID`, un GUID).
5. Llena las 4 variables `DOCUSIGN_*` en `.env` y reinicia el servidor.
6. La primera vez que envíes algo a firma, DocuSign va a pedir consentimiento
   — el error te da la URL exacta, ábrela una vez en el navegador (logueado
   como el mismo usuario) y dale "Allow".
7. Prueba con dos correos tuyos como comprador/vendedor de prueba (el
   ambiente sandbox limita a quién le puedes mandar sobres hasta pedir
   "go-live" con DocuSign).

## Desplegarlo (para que tenga una URL real)
Cualquiera de estas funciona bien para un proyecto así de tamaño:
- **Render** (render.com) — despliegue directo desde un repo de GitHub, con
  disco persistente para el archivo SQLite y la carpeta `uploads/`.
- **Railway** (railway.app) — similar, muy simple para Node + SQLite.
- **Fly.io** — más control, requiere Dockerfile (te lo puede armar Claude Code).

Cualquiera de las tres necesita poder instalar LibreOffice en el contenedor
(para generar los PDF de KYC/escrow) — si usas Dockerfile, agrega
`apt-get install libreoffice` (o el paquete equivalente) al build.

Para producción real conviene migrar de SQLite a Postgres (Render y Railway
lo ofrecen gestionado) si esperas mucha concurrencia, y migrar `uploads/` a
S3/Google Cloud Storage si vas a correr más de una instancia del servidor.
Para el volumen de una coordinadora de cierres, lo actual es suficiente para
empezar.

## Siguiente paso recomendado
Abre este proyecto en **Claude Code** y pídele que:
1. Configure y pruebe la integración real de DocuSign contra tu cuenta
   sandbox (pasos arriba).
2. Replique las plantillas KYC que faltan (Armour Física EN, TLA Entity en
   español) siguiendo el mismo patrón de `lib/kycFill/armourIndividualEs.js`.
3. Agregue el envío de invitaciones y contraseñas temporales por correo
   (Resend/SendGrid) en vez de mostrarlas/copiar el link a mano.
4. Prepare el despliegue (Dockerfile o configuración de Render/Railway) y lo
   suba con tu cuenta.
