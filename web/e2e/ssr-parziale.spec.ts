import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

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
