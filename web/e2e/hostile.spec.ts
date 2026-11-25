import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// Contenuto ostile (seed SEED_XSS: eventi xssUno e xssDue) reso nel browser vero. Parte solo con SEED_XSS=1:
// `npm run test:e2e:hostile` (emulators:exec, si chiude da solo). Senza la variabile i test sono saltati.
test.skip(!process.env.SEED_XSS, 'serve SEED_XSS=1: eventi ostili solo sull’emulatore');

async function spy(page: Page) {
	const problems: string[] = [];
	const dialogs: string[] = [];
	page.on('dialog', async (d) => (dialogs.push(d.message()), await d.dismiss()));
	page.on('console', (m) => /Content Security Policy|violates the following|hydration_mismatch/i.test(m.text()) && problems.push(m.text()));
	page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
	await page.addInitScript(() => {
		// i payload di prova chiamano alert(n): qui nessuno deve arrivare a eseguire codice
		(window as unknown as { __xss?: number[] }).__xss = [];
	});
	return { problems, dialogs };
}

/** Dopo il rendering: nessun elemento iniettato, nessun URL pericoloso negli attributi. */
async function assertClean(page: Page) {
	const bad = await page.evaluate(() => {
		const out: string[] = [];
		for (const s of document.querySelectorAll('script')) {
			const t = s.textContent ?? '';
			// un <script> iniettato conterrebbe il payload come codice; nel payload di idratazione di SvelteKit e nel JSON-LD compare solo dentro stringhe
			if (/^\s*alert\(\d+\)\s*;?\s*$/.test(t)) out.push(`script iniettato: ${t.slice(0, 60)}`);
		}
		if (document.querySelector('img[onerror], svg[onload], [onload], [onerror]')) out.push('attributo on* iniettato');
		for (const el of document.querySelectorAll('[href],[src],[action],[formaction]')) {
			for (const a of ['href', 'src', 'action', 'formaction']) {
				const v = el.getAttribute(a);
				if (v && /^\s*(javascript|data|vbscript):/i.test(v) && !(a === 'src' && /^data:image\//i.test(v))) out.push(`${a}=${v.slice(0, 40)}`);
			}
		}
		for (const a of document.querySelectorAll('a[target="_blank"]')) {
			if (!/noopener/.test(a.getAttribute('rel') ?? '')) out.push(`target=_blank senza noopener: ${a.getAttribute('href')}`);
		}
		const g = window as unknown as { __xss?: number[]; alert: unknown };
		if (typeof g.alert !== 'function') out.push('alert sostituito');
		return out;
	});
	expect(bad).toEqual([]);
}

// Lo slug iniziale non conta: l'evento si risolve dall'id finale (idFromSlug).
const detailPath = async (_page: Page, id: string) => `/eventi/x-${id}`;

test('home e città: titoli ostili come testo, nessun codice eseguito', async ({ page }) => {
	const { problems, dialogs } = await spy(page);
	for (const url of ['/?luogo=modena', '/citta/modena']) {
		await page.goto(url);
		await page.waitForLoadState('networkidle');
		await expect(page.locator('body')).toContainText('Prova');
		// il testo del payload compare letterale, non come elemento
		await expect(page.locator('main img[src="x"]')).toHaveCount(0);
		await assertClean(page);
	}
	expect(dialogs).toEqual([]);
	expect(problems).toEqual([]);
});

test.describe('dettaglio', () => {
	for (const id of ['xssUno', 'xssDue']) {
		test(`evento ${id}: nessun dialog, nessun elemento iniettato, JSON-LD valido`, async ({ page }) => {
			const { problems, dialogs } = await spy(page);
			await page.goto(await detailPath(page, id));
			await page.waitForLoadState('networkidle');
			await expect(page.locator('h1')).toBeVisible();
			await assertClean(page);

			const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
			expect(ld.length).toBeGreaterThan(0);
			for (const t of ld) {
				expect(() => JSON.parse(t)).not.toThrow();
				expect(t).not.toMatch(/<\/script/i);
				expect(t).not.toContain('<!--');
				// i campi che sono URL (url, image, offers.url) non portano schemi pericolosi; l'indirizzo di prova «data:text/html…» è solo testo
				const urls: unknown[] = [];
				JSON.parse(t, (k, v) => (['url', 'image', 'sameAs'].includes(k) && urls.push(v), v));
				for (const u of urls.flat()) expect(String(u)).not.toMatch(/^\s*(javascript|data|vbscript):/i);
			}
			expect(dialogs).toEqual([]);
			expect(problems).toEqual([]);
		});
	}

	test('xssUno: i link ostili (biglietti, fonte) non diventano href pericolosi', async ({ page }) => {
		await spy(page);
		await page.goto(await detailPath(page, 'xssUno'));
		const hrefs = await page.locator('main a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
		expect(hrefs.filter((h) => /^\s*(javascript|data):/i.test(h))).toEqual([]);
		await expect(page.locator('main img[src^="javascript:"]')).toHaveCount(0);
	});

	test('xssDue: il file .ics scaricato non ha righe né eventi iniettati', async ({ page }) => {
		await spy(page);
		await page.goto(await detailPath(page, 'xssDue'));
		const [download] = await Promise.all([
			page.waitForEvent('download'),
			page.getByRole('button', { name: 'Aggiungi al calendario' }).click()
		]);
		const text = readFileSync((await download.path())!, 'utf8');
		const lines = text.split('\r\n').filter(Boolean);
		expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
		expect(lines.filter((l) => l === 'END:VEVENT')).toHaveLength(1);
		expect(lines.some((l) => /^ATTENDEE/i.test(l))).toBe(false);
		expect(lines.some((l) => /^SUMMARY:iniettato/i.test(l))).toBe(false);
	});
});

test('accedi: next ostile non porta fuori dal sito né rompe la pagina', async ({ page }) => {
	const { problems } = await spy(page);
	for (const next of ['/.//evil.com', '/..//evil.com', '//evil.com', 'https://evil.com', 'javascript:alert(1)']) {
		await page.goto(`/accedi?next=${encodeURIComponent(next)}`);
		await expect(page.locator('h1')).toBeVisible();
		expect(new URL(page.url()).origin).toBe('http://localhost:4300');
	}
	expect(problems).toEqual([]);
});
