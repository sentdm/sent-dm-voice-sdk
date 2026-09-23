// Forwards incoming-call pushes to the open pages of your app.
self.addEventListener('push', (event) => {
  const body = event.data?.json?.() ?? null;
  event.waitUntil(
    self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((clients) => {
      clients.forEach((client) => {
        client.postMessage({
          visible: client.visibilityState === 'visible',
          data: body,
        });
      });
    }),
  );
});
