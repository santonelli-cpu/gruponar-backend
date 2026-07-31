// Service worker del portal — lo que hace que se pueda "instalar" en el
// celular y que abra aunque la señal esté mala.
//
// Estrategia: RED PRIMERO, caché solo como red de seguridad. Al revés
// (caché primero) sería más rápido pero serviría código viejo después de
// cada deploy, justo lo que el aviso de "hay una versión nueva" existe para
// evitar. Aquí la caché solo entra cuando de plano no hay conexión.
//
// Lo que NUNCA se guarda: todo lo de /api/. Son datos de una operación
// concreta y de una sesión concreta; dejarlos en la caché del navegador
// sería filtrarlos a quien tome el teléfono después.

const CACHE = 'gruponar-shell-v1';

// El armazón: lo mínimo para que la aplicación pinte algo sin conexión.
const SHELL = [
  '/',
  '/styles.css',
  '/js/i18n.js',
  '/js/core.js',
  '/js/auth-views.js',
  '/js/admin.js',
  '/js/deal-detail.js',
  '/js/deal-docs.js',
  '/js/portal.js',
  '/js/app.js',
  '/manifest.json',
  '/icon-192.png'
];

self.addEventListener('install', (event) => {
  // addAll falla completo si UN archivo falla; se agregan de uno en uno
  // para que un 404 pasajero no deje al service worker sin instalar.
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.all(SHELL.map(url => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // fuentes, íconos de CDN: que los maneje el navegador
  if (url.pathname.startsWith('/api/')) return;      // datos de sesión: nunca a la caché

  event.respondWith(
    fetch(request)
      .then(response => {
        // Solo se guardan respuestas completas y propias (no 206, no errores).
        if (response.ok && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        // Navegación sin conexión y sin copia de ESA ruta: se devuelve el
        // armazón, que es una sola página de todos modos.
        if (request.mode === 'navigate') {
          const shell = await caches.match('/');
          if (shell) return shell;
        }
        return new Response('Sin conexión.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      })
  );
});
