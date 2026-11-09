// Kill switch del vecchio service worker Flutter: deve restare servito con 200 allo stesso URL,
// perché un browser non aggiorna un SW il cui script risponde con un redirect.
const HOME = 'https://eventi-vicini.pages.dev';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) await caches.delete(key);
			await self.registration.unregister();
			for (const client of await self.clients.matchAll({ type: 'window' })) {
				const { pathname } = new URL(client.url);
				// Stessa mappatura delle regole di firebase.json, ma solo per la home: il resto lo decide il redirect del server.
				client.navigate(pathname.startsWith('/admin') ? client.url : HOME + '/').catch(() => {});
			}
		})()
	);
});
