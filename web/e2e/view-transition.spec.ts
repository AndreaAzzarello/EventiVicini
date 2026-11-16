import { expect, test, type Page } from '@playwright/test';

// Passaggio card → dettaglio con le View Transitions (DESIGN.md «Movimento»). Gira sul progetto mobile (Pixel 7, Chromium);
// il blocco desktop cambia solo la finestra. Una spia su document.startViewTransition dice se la transizione è partita
// e quale riquadro portava il nome.
type Spy = { named: number; vt: ViewTransition }[];

async function spy(page: Page) {
	await page.addInitScript(() => {
		const w = window as unknown as { __vt: Spy };
		w.__vt = [];
		const orig = document.startViewTransition?.bind(document);
		if (!orig) return;
		document.startViewTransition = ((cb?: ViewTransitionUpdateCallback) => {
			const named = [...document.querySelectorAll<HTMLElement>('[data-ev-id] .media, [data-ev-id] .stub')].filter((e) => e.style.viewTransitionName === 'ev-media').length;
			const vt = orig(cb);
			w.__vt.push({ named, vt });
			return vt;
		}) as typeof document.startViewTransition;
	});
	return {
		count: () => page.evaluate(() => (window as unknown as { __vt: Spy }).__vt.length),
		first: () => page.evaluate(() => (window as unknown as { __vt: Spy }).__vt[0]?.named ?? -1),
		finished: () => page.evaluate(() => (window as unknown as { __vt: Spy }).__vt[0].vt.finished.then(() => true))
	};
}

async function openFirstCard(page: Page) {
	await page.goto('/?luogo=modena');
	const link = page.locator('article.ev h3 a').first();
	await expect(link).toBeVisible();
	await link.click();
	await page.waitForURL(/\/eventi\//);
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

function cspViolations(page: Page) {
	const out: string[] = [];
	page.on('console', (m) => /Content Security Policy|violates the following/i.test(m.text()) && out.push(m.text()));
	return out;
}

test('card → dettaglio: parte una sola transizione e il riquadro della card porta il nome condiviso', async ({ page }) => {
	const violations = cspViolations(page);
	const s = await spy(page);
	await openFirstCard(page);
	expect(await s.count()).toBe(1);
	expect(await s.first()).toBe(1);
	expect(await s.finished()).toBe(true);
	await expect(page.locator('.hero')).toHaveCSS('view-transition-name', 'ev-media');
	expect(violations).toEqual([]);
});

test('card → dettaglio: il gruppo ev-media si anima e dura al massimo 250 ms', async ({ page }) => {
	await page.goto('/?luogo=modena');
	await page.evaluate(() => {
		const w = window as unknown as { __g: Promise<number | null> };
		const orig = document.startViewTransition.bind(document);
		document.startViewTransition = ((cb?: ViewTransitionUpdateCallback) => {
			const vt = orig(cb);
			w.__g = vt.ready.then(() => {
				const a = document.getAnimations().find((x) => (x.effect as KeyframeEffect | null)?.pseudoElement === '::view-transition-group(ev-media)');
				return a ? Number(a.effect!.getComputedTiming().duration) : null;
			});
			return vt;
		}) as typeof document.startViewTransition;
	});
	await page.locator('article.ev h3 a').first().click();
	await page.waitForURL(/\/eventi\//);
	const duration = await page.evaluate(() => (window as unknown as { __g: Promise<number | null> }).__g);
	expect(duration).not.toBeNull();
	expect(duration!).toBeLessThanOrEqual(250);
});

test('tasto indietro: nessuna nuova transizione, la lista torna', async ({ page }) => {
	const s = await spy(page);
	await openFirstCard(page);
	expect(await s.count()).toBe(1);
	await page.goBack();
	await expect(page.locator('article.ev').first()).toBeVisible();
	expect(await s.count()).toBe(1);
});

test.describe('movimento ridotto', () => {
	test.use({ reducedMotion: 'reduce' });
	test('la navigazione funziona e nessuna transizione parte', async ({ page }) => {
		const s = await spy(page);
		await openFirstCard(page);
		expect(await s.count()).toBe(0);
		await expect(page.locator('.hero')).toBeVisible();
	});
});

test.describe('desktop', () => {
	test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });
	test('card → dettaglio anche con finestra larga', async ({ page }) => {
		const s = await spy(page);
		await openFirstCard(page);
		expect(await s.count()).toBe(1);
		expect(await s.first()).toBe(1);
		expect(await s.finished()).toBe(true);
	});
});

// Fotogrammi di revisione, non fanno parte dei test: REVIEW_MOTION=<cartella> → web/.review/<cartella>/
// La transizione si ferma a istanti precisi (0, 60, 125, 200 ms) con la Web Animations API e si fotografa.
const OUT = process.env.REVIEW_MOTION;
for (const [name, w, h, reduced] of [['mobile-390', 390, 844, false], ['desktop', 1280, 800, false], ['mobile-390-ridotto', 390, 844, true]] as const) {
	test(`fotogrammi: ${name}`, async ({ page }) => {
		test.skip(!OUT, 'impostare REVIEW_MOTION=<cartella>');
		await page.setViewportSize({ width: w, height: h });
		await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
		await page.goto('/?luogo=modena');
		await page.waitForLoadState('networkidle');
		await page.screenshot({ path: `.review/${OUT}/${name}-0-lista.png` });
		await page.evaluate(() => {
			const orig = document.startViewTransition?.bind(document);
			if (!orig) return;
			document.startViewTransition = ((cb?: ViewTransitionUpdateCallback) => {
				const vt = orig(cb);
				(window as unknown as { __ready: Promise<void> }).__ready = vt.ready.then(() => {
					for (const a of document.getAnimations()) if ((a.effect as KeyframeEffect | null)?.pseudoElement?.startsWith('::view-transition')) a.pause();
				});
				return vt;
			}) as typeof document.startViewTransition;
		});
		await page.locator('article.ev h3 a').first().click();
		if (reduced) {
			await page.waitForURL(/\/eventi\//);
			await page.screenshot({ path: `.review/${OUT}/${name}-1-dettaglio.png` });
			return;
		}
		await page.evaluate(() => (window as unknown as { __ready: Promise<void> }).__ready);
		for (const ms of [0, 60, 125, 200]) {
			await page.evaluate((t) => {
				for (const a of document.getAnimations()) if ((a.effect as KeyframeEffect | null)?.pseudoElement?.startsWith('::view-transition')) a.currentTime = t;
			}, ms);
			await page.screenshot({ path: `.review/${OUT}/${name}-${String(ms).padStart(3, '0')}ms.png` });
		}
	});
}
