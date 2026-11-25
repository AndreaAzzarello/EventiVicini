import { expect, test } from '@playwright/test';

// Niente onerror inline (la CSP lo blocca): un'immagine rotta, anche prima dell'idratazione, ripiega sul motivo di categoria.
test('immagine rotta: la card ripiega sul motivo di categoria, senza violazioni CSP', async ({ page }) => {
	const problems: string[] = [];
	page.on('console', (m) => /Content Security Policy|violates the following|hydration_mismatch/i.test(m.text()) && problems.push(m.text()));
	await page.route('https://example.org/**', (r) => r.abort());
	// Il dato nel seed è http://example.org/immagine-rotta.jpg: il sito deve chiedere l'https (mai l'http) e poi ripiegare.
	const asked: string[] = [];
	page.on('request', (r) => r.url().includes('immagine-rotta') && asked.push(r.url()));
	await page.goto('/?luogo=modena');
	const card = page.locator('article', { hasText: 'Mercato dell’antiquariato' });
	await expect(card).toBeVisible();
	await expect(card.locator('img')).toHaveCount(0);
	expect(asked.length).toBeGreaterThan(0);
	expect(asked.every((u) => u.startsWith('https://example.org/'))).toBe(true);
	expect(problems).toEqual([]);
});

test('dettaglio evento: nessun hydration_mismatch né violazione CSP', async ({ page }) => {
	const problems: string[] = [];
	page.on('console', (m) => /Content Security Policy|violates the following|hydration_mismatch/i.test(m.text()) && problems.push(m.text()));
	await page.goto('/eventi/jazz-in-piazza-grande-seedJazz');
	await page.waitForLoadState('networkidle');
	await expect(page.getByRole('button', { name: 'Segnala questo evento' })).toBeVisible();
	expect(problems).toEqual([]);
});

