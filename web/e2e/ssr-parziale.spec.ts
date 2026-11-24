import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { openMapSheet, pickFirstEvent } from './helpers';

// Liste lunghe (Torino, 60 eventi nel seed grande): l'HTML del server ha solo le prime 12 card, il resto arriva da /api/events (#51).
const URL_TORINO = '/?luogo=torino';

test('HTML grezzo: 12 card, conteggi dell’elenco intero, nessuno scheletro; poi la lista completa', async ({ page, request }) => {
	const html = await (await request.get(URL_TORINO)).text();
	expect(html.match(/<article/g)?.length).toBe(12);
	expect(html).toContain('60 eventi');
	expect(html).toContain('Carico gli altri eventi');

	// Nessuno scheletro mai visibile mentre arriva il resto.
	await page.addInitScript(() => {
		(window as unknown as { __sk: number }).__sk = 0;
		new MutationObserver(() => {
			if (document.querySelector('.sk')) (window as unknown as { __sk: number }).__sk++;
		}).observe(document, { childList: true, subtree: true });
	});
	await page.goto(URL_TORINO);
	await expect(page.locator('article')).toHaveCount(60);
	await expect(page.getByText('Carico gli altri eventi')).toHaveCount(0);
	await expect(page.getByText('60 eventi')).toBeVisible();
	expect(await page.evaluate(() => (window as unknown as { __sk: number }).__sk)).toBe(0);
});

// Render a blocchi (EventList): 12 card dal server, 24 al primo render del client, poi +12 per volta nei momenti liberi.
test('render a blocchi: passi di al più 12 card, conteggi interi, nessun hydration_mismatch', async ({ page }) => {
	const problems: string[] = [];
	page.on('console', (m) => /Content Security Policy|violates the following|hydration_mismatch/i.test(m.text()) && problems.push(m.text()));
	await page.addInitScript(() => {
		const w = window as unknown as { __n: number[] };
		w.__n = [];
		new MutationObserver(() => {
			const n = document.querySelectorAll('article').length;
			if (n !== w.__n.at(-1)) w.__n.push(n);
		}).observe(document, { childList: true, subtree: true });
	});
	await page.goto(URL_TORINO);
	await expect(page.locator('article')).toHaveCount(60);
	const seq = await page.evaluate(() => (window as unknown as { __n: number[] }).__n);
	for (let i = 1; i < seq.length; i++) expect(seq[i] - seq[i - 1], `passi: ${seq.join(' → ')}`).toBeLessThanOrEqual(12);
	expect(seq.at(-1)).toBe(60);
	// titoli di sezione: i conteggi sono quelli dell'elenco intero
	const counts = await page.locator('.sect h2 .count').allTextContents();
	expect(counts.reduce((n, c) => n + Number(c.replace(/\D/g, '')), 0)).toBe(60);
	expect(problems).toEqual([]);
});

test('un filtro riparte dalle prime card e la lista si riempie di nuovo a blocchi', async ({ page }) => {
	const sum = async () => (await page.locator('.sect h2 .count').allTextContents()).reduce((n, c) => n + Number(c.replace(/\D/g, '')), 0);
	await page.goto(URL_TORINO);
	await expect(page.locator('article')).toHaveCount(60);
	await page.getByRole('button', { name: 'Gratis', exact: true }).click();
	await expect.poll(sum).toBeLessThan(60); // i titoli dicono subito il totale filtrato
	const free = await sum();
	await expect(page.locator('article')).toHaveCount(free); // e le card lo raggiungono, né una di più né una di meno
	await page.getByRole('button', { name: /Azzera/ }).click();
	await expect(page.locator('article')).toHaveCount(60);
});

test('«Vedi nella lista» dalla mappa porta alla card (lista a blocchi) e le dà il focus', async ({ page }) => {
	await page.goto('/?luogo=torino&vista=mappa');
	const { sheet } = await openMapSheet(page);
	await pickFirstEvent(sheet);
	const id = (await sheet.getByRole('link', { name: 'Apri scheda' }).getAttribute('href'))!.split('-').pop()!;
	await sheet.getByRole('button', { name: 'Vedi nella lista' }).click();
	await expect(page.locator(`[data-ev-id="${id}"] a`).first()).toBeFocused();
});

