const { getClientIp } = require('./clientIp');

// Rate limiting simple en memoria — no persiste entre reinicios ni entre
// procesos, pero es suficiente para esta escala (un solo proceso Node en
// Render).
//
// keyBy:
//   'ip'   (default) — para endpoints públicos sin sesión (login, registro,
//          aceptar invitación): lo único que se puede usar para distinguir
//          quién está pidiendo antes de que exista una cuenta.
//   'user' — para endpoints ya autenticados: limita por cuenta en vez de
//          por IP, para que una oficina entera detrás del mismo NAT no se
//          bloqueen entre sí por el uso normal de sus compañeros. Cae de
//          vuelta a IP si por lo que sea no hay sesión todavía.
//
// Un 429 siempre manda Retry-After (segundos) y lo repite en el body, para
// que el frontend pueda mostrar "intenta de nuevo en X" en vez de un error
// genérico — eso es lo que hace que un 429 sea "graceful" en vez de un
// callejón sin salida.
function createRateLimiter({ windowMs, maxAttempts, keyBy = 'ip' }) {
  const attemptsByKey = new Map();
  // Sin esto el Map crecía para siempre: una llave (IP o usuario) que dejó
  // de pedir nunca se borraba, solo se filtraban sus timestamps al volver.
  // Barrido periódico de llaves cuyo último intento ya salió de la ventana.
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, attempts] of attemptsByKey) {
      if (!attempts.length || attempts[attempts.length - 1] < cutoff) attemptsByKey.delete(key);
    }
  }, Math.max(windowMs, 60 * 1000)).unref();
  return function rateLimit(req, res, next) {
    const now = Date.now();
    const key = keyBy === 'user' && req.session && req.session.userId
      ? `user:${req.session.userId}`
      : `ip:${getClientIp(req)}`;
    const attempts = (attemptsByKey.get(key) || []).filter(t => now - t < windowMs);
    if (attempts.length >= maxAttempts) {
      const retryAfterSec = Math.max(1, Math.ceil((attempts[0] + windowMs - now) / 1000));
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: 'Demasiados intentos. Intenta de nuevo en unos minutos.',
        retryAfter: retryAfterSec
      });
    }
    attempts.push(now);
    attemptsByKey.set(key, attempts);
    next();
  };
}

module.exports = { createRateLimiter };
