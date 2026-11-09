// Redirect di Firebase Hosting verso il sito nuovo. Le regex sono ancorate (^...$) e con gruppi senza nome (:1), validi sia in RE2
// (produzione) sia nelle RegExp dell'emulatore; qui si simula con RegExp. Il comportamento reale va verificato dopo il deploy.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cfg = JSON.parse(readFileSync(new URL('../firebase.json', import.meta.url), 'utf8')).hosting;
const SITE = 'https://eventi-vicini.pages.dev';

/** Prima regola che corrisponde, come fa Hosting; null = nessun redirect. */
function redirectFor(path) {
	for (const r of cfg.redirects) {
		const m = new RegExp(r.regex).exec(path);
		if (m) return { to: r.destination.replace(/:(\d)/g, (_, n) => m[Number(n)]), type: r.type };
	}
	return null;
}

describe('percorsi della vecchia app Flutter con equivalente nel sito nuovo', () => {
	it.each([
		['/admin', '/admin'],
		['/admin/', '/admin'],
		['/admin/events/new', '/admin/eventi/nuovo'],
		['/admin/events/AbC123xyz', '/admin/eventi/AbC123xyz'],
		['/admin/events/AbC123xyz/', '/admin/eventi/AbC123xyz']
	])('%s → %s', (from, to) => {
		expect(redirectFor(from)).toEqual({ to: SITE + to, type: 301 });
	});
});

describe('tutti gli altri percorsi vanno alla home, non a un 404', () => {
	it.each(['/', '/index.html', '/main.dart.js', '/robots.txt', '/evento/abc', '/eventi/qualcosa-abc', '/admin/altro', '/admin/events/a/b',
		'/a/flutter_service_worker.js', '/flutter_service_worker.js.map', '/flutter_service_worker.jsx', '/f', '/flutter_service_worker.j'])('%s', (from) => {
		expect(redirectFor(from)).toEqual({ to: SITE + '/', type: 301 });
	});
});

describe('service worker kill switch', () => {
	it('/flutter_service_worker.js non viene reindirizzato (deve restare 200, o il vecchio SW non si aggiorna)', () => {
		expect(redirectFor('/flutter_service_worker.js')).toBeNull();
	});
	it('è un file in hosting-redirect e ha Cache-Control: no-cache', () => {
		expect(readFileSync(new URL('../hosting-redirect/flutter_service_worker.js', import.meta.url), 'utf8')).toContain('unregister');
		const h = cfg.headers.find((x) => x.source === '**/flutter_service_worker.js');
		expect(h.headers).toContainEqual({ key: 'Cache-Control', value: 'no-cache' });
	});
});

describe('regole fisse', () => {
	it('tutti i redirect sono 301 verso il sito nuovo', () => {
		for (const r of cfg.redirects) {
			expect(r.type).toBe(301);
			expect(r.destination.startsWith(SITE + '/')).toBe(true);
		}
	});
});
