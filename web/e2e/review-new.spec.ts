import { test, type Page } from '@playwright/test';
import { FIRESTORE, signInByEmail } from './helpers';

// Screenshot di revisione delle viste del filtro per data, del benvenuto, delle segnalazioni e dell'esportazione.
// REVIEW_NEW=<cartella> → web/.review/<cartella>/. Non sono test.
const OUT = process.env.REVIEW_NEW;
test.skip(!OUT, 'impostare REVIEW_NEW=<cartella>');
test.describe.configure({ mode: 'serial' });

const SIZES: [string, number, number][] = [['360', 360, 740], ['390', 390, 844], ['desktop', 1280, 800]];
const dayPlus = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function seedReport() {
	const f = (s: string) => ({ stringValue: s });
	const res = await fetch(`${FIRESTORE}/reports/review1`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json', Authorization: 'Bearer owner' },
		body: JSON.stringify({
			fields: {
				eventId: f('seedJazz'), reason: f('misleading'), status: f('open'), email: f('segnalante@example.org'),
				text: f('La data indicata non corrisponde a quella pubblicata sul sito del Comune: il concerto è il giorno dopo.'),
				createdAt: { timestampValue: new Date().toISOString() }
			}
		})
	});
	if (!res.ok) throw new Error(`report: ${res.status}`);
}

for (const theme of ['light', 'dark']) {
	test(`nuove viste ${theme}`, async ({ page, browser }) => {
		const shoot = async (p: Page, name: string, path: string, before?: (p: Page) => Promise<void>, sizes = SIZES) => {
			for (const [size, w, h] of sizes) {
				await p.setViewportSize({ width: w, height: h });
				await p.goto(path);
				await p.waitForLoadState('networkidle');
				await before?.(p);
				await p.waitForTimeout(300);
				await p.screenshot({ path: `.review/${OUT}/${name}-${size}-${theme}.png`, fullPage: true });
			}
		};
		const dark = (p: Page) => p.addInitScript((t) => localStorage.setItem('ev:theme', JSON.stringify(t)), theme);

		// benvenuto: nessun luogo salvato
		const fresh = await browser.newContext({ storageState: { cookies: [], origins: [] } });
		const first = await fresh.newPage();
		await dark(first);
		await shoot(first, 'benvenuto', '/');
		await fresh.close();

		await dark(page);
		await shoot(page, 'home-filtro-domani', '/?luogo=modena&quando=domani');
		await shoot(page, 'home-filtro-periodo', `/?luogo=modena&dal=${dayPlus(2)}&al=${dayPlus(4)}`);
		await shoot(page, 'home-selettore-date', '/?luogo=modena', (p) => p.getByRole('button', { name: 'Scegli date' }).click());
		await shoot(page, 'citta-filtro', '/citta/modena?quando=domani');
		await shoot(page, 'dettaglio-segnala', '/eventi/jazz-in-piazza-grande-seedJazz', (p) =>
			p.getByRole('button', { name: 'Segnala questo evento' }).click());

		await signInByEmail(page, 'esporta@example.org', '/account');
		await shoot(page, 'account-esporta', '/account', undefined, [['360', 360, 740], ['desktop', 1280, 800]]);
		await seedReport();
	});

	test(`admin segnalazioni ${theme}`, async ({ page }) => {
		await page.addInitScript((t) => localStorage.setItem('ev:theme', JSON.stringify(t)), theme);
		await signInByEmail(page, 'eventivicini.info@gmail.com', '/admin/segnalazioni');
		for (const [size, w, h] of [['360', 360, 740], ['desktop', 1280, 800]] as const) {
			await page.setViewportSize({ width: w, height: h });
			await page.goto('/admin/segnalazioni');
			await page.getByText('Contatto: segnalante@example.org').waitFor();
			await page.screenshot({ path: `.review/${OUT}/admin-segnalazioni-${size}-${theme}.png`, fullPage: true });
			await page.getByRole('button', { name: 'Respingi' }).click();
			await page.screenshot({ path: `.review/${OUT}/admin-segnalazioni-dialog-${size}-${theme}.png` });
			await page.keyboard.press('Escape');
		}
	});
}
