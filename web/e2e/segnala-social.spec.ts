import { expect, test, type Page } from '@playwright/test';
import { FIRESTORE, mockGeocode, signInByEmail } from './helpers';

// «Segnala un evento trovato sui social»: /proponi?da=social con il link al post in testa. Il link si controlla solo come testo:
// nessuna richiesta all'indirizzo (né dal browser né dal server). I test dipendono dall'ordine, come in app.spec.ts.
const USER = 'social@example.org';
const ADMIN = 'eventivicini.info@gmail.com';
const LINK = 'https://www.instagram.com/p/AbC123/';
const TITLE_A = 'Sagra social A';
const TITLE_B = 'Sagra social B';

const linkField = (page: Page) => page.getByLabel('Link al post o alla pagina *');

async function fillEvent(page: Page, title: string) {
	await page.getByLabel('Titolo *').fill(title);
	await page.getByLabel('Inizio *').fill('2030-06-14T20:00');
	await page.getByLabel('Indirizzo *').fill('Via Emilia Centro 100, Modena');
	await page.getByRole('button', { name: 'Trova' }).click();
	await expect(page.getByText(/Trovato/)).toBeVisible();
}

async function submissions() {
	const res = await fetch(`${FIRESTORE}/submissions`, { headers: { Authorization: 'Bearer owner' } });
	const body = (await res.json()) as { documents?: { fields: Record<string, { stringValue?: string }> }[] };
	return body.documents ?? [];
}

test('la riga «Segnala un evento» sta dopo l’ottava card, senza rompere sezioni, conteggi e tastiera', async ({ page }) => {
	await page.goto('/citta/torino');
	await expect(page.locator('li.inline')).toHaveCount(1);
	// tutte le card montate (render a blocchi): la riga non si sposta
	const cards = page.locator('.sect ul.list > li:not(.inline)');
	await expect.poll(() => cards.count()).toBeGreaterThanOrEqual(24);
	const idx = await page.evaluate(() => [...document.querySelectorAll('.sect ul.list > li')].findIndex((li) => li.classList.contains('inline')));
	expect(idx).toBe(8); // otto card prima
	// titoli di sezione e conteggi sull'elenco intero (carico anche le pagine successive): la somma dei conteggi è il numero di card
	const more = page.getByRole('button', { name: /^Mostra altri/ });
	while (await more.isVisible()) {
		const before = await cards.count();
		await more.click();
		await expect.poll(() => cards.count()).toBeGreaterThan(before);
	}
	await page.waitForTimeout(500); // il render a blocchi finisce nei momenti liberi
	const counts = await page.locator('.sect h2 .count').allInnerTexts();
	const sum = counts.reduce((n, t) => n + Number(t.replace(/\D/g, '')), 0);
	expect(sum).toBe(await cards.count());
	// la riga è dentro una sezione (non spezza il raggruppamento) e ha il suo link
	const row = page.locator('li.inline');
	await expect(row.locator('xpath=ancestor::section[contains(@class,"sect")]')).toHaveCount(1);
	const link = row.getByRole('link', { name: 'Segnala un evento' });
	await expect(link).toHaveAttribute('href', '/proponi?da=social');

	// tastiera: dalla card precedente si arriva al link con Tab; da lì Tab esce senza intrappolare il focus, Maiusc+Tab torna indietro
	await page.locator('.sect ul.list > li').nth(7).getByRole('link').first().focus();
	let reached = false;
	for (let i = 0; i < 6 && !reached; i++) {
		await page.keyboard.press('Tab');
		reached = await link.evaluate((el) => el === document.activeElement);
	}
	expect(reached).toBe(true);
	await page.keyboard.press('Tab');
	expect(await link.evaluate((el) => el === document.activeElement)).toBe(false);
	expect(await row.evaluate((el) => el.contains(document.activeElement))).toBe(false);
	await page.keyboard.press('Shift+Tab');
	expect(await link.evaluate((el) => el === document.activeElement)).toBe(true);
});

test('con meno di otto eventi la riga è in fondo all’elenco, sulla home e a 360 px', async ({ page }) => {
	await page.setViewportSize({ width: 360, height: 640 });
	await page.goto('/?luogo=modena');
	await page.waitForLoadState('networkidle');
	const row = page.locator('li.inline');
	await expect(row).toHaveCount(1);
	const { idx, n } = await page.evaluate(() => {
		const all = [...document.querySelectorAll('.sect ul.list > li')];
		return { idx: all.findIndex((li) => li.classList.contains('inline')), n: all.length - 1 };
	});
	expect(idx).toBe(Math.min(8, n));
	await expect(row.getByRole('link', { name: 'Segnala un evento' })).toBeVisible();
	// il footer ha lo stesso collegamento
	await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Segnala un evento' })).toHaveAttribute('href', '/proponi?da=social');
});

test('la scheda dell’evento rimanda alla segnalazione dai social', async ({ page }) => {
	await page.goto('/eventi/jazz-in-piazza-grande-seedJazz');
	await page.getByRole('link', { name: 'Segnala un evento trovato sui social' }).click();
	await expect(page).toHaveURL(/\/proponi\?da=social$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Segnala un evento trovato sui social' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Accedi per segnalare' })).toBeVisible();
});

