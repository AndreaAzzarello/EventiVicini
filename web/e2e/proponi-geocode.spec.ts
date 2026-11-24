import { expect, test } from '@playwright/test';
import { signInByEmail } from './helpers';

// /proponi: i risultati della ricerca indirizzo si distinguono (nome in evidenza, dettaglio sotto) anche a 320 e 360 px.
// /api/geocode risponde una fixture: dedupe, scarto delle aree ampie e ordine sono provati nei vitest (geocodeResults.test.ts) con risposte reali di Nominatim.
test('i candidati hanno nome e dettaglio, entrano in 320 e 360 px e la scelta indica il luogo giusto', async ({ page }) => {
	const place = (city: string) => ({ city, citySlug: city.toLowerCase(), province: 'MO', region: 'Emilia-Romagna' });
	await page.route('**/api/geocode**', (route) =>
		route.fulfill({
			json: [
				{ label: 'Modena (MO)', detail: 'comune', lat: 44.6459, lng: 10.9256, place: place('Modena') },
				{ label: 'Modena Nord', detail: 'frazione di Campogalliano (MO)', lat: 44.69, lng: 10.99, place: place('Campogalliano') },
				{ label: 'Via Emilia Centro 100', detail: 'Modena (MO) 41121', lat: 44.64594, lng: 10.92745, place: place('Modena') }
			]
		})
	);
	await signInByEmail(page, 'geocode@example.org', '/proponi');
	await page.getByLabel('Indirizzo *').fill('modena');
	for (const width of [360, 320]) {
		await page.setViewportSize({ width, height: 740 });
		await page.getByRole('button', { name: 'Trova' }).click();
		await expect(page.getByText('Più risultati: scegli quello giusto.')).toBeVisible();
		const buttons = page.locator('.candidates button');
		await expect(buttons).toHaveCount(3);
		expect(new Set(await buttons.allInnerTexts()).size).toBe(3); // nessun testo uguale
		for (const [i, b] of (await buttons.all()).entries()) {
			const box = (await b.boundingBox())!;
			expect(box.x + box.width, `candidato ${i} a ${width} px`).toBeLessThanOrEqual(width);
			expect(box.height).toBeGreaterThanOrEqual(31);
		}
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	}
	await page.locator('.candidates button', { hasText: 'Modena Nord' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Trovato' })).toHaveText('Trovato: Modena Nord · frazione di Campogalliano (MO)');
});
