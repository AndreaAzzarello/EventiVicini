import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ header: null as string | null }));
vi.mock('./gauth', () => ({ firestoreAuthHeader: async () => auth.header }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$env/dynamic/public', () => ({ env: { PUBLIC_FIREBASE_PROJECT_ID: 'p', PUBLIC_FIREBASE_API_KEY: 'chiave-web' } }));

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	vi.resetModules();
	fetchMock = vi.fn(async () => new Response('{}', { status: 404 }));
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function readOne() {
	const { getEvent } = await import('./firestore');
	await getEvent('abc');
	return fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
}

describe('letture Firestore dal Worker', () => {
	it('con l’account di servizio usa solo il token: niente chiave web nell’URL', async () => {
		auth.header = 'Bearer ya29.test';
		const [url, init] = await readOne();
		expect(init.headers.authorization).toBe('Bearer ya29.test');
		expect(url).not.toContain('key=');
	});

	it('senza account di servizio ripiega sulla chiave web, senza intestazione', async () => {
		auth.header = null;
		const [url, init] = await readOne();
		expect(url).toContain('key=chiave-web');
		expect(init.headers.authorization).toBeUndefined();
	});
});
