import { expect, test } from '@playwright/test';
import { FIRESTORE } from './helpers';

// Lettura pubblica chiusa (audit run-1, esito 2): senza credenziali di proprietà Firestore risponde 403, anche con la chiave web.
for (const path of ['events/seedJazz', 'coverage/emilia-romagna', 'bundles/coverage', 'stats/emilia-romagna_2026-11']) {
	test(`lettura diretta di ${path} senza credenziali: negata`, async () => {
		expect((await fetch(`${FIRESTORE}/${path}`)).status).toBe(403);
		expect((await fetch(`${FIRESTORE}/${path}?key=demo-key`)).status).toBe(403);
		expect((await fetch(`${FIRESTORE}/${path}`, { headers: { Authorization: 'Bearer owner' } })).status).not.toBe(403); // l'account di servizio passa
	});
}

test('le pagine pubbliche non leggono Firestore dal browser', async ({ browser }) => {
	const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const page = await ctx.newPage();
	const direct: string[] = [];
	page.on('request', (r) => /127\.0\.0\.1:8080|firestore\.googleapis\.com/.test(r.url()) && direct.push(r.url()));
	for (const path of ['/?luogo=modena', '/eventi/jazz-in-piazza-grande-seedJazz', '/citta/modena', '/regione/emilia-romagna', '/preferiti', '/privacy']) {
		await page.goto(path);
		await page.waitForLoadState('networkidle');
	}
	expect(direct).toEqual([]);
	await ctx.close();
});
