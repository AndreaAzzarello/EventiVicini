import { test } from '@playwright/test';
import { openMapSheet } from './helpers';

// Screenshot di revisione, non fanno parte dei test: REVIEW_REFINE=<cartella> → web/.review/<cartella>/
const OUT = process.env.REVIEW_REFINE;
test.skip(!OUT, 'impostare REVIEW_REFINE=<cartella>');

const PAGES: [string, string][] = [
	['home', '/?luogo=modena'],
	['home-con-mostra', '/?luogo=bologna'],
	['vuoto', '/?luogo=modena&q=zzzzqq'],
	['citta', '/citta/modena'],
	['dettaglio', '/eventi/jazz-in-piazza-grande-seedJazz'],
	['dettaglio-luogo-da-confermare', '/eventi/sagra-della-piadina-seedCesena']
];
const SIZES: [string, number, number][] = [['360', 360, 740], ['desktop', 1280, 800]];

for (const theme of ['light', 'dark']) {
	test(`screenshot ${theme}`, async ({ page, browser }) => {
		await page.addInitScript((t) => localStorage.setItem('ev:theme', JSON.stringify(t)), theme);
		const file = (name: string, size: string) => `.review/${OUT}/${name}-${size}-${theme}.png`;
		for (const [size, w, h] of SIZES) {
			await page.setViewportSize({ width: w, height: h });
			for (const [name, path] of PAGES) {
				await page.goto(path);
				await page.waitForLoadState('networkidle');
				await page.screenshot({ path: file(name, size), fullPage: true });
			}

			// Mappa con pin e cluster, poi con l'anteprima di un evento aperta
			await page.goto('/?luogo=modena&vista=mappa');
			await page.locator('.ev-pin, .ev-cluster').first().waitFor();
			await page.waitForLoadState('networkidle');
			await page.screenshot({ path: file('mappa', size) });
			await openMapSheet(page);
			await page.screenshot({ path: file('mappa-anteprima', size) });

			// Ricerca aperta con i suggerimenti
			await page.goto('/?luogo=modena');
			await page.locator('#q').fill('bol');
			await page.getByRole('option').first().waitFor();
			await page.screenshot({ path: file('ricerca', size) });

			// Prima visita: nessun luogo salvato, scelta e link a città e regioni
			const fresh = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: w, height: h } });
			const first = await fresh.newPage();
			await first.addInitScript((t) => localStorage.setItem('ev:theme', JSON.stringify(t)), theme);
			await first.goto('/');
			await first.waitForLoadState('networkidle');
			await first.screenshot({ path: file('senza-luogo', size), fullPage: true });
			await fresh.close();
		}
	});
}
