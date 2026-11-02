import { test } from '@playwright/test';
import { signInByEmail } from './helpers';

// Screenshot di revisione, non fanno parte dei test: REVIEW_SHOTS=before|after → web/.review/<valore>/
const OUT = process.env.REVIEW_SHOTS;
test.skip(!OUT, 'impostare REVIEW_SHOTS=before|after');

const PAGES: [string, string][] = [
	['home', '/'],
	['citta', '/citta/modena'],
	['regione', '/regione/emilia-romagna'],
	['dettaglio', '/eventi/jazz-in-piazza-grande-seedJazz']
];
const SIZES: [string, number, number][] = [['360', 360, 740], ['390', 390, 844], ['desktop', 1280, 800]];

for (const theme of ['light', 'dark']) {
	test(`screenshot ${theme}`, async ({ page }) => {
		await page.addInitScript((t) => localStorage.setItem('ev:theme', JSON.stringify(t)), theme);
		const shoot = async (name: string, path: string, w: number, h: number, size: string) => {
			await page.setViewportSize({ width: w, height: h });
			await page.goto(path);
			await page.waitForLoadState('networkidle');
			await page.screenshot({ path: `.review/${OUT}/${name}-${size}-${theme}.png`, fullPage: true });
		};
		for (const [name, path] of PAGES) for (const [size, w, h] of SIZES) await shoot(name, path, w, h, size);
		await signInByEmail(page, 'eventivicini.info@gmail.com', '/admin');
		for (const [size, w, h] of SIZES) await shoot('admin', '/admin', w, h, size);
		// Pagine nate con il nuovo design: non hanno un "prima".
		for (const [name, path] of [['statistiche', '/admin/statistiche'], ['stile', '/admin/stile']]) await shoot(name, path, 390, 844, '390');
	});
}
