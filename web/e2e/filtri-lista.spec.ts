import { expect, test, type Page } from '@playwright/test';
import { applyFilter, filterFromParams } from '../src/lib/filters';
import { DEFAULT_RADIUS_KM, snapCoord } from '../src/lib/geo';
import type { Event } from '../src/lib/event';

// Lista, riepilogo e mappa usano lo stesso insieme filtrato, al primo caricamento con il filtro nell'URL e dopo un cambio di chip.
// Gira su mobile (Pixel 7, vista Lista) e su desktop (lista e mappa affiancate).

const MODENA = { lat: 44.6471, lng: 10.9252 };

/** "AAAA-MM-GG" di oggi + n giorni, nel calendario di Roma. */
function dayPlus(n: number) {
	const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date()).split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const CASES: { name: string; query: string; chip?: string }[] = [
	{ name: 'Domani', query: 'quando=domani', chip: 'Domani' },
	{ name: 'Weekend', query: 'quando=weekend', chip: 'Weekend' },
	{ name: 'Prossimi 7 giorni', query: 'quando=7giorni', chip: 'Prossimi 7 giorni' },
	{ name: 'Scegli date (fino a 14 giorni)', query: `dal=${dayPlus(2)}&al=${dayPlus(9)}` },
	{ name: 'Scegli date (oltre 14 giorni)', query: `dal=${dayPlus(1)}&al=${dayPlus(20)}` },
	{ name: 'categoria', query: 'cat=music' }
];

/** L'insieme che il codice di filtro dà per questa query, sulla stessa lista che scarica il browser. */
async function expectedIds(page: Page, query: string) {
	const res = await page.request.get(`/api/events?lat=${snapCoord(MODENA.lat)}&lng=${snapCoord(MODENA.lng)}&r=${DEFAULT_RADIUS_KM}`);
	const all = (await res.json()) as Event[];
	const filter = filterFromParams(new URLSearchParams(query));
	return applyFilter(all, filter, Date.now(), MODENA).map((e) => e.id);
}

const LEGACY = ['Prossimi giorni', 'Questo weekend', 'Più avanti'];
const DAY_TITLE = /^(Oggi|Stasera|Domani|(Lunedì|Martedì|Mercoledì|Giovedì|Venerdì|Sabato|Domenica) \d+|Settimana dal \d+ \w+|In corso .+)$/;

async function readList(page: Page) {
	const ids = await page.locator('[data-ev-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-ev-id')!));
	const heads = await page.locator('section.sect > h2').evaluateAll((els) =>
		els.map((h) => ({
			title: (h.childNodes[0].textContent ?? '').trim(),
			count: Number((h.querySelector('.count')?.textContent ?? '0').replace(/\D/g, ''))
		}))
	);
	return { ids, heads };
}

/** Pin e numeri dei cluster della mappa: ogni evento conta una volta. */
async function markerTotal(page: Page) {
	await expect(page.locator('.leaflet-marker-icon').first()).toBeVisible();
	return page.evaluate(() => {
		let n = 0;
		for (const el of document.querySelectorAll('.leaflet-marker-icon')) {
			const cluster = el.querySelector('.ev-cluster');
			n += cluster ? Number((cluster.textContent ?? '0').replace(/\D/g, '')) : el.querySelector('.ev-pin') ? 1 : 0;
		}
		return n;
	});
}

