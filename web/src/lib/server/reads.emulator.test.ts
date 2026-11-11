// Letture Firestore per OGNI rotta, misurate sull'emulatore con i dati di seed (scripts/seed-emulator.mjs).
// Conta i documenti restituiti dal server (minimo 1 per richiesta), non i contatori interni del codice.
// Ogni rotta parte da cache vuota (moduli ricaricati). Fallisce se una pagina supera il suo budget.
// Con i bundle dell'importer (seed) ogni lista costa una lettura per cella; senza, l'ultimo test prova il ripiego sulle query.
// Si salta senza emulatore. Lancio: npm run test:reads
import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;

vi.mock('$env/dynamic/private', () => ({ env: { FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST } }));
vi.mock('$env/dynamic/public', () => ({
	env: { PUBLIC_FIREBASE_PROJECT_ID: 'demo-eventi', PUBLIC_FIREBASE_API_KEY: 'k', PUBLIC_SITE_URL: 'https://example.test' }
}));

// Gli indici dei comuni (comuneSlug.ts) sono asset statici letti con read() dell'adapter: qui vengono dal disco, senza Firestore.
vi.mock('$app/server', async () => {
	const { readFile } = await import('node:fs/promises');
	const { join } = await import('node:path');
	return { read: (url: string) => ({ json: async () => JSON.parse(await readFile(join(process.cwd(), url), 'utf8')) }) };
});

type Stats = { reads: number; requests: number; worst: number };
let stats: Stats = { reads: 0, requests: 0, worst: 0 };

/** Letture di una richiesta: documenti restituiti. `worst` = quanti ne potrebbe restituire con dati reali (limiti delle query). */
async function count(url: string, init: { body?: string } | undefined, res: Response) {
	stats.requests++;
	const body = init?.body ? JSON.parse(init.body) : null;
	const json = await res.clone().json().catch(() => null);
	if (url.endsWith(':runQuery')) {
		const docs = (json as { document?: unknown }[]).filter((r) => r.document).length;
		stats.reads += Math.max(docs, 1);
		stats.worst += body.structuredQuery.limit;
	} else if (url.endsWith(':batchGet')) {
		stats.reads += body.documents.length;
		stats.worst += body.documents.length;
	} else if (json && 'documents' in json) {
		stats.reads += Math.max(json.documents.length, 1);
		stats.worst += json.documents.length; // un documento per regione: ≤ 20
	} else {
		stats.reads += 1;
		stats.worst += 1;
	}
}

const ev = (path: string) => ({
	url: new URL(`http://localhost${path}`),
	params: {} as Record<string, string>,
	setHeaders: () => {}
});

type Run = () => Promise<unknown>;
// maxReads: sui dati di seed; maxWorst: con dati reali (somma dei limit delle query); maxRequests: richieste a Firestore.
const ROUTES: { label: string; run: Run; maxReads: number; maxRequests: number; maxWorst: number; threw?: boolean }[] = [
	{
		label: '/ (senza luogo)',
		run: async () => (await import('../../routes/+page.server')).load(ev('/') as never),
		maxReads: 2, maxRequests: 1, maxWorst: 2
	},
	{
		label: '/?luogo=modena',
		run: async () => (await import('../../routes/+page.server')).load(ev('/?luogo=modena') as never),
		maxReads: 12, maxRequests: 3, maxWorst: 12
	},
	{
		label: '/?luogo=bologna&r=100',
		run: async () => (await import('../../routes/+page.server')).load(ev('/?luogo=bologna&r=100') as never),
		maxReads: 90, maxRequests: 3, maxWorst: 90
	},
	{
		label: '/?luogo=atlantide (sconosciuto)',
		run: async () => (await import('../../routes/+page.server')).load(ev('/?luogo=atlantide') as never),
		maxReads: 3, maxRequests: 3, maxWorst: 3
	},
	{
		label: '/api/places',
		run: async () => (await import('../../routes/api/places/+server')).GET(ev('/api/places') as never),
		maxReads: 2, maxRequests: 1, maxWorst: 2
	},
	{
		label: '/api/events?lat&lng&r=25',
		run: async () => (await import('../../routes/api/events/+server')).GET(ev('/api/events?lat=44.65&lng=10.95&r=25') as never),
		maxReads: 12, maxRequests: 3, maxWorst: 12
	},
	{
		label: '/api/events?ids=a,b',
		run: async () => (await import('../../routes/api/events/+server')).GET(ev('/api/events?ids=seedJazz,seedCesena') as never),
		maxReads: 2, maxRequests: 1, maxWorst: 2
	},
	{
		// Il filtro per data è tutto nel browser: stessa spesa di /?luogo=modena
		label: '/?luogo=modena&dal=2026-11-14&al=2026-11-16 (filtro data)',
		run: async () => (await import('../../routes/+page.server')).load(ev('/?luogo=modena&dal=2026-11-14&al=2026-11-16') as never),
		maxReads: 12, maxRequests: 3, maxWorst: 12
	},
	{
		label: '/citta/modena?quando=domani (filtro data)',
		run: async () => (await import('../../routes/citta/[slug]/+page.server')).load({ ...ev('/citta/modena?quando=domani'), params: { slug: 'modena' } } as never),
		maxReads: 3, maxRequests: 3, maxWorst: 3
	},
	{
		label: '/citta/modena',
		run: async () => (await import('../../routes/citta/[slug]/+page.server')).load({ ...ev('/citta/modena'), params: { slug: 'modena' } } as never),
		maxReads: 3, maxRequests: 3, maxWorst: 3
	},
	{
		label: '/api/citta/modena',
		run: async () => (await import('../../routes/api/citta/[slug]/+server')).GET({ ...ev('/api/citta/modena'), params: { slug: 'modena' } } as never),
		maxReads: 3, maxRequests: 3, maxWorst: 3
	},
	{
		label: '/citta/zzz (404)',
		run: async () => (await import('../../routes/citta/[slug]/+page.server')).load({ ...ev('/citta/zzz'), params: { slug: 'zzz' } } as never),
		maxReads: 3, maxRequests: 3, maxWorst: 3, threw: true
	},
	{
		label: '/regione/emilia-romagna',
		run: async () => (await import('../../routes/regione/[slug]/+page.server')).load({ ...ev('/regione/emilia-romagna'), params: { slug: 'emilia-romagna' } } as never),
		maxReads: 3, maxRequests: 2, maxWorst: 3
	},
	{
		label: '/eventi/[slug]',
		run: async () => (await import('../../routes/eventi/[slug]/+page.server')).load({ ...ev('/eventi/jazz-in-piazza-grande-seedJazz'), params: { slug: 'jazz-in-piazza-grande-seedJazz' } } as never),
		maxReads: 1, maxRequests: 1, maxWorst: 1
	},
	{
		label: '/sitemap.xml',
		run: async () => (await import('../../routes/sitemap.xml/+server')).GET(ev('/sitemap.xml') as never),
		maxReads: 3, maxRequests: 3, maxWorst: 3
	}
];

