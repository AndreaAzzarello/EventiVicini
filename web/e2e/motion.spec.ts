import { expect, test, type Page } from '@playwright/test';
import { openMapSheet, pickFirstEvent } from './helpers';

// Micro-movimento (DESIGN.md «Movimento»): battito del preferito, scheda mappa, toast. Ogni caso gira su mobile (Pixel 7) e su
// desktop (come view-transition.spec.ts: stesso progetto, cambia la finestra), con movimento normale e ridotto.
// Le durate si leggono dagli stili calcolati e da una spia su Element.animate (svelte/transition usa la Web Animations API:
// con durata 0 Svelte non crea nessuna animazione).

type Beat = { pressed: string | null; duration: number };

/** Spia: ogni volta che un pulsante .fav prende la classe `beat` registra aria-pressed e la durata calcolata dell'animazione del cuore. */
async function spyBeats(page: Page) {
	await page.addInitScript(() => {
		const w = window as unknown as { __beats: Beat[] };
		w.__beats = [];
		// più mutazioni nello stesso ciclo vedono tutte lo stato finale: si conta un battito per elemento finché la classe resta
		const on = new WeakSet<Element>();
		new MutationObserver((list) => {
			for (const m of list) {
				const el = m.target as HTMLElement;
				if (!el.classList?.contains('fav')) continue;
				if (!el.classList.contains('beat')) on.delete(el);
				else if (!on.has(el)) {
					on.add(el);
					const svg = el.querySelector('svg');
					w.__beats.push({ pressed: el.getAttribute('aria-pressed'), duration: svg ? parseFloat(getComputedStyle(svg).animationDuration) : -1 });
				}
			}
		}).observe(document, { attributes: true, attributeFilter: ['class'], subtree: true });
	});
	return () => page.evaluate(() => (window as unknown as { __beats: Beat[] }).__beats);
}

/** Spia: durate (ms) delle animazioni create per la scheda mappa, in ordine. */
async function spySheet(page: Page) {
	await page.addInitScript(() => {
		const w = window as unknown as { __sheet: number[] };
		w.__sheet = [];
		const orig = Element.prototype.animate;
		Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
			if (this.getAttribute('data-testid') === 'map-sheet') {
				const o = args[1];
				w.__sheet.push(typeof o === 'number' ? o : Number(o?.duration ?? 0));
			}
			return orig.apply(this, args);
		} as typeof orig;
	});
	return () => page.evaluate(() => (window as unknown as { __sheet: number[] }).__sheet);
}

const firstCardHeart = (page: Page) => page.locator('article.ev button.fav').first();

