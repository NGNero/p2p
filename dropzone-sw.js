/* DropZone Service Worker — streaming downloads */
'use strict';

const SW_VERSION = 'dz-sw-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const downloads = new Map();

self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'REGISTER_DOWNLOAD') return;

  const { downloadId, filename, filetype, size } = event.data;
  const port = event.ports[0];

  const stream = new ReadableStream({
    start(controller) {
      port.onmessage = (e) => {
        switch (e.data.type) {
          case 'CHUNK':
            controller.enqueue(new Uint8Array(e.data.chunk));
            break;
          case 'END':
            controller.close();
            downloads.delete(downloadId);
            break;
          case 'ABORT':
            controller.error(new Error('Transfer aborted'));
            downloads.delete(downloadId);
            break;
        }
      };
      port.start();
    },
    cancel() {
      downloads.delete(downloadId);
    }
  });

  const safeFilename = encodeURIComponent(filename).replace(/['"\\\\]/g, '_');

  downloads.set(downloadId, { stream, filename: safeFilename, filetype, size });
  
  // FIX: Respond directly through the MessageChannel port so the client's promise resolves
  port.postMessage({ type: 'REGISTERED', downloadId });
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // FIX: Use .includes() instead of .startsWith() so it supports subfolders gracefully
  if (!url.pathname.includes('/__dz_dl/')) return;

  // Extract the transfer ID from the path segment
  const matches = url.pathname.match(/\/__dz_dl\/([^\/]+)/);
  if (!matches) return;
  
  const id = matches[1];
  const dl = downloads.get(id);
  if (!dl) return;

  const contentType = dl.filetype || 'application/octet-stream';
  const headers = {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${dl.filename}"; filename*=UTF-8''${dl.filename}`,
    'Content-Length': dl.size,
    'X-Content-Type-Options': 'nosniff'
  };

  event.respondWith(new Response(dl.stream, { headers }));
});
