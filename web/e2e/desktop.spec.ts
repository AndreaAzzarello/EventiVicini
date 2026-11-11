import { expect, test } from '@playwright/test';

test('mappa: i pin vicini fanno un cluster numerato e il tocco apre l’anteprima dell’evento', async ({ page }) => {
	await page.goto('/?luogo=modena');
	const map = page.getByRole('region', { name: 'Mappa degli eventi' });
	await expect(map.locator('.ev-pin, .ev-cluster').first()).toBeVisible();
	// Si scende nei cluster (zoom sui loro confini, oppure elenco se gli eventi hanno lo stesso indirizzo) finché non compare un'anteprima
	const popup = page.locator('.leaflet-popup');
	for (let i = 0; i < 8 && !(await popup.isVisible()); i++) {
		const target = map.locator('.ev-cluster, .ev-pin').first();
		await target.click();
		await page.waitForTimeout(400);
	}
	await expect(popup).toBeVisible();
	await expect(popup.getByRole('link').first()).toHaveAttribute('href', /\/eventi\//);
});

test('su desktop lista e mappa sono affiancate', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('tab', { name: 'Mappa' })).toBeHidden();
	await expect(page.getByRole('link', { name: 'Jazz in Piazza Grande' })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Mappa degli eventi' })).toBeVisible();
	// Navigazione da tastiera: il primo Tab porta al link "Vai al contenuto".
	await page.keyboard.press('Tab');
	await expect(page.getByRole('link', { name: 'Vai al contenuto' })).toBeFocused();
});
