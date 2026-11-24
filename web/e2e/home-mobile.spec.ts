import { expect, test, type Page } from '@playwright/test';
import { openMapSheet } from './helpers';

// Home mobile (#22): selettore Lista/Mappa (controllo segmentato sticky), filtri. Gira su Pixel 7 (Chromium) e iPhone 15 (WebKit).
// Limite noto: Playwright non simula la barra di Safari né la notch, quindi env(safe-area-inset-*) vale 0:
// qui si verifica la geometria di base, la safe area si prova su un iPhone reale.
const tab = (page: Page, name: 'Mappa' | 'Lista') => page.getByRole('tab', { name, exact: true });
const toolbar = (page: Page) => page.locator('.toolbar');

async function home(page: Page, query = '') {
	await page.goto(`/?luogo=modena${query}`);
	await expect(page.getByRole('link', { name: 'Jazz in Piazza Grande' }).or(page.getByRole('region', { name: 'Mappa degli eventi' })).first()).toBeVisible();
	await page.waitForLoadState('networkidle');
}

test('il selettore è a tutta larghezza, in due metà uguali, alto --control', async ({ page }) => {
	await home(page);
	const { width } = page.viewportSize()!;
	const tabs = (await page.getByRole('tablist', { name: 'Vista' }).boundingBox())!;
	const a = (await tab(page, 'Lista').boundingBox())!;
	const b = (await tab(page, 'Mappa').boundingBox())!;
	expect(tabs.width).toBeGreaterThanOrEqual(width - 2 * 16 - 1); // tutta la colonna (padding del container: --space-3)
	expect(tabs.height).toBeGreaterThanOrEqual(47);
	expect(Math.abs(a.width - b.width)).toBeLessThanOrEqual(1);
	expect(Math.min(a.height, b.height)).toBeGreaterThanOrEqual(44);
});

test('stato attivo inequivocabile: metà piena e in grassetto, l’altra neutra e a peso normale', async ({ page }) => {
	await home(page);
	const style = (name: 'Mappa' | 'Lista') =>
		tab(page, name).evaluate((el) => {
			const s = getComputedStyle(el);
			return { bg: s.backgroundColor, color: s.color, weight: Number(s.fontWeight) };
		});
	const page$ = await page.evaluate(() => ({ text: getComputedStyle(document.body).color, bg: getComputedStyle(document.body).backgroundColor }));
	await expect(tab(page, 'Lista')).toHaveAttribute('aria-selected', 'true');
	await expect(tab(page, 'Mappa')).toHaveAttribute('aria-selected', 'false');
	// con poll: i colori passano da una transizione di --dur, quindi si aspetta lo stato finale
	const active = { bg: page$.text, color: page$.bg, weight: 600 }; // sfondo --text e testo --bg, come i toast
	const neutral = { bg: 'rgba(0, 0, 0, 0)', color: page$.text, weight: 400 }; // nessun riempimento, peso normale
	await expect.poll(() => style('Lista')).toEqual(active);
	await expect.poll(() => style('Mappa')).toEqual(neutral);
	await tab(page, 'Mappa').click();
	await expect(tab(page, 'Mappa')).toHaveAttribute('aria-selected', 'true');
	await expect(tab(page, 'Lista')).toHaveAttribute('aria-selected', 'false');
	await expect.poll(() => style('Mappa')).toEqual(active);
	await expect.poll(() => style('Lista')).toEqual(neutral);
	await expect(page).toHaveURL(/vista=mappa/);
});

test('il selettore resta agganciato sotto l’header dopo uno scroll di 2000 px', async ({ page }) => {
	await home(page, '&vista=mappa'); // la vista mappa è la più alta: lo scroll arriva davvero lontano
	await page.evaluate(() => window.scrollTo(0, 2000));
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
	const header = (await page.locator('.site-header').boundingBox())!;
	const bar = (await toolbar(page).boundingBox())!;
	expect(Math.abs(bar.y - (header.y + header.height))).toBeLessThanOrEqual(1);
	await expect(tab(page, 'Lista')).toBeVisible();
	// sotto l'header e sopra la lista
	const z = await page.evaluate(() => ({ bar: Number(getComputedStyle(document.querySelector('.toolbar')!).zIndex), header: Number(getComputedStyle(document.querySelector('.site-header')!).zIndex) }));
	expect(z.bar).toBeLessThan(z.header);
	// si può ancora cambiare vista da lì
	await tab(page, 'Lista').click();
	await expect(page.getByRole('link', { name: 'Jazz in Piazza Grande' })).toBeVisible();
});

test('in lista, in fondo alla pagina, l’ultima card è cliccabile', async ({ page }) => {
	await home(page);
	await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
	const last = page.locator('[data-ev-id]').last();
	await last.scrollIntoViewIfNeeded();
	await last.getByRole('link').first().click({ trial: true }); // fallisce se qualcosa (il selettore sticky) copre il punto di clic
	expect((await last.boundingBox())!.y + (await last.boundingBox())!.height).toBeLessThanOrEqual(page.viewportSize()!.height); // il fondo della card non è tagliato
});

