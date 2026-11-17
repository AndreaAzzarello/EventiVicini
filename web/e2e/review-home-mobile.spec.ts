import { test } from '@playwright/test';
import { openMapSheet, pickFirstEvent } from './helpers';

// Screenshot di revisione della home mobile (#22), non fanno parte dei test:
// REVIEW_HOME=prima|dopo|v1|v2 → web/.review/home-mobile/<valore>/ (non committata).
const OUT = process.env.REVIEW_HOME;
test.skip(!OUT, 'impostare REVIEW_HOME=prima|dopo|v1|v2');

const SIZES: [string, number, number][] = [['360', 360, 740], ['390', 390, 844], ['430', 430, 932]];

for (const theme of ['light', 'dark']) {
	test(`home mobile ${theme}`, async ({ page }) => {
		await page.addInitScript((t) => localStorage.setItem('ev:theme', JSON.stringify(t)), theme);
		const dir = `.review/home-mobile/${OUT}`;
		for (const [size, w, h] of SIZES) {
			await page.setViewportSize({ width: w, height: h });
			await page.goto('/?luogo=modena');
			await page.waitForLoadState('networkidle');
			await page.screenshot({ path: `${dir}/lista-${size}-${theme}.png` }); // viewport: si vede cosa copre la barra in basso
			await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
			await page.screenshot({ path: `${dir}/lista-fondo-${size}-${theme}.png` });
			await page.goto('/?luogo=modena&vista=mappa');
			await page.waitForLoadState('networkidle');
			await page.screenshot({ path: `${dir}/mappa-${size}-${theme}.png` });
			await openMapSheet(page).then(({ sheet }) => pickFirstEvent(sheet));
			await page.screenshot({ path: `${dir}/mappa-scheda-${size}-${theme}.png` });
		}
	});
}
