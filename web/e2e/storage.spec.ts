import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { isDeclared, type Kind } from '../src/lib/cookies';
import { signInByEmail } from './helpers';

// Politica "senza banner": solo strumenti tecnici dichiarati in src/lib/cookies.ts (e quindi in /cookie).
// Il test parte da un profilo pulito, visita il sito prima e dopo il login e fallisce se compare qualcosa non dichiarato.
type Found = { kind: Kind; name: string; origin: string };

async function snapshot(page: Page, ctx: BrowserContext): Promise<Found[]> {
	const origin = new URL(page.url()).origin;
	const inPage = await page.evaluate(async () => ({
		localStorage: Object.keys(localStorage),
		sessionStorage: Object.keys(sessionStorage),
		indexedDB: ((await indexedDB.databases?.()) ?? []).map((d) => d.name ?? ''),
		cacheStorage: await caches.keys()
	}));
	const cookies = (await ctx.cookies()).map((c) => ({ kind: 'cookie' as const, name: c.name, origin: c.domain }));
	return [
		...cookies,
		...(Object.entries(inPage) as [Kind, string[]][]).flatMap(([kind, names]) => names.map((name) => ({ kind, name, origin })))
	];
}

const undeclared = (found: Found[]) => found.filter((f) => !isDeclared(f.kind, f.name)).map((f) => `${f.kind}: ${f.name} (${f.origin})`);

test('profilo pulito: nessun cookie e solo storage dichiarato, prima e dopo il login', async ({ browser }) => {
	const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const page = await ctx.newPage();

	await page.goto('/?luogo=modena');
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	await page.goto('/eventi/jazz-in-piazza-grande-seedJazz');
	await page.waitForLoadState('networkidle');
	const before = await snapshot(page, ctx);
	console.log('PRIMA del login:', JSON.stringify(before));
	expect(undeclared(before)).toEqual([]);

	await signInByEmail(page, 'storage@example.org', '/account');
	await page.waitForLoadState('networkidle');
	const after = await snapshot(page, ctx);
	console.log('DOPO il login:', JSON.stringify(after));
	expect(undeclared(after)).toEqual([]);
	// Nessun cookie, in nessuna origine (l'emulatore Auth risponde da 127.0.0.1 ma il browser non ne riceve).
	expect(after.filter((f) => f.kind === 'cookie')).toEqual([]);
	await ctx.close();
});
