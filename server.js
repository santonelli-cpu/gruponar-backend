require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const helmet = require('helmet');
const sqlite3 = require('sqlite3');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');

const { router: authRouter } = require('./routes/auth');
const dealsRouter = require('./routes/deals');
const docusignRouter = require('./routes/docusign');
const usersRouter = require('./routes/users');
const invitesRouter = require('./routes/invites');
const dashboardRouter = require('./routes/dashboard');
const kycRouter = require('./routes/kyc');
const contractsRouter = require('./routes/contracts');
const googleDriveRouter = require('./routes/googleDrive');
const settingsRouter = require('./routes/settings');
const { runAutomaticReminders } = require('./lib/reminders');
const { checkAndSendPredialReminders } = require('./lib/predialReminder');
const { checkAndSendDeadlineReminders } = require('./lib/deadlineReminders');
const { runDailyDbBackup } = require('./lib/dbBackup');
const { createRateLimiter } = require('./lib/rateLimit');

const app = express();
// Headers de seguridad estándar (X-Content-Type-Options, X-Frame-Options,
// Strict-Transport-Security, etc.) más una CSP de verdad: ya no hay NI UN
// script inline en el portal (todo vive en public/js/*.js), así que
// script-src puede ser 'self' a secas — si alguna vez se colara HTML de un
// tercero con un <script> adentro, el navegador simplemente no lo corre.
//
// Lo que sí sigue necesitando 'unsafe-inline' es el estilo: la interfaz usa
// atributos style="..." por todos lados. Eso es mucho menos grave (un
// atributo de estilo no ejecuta código) y es el siguiente paso natural si
// se quiere apretar más.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
      // data: — los QR de 2FA se generan como data URI (ver routes/auth.js).
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      // La firma embebida de DocuSign se abre en un iframe dentro del portal.
      frameSrc: ["'self'", 'https://*.docusign.com', 'https://*.docusign.net'],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      upgradeInsecureRequests: []
    }
  }
}));
// 1mb en vez del default de 100kb — un KYC de entidad con muchos campos de
// texto libre (o un contract_json grande) puede pasar de 100kb, y el 413
// resultante era un error mudo e inexplicable para quien estaba llenando
// el formulario.
app.use(express.json({ limit: '1mb' }));

// Si tu frontend vive en otro origen (ej. lo sigues abriendo como artifact
// de claude.ai en vez de servirlo desde /public de este mismo servidor),
// necesitas declarar aquí ese origen exacto para que las cookies de sesión
// funcionen. Sirviendo el frontend desde /public (mismo origen) evitas todo
// esto — ver public/index.html y la nota en el README.
const allowedOrigin = process.env.FRONTEND_ORIGIN;
if (allowedOrigin) {
  app.use(cors({ origin: allowedOrigin, credentials: true }));
}

// Mismo DATA_DIR que db/index.js y lib/storage.js — las sesiones también
// deben vivir en el disco persistente en producción, o cada redeploy
// desloguea a todo el mundo.
const sessionsDbPath = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'sessions.db')
  : path.join(__dirname, 'db', 'sessions.db');
const sessionDb = new sqlite3.Database(sessionsDbPath);

app.set('trust proxy', 1);
app.use(session({
  store: new SQLiteStore({ db: sessionDb }),
  secret: process.env.SESSION_SECRET || (() => { throw new Error('Define SESSION_SECRET en .env'); })(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 8 // 8 horas
  }
}));

// Respaldo general para el resto de la API — los endpoints sensibles
// (login, registro, 2FA, aceptar invitación) ya tienen sus propios límites
// más estrictos en routes/auth.js e routes/invites.js; este es el piso
// mínimo para todo lo demás (deals, documentos, KYC, DocuSign, Drive,
// contratos), que antes no tenía ningún límite y se podía golpear sin
// restricción por una sola sesión/IP.
const rateLimitApi = createRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 600 });
app.use('/api', rateLimitApi);

