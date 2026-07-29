// Rate limiting simple en memoria por IP, para endpoints públicos que crean
// cuentas (registro, aceptar invitación) — no persiste entre reinicios ni
// entre procesos, pero es suficiente para esta escala.
function createRateLimiter({ windowMs, maxAttempts }) {
  const attemptsByIp = new Map();
  return function rateLimit(req, res, next) {
    const now = Date.now();
    const ip = req.ip;
    const attempts = (attemptsByIp.get(ip) || []).filter(t => now - t < windowMs);
    if (attempts.length >= maxAttempts) {
      return res.status(429).json({ error: 'Demasiados intentos. Intenta de nuevo en unos minutos.' });
    }
    attempts.push(now);
    attemptsByIp.set(ip, attempts);
    next();
  };
}

module.exports = { createRateLimiter };