// Ripiego a due livelli, a 360 px e DPR 2: la variante piccola (scala Plone senza hash) risponde 404 → si torna all'originale;
// se anche l'originale fallisce → motivo di categoria. Mai un'immagine rotta né richieste in loop.
test.describe('variante piccola non disponibile', () => {
	test.use({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2 });

	const ORIGINAL = /example\.org\/ev\/jazz\/@@images\/image-800-[0-9a-f]{32}\.png$/;
	const VARIANT = /example\.org\/ev\/jazz\/@@images\/image\/\w+$/;
	// PNG 800×496 tinta unita: con un'immagine di 1 px il naturalWidth corretto dalla densità (srcset con descrittori w) arrotonda a 0
	const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAyAAAAHwCAIAAADRs5w5AAAHUElEQVR42u3WMQ0AAAzDsEIr/MEaiR07LBlBrmRaAAAORQIAAIMFAGCwAAAMFgAABgsAwGABABgsAAAMFgCAwQIAMFgAABgsAACDBQBgsAAADBYAAAYLAMBgAQAYLAAADBYAgMECADBYAAAYLAAAgwUAYLAAADBYAAAGCwDAYAEAGCwAAAwWAIDBAgAwWAAAGCwAAIMFAGCwAAAwWAAABgsAwGABAGCwAAAMFgCAwQIAMFgAABgsAACDBQBgsAAAMFgAAAYLAMBgAQBgsAAADBYAgMECAMBgAQAYLAAAgwUAYLAAADBYAAAGCwDAYAEAYLAAAAwWAIDBAgDAYAEAGCwAAIMFAGCwAAAwWAAABgsAwGABAGCwAAAMFgCAwQIAwGABABgsAACDBQCAwQIAMFgAAAYLAMBgAQBgsAAADBYAgMECAMBgAQAYLAAAgwUAgMECADBYAAAGCwAAgwUAYLAAAAwWAIDBAgDAYAEAGCwAAIMFAIDBAgAwWAAABgsAAIMFAGCwAAAMFgAABgsAwGABABgsAACDBQCAwQIAMFgAAAYLAACDBQBgsAAADBYAAAYLAMBgAQAYLAAAgwUAgMECADBYAAAGCwAAgwUAYLAAAAwWAAAGCwDAYAEAGCwAAAwWAIDBAgAwWAAABgsAAIMFAGCwAAAMFgAABgsAwGABABgsAAAMFgCAwQIAMFgAABgsAACDBQBgsAAADBYAAAYLAMBgAQAYLAAADBYAgMECADBYAAAYLAAAgwUAYLAAADBYAAAGCwDAYAEAGCwAAAwWAIDBAgAwWAAAGCwAAIMFAGCwAAAwWAAABgsAwGABABgsFQAADBYAgMECADBYAAAYLAAAgwUAYLAAADBYAAAGCwDAYAEAYLAAAAwWAIDBAgAwWAAAGCwAAIMFAGCwAAAwWAAABgsAwGABAGCwAAAMFgCAwQIAwGABABgsAACDBQBgsAAAMFgAAAYLAMBgAQBgsAAADBYAgMECAMBgAQAYLAAAgwUAgMECADBYAAAGCwDAYAEAYLAAAAwWAIDBAgDAYAEAGCwAAIMFAIDBAgAwWAAABgsAwGCpAABgsAAADBYAgMECAMBgAQAYLAAAgwUAgMECADBYAAAGCwAAgwUAYLAAAAwWAIDBAgDAYAEAGCwAAIMFAIDBAgAwWAAABgsAAIMFAGCwAAAMFgAABgsAwGABABgsAACDBQCAwQIAMFgAAAYLAACDBQBgsAAADBYAAAYLAMBgAQAYLAAADBYAgMECADBYAAAGCwAAgwUAYLAAAAwWAAAGCwDAYAEAGCwAAAwWAIDBAgAwWAAABksCAACDBQBgsAAADBYAAAYLAMBgAQAYLAAADBYAgMECADBYAAAYLAAAgwUAYLAAAAwWAAAGCwDAYAEAGCwAAAwWAIDBAgAwWAAAGCwAAIMFAGCwAAAwWAAABgsAwGABABgsAAAMFgCAwQIAMFgAABgsAACDBQBgsAAAMFgAAAYLAMBgAQBgsAAADBYAgMECADBYAAAYLAAAgwUAYLAAADBYAAAGCwDAYAEAYLAAAAwWAIDBAgDAYAEAGCwAAIMFAGCwAAAwWAAABgsAwGABAGCwAAAMFgCAwQIAwGABABgsAACDBQBgsAAAMFgAAAYLAMBgAQBgsAAADBYAgMECAMBgAQAYLAAAgwUAgMECADBYAAAGCwDAYAEAYLAAAAwWAIDBAgDAYAEAGCwAAIMFAIDBAgAwWAAABgsAAIMFAGCwAAAMFgCAwQIAwGABABgsAACDBQCAwQIAMFgAAAYLAACDBQBgsAAADBYAAAYLAMBgAQAYLAAAgwUAgMECADBYAAAGCwAAgwUAYLAAAAwWAAAGCwDAYAEAGCwAAIMFAIDBAgAwWAAABgsAAIMFAGCwAAAMFgAABgsAwGABABgsAAAMFgCAwQIAMFgAAAYLAACDBQBgsAAADBYAAAYLAMBgAQAYLAAADBYAgMECADBYAAAYLAAAgwUAYLAAAAwWAAAGCwDAYAEAGCwAAAwWAIDBAgAwWAAAGCwAAIMFAGCwAAAwWAAABgsAwGABABgsAAAMFgCAwQIAMFgAABgsAACDBQBgsAAAMFgAAAYLAMBgAQAYLBUAAAwWAIDBAgAwWAAAGCwAAIMFAGCwAAAwWAAABgsAwGABAGCwAAAMFgCAwQIAMFgAABgsAACDBQBgsAAAMFgAAAYLAMBgAQBgsAAADBYAgMECAMBgAQAYLAAAgwUAYLAAADBYAAAGCwDAYAEAYLAAAAwWAIDBAgDAYAEAGCwAAIMFAIDBAgAwWAAABgsAwGABAGCwAAAMFgCAwQIAwGABABgsAACDBQCAwQIAMFgAAAYLAMBgqQAAYLAAAAwWAIDBAgDAYAEAGCwAAIMFAIDBAgAwWAAABgsAAIMFAGCwAAAMFgCAwQIAwGABABgsAACDBQCAwQIAMFgAAAYLAACDBQBgsAAADBYAAAYLAMBgAQAYLAAAgwUAgMECAPhnATA2ZF/R33SKAAAAAElFTkSuQmCC', 'base64');

	test('card e hero tornano all’originale, una sola richiesta ciascuno', async ({ page }) => {
		let originals = 0;
		let variants = 0;
		await page.route(VARIANT, (r) => (variants++, r.fulfill({ status: 404 })));
		await page.route(ORIGINAL, (r) => (originals++, r.fulfill({ status: 200, contentType: 'image/png', body: PNG })));

		await page.goto('/?luogo=modena');
		const card = page.locator('article', { hasText: 'Jazz in Piazza Grande' });
		const thumb = card.locator('img');
		await expect(thumb).toHaveAttribute('src', /image-800-0123456789abcdef0123456789abcdef\.png$/);
		await expect.poll(() => thumb.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
		expect(await thumb.getAttribute('srcset')).toBeNull();
		expect(variants).toBeGreaterThan(0);

		originals = 0;
		await page.goto('/eventi/jazz-in-piazza-grande-seedJazz');
		const hero = page.locator('.hero img');
		await expect(hero).toHaveAttribute('src', /image-800-0123456789abcdef0123456789abcdef\.png$/);
		await expect.poll(() => hero.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
		await page.waitForLoadState('networkidle');
		expect(originals).toBeLessThanOrEqual(1);
	});

	test('variante e originale in errore: motivo di categoria, nessun loop', async ({ page }) => {
		const problems: string[] = [];
		page.on('console', (m) => /Content Security Policy|violates the following|hydration_mismatch/i.test(m.text()) && problems.push(m.text()));
		let requests = 0;
		await page.route(/example\.org\/ev\//, (r) => (requests++, r.fulfill({ status: 404 })));

		await page.goto('/?luogo=modena');
		const card = page.locator('article', { hasText: 'Jazz in Piazza Grande' });
		await expect(card).toBeVisible();
		await expect(card.locator('img')).toHaveCount(0);
		await page.goto('/eventi/jazz-in-piazza-grande-seedJazz');
		await expect(page.locator('.hero img')).toHaveCount(0);
		await expect(page.locator('.hero svg').first()).toBeVisible();
		await page.waitForLoadState('networkidle');
		const settled = requests;
		await page.waitForTimeout(500);
		expect(requests).toBe(settled);
		expect(problems).toEqual([]);
	});
});
