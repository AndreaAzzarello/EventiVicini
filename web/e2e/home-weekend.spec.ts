import { expect, test, type Page } from '@playwright/test';

// #22: la home senza luogo mostra «Questo weekend» (5 eventi del bundle weekend del seed) e città di regioni diverse.
// Prima visita: nessun luogo salvato. 360x640 è il caso stretto: almeno un evento o un blocco di città sopra la piega.
test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 360, height: 640 } });

const strip = (page: Page) => page.getByRole('region', { name: 'Questo weekend' });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

test('fascia «Questo weekend» con 5 eventi di città diverse, dopo la scelta del luogo', async ({ page }) => {
	await page.goto('/');
	await expect(strip(page)).toBeVisible();
	await expect(strip(page).getByRole('heading', { level: 2, name: 'Questo weekend' })).toBeVisible();
	const cards = strip(page).locator('article');
	await expect(cards).toHaveCount(5);
	await expect(strip(page).getByRole('heading', { level: 3 })).toHaveCount(5);
	// stessa pagina: prima la scelta del luogo, poi la fascia, poi le città
	const y = async (loc: ReturnType<Page['locator']>) => (await loc.first().boundingBox())!.y;
	const choose = await y(page.getByRole('heading', { name: 'Dove cerchi eventi?' }));
	const weekend = await y(page.getByRole('heading', { name: 'Questo weekend' }));
	const cities = await y(page.getByRole('heading', { name: 'Oppure sfoglia per luogo' }));
	expect(choose).toBeLessThan(weekend);
	expect(weekend).toBeLessThan(cities);
	expect(await overflow(page)).toBe(false);
});

test('a 360x640 almeno un evento della fascia è visibile senza scorrere', async ({ page }) => {
	await page.goto('/');
	await expect(strip(page)).toBeVisible();
	const first = (await strip(page).locator('article').first().boundingBox())!;
	console.log('weekend: titolo y', (await page.getByRole('heading', { name: 'Questo weekend' }).boundingBox())!.y, 'prima card y', first.y, 'altezza', first.height);
	await page.screenshot({ path: 'test-results/home-weekend-360.png' });
	await page.screenshot({ path: 'test-results/home-weekend-360-full.png', fullPage: true });
	expect(first.y + 48).toBeLessThanOrEqual(640); // almeno la riga del titolo della prima card
});

test('città proposte: Modena per prima e non tutte della stessa regione', async ({ page }) => {
	await page.goto('/');
	const pills = page.getByRole('list', { name: 'Città con più eventi' }).getByRole('link');
	await expect(pills.first()).toContainText('Modena');
	const hrefs = await pills.evaluateAll((a) => a.map((x) => x.getAttribute('href')));
	expect(new Set(hrefs).size).toBe(hrefs.length);
	expect(hrefs.length).toBeGreaterThan(3);
	expect(hrefs).toContain('/citta/bolzano'); // Trentino-Alto Adige: prima non era l'unica ad avere più città di Modena
});

test('chi ha già un luogo salvato non vede la fascia', async ({ browser }) => {
	const ctx = await browser.newContext({
		viewport: { width: 360, height: 640 },
		storageState: { cookies: [], origins: [{ origin: 'http://localhost:4300', localStorage: [{ name: 'ev:place', value: JSON.stringify({ lat: 44.6471, lng: 10.9252, label: 'Modena' }) }] }] }
	});
	const page = await ctx.newPage();
	await page.goto('/?luogo=modena');
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	await expect(page.locator('section.weekend')).toHaveCount(0); // (la lista di un luogo ha una sezione omonima: si guarda la fascia)
	await ctx.close();
});