test('senza JavaScript: 12 card e il link a /citta', async ({ browser }) => {
	const ctx = await browser.newContext({ javaScriptEnabled: false });
	const page = await ctx.newPage();
	await page.goto(URL_TORINO);
	await expect(page.getByText('Evento di prova numero').first()).toBeVisible();
	await expect(page.getByRole('link', { name: 'Vedi tutti gli eventi a Torino' })).toHaveAttribute('href', '/citta/torino');
	await ctx.close();
});

test('un luogo con meno di 13 eventi resta tutto nell’HTML', async ({ request }) => {
	const html = await (await request.get('/?luogo=modena')).text();
	expect(html).not.toContain('Carico gli altri eventi');
});

test('a11y: home con SSR parziale', async ({ page }) => {
	await page.goto(URL_TORINO);
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).disableRules(['color-contrast']).analyze();
	expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
});

// --- /citta/<slug>: una pagina di 24 card nell'HTML, «Mostra altri» da /api/citta, paginazione anche senza JavaScript ---

test('/citta/torino: 24 card nell’HTML, conteggio intero, link alle altre pagine', async ({ request }) => {
	const html = await (await request.get('/citta/torino')).text();
	expect(html.match(/<article/g)?.length).toBe(24);
	expect(html).toContain('60 eventi in programma');
	expect(html).toContain('/citta/torino?pagina=2');
	expect(html).toContain('<link rel="canonical" href="http://localhost:');
	expect(html).toMatch(/rel="canonical" href="[^"]*\/citta\/torino"/);
});

test('?pagina=3 ha le ultime 12 card e canonical su se stessa; oltre l’ultima porta all’ultima; non valida vale 1', async ({ request }) => {
	const p3 = await (await request.get('/citta/torino?pagina=3')).text();
	expect(p3.match(/<article/g)?.length).toBe(12);
	expect(p3).toMatch(/rel="canonical" href="[^"]*\/citta\/torino\?pagina=3"/);
	expect(p3).toContain('pagina 3');
	const over = await request.get('/citta/torino?pagina=9', { maxRedirects: 0 });
	expect(over.status()).toBe(302);
	expect(over.headers().location).toBe('/citta/torino?pagina=3');
	const bad = await (await request.get('/citta/torino?pagina=abc')).text();
	expect(bad.match(/<article/g)?.length).toBe(24);
});

test('/citta/torino senza JavaScript: pagina 2 raggiungibile dal link', async ({ browser }) => {
	const ctx = await browser.newContext({ javaScriptEnabled: false });
	const page = await ctx.newPage();
	await page.goto('/citta/torino');
	await page.getByRole('link', { name: 'Pagina successiva' }).click();
	await expect(page).toHaveURL(/pagina=2/);
	await expect(page.locator('article')).toHaveCount(24);
	await ctx.close();
});

test('/citta/torino con JavaScript: Mostra altri aggiunge card e a fine lista sparisce', async ({ page }) => {
	await page.goto('/citta/torino');
	await expect(page.locator('article')).toHaveCount(24);
	await page.getByRole('button', { name: /Mostra altri/ }).click();
	await expect(page.locator('article')).toHaveCount(48);
	await page.getByRole('button', { name: /Mostra altri/ }).click();
	await expect(page.locator('article')).toHaveCount(60);
	await expect(page.getByRole('button', { name: /Mostra altri/ })).toHaveCount(0);
});

test('/citta/torino: un filtro riparte dall’inizio della lista filtrata (lista completa scaricata)', async ({ page }) => {
	await page.goto('/citta/torino?gratis=1');
	const free = await page.locator('article').count();
	expect(free).toBeLessThanOrEqual(24);
	await page.goto('/citta/torino');
	await page.getByRole('button', { name: /Mostra altri/ }).click();
	await expect(page.locator('article')).toHaveCount(48);
});

test('/api/citta/torino dà tutti gli eventi; slug non valido 404', async ({ request }) => {
	const res = await request.get('/api/citta/torino');
	expect(res.status()).toBe(200);
	expect((await res.json()).length).toBe(60);
	expect((await request.get('/api/citta/Torino')).status()).toBe(404);
});

test('a11y: /citta/torino paginata', async ({ page }) => {
	await page.goto('/citta/torino');
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).disableRules(['color-contrast']).analyze();
	expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
});
