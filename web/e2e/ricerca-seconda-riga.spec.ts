import { expect, test } from '@playwright/test';

// #101: nella ricerca del luogo, i risultati fuori copertura (Nominatim, kind=city) mostrano sotto il nome una seconda riga
// con provincia e regione; la riga della provincia (place: null) non c'è più. Verificato a 360 px, il caso stretto.
test.use({ viewport: { width: 360, height: 640 } });

test('risultato remoto: seconda riga con provincia e regione, dentro lo schermo e senza scroll orizzontale', async ({ page }) => {
	await page.route('**/api/geocode**', (route) =>
		route.fulfill({
			json: [
				{
					label: 'Qwertyville (MO)',
					detail: 'Prov. MO · Emilia-Romagna',
					lat: 44.6,
					lng: 10.9,
					place: { city: 'Qwertyville', citySlug: 'qwertyville', province: 'MO', region: 'Emilia-Romagna' }
				}
			]
		})
	);
	await page.goto('/?luogo=modena');
	const box = page.getByRole('combobox', { name: 'Cerca eventi o luoghi' });
	await box.fill('Qwertyville');
	const option = page.getByRole('option', { name: /Qwertyville/ });
	await expect(option).toBeVisible({ timeout: 10_000 });
	await expect(option.locator('.sub')).toHaveText('Prov. MO · Emilia-Romagna');
	await expect(option.locator('.name')).toHaveText('Qwertyville');
	const b = (await option.boundingBox())!;
	expect(b.x).toBeGreaterThanOrEqual(0);
	expect(b.x + b.width).toBeLessThanOrEqual(360);
	expect(b.y + b.height).toBeLessThanOrEqual(640);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
	await page.screenshot({ path: 'test-results/ricerca-seconda-riga-360.png' });
});