async function check(page: Page, c: { name: string; query: string }, mobile: boolean) {
	const want = await expectedIds(page, c.query);
	expect(want.length, `${c.name}: il seed deve dare almeno un evento`).toBeGreaterThan(0);

	// lista completa scaricata: niente «Carico gli altri eventi»
	await expect(page.getByText('Carico gli altri eventi')).toHaveCount(0);
	await expect(page.locator('[data-ev-id]')).toHaveCount(want.length);
	const { ids, heads } = await readList(page);

	// 1. le card sono tutte e sole l'insieme filtrato
	expect(new Set(ids)).toEqual(new Set(want));
	// 2. riepilogo e conteggi di sezione coincidono con la lista
	const total = want.length;
	await expect(page.locator('.summary')).toContainText(total === 1 ? '1 evento' : new RegExp(`${total.toLocaleString('it-IT')} eventi`));
	expect(heads.reduce((n, h) => n + h.count, 0)).toBe(total);
	// 3. i titoli rispecchiano l'intervallo scelto, non il tempo da adesso
	if (c.query.includes('quando=') || c.query.includes('dal=')) {
		for (const h of heads) {
			expect(LEGACY, `titolo «${h.title}» con «${c.name}»`).not.toContain(h.title);
			expect(h.title).toMatch(DAY_TITLE);
		}
	}
	// 4. la mappa ha gli stessi eventi della lista
	if (mobile) await page.getByRole('tab', { name: 'Mappa' }).click();
	expect(await markerTotal(page)).toBe(total);
	if (mobile) await page.getByRole('tab', { name: 'Lista' }).click();
}

for (const c of CASES) {
	test(`primo caricamento con «${c.name}» nell'URL: lista, riepilogo e mappa coerenti`, async ({ page, isMobile }) => {
		await page.goto(`/?luogo=modena&${c.query}`);
		await check(page, c, !!isMobile);
	});
}

for (const c of CASES.filter((x) => x.chip)) {
	test(`cambio chip «${c.name}» dopo l'idratazione: lista, riepilogo e mappa seguono, il focus resta`, async ({ page, isMobile }) => {
		await page.goto('/?luogo=modena');
		await expect(page.locator('[data-ev-id]').first()).toBeVisible();
		await expect(page.getByText('Carico gli altri eventi')).toHaveCount(0);
		const chip = page.getByRole('button', { name: c.chip!, exact: true });
		await chip.click();
		await expect(chip).toHaveAttribute('aria-pressed', 'true');
		await expect(page).toHaveURL(new RegExp(c.query));
		await expect(chip).toBeFocused(); // il focus non salta al cambio filtro
		await check(page, c, !!isMobile);
		if (isMobile) {
			// il selettore Lista/Mappa resta agganciato
			expect(await page.locator('.toolbar').evaluate((el) => getComputedStyle(el).position)).toBe('sticky');
		}
	});
}

test('il riepilogo (aria-live) segue il filtro', async ({ page }) => {
	await page.goto('/?luogo=modena');
	const summary = page.locator('.summary');
	await expect(summary).toHaveAttribute('aria-live', 'polite');
	const before = await summary.innerText();
	await page.getByRole('button', { name: 'Domani', exact: true }).click();
	const want = await expectedIds(page, 'quando=domani');
	await expect(summary).toContainText(want.length === 1 ? '1 evento' : `${want.length} eventi`);
	expect(want.length === 1 ? '1 evento' : `${want.length} eventi`).not.toBe(before.split(' ·')[0]); // il seed ha più eventi in tutto che domani
});

test('un filtro senza risultati mostra lo stato vuoto e «0 eventi»', async ({ page }) => {
	await page.goto('/?luogo=modena&quando=oggi&q=zzzzqq');
	await expect(page.getByRole('heading', { name: /qui è tranquillo/ })).toBeVisible();
	await expect(page.locator('.summary')).toContainText('0 eventi');
	await expect(page.locator('[data-ev-id]')).toHaveCount(0);
});

test('SSR parziale: la lista del server ha il filtro dell’URL e i titoli giusti', async ({ request }) => {
	const html = await (await request.get('/?luogo=torino&quando=weekend')).text();
	const titles = [...html.matchAll(/<h2 id="sez-[^"]+"[^>]*>([^<]*)/g)].map((m) => m[1].trim());
	expect(titles.length).toBeGreaterThan(0);
	for (const t of titles) {
		expect(LEGACY).not.toContain(t);
		expect(t).toMatch(DAY_TITLE);
	}
});