test('in mappa il selettore non copre i controlli di Leaflet né l’anteprima aperta', async ({ page }) => {
	await home(page, '&vista=mappa');
	const zoom = page.locator('.leaflet-control-zoom-in');
	await expect(zoom).toBeVisible();
	const zoomBox = (await zoom.boundingBox())!;
	const bar = (await toolbar(page).boundingBox())!;
	expect(zoomBox.y).toBeGreaterThanOrEqual(bar.y + bar.height); // lo zoom sta sotto il selettore
	await zoom.click({ trial: true });
	const { sheet } = await openMapSheet(page);
	// con poll: la scheda entra con una transizione (--dur-view), a metà corsa il punto campionato è ancora sulla mappa
	await expect
		.poll(() =>
			sheet.evaluate((el) => {
				const r = el.getBoundingClientRect();
				const top = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 40));
				return !!top && !el.contains(top); // true = qualcosa copre l'anteprima
			})
		)
		.toBe(false);
	const s = (await sheet.boundingBox())!;
	const t = (await toolbar(page).boundingBox())!;
	expect(s.y >= t.y + t.height || s.y + s.height <= t.y).toBe(true);
});

// Pattern ARIA tabs (#84): Tab entra sul tab selezionato (roving tabindex), la freccia sposta il focus e attiva la vista.
test('da tastiera: la freccia destra porta da Lista a Mappa e cambia vista', async ({ page }) => {
	await home(page);
	await tab(page, 'Lista').focus();
	await expect(tab(page, 'Lista')).toBeFocused();
	await page.keyboard.press('ArrowRight');
	await expect(tab(page, 'Mappa')).toBeFocused();
	await expect(tab(page, 'Mappa')).toHaveAttribute('aria-selected', 'true');
	await expect(page).toHaveURL(/vista=mappa/);
	await expect(page.getByRole('region', { name: 'Mappa degli eventi' })).toBeVisible();
	await expect(tab(page, 'Mappa')).toBeFocused();
});

// Sopra la piega (#22): a 360×640 la prima card è intera, senza togliere il testo di «Usa la mia posizione».
test('a 360×640 la prima card è intera sopra la piega', async ({ page }) => {
	await page.setViewportSize({ width: 360, height: 640 });
	await home(page);
	const box = (await page.locator('[data-ev-id]').first().boundingBox())!;
	expect(box.y).toBeGreaterThanOrEqual(0);
	expect(box.y + box.height).toBeLessThanOrEqual(640);
	await expect(page.getByRole('button', { name: 'Usa la mia posizione' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Usa la mia posizione' })).toContainText('Usa la mia posizione'); // testo visibile, non solo etichetta
});

for (const [width, height] of [[360, 640], [320, 640]]) {
	test(`a ${width}px: nessun overflow orizzontale e bersagli di testata, filtri e selettore ≥ 24 px`, async ({ page }) => {
		await page.setViewportSize({ width, height });
		await home(page);
		expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
		const small = await page.evaluate(() =>
			[...document.querySelectorAll<HTMLElement>('.intro button, .tabs button, .filters .chip, .filters select, .filters input')]
				.map((el) => ({ el, r: el.getBoundingClientRect() }))
				.filter(({ r }) => r.width && (r.width < 24 || r.height < 24))
				.map(({ el, r }) => `${el.tagName.toLowerCase()} «${(el.textContent ?? '').trim().slice(0, 20)}» ${Math.round(r.width)}×${Math.round(r.height)}`)
		);
		expect(small).toEqual([]);
	});
}

// Immagini sopra la piega: eager solo nelle prime due card, priorità alta di rete al massimo sulla prima immagine, il resto lazy.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
test('immagini: eager nelle prime due card, fetchpriority alta solo sulla prima, le altre lazy', async ({ page }) => {
	await page.route('https://example.org/**', (r) => r.fulfill({ contentType: 'image/png', body: PNG })); // immagini che caricano: nessun ripiego
	await page.goto('/?luogo=torino'); // seed grande: card con immagine
	await expect(page.locator('[data-ev-id]')).toHaveCount(60);
	const imgs = await page.$$eval('[data-ev-id]', (cards) =>
		cards.map((c) => {
			const i = c.querySelector('img');
			return i ? { loading: i.loading, fp: i.getAttribute('fetchpriority') } : null;
		})
	);
	expect(imgs.filter(Boolean).length).toBeGreaterThan(0);
	imgs.forEach((im, i) => im && expect(im.loading, `card ${i}`).toBe(i < 2 ? 'eager' : 'lazy'));
	const high = imgs.map((im, i) => (im?.fp === 'high' ? i : -1)).filter((i) => i >= 0);
	expect(high.length).toBe(1); // esattamente una, sulla prima con immagine
	expect(high[0]).toBeLessThan(2);
});

test('filtri: il select della distanza è alto quanto i chip', async ({ page }) => {
	await home(page);
	const select = (await page.locator('.filters select').boundingBox())!;
	const chip = (await page.getByRole('button', { name: 'Oggi', exact: true }).boundingBox())!;
	expect(Math.abs(select.height - chip.height)).toBeLessThanOrEqual(1);
	// stessa linea: i centri verticali coincidono
	expect(Math.abs(select.y + select.height / 2 - (chip.y + chip.height / 2))).toBeLessThanOrEqual(1);
});

test('filtri: la riga scorre in orizzontale con la sfumatura e non allarga la pagina', async ({ page }) => {
	await home(page);
	const m = await page.locator('.filters .row').evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, mask: getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage }));
	expect(m.scroll).toBeGreaterThan(m.client);
	expect(m.mask).toContain('linear-gradient');
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
