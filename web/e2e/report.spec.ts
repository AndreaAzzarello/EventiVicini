import { expect, test, type Page } from '@playwright/test';
import { FIRESTORE, signInByEmail } from './helpers';

const EVENT = '/eventi/mercato-dellantiquariato-seedMercato';
const TEXT = 'La data indicata non corrisponde a quella pubblicata sul sito del Comune.';

async function reports() {
	const res = await fetch(`${FIRESTORE}/reports`, { headers: { Authorization: 'Bearer owner' } });
	const body = (await res.json()) as { documents?: { name: string; fields: Record<string, { stringValue?: string }> }[] };
	return body.documents ?? [];
}
const noOverflow = (page: Page) =>
	page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test.beforeEach(async ({ request }) => {
	// parte sempre da zero: le segnalazioni di altri test non contano
	for (const d of await reports()) await fetch(`http://127.0.0.1:8080/v1/${d.name}`, { method: 'DELETE', headers: { Authorization: 'Bearer owner' } });
	void request;
});

test('chiunque segnala un evento, senza account: validazione, invio, una sola volta per dispositivo', async ({ page }) => {
	await page.goto(EVENT);
	await page.getByRole('button', { name: 'Segnala questo evento' }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog.getByRole('link', { name: 'Termini', exact: true })).toBeVisible();
	await expect(dialog.getByRole('link', { name: 'Privacy', exact: true })).toBeVisible();
	await expect(dialog.getByRole('link', { name: /@/ }).first()).toHaveAttribute('href', /^mailto:[^@]+@[^@]+$/);

	// troppo corta
	await dialog.getByLabel('Spiegazione').fill('boh');
	await dialog.getByRole('button', { name: 'Invia la segnalazione' }).click();
	await expect(dialog.getByRole('alert')).toContainText('almeno 10 caratteri');
	// email non valida
	await dialog.getByLabel('Spiegazione').fill(TEXT);
	await dialog.getByLabel('La tua email (facoltativa)').fill('non-una-email');
	await dialog.getByRole('button', { name: 'Invia la segnalazione' }).click();
	await expect(dialog.getByRole('alert')).toContainText('email');
	expect(await reports()).toHaveLength(0);

	await dialog.getByLabel('La tua email (facoltativa)').fill('');
	await dialog.getByRole('button', { name: 'Invia la segnalazione' }).click();
	await expect(dialog.getByRole('heading', { name: 'Segnalazione inviata' })).toBeVisible();

	const docs = await reports();
	expect(docs).toHaveLength(1);
	expect(docs[0].fields.reason.stringValue).toBe('misleading');
	expect(docs[0].fields.text.stringValue).toBe(TEXT);
	expect(docs[0].fields.status.stringValue).toBe('open');
	expect(Object.keys(docs[0].fields).sort()).toEqual(['createdAt', 'email', 'eventId', 'reason', 'status', 'text']); // nessun dato su chi segnala

	// stesso dispositivo, stesso evento: niente doppioni
	await dialog.getByRole('button', { name: 'Chiudi' }).click();
	await page.getByRole('button', { name: 'Segnala questo evento' }).click();
	await expect(page.getByRole('heading', { name: 'Hai già segnalato questo evento' })).toBeVisible();
	expect(await reports()).toHaveLength(1);
});

test('il campo esca fa finta di niente e non scrive nulla', async ({ page }) => {
	await page.goto(EVENT);
	await page.getByRole('button', { name: 'Segnala questo evento' }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Spiegazione').fill(TEXT);
	await dialog.locator('input[tabindex="-1"]').fill('http://spam.example', { force: true });
	await dialog.getByRole('button', { name: 'Invia la segnalazione' }).click();
	await expect(dialog.getByRole('heading', { name: 'Segnalazione inviata' })).toBeVisible();
	expect(await reports()).toHaveLength(0);
});

test('l’admin trova la segnalazione e la chiude con una motivazione', async ({ page }) => {
	await page.goto(EVENT);
	await page.getByRole('button', { name: 'Segnala questo evento' }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Motivo').selectOption('illegal');
	await dialog.getByLabel('Spiegazione').fill(TEXT);
	await dialog.getByLabel('La tua email (facoltativa)').fill('segnalante@example.org');
	await dialog.getByRole('button', { name: 'Invia la segnalazione' }).click();
	await expect(dialog.getByRole('heading', { name: 'Segnalazione inviata' })).toBeVisible();

	await signInByEmail(page, 'eventivicini.info@gmail.com', '/admin/segnalazioni');
	await expect(page.getByRole('heading', { name: 'Segnalazioni', exact: true })).toBeVisible();
	await expect(page.getByText('Contenuto illegale')).toBeVisible();
	await expect(page.getByText(TEXT)).toBeVisible();
	await expect(page.getByText('Contatto: segnalante@example.org')).toBeVisible();

	await page.getByRole('button', { name: 'Respingi' }).click();
	const ask = page.getByRole('dialog');
	await expect(ask.getByRole('button', { name: 'Conferma' })).toBeDisabled(); // senza motivazione non si decide
	await ask.getByLabel(/Motivazione/).fill('La data coincide con quella del sito del Comune.');
	await ask.getByRole('button', { name: 'Conferma' }).click();
	await expect(page.getByText('Segnalazione respinta.')).toBeVisible();
	await expect(page.getByText('Nessuna segnalazione aperta.')).toBeVisible();

	const [doc] = await reports();
	expect(doc.fields.status.stringValue).toBe('dismissed');
	expect(doc.fields.decision.stringValue).toContain('coincide');
});

test('un utente normale non vede la coda', async ({ page }) => {
	await signInByEmail(page, 'mario@example.org', '/admin/segnalazioni');
	await expect(page.getByText('Questo account non ha i permessi di amministrazione.')).toBeVisible();
});

for (const width of [360, 390]) {
	test(`il modulo sta nello schermo a ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 740 });
		await page.goto(EVENT);
		await page.getByRole('button', { name: 'Segnala questo evento' }).click();
		const box = await page.getByRole('dialog').boundingBox();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.x + box!.width).toBeLessThanOrEqual(width);
		expect(await noOverflow(page)).toBe(true);
	});
}