function suite(reduced: boolean) {
	const tiny = (s: number) => (reduced ? expect(s).toBeLessThanOrEqual(0.0001) : expect(s).toBeCloseTo(0.15, 2));

	test.describe('preferito: battito', () => {
		test('parte all’aggiunta, non alla rimozione e non al caricamento', async ({ page }) => {
			const beats = await spyBeats(page);
			await page.goto('/?luogo=modena');
			const heart = firstCardHeart(page);
			await expect(heart).toBeVisible();
			expect(await beats()).toEqual([]);

			await heart.click();
			await expect.poll(async () => (await beats()).length).toBe(1);
			const [b] = await beats();
			expect(b.pressed).toBe('true'); // lo stato annunciato cambia subito, l’animazione non lo ritarda
			tiny(b.duration);
			await expect(heart).not.toHaveClass(/beat/); // la classe esce da sola a fine animazione

			await heart.click();
			await expect(heart).toHaveAttribute('aria-pressed', 'false');
			expect(await beats()).toHaveLength(1);

			// preferito già salvato: dopo un ricaricamento il cuore è pieno e non batte
			await heart.click();
			await expect(heart).toHaveAttribute('aria-pressed', 'true');
			await expect(heart).not.toHaveClass(/beat/);
			await page.reload();
			await expect(firstCardHeart(page)).toHaveAttribute('aria-pressed', 'true');
			expect(await beats()).toEqual([]);
		});

		test('anche nella pagina di dettaglio', async ({ page }) => {
			const beats = await spyBeats(page);
			await page.goto('/?luogo=modena');
			await page.locator('article.ev h3 a').first().click();
			await page.waitForURL(/\/eventi\//);
			const heart = page.locator('button.fav.with-label');
			await expect(heart).toBeVisible();
			expect(await beats()).toEqual([]);
			await heart.click();
			await expect.poll(async () => (await beats()).length).toBe(1);
			tiny((await beats())[0].duration);
			await expect(heart).toHaveAttribute('aria-pressed', 'true');
		});
	});

	test.describe('scheda mappa', () => {
		const focusedMarker = (page: Page) => page.locator('.ev-marker-wrap:focus');

		async function open(page: Page) {
			await page.goto('/?luogo=modena&vista=mappa');
			const { map, sheet } = await openMapSheet(page);
			await pickFirstEvent(sheet);
			return { map, sheet };
		}

		for (const how of ['Chiudi anteprima', 'Esc'] as const) {
			test(`chiusura con ${how}: focus al marker di partenza`, async ({ page }) => {
				const anim = await spySheet(page);
				const { sheet } = await open(page);
				await expect(sheet.getByRole('heading')).toBeFocused();
				if (how === 'Esc') await page.keyboard.press('Escape');
				else await sheet.getByRole('button', { name: how }).click();
				await expect(sheet).toHaveCount(0);
				await expect(focusedMarker(page)).toHaveCount(1);
				// entrata dal token --dur-view (250), uscita da --dur (150); con movimento ridotto nessuna animazione
				const d = await anim();
				expect(d.includes(250)).toBe(!reduced);
				expect(d.includes(150)).toBe(!reduced);
				if (reduced) expect(d).toEqual([]);
			});
		}

		test('tocco sulla mappa: chiude e il focus resta dov’è, senza scroll', async ({ page }) => {
			const { map, sheet } = await open(page);
			// Lo scroll che Playwright fa per rendere raggiungibile il punto (sotto l'header e il selettore sticky) non conta: il hover lo
			// esaurisce prima della misura, così il clic non scrolla più e resta solo l'eventuale scroll della pagina.
			const box = (await map.boundingBox())!;
			const at = { position: { x: box.width / 2, y: 6 } };
			await map.hover(at);
			const y = await page.evaluate(() => window.scrollY);
			await map.click(at);
			await expect(sheet).toHaveCount(0);
			await expect(focusedMarker(page)).toHaveCount(0);
			expect(await page.evaluate(() => window.scrollY)).toBe(y);
		});

		test('«Apri scheda» cambia pagina senza animare l’uscita (|local)', async ({ page }) => {
			const anim = await spySheet(page);
			const { sheet } = await open(page);
			await sheet.getByRole('link', { name: 'Apri scheda' }).click();
			await page.waitForURL(/\/eventi\//);
			await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
			expect((await anim()).includes(150)).toBe(false);
		});
	});

	test.describe('toast', () => {
		test('compare, è annunciato (aria-live) ed entra con la durata del token', async ({ page }) => {
			await page.goto('/?luogo=modena');
			await firstCardHeart(page).click();
			const region = page.locator('.toasts[aria-live="polite"]');
			const toast = region.getByRole('status').filter({ hasText: 'Salvato nei preferiti su questo dispositivo.' });
			await expect(toast).toBeVisible();
			await expect(toast).toHaveText(/Salvato nei preferiti su questo dispositivo\./); // il testo è nel DOM subito: l’annuncio non aspetta l’animazione
			const d = await toast.evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration));
			tiny(d);
			await expect.poll(() => toast.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
		});
	});
}

test.describe('movimento normale', () => {
	suite(false);
	test.describe('desktop', () => {
		test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });
		suite(false);
	});
});

test.describe('movimento ridotto', () => {
	test.use({ reducedMotion: 'reduce' });
	suite(true);
	test.describe('desktop', () => {
		test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });
		suite(true);
	});
});

// Fotogrammi di revisione, non fanno parte dei test: REVIEW_MOTION=<cartella> → web/.review/<cartella>/
// Le animazioni si fermano a istanti precisi con la Web Animations API e si fotografa.
const OUT = process.env.REVIEW_MOTION;
const freeze = (page: Page, t: number) =>
	page.evaluate((ms) => {
		for (const a of document.getAnimations()) {
			a.pause();
			a.currentTime = ms;
		}
	}, t);

for (const [name, w, h, reduced] of [['mobile-390', 390, 844, false], ['desktop', 1280, 800, false], ['mobile-390-ridotto', 390, 844, true]] as const) {
	test(`fotogrammi micro-movimento: ${name}`, async ({ page }) => {
		test.skip(!OUT, 'impostare REVIEW_MOTION=<cartella>');
		await page.setViewportSize({ width: w, height: h });
		await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
		const shot = (n: string) => page.screenshot({ path: `.review/${OUT}/${name}-${n}.png` });

		// A + C: aggiunta di un preferito (battito e toast)
		await page.goto('/?luogo=modena');
		const heart = firstCardHeart(page);
		await expect(heart).toBeVisible();
		await heart.click();
		for (const t of [0, 75]) {
			if (!reduced) await freeze(page, t);
			await shot(`A-C-battito-toast-${t}ms`);
		}

		// B: scheda mappa, entrata e uscita
		await page.goto('/?luogo=modena&vista=mappa');
		const map = page.getByRole('region', { name: 'Mappa degli eventi' });
		const sheet = page.getByTestId('map-sheet');
		await expect(map.locator('.ev-pin, .ev-cluster').first()).toBeVisible();
		for (let i = 0; i < 10 && !(await sheet.count()); i++) {
			const before = await map.getAttribute('data-zoom');
			await map.locator('.ev-cluster, .ev-pin').first().click();
			await expect.poll(async () => (await sheet.count()) > 0 || (await map.getAttribute('data-zoom')) !== before).toBe(true);
		}
		if (!reduced) await freeze(page, 60);
		await shot('B-entrata-60ms');
		await page.evaluate(() => document.getAnimations().forEach((a) => a.finish()));
		await shot('B-aperta');
		await page.keyboard.press('Escape');
		if (!reduced) await freeze(page, 60);
		await shot('B-uscita-60ms');
	});
}
