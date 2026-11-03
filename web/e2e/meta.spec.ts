import { expect, test } from '@playwright/test';

const meta = (page: import('@playwright/test').Page, name: string) => page.locator(`meta[name="${name}"]`).getAttribute('content');

test('titolo della home col luogo, canonical invariato', async ({ page }) => {
	await page.goto('/?luogo=modena');
	await expect(page).toHaveTitle('Eventi a Modena e dintorni · Eventi Vicini');
	await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/$/);
});

test('home senza luogo: titolo descrittivo', async ({ browser }) => {
	const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const page = await ctx.newPage();
	await page.goto('/');
	await expect(page).toHaveTitle('Cosa fare oggi e nel weekend vicino a te · Eventi Vicini');
	await ctx.close();
});

test('dettaglio evento: description su una riga e al massimo 155 caratteri', async ({ page }) => {
	await page.goto('/eventi/jazz-in-piazza-grande-seedJazz');
	const d = (await meta(page, 'description'))!;
	expect(d).not.toMatch(/\s{2}|\n/);
	expect(d.length).toBeLessThanOrEqual(155);
});

test('404: description dedicata', async ({ page }) => {
	await page.goto('/pagina-che-non-esiste');
	expect(await meta(page, 'description')).toMatch(/non esiste o è stata spostata/);
});
