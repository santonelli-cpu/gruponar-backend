const { createRateLimiter } = require('./rateLimit');

// Límites por categoría para el resto de la API autenticada — los
// endpoints sensibles de sesión (login, 2FA, registro, aceptar invitación)
// ya tienen los suyos, más estrictos, en routes/auth.js y routes/invites.js.
// Todos por cuenta (keyBy: 'user'), no por IP: son endpoints ya
// autenticados, así que limitar por cuenta es lo que realmente importa
// (varias personas de la misma oficina no deben bloquearse entre sí).
//
//   expensive — dispara una llamada a un servicio externo con costo real
//               (DocuSign crea un sobre, se genera un PDF con LibreOffice).
//   email     — dispara un correo saliente (Resend) — importa no gastar la
//               reputación del dominio ni inundar a alguien.
//   upload    — sube un archivo — ya está topado en tamaño (multer), esto
//               limita cuántas veces por rato, no qué tan pesado cada uno.
//   write     — el resto de escrituras autenticadas (crear/editar/borrar
//               operación, parte, tarea, etc.) — el más laxo de los
//               cuatro, es el piso para todo lo que no cae en las otras
//               categorías.
const rateLimitExpensive = createRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 20, keyBy: 'user' });
const rateLimitEmail = createRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 30, keyBy: 'user' });
const rateLimitUpload = createRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 40, keyBy: 'user' });
const rateLimitWrite = createRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 120, keyBy: 'user' });

module.exports = { rateLimitExpensive, rateLimitEmail, rateLimitUpload, rateLimitWrite };