describe.skipIf(!HOST)('letture per rotta (emulatore)', () => {
	beforeAll(() => {
		execFileSync('node', ['scripts/seed-emulator.mjs'], { env: process.env, stdio: 'ignore' });
		const real = globalThis.fetch;
		vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
			const res = await real(url, init as RequestInit);
			if (String(url).includes('/documents')) await count(String(url), init, res);
			return res;
		});
	});

	for (const r of ROUTES) {
		it(`${r.label}: dentro il budget a freddo`, async () => {
			vi.resetModules(); // cache in memoria vuota: la prima visita dopo un deploy o una scadenza
			stats = { reads: 0, requests: 0, worst: 0 };
			await r.run().catch((e) => {
				if (!r.threw) throw e;
			});
			console.log(`LETTURE ${r.label}: ${stats.reads} (seed), ${stats.requests} richieste, fino a ${stats.worst} con dati reali`);
			expect(stats.reads, 'letture sui dati di seed').toBeLessThanOrEqual(r.maxReads);
			expect(stats.requests, 'richieste a Firestore').toBeLessThanOrEqual(r.maxRequests);
			expect(stats.worst, 'letture nel caso peggiore').toBeLessThanOrEqual(r.maxWorst);
		});
	}

	it('seconda visita uguale: zero letture; SSR della home e /api/events condividono la cache', async () => {
		vi.resetModules();
		const home = (await import('../../routes/+page.server')).load;
		const api = (await import('../../routes/api/events/+server')).GET;
		const res = await home(ev('/?luogo=modena') as never);
		// Lo stesso punto, come lo chiede il browser quando serve altro: nessuna lettura in più.
		const { lat, lng, km } = (res as { fetched: { lat: number; lng: number; km: number } }).fetched;
		stats = { reads: 0, requests: 0, worst: 0 };
		await home(ev('/?luogo=modena') as never);
		await api(ev(`/api/events?lat=${lat}&lng=${lng}&r=${km - 4}`) as never);
		expect(stats.requests).toBe(0);
	});

	it('senza bundle (prima del primo import) ripiega sulle query e la home funziona', async () => {
		await fetch(`http://${HOST}/v1/projects/demo-eventi/databases/(default)/documents/bundles/coverage`, {
			method: 'DELETE',
			headers: { Authorization: 'Bearer owner' }
		});
		vi.resetModules();
		stats = { reads: 0, requests: 0, worst: 0 };
		const res = (await (await import('../../routes/+page.server')).load(ev('/?luogo=modena') as never)) as { events: unknown[]; error: string };
		expect(res.error).toBe('');
		expect(res.events.length).toBeGreaterThan(0);
		expect(stats.worst, 'è il comportamento di prima: query con limite').toBeGreaterThan(100);
	});
});
