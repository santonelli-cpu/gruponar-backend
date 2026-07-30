// IP real del visitante para rate limiting y access_log.
//
// Hoy Render es el único proxy enfrente del servidor, así que
// `app.set('trust proxy', 1)` (server.js) ya resuelve req.ip correctamente.
// En cuanto se ponga Cloudflare enfrente de Render, hay DOS saltos de proxy
// (Cloudflare -> Render -> esta app) y "trust proxy: 1" empezaría a
// resolver la IP del proxy de Render, no la del visitante real — rompiendo
// en silencio el rate limiting (todo el tráfico se vería como la misma IP,
// o como IPs random del pool de Render) y el access_log de login.
//
// CF-Connecting-IP es la que Cloudflare pone siempre con la IP real del
// visitante (y descarta cualquier valor que el cliente intente falsificar
// con ese mismo nombre de header), así que preferirla evita depender de
// contar saltos de proxy correctamente. Sin Cloudflare enfrente (local, o
// antes de terminar de configurarlo) este header simplemente no existe y
// cae de vuelta a req.ip de Express, igual que antes.
function getClientIp(req) {
  return req.headers['cf-connecting-ip'] || req.ip;
}

module.exports = { getClientIp };