test('link non https o troppo lungo rifiutati; link valido inviato senza mai aprire l’indirizzo', async ({ page }) => {
	const touched: string[] = [];
	page.on('request', (r) => {
		if (/instagram\.com|example\.org/.test(new URL(r.url()).hostname)) touched.push(r.url());
	});
	await mockGeocode(page);
	await page.setViewportSize({ width: 360, height: 740 });
	await signInByEmail(page, USER, '/proponi?da=social');
	await expect(page.getByRole('heading', { level: 1, name: 'Segnala un evento trovato sui social' })).toBeVisible();

	// il link è il primo campo del modulo, obbligatorio
	const field = linkField(page);
	await expect(page.locator('form input').first()).toHaveAttribute('id', 'f-source');
	await expect(field).toHaveAttribute('maxlength', '500');
	await expect(page.getByLabel('Immagine (link)')).toHaveCount(0);
	await fillEvent(page, TITLE_A);

	await page.getByRole('button', { name: 'Invia la segnalazione' }).click();
	await expect(page.locator('#e-source')).toHaveText('Campo obbligatorio');

	await field.fill('http://www.instagram.com/p/AbC123/');
	await expect(page.locator('#e-source')).toHaveText('Inserisci un link che inizi con https://');
	await expect(page.locator('#e-source')).toHaveAttribute('role', 'alert');
	await expect(field).toHaveAttribute('aria-invalid', 'true');

	await field.evaluate((el) => el.removeAttribute('maxlength')); // fill() ignora maxlength: così si prova il controllo, non l'attributo
	await field.fill(`https://example.org/${'a'.repeat(481)}`);
	await expect(page.locator('#e-source')).toHaveText('Massimo 500 caratteri');
	expect(await submissions()).toHaveLength(0);

	await field.fill(`  ${LINK.replace('www.instagram', 'WWW.Instagram')}  `);
	await expect(page.locator('#e-source')).toHaveCount(0);
	await page.getByRole('button', { name: 'Invia la segnalazione' }).click();
	await expect(page).toHaveURL(/\/account#proposte$/);
	await expect(page.getByText(TITLE_A)).toBeVisible();

	const docs = await submissions();
	expect(docs).toHaveLength(1);
	expect(docs[0].fields.sourceUrl.stringValue).toBe(LINK); // salvato normalizzato, non altro
	expect(touched).toEqual([]);
});

test('la seconda segnalazione con lo stesso link', async ({ page }) => {
	await mockGeocode(page);
	await signInByEmail(page, USER, '/proponi?da=social');
	await linkField(page).fill(LINK);
	await fillEvent(page, TITLE_B);
	await page.getByRole('button', { name: 'Invia la segnalazione' }).click();
	await expect(page).toHaveURL(/\/account#proposte$/);
});

test('admin: link visibile e cliccabile, duplicati segnalati, «Fonte» dopo l’approvazione', async ({ page }) => {
	await signInByEmail(page, ADMIN, '/admin/proposte');
	const cardA = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: TITLE_A }) });
	const cardB = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: TITLE_B }) });
	const linkA = cardA.getByRole('link', { name: LINK });
	await expect(linkA).toHaveAttribute('href', LINK);
	await expect(linkA).toHaveAttribute('target', '_blank');
	await expect(linkA).toHaveAttribute('rel', 'noopener noreferrer nofollow ugc');
	await expect(cardA.getByText('Stesso link di un’altra proposta in attesa.')).toBeVisible();
	await expect(cardB.getByText('Stesso link di un’altra proposta in attesa.')).toBeVisible();

	await cardA.getByRole('button', { name: 'Approva' }).click();
	await expect(page.getByText(`Pubblicato “${TITLE_A}”.`)).toBeVisible();

	// già pubblicato: all'apertura dell'anteprima della seconda
	await expect(cardA).toHaveCount(0);
	await cardB.getByRole('button', { name: 'Anteprima' }).click();
	await expect(cardB.getByText('Già pubblicato con questo link:')).toBeVisible();
	await expect(cardB.getByRole('link', { name: TITLE_A })).toBeVisible();

	// la scheda dell'evento approvato mostra la fonte, con il rel dei contenuti degli utenti
	await cardB.getByRole('link', { name: TITLE_A }).click();
	await expect(page.getByRole('heading', { level: 1, name: TITLE_A })).toBeVisible();
	const fonte = page.locator('dd', { hasText: 'segnalato da un utente e approvato dalla redazione' });
	await expect(fonte).toBeVisible();
	const a = fonte.getByRole('link', { name: 'instagram.com' });
	await expect(a).toHaveAttribute('href', LINK);
	await expect(a).toHaveAttribute('target', '_blank');
	await expect(a).toHaveAttribute('rel', 'noopener noreferrer nofollow ugc');
	await expect(page.locator('body')).not.toContainText(/verificat[oa] dalla redazione/);
	await expect(page.locator('body')).not.toContainText(USER);
});

test('pulizia: l’admin rifiuta la proposta duplicata', async ({ page }) => {
	await signInByEmail(page, ADMIN, '/admin/proposte');
	const cardB = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: TITLE_B }) });
	await cardB.getByRole('button', { name: 'Rifiuta' }).click();
	await page.getByLabel('Motivo (lo vedrà l’autore)').fill('Evento già pubblicato.');
	await page.getByRole('dialog').getByRole('button', { name: 'Rifiuta' }).click();
	await expect(cardB).toHaveCount(0);
});
