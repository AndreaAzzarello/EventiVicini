import { expect, test } from '@playwright/test';
import { getDocument, signInByEmail, uidOf } from './helpers';

// Primo accesso: nessuna posizione salvata, geolocalizzazione non concessa, schermo da 360 px.
test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 360, height: 740 } });

const noOverflow = (page: import('@playwright/test').Page) =>
	page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('senza posizione si sceglie il luogo dalla ricerca, non si parte da Modena', async ({ page }) => {
	await page.goto('/');
	const first = page.getByRole('region', { name: 'Dove cerchi eventi?' });
	await expect(first).toBeVisible();
	for (const t of ['Eventi pubblici vicino a te', 'senza pubblicità né tracciamento', 'preferiti e aggiungi gli eventi al calendario'])
		await expect(first.getByText(t)).toBeVisible();
	await expect(page.getByRole('dialog')).toHaveCount(0); // niente popup
	expect(await noOverflow(page)).toBe(true);
	const box = await first.boundingBox();
	expect(box!.x).toBeGreaterThanOrEqual(0);
	expect(box!.x + box!.width).toBeLessThanOrEqual(360);
	// La home dietro non mostra gli eventi di Modena come se fossero i suoi.
	await expect(page.getByRole('link', { name: 'Jazz in Piazza Grande' })).toHaveCount(0);

	await first.getByRole('combobox').fill('formig');
	await expect(page.getByRole('option', { name: /Modena/ })).toHaveCount(0);
	await page.getByRole('option', { name: /Formigine/ }).click();

	await expect(first).toBeHidden();
	await expect(page).toHaveURL(/luogo=formigine/);
	await expect(page.getByRole('button', { name: /^Formigine/ })).toBeVisible();
	await expect(page.getByRole('link', { name: /Letture animate/ })).toBeVisible();
	expect(await noOverflow(page)).toBe(true);
	const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ev:place')!));
	expect(saved).toMatchObject({ label: 'Formigine', slug: 'formigine', region: 'Emilia-Romagna' });

	// Al ritorno la scelta resta: niente invito a scegliere.
	await page.goto('/');
	await expect(page.getByRole('button', { name: /^Formigine/ })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Dove cerchi eventi?' })).toBeHidden();
});

test('home senza luogo: il server non sceglie Modena, offre la scelta e i link alle città e regioni con più eventi', async ({ page }) => {
	const html = await (await page.request.get('/')).text();
	expect(html).toContain('Dove cerchi eventi?');
	expect(html).not.toContain('Jazz in Piazza Grande'); // nessun evento di un luogo scelto a caso
	expect(html).toContain('href="/citta/modena"');
	expect(html).toContain('href="/regione/emilia-romagna"');
});

test.describe('senza JavaScript', () => {
	test.use({ javaScriptEnabled: false });
	test('la scelta del luogo e i link a città e regioni ci sono, e portano alle pagine', async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('heading', { name: 'Dove cerchi eventi?' })).toBeVisible();
		await expect(page.getByRole('navigation', { name: 'Oppure sfoglia per luogo' }).getByRole('link', { name: /Modena/ })).toBeVisible();
		await page.getByRole('link', { name: /Emilia-Romagna/ }).click();
		await expect(page).toHaveURL(/\/regione\/emilia-romagna$/);
	});
});

test('con un luogo salvato "/" porta al suo indirizzo senza mostrare la scelta', async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem('ev:place', JSON.stringify({ lat: 44.4939, lng: 11.3428, label: 'Bologna', slug: 'bologna', region: 'Emilia-Romagna' })));
	await page.goto('/');
	await expect(page).toHaveURL(/luogo=bologna/);
	await expect(page.getByRole('region', { name: 'Dove cerchi eventi?' })).toBeHidden();
	await expect(page.getByRole('button', { name: /^Bologna/ })).toBeVisible();
});

test('prima visita: al focus i luoghi più frequenti, e il centro della mappa segue la scelta', async ({ page }) => {
	await page.goto('/');
	await page.getByRole('region', { name: 'Dove cerchi eventi?' }).getByRole('combobox').focus();
	await expect(page.getByRole('option', { name: /Modena/ })).toBeVisible();
	await page.getByRole('option', { name: /^Bologna \(BO\)/ }).click();
	await page.getByRole('tab', { name: 'Mappa' }).click();
	const map = page.getByRole('region', { name: 'Mappa degli eventi' });
	await expect.poll(async () => Number(await map.getAttribute('data-lat'))).toBeCloseTo(44.49, 1);
});

test('pagina regione e breadcrumb della città', async ({ page }) => {
	await page.goto('/regione/emilia-romagna');
	await expect(page.getByRole('heading', { level: 1, name: 'Eventi in Emilia-Romagna' })).toBeVisible();
	await expect(page.getByRole('link', { name: /Modena/ })).toBeVisible();
	expect(await noOverflow(page)).toBe(true);

	// Confronto col mese precedente (seed: 412 contro 374), in testo semplice
	await expect(page.getByText(/^412 eventi (a|ad) \w+ · \+38 rispetto (a|ad) \w+$/)).toBeVisible();

	await page.goto('/regione/lombardia');
	await expect(page.getByText('Como, Lecco')).toBeVisible();
	await expect(page.getByText(/rispetto/)).toHaveCount(0); // nessuna statistica: nessun confronto

	expect((await page.goto('/regione/inesistente'))!.status()).toBe(404);

	await page.goto('/citta/modena');
	await page.getByRole('navigation', { name: 'Percorso' }).getByRole('link', { name: 'Emilia-Romagna' }).click();
	await expect(page).toHaveURL(/\/regione\/emilia-romagna$/);

	const xml = await (await page.request.get('/sitemap.xml')).text();
	expect(xml).toContain('/regione/emilia-romagna');
});

test('la zona scelta va nel profilo al login e si ritrova su un altro dispositivo', async ({ page, browser }) => {
	await page.goto('/');
	await page.getByRole('region', { name: 'Dove cerchi eventi?' }).getByRole('combobox').fill('bologna');
	await page.getByRole('option', { name: /^Bologna \(BO\)/ }).click();

	await signInByEmail(page, 'zona@example.org', '/');
	const uid = await uidOf(page);
	await expect.poll(async () => (await getDocument(`users/${uid}`))?.fields.homePlace).toBeTruthy();
	const stored = (await getDocument(`users/${uid}`))!.fields.homePlace as { mapValue: { fields: Record<string, { stringValue?: string }> } };
	expect(stored.mapValue.fields.label.stringValue).toBe('Bologna');

	// Altro dispositivo: nessun localStorage, stesso account → la zona del profilo, senza dialogo.
	const other = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 360, height: 740 } });
	const page2 = await other.newPage();
	await signInByEmail(page2, 'zona@example.org', '/');
	await expect(page2.getByRole('button', { name: /^Bologna/ })).toBeVisible();
	await expect(page2.getByRole('region', { name: 'Dove cerchi eventi?' })).toBeHidden();
	await other.close();
});
