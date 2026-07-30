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
const { createRateLimiter } = require('./lib/rateLimit');

const app = express();
// Headers de seguridad estándar (X-Content-Type-Options, X-Frame-Options,
// Strict-Transport-Security, etc.) — CSP se deja apagada a propósito: todo
// el frontend es un solo public/index.html con <script>/<style> inline, y
// la política por default de helmet bloquearía eso (haría falta moverlo a
// archivos externos con nonce para poder prender CSP de verdad).
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());

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

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Sirve el frontend (public/index.html) desde el mismo origen — así el
// login y las cookies de sesión funcionan sin configurar CORS.
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Grupo Nar backend escuchando en puerto ${PORT}`));

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
