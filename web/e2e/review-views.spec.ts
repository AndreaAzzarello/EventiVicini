import { test, type Page } from '@playwright/test';
import { FIRESTORE, signInByEmail, uidOf } from './helpers';

// Screenshot di revisione delle viste con account: REVIEW_VIEWS=<cartella> → web/.review/<cartella>/. Non sono test.
const OUT = process.env.REVIEW_VIEWS;
test.skip(!OUT, 'impostare REVIEW_VIEWS=<cartella>');
test.describe.configure({ mode: 'serial' });

const SIZES: [string, number, number][] = [['360', 360, 740], ['desktop', 1280, 800]];

const enc = (v: unknown): Record<string, unknown> => {
	if (typeof v === 'string') return { stringValue: v };
	if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
	if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
	return { nullValue: null };
};

async function seedSubmission(id: string, uid: string, status: 'pending' | 'rejected', title: string) {
	const day = 86_400_000;
	const data: Record<string, unknown> = {
		title, shortDescription: 'Una serata di prova per la revisione grafica.', category: 'music', priceType: 'low',
		startTime: Date.now() + 5 * day, endTime: Date.now() + 5 * day + 3_600_000, venueName: 'Teatro comunale',
		address: 'Via Emilia Centro 100, Modena', lat: 44.6466, lng: 10.9262, imageUrl: '', ticketUrl: 'https://example.org/biglietti',
		tags: ['live'], geohash: 'srbj4w1t0q', city: 'Modena', citySlug: 'modena', province: 'MO', region: 'Emilia-Romagna',
		ownerId: uid, status, ...(status === 'rejected' ? { rejectReason: 'Evento già presente in agenda.' } : {})
	};
	const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, enc(v)]));
	fields.createdAt = { timestampValue: new Date().toISOString() };
	const res = await fetch(`${FIRESTORE}/submissions/${id}`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json', Authorization: 'Bearer owner' },
		body: JSON.stringify({ fields })
	});
	if (!res.ok) throw new Error(`${id}: ${res.status} ${await res.text()}`);
}

for (const theme of ['light', 'dark']) {
	const shoot = async (page: Page, name: string, path: string) => {
		for (const [size, w, h] of SIZES) {
			await page.setViewportSize({ width: w, height: h });
			await page.goto(path);
			await page.waitForLoadState('networkidle');
			await page.waitForTimeout(400);
			await page.screenshot({ path: `.review/${OUT}/${name}-${size}-${theme}.png`, fullPage: true });
		}
	};

	test(`utente ${theme}`, async ({ page }) => {
		await page.addInitScript((t) => localStorage.setItem('ev:theme', JSON.stringify(t)), theme);
		await shoot(page, 'accedi', '/accedi');
		await shoot(page, 'proponi-anonimo', '/proponi');
		await signInByEmail(page, 'mario@example.org', '/');
		const uid = await uidOf(page);
		await seedSubmission('rev-1', uid, 'pending', 'Concerto della banda di paese');
		await seedSubmission('rev-2', uid, 'rejected', 'Serata di prova duplicata');
		await shoot(page, 'proponi', '/proponi');
		await shoot(page, 'account', '/account');
		// Errori del form: invio a vuoto
		await page.setViewportSize({ width: 360, height: 740 });
		await page.goto('/proponi');
		await page.getByRole('button', { name: 'Invia la proposta' }).click();
		await page.waitForTimeout(300);
		await page.screenshot({ path: `.review/${OUT}/proponi-errori-360-${theme}.png`, fullPage: true });
	});

	test(`admin ${theme}`, async ({ page }) => {
		await page.addInitScript((t) => localStorage.setItem('ev:theme', JSON.stringify(t)), theme);
		await signInByEmail(page, 'eventivicini.info@gmail.com', '/admin');
		for (const [name, path] of [
			['admin-eventi', '/admin'],
			['admin-proposte', '/admin/proposte'],
			['admin-statistiche', '/admin/statistiche'],
			['admin-stile', '/admin/stile'],
			['admin-nuovo', '/admin/eventi/nuovo'],
			['admin-modifica', '/admin/eventi/seedJazz']
		])
			await shoot(page, name, path);
		// Dialog di conferma dell'eliminazione
		await page.setViewportSize({ width: 360, height: 740 });
		await page.goto('/admin');
		await page.getByRole('button', { name: /^Elimina/ }).first().click();
		await page.waitForTimeout(300);
		await page.screenshot({ path: `.review/${OUT}/admin-dialog-360-${theme}.png` });
	});
}
