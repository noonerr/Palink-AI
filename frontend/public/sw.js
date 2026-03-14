const CACHE_NAME = 'palink-ai-v5';
const STATIC_CACHE_NAME = 'palink-ai-static-v5';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

let updateAvailable = false;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE_NAME)
      .then((cache) => {
        return cache.addAll(STATIC_ASSETS);
      })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME && name !== STATIC_CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') {
    return;
  }

  if (url.origin !== location.origin) {
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    return;
  }

  if (url.pathname.startsWith('/ws/')) {
    return;
  }

  event.respondWith(
    caches.match(request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          fetch(request)
            .then((networkResponse) => {
              if (networkResponse && networkResponse.status === 200) {
                const responseClone = networkResponse.clone();
                caches.open(STATIC_CACHE_NAME)
                  .then((cache) => {
                    cache.put(request, responseClone);
                  });

                if (request.destination === 'script' || request.destination === 'style') {
                  updateAvailable = true;
                  notifyClients();
                }
              }
            })
            .catch(() => {});
          return cachedResponse;
        }

        return fetch(request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const responseClone = networkResponse.clone();
              caches.open(STATIC_CACHE_NAME)
                .then((cache) => {
                  cache.put(request, responseClone);
                });
            }
            return networkResponse;
          })
          .catch(() => {
            if (request.destination === 'document') {
              return caches.match('/index.html');
            }
          });
      })
  );
});

function notifyClients() {
  self.clients.matchAll({ type: 'window' }).then((clients) => {
    clients.forEach((client) => {
      client.postMessage({
        type: 'UPDATE_AVAILABLE'
      });
    });
  });
}

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