app.use('/api/auth', authRouter);
app.use('/api/deals', dealsRouter);
app.use('/api/docusign', docusignRouter);
app.use('/api/users', usersRouter);
app.use('/api/invites', invitesRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api', kycRouter);
app.use('/api', contractsRouter);
app.use('/api/google-drive', googleDriveRouter);
app.use('/api/settings', settingsRouter);

// `version` identifica el deploy actual (Render expone el SHA del commit;
// en local, la hora de arranque). El frontend la consulta periódicamente y,
// si cambió, muestra "hay una versión nueva — recarga": una pestaña abierta
// desde hace días nunca se recarga sola y se queda con el código viejo.
const APP_VERSION = process.env.RENDER_GIT_COMMIT || String(Date.now());
app.get('/api/health', (req, res) => res.json({ ok: true, version: APP_VERSION }));

// Cualquier /api/* que no coincidió con ninguna ruta devuelve JSON 404 —
// sin esto caía al static/al default de Express y el frontend intentaba
// parsear HTML como JSON, mostrando "Error 404" sin contexto.
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

// Sirve el frontend (public/index.html) desde el mismo origen — así el
// login y las cookies de sesión funcionan sin configurar CORS.
app.use(express.static(path.join(__dirname, 'public')));

// Manejador de errores final — cualquier throw síncrono en un middleware o
// un next(err) termina aquí como JSON limpio, nunca como la página HTML de
// stack trace de Express. Un body JSON malformado (SyntaxError de
// express.json) es culpa del cliente → 400; todo lo demás → 500 genérico
// (el detalle queda en el log del servidor, no se filtra al cliente).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return;
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'El cuerpo de la petición no es JSON válido.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'La petición es demasiado grande.' });
  }
  if (err.name === 'MulterError') {
    return res.status(413).json({
      error: err.code === 'LIMIT_FILE_SIZE'
        ? 'El archivo es demasiado grande (máximo 15 MB).'
        : 'Archivo inválido.'
    });
  }
  console.error('[error]', req.method, req.originalUrl, err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

// Red de seguridad para promesas sin catch (un handler async que truena
// después de responder, un best-effort sin .catch) — se registra en vez de
// tumbar el proceso, que con better-sqlite3 síncrono dejaría a todos los
// usuarios fuera por un error periférico (ej. un correo que falló raro).
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  // Aquí sí puede haber estado corrupto — log y salir; Render reinicia solo.
  console.error('[uncaughtException]', err);
  process.exit(1);
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Grupo Nar backend escuchando en puerto ${PORT}`));

// Apagado limpio en redeploys de Render (SIGTERM): deja de aceptar
// conexiones nuevas pero termina las peticiones en vuelo (una subida de
// documento a medias, un sobre de DocuSign creándose) antes de salir.
function shutdown(signal) {
  console.log(`[${signal}] cerrando servidor...`);
  server.close(() => process.exit(0));
  // Si algo quedó colgado, salir de todos modos tras 10s.
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Recordatorios automáticos de documentos pendientes (lib/reminders.js) —
// una pasada 1 minuto después de arrancar (deja que todo termine de cargar)
// y luego cada 24h. No pasa nada si Resend no está configurado (se salta
// solo); tampoco si el proceso se reinicia entre pasadas, el cooldown vive
// en la base de datos, no en memoria.
setTimeout(() => runAutomaticReminders().catch(err => console.error('[reminders] error:', err.message)), 60 * 1000);
setInterval(() => runAutomaticReminders().catch(err => console.error('[reminders] error:', err.message)), 24 * 60 * 60 * 1000);

// Recordatorio anual de predial a compradores ya cerrados (lib/predialReminder.js)
// — se checa una vez al día; el propio módulo decide si en verdad hay que
// mandar algo (solo la primera semana de enero, una vez por año, sin
// importar cuántas veces se reinicie el servidor esa semana).
setTimeout(() => checkAndSendPredialReminders().catch(err => console.error('[predial-reminder] error:', err.message)), 90 * 1000);
setInterval(() => checkAndSendPredialReminders().catch(err => console.error('[predial-reminder] error:', err.message)), 24 * 60 * 60 * 1000);

// Fechas límite (cierre / fin de due diligence) a 7 y a 2 días — aviso
// interno al equipo (lib/deadlineReminders.js); una vez al día, con
// registro en base de datos para nunca avisar doble.
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://portal.gruponar.com';
setTimeout(() => checkAndSendDeadlineReminders(APP_BASE_URL).catch(err => console.error('[deadline-reminder] error:', err.message)), 2 * 60 * 1000);
setInterval(() => checkAndSendDeadlineReminders(APP_BASE_URL).catch(err => console.error('[deadline-reminder] error:', err.message)), 24 * 60 * 60 * 1000);

// Respaldo diario de la base de datos a Cloud Storage (lib/dbBackup.js) —
// solo corre en Render; la clave incluye la fecha, así que reinicios en el
// mismo día no duplican nada. Retención de 14 días con poda automática.
setTimeout(() => runDailyDbBackup().catch(err => console.error('[backup] error:', err.message)), 3 * 60 * 1000);
setInterval(() => runDailyDbBackup().catch(err => console.error('[backup] error:', err.message)), 24 * 60 * 60 * 1000);
