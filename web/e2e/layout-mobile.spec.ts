import { expect, test, type Page } from '@playwright/test';
import { signInByEmail } from './helpers';

for (const [width, height] of [[360, 740], [390, 844]]) {
	test(`header e pagine senza overflow orizzontale a ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height });
		for (const path of [
			'/',
			'/?luogo=modena&vista=mappa',
			'/?luogo=bologna', // con la sezione "In corso" compatta
			'/?luogo=modena&q=zzzzqq', // stato vuoto
			'/citta/modena',
			'/regione/emilia-romagna',
			'/eventi/jazz-in-piazza-grande-seedJazz',
			'/eventi/sagra-della-piadina-seedCesena' // luogo da confermare
		]) {
			await page.goto(path);
			await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
			const { sw, cw } = await page.evaluate(() => ({
				sw: document.documentElement.scrollWidth,
				cw: document.documentElement.clientWidth
			}));
			expect(sw, path).toBeLessThanOrEqual(cw);
			const box = await page.getByRole('button', { name: 'Cambia tema chiaro/scuro' }).boundingBox();
			expect(box!.x + box!.width, path).toBeLessThanOrEqual(width);
		}
	});
}

async function brandIntact(page: Page, width: number, label: string) {
	const brand = await page.locator('.brand span').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, text: el.textContent }));
	expect(brand.text, label).toBe('Eventi Vicini');
	expect(brand.sw, `${label}: marchio troncato`).toBeLessThanOrEqual(brand.cw);
	const nav = await page.locator('nav[aria-label="Principale"]').boundingBox();
	expect(nav!.x + nav!.width, `${label}: azioni fuori schermo`).toBeLessThanOrEqual(width);
}

for (const width of [360, 390]) {
	test(`il marchio "Eventi Vicini" resta intero a ${width}px, anche con account e admin`, async ({ page }) => {
		await page.setViewportSize({ width, height: 740 });
		await page.goto('/');
		await brandIntact(page, width, 'anonimo');
		await signInByEmail(page, 'eventivicini.info@gmail.com', '/');
		await brandIntact(page, width, 'admin');
		// "Admin" non sta più nell'header stretto: si apre dall'account
		await expect(page.locator('nav[aria-label="Principale"] a[href="/admin"]')).toBeHidden();
		await page.goto('/account');
		await page.getByRole('link', { name: 'Area admin' }).click();
		await expect(page).toHaveURL(/\/admin$/);
	});
}

const overflow = (page: Page) =>
	page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('accedi, proponi, account e tutte le viste admin senza scroll orizzontale a 360px', async ({ page }) => {
	await page.setViewportSize({ width: 360, height: 740 });
	for (const path of ['/accedi', '/proponi']) {
		await page.goto(path);
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
		expect(await overflow(page), path).toBeLessThanOrEqual(0);
	}
	await signInByEmail(page, 'eventivicini.info@gmail.com', '/proponi');
	for (const path of ['/proponi', '/account', '/admin', '/admin/proposte', '/admin/statistiche', '/admin/stile', '/admin/eventi/nuovo', '/admin/eventi/seedJazz']) {
		await page.goto(path);
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
		await page.waitForLoadState('networkidle');
		expect(await overflow(page), path).toBeLessThanOrEqual(0);
	}
});
