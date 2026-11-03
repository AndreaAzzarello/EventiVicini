import { expect, test } from '@playwright/test';

// Smontare la mappa durante uno zoom animato non deve lasciare timer di Leaflet su una mappa rimossa (_leaflet_pos).
test('mappa smontata durante lo zoom: nessun errore in console', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.stack ?? e.message));
	page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
	await page.goto('/?luogo=modena&vista=mappa');
	await expect(page.locator('.leaflet-control-zoom-in')).toBeVisible();
	await page.locator('.leaflet-control-zoom-in').click();
	// subito dopo, navigazione lato client: il componente si smonta mentre l'animazione è in corso
	await page.evaluate(() => document.querySelector<HTMLAnchorElement>('a[href="/privacy"]')?.click());
	await expect(page).toHaveURL(/\/privacy/);
	await page.waitForTimeout(600);
	expect(errors).toEqual([]);
});
