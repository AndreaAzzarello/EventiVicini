import { expect, test, type Locator, type Page } from '@playwright/test';
import { patchDocument, signInByEmail, uidOf } from './helpers';

// Messaggi dei limiti dei preferiti (200 in totale, 100 modifiche al giorno) a 360 × 640 px, in chiaro e in scuro:
// devono essere visibili, dentro lo schermo, senza testo tagliato né coperti da altro. Gli screenshot finiscono in
// web/.review/favorites-limit/ (cartella ignorata da git) per il controllo a occhio.
test.use({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 2 });

const OUT = '.review/favorites-limit';
const JAZZ = '/eventi/jazz-in-piazza-grande-seedJazz';
const MERCATO = '/eventi/mercato-dellantiquariato-seedMercato';
const now = () => new Date().toISOString();

const int = (n: number) => ({ integerValue: String(n) });

/** Contatori del profilo come li lasciano le regole: favCount, favChanges del giorno UTC di favAt, lastFavId. */
async function setLimits(uid: string, favCount: number, favChanges: number) {
	await patchDocument(`limits/${uid}`, { favCount: int(favCount), favChanges: int(favChanges), favAt: { timestampValue: now() }, lastFavId: { stringValue: 'x' } });
}

async function addFavorites(uid: string, ids: string[]) {
	for (const id of ids) await patchDocument(`users/${uid}/favorites/${id}`, { addedAt: int(Date.now() - 86_400_000) });
}

/** Il messaggio sta tutto nello schermo, non è tagliato (né in orizzontale né in verticale) e nessun elemento lo copre. */
async function expectReadable(page: Page, toast: Locator) {
	await expect(toast).toBeVisible();
	const { width, height } = page.viewportSize()!;
	const box = (await toast.boundingBox())!;
	expect(box.x, 'a sinistra dentro lo schermo').toBeGreaterThanOrEqual(0);
	expect(box.x + box.width, 'a destra dentro lo schermo').toBeLessThanOrEqual(width);
	expect(box.y, 'in alto dentro lo schermo').toBeGreaterThanOrEqual(0);
	expect(box.y + box.height, 'in basso dentro lo schermo').toBeLessThanOrEqual(height);
	const clipped = await toast.evaluate((el) =>
		[el, ...el.querySelectorAll('*')].filter((e) => e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1).map((e) => e.tagName)
	);
	expect(clipped, 'nessun elemento con contenuto tagliato').toEqual([]);
	const covered = await toast.evaluate((el) => {
		const r = el.getBoundingClientRect();
		const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
		return !top || !el.contains(top);
	});
	expect(covered, 'nessun elemento sopra il messaggio').toBe(false);
	// Il testo è su più righe ma la sua altezza resta ragionevole: meno di metà schermo.
	expect(box.height).toBeLessThan(height / 2);
}

async function shoot(page: Page, name: string, theme: string) {
	await page.screenshot({ path: `${OUT}/${name}-${theme}.png` });
}

for (const theme of ['light', 'dark']) {
	test.describe(`limiti dei preferiti a 360 px (${theme})`, () => {
		test.beforeEach(async ({ page }) => {
			await page.addInitScript((t) => localStorage.setItem('ev:theme', JSON.stringify(t)), theme);
		});

		test('massimo di 200 preferiti', async ({ page }) => {
			await signInByEmail(page, `max200-${theme}@example.org`, '/');
			const uid = await uidOf(page);
			await addFavorites(uid, Array.from({ length: 200 }, (_, i) => `fav${String(i).padStart(4, '0')}`));
			await setLimits(uid, 200, 0);
			await page.goto(MERCATO);
			await expect(page.getByRole('link', { name: 'Account' })).toBeVisible();
			await page.waitForLoadState('networkidle');
			await page.getByRole('button', { name: 'Salva', exact: true }).click();
			const toast = page.getByRole('status').filter({ hasText: 'massimo di 200 preferiti' });
			await expectReadable(page, toast);
			await shoot(page, '1-massimo-200', theme);
		});

		test('100 modifiche al giorno: aggiungere resta sul dispositivo', async ({ page }) => {
			await signInByEmail(page, `add100-${theme}@example.org`, '/');
			const uid = await uidOf(page);
			await setLimits(uid, 5, 100);
			await page.goto(MERCATO);
			await expect(page.getByRole('link', { name: 'Account' })).toBeVisible();
			await page.waitForLoadState('networkidle');
			await page.getByRole('button', { name: 'Salva', exact: true }).click();
			const toast = page.getByRole('status').filter({ hasText: 'limite di 100 modifiche ai preferiti, si sincronizzerà' });
			await expectReadable(page, toast);
			await shoot(page, '2-giornaliero-aggiunta', theme);
		});

		test('100 modifiche al giorno: togliere si potrà domani', async ({ page }) => {
			await signInByEmail(page, `rem100-${theme}@example.org`, '/');
			const uid = await uidOf(page);
			await addFavorites(uid, ['seedJazz']);
			await setLimits(uid, 1, 100);
			await page.goto(JAZZ);
			await expect(page.getByRole('link', { name: 'Account' })).toBeVisible();
			await page.waitForLoadState('networkidle');
			await page.getByRole('button', { name: 'Nei preferiti' }).click();
			const toast = page.getByRole('status').filter({ hasText: 'Potrai togliere questo preferito domani' });
			await expectReadable(page, toast);
			await shoot(page, '3-giornaliero-rimozione', theme);
		});

		test('al login i preferiti oltre il limite del giorno aspettano', async ({ page }) => {
			await signInByEmail(page, `sync100-${theme}@example.org`, '/');
			const uid = await uidOf(page);
			await setLimits(uid, 0, 98); // restano 2 modifiche: dei 5 preferiti locali ne partono 2, gli altri 3 aspettano
			await page.evaluate(() => localStorage.setItem('ev:favorites', JSON.stringify(['seedJazz', 'seedMercato', 'seedMostra', 'seedBimbi', 'seedLecce'])));
			await page.reload();
			const toast = page.getByRole('status').filter({ hasText: 'si sincronizzeranno nei prossimi giorni' });
			await expectReadable(page, toast);
			await expect(toast).toContainText('3 preferiti');
			await shoot(page, '4-sincronizzazione-rimandata', theme);
		});
	});
}
