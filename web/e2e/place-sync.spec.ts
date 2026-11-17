import { expect, test, type Page } from '@playwright/test';
import { getDocument, signInByEmail, uidOf } from './helpers';

// Luogo scelto, lista e mappa devono muoversi insieme. Il centro si legge dai data-* della mappa.
const BOLOGNA = { lat: 44.4939, lng: 11.3428 };
const BOLZANO = { lat: 46.4983, lng: 11.3548 };
const MODENA = { lat: 44.6471, lng: 10.9252 };
const LECCE = { lat: 40.35, lng: 18.17 };

const searchBox = (page: Page) => page.getByRole('combobox', { name: 'Cerca eventi o luoghi' });
const placeButton = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name}`) });
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

async function showMap(page: Page) {
	const tab = page.getByRole('tab', { name: 'Mappa' });
	if (await tab.isVisible()) await tab.click();
}

async function mapCenter(page: Page) {
	const map = page.getByRole('region', { name: 'Mappa degli eventi' });
	await expect(map).toHaveAttribute('data-lat', /\d/);
	return {
		lat: Number(await map.getAttribute('data-lat')),
		lng: Number(await map.getAttribute('data-lng')),
		zoom: Number(await map.getAttribute('data-zoom'))
	};
}

/** Attende che la mappa si sia centrata sul punto (la fitBounds può animare). */
async function expectCenter(page: Page, p: { lat: number; lng: number }) {
	await expect.poll(async () => Math.abs((await mapCenter(page)).lat - p.lat) + Math.abs((await mapCenter(page)).lng - p.lng), { timeout: 8000 }).toBeLessThan(0.02);
}

async function choose(page: Page, text: string, option: RegExp) {
	await searchBox(page).fill(text);
	await page.getByRole('option', { name: option }).click();
}

test('da loggato, cambiare città sposta lista e mappa (regressione: il profilo ripristinava la zona vecchia)', async ({ page }) => {
	await signInByEmail(page, 'mappa@example.org', '/');
	// Utente che torna: il profilo ha già una zona (Modena, salvata al primo accesso).
	const uid = await uidOf(page);
	await expect.poll(async () => (await getDocument(`users/${uid}`))?.fields.homePlace).toBeTruthy();
	await page.reload();
	await showMap(page);
	await expectCenter(page, MODENA);

	await choose(page, 'bologna', /^Bologna \(BO\)/);
	await expect(placeButton(page, 'Bologna')).toBeVisible();
	await expectCenter(page, BOLOGNA);
	// Resta lì: l'effetto del profilo non deve riportarla a Modena.
	await page.waitForTimeout(1500);
	await expectCenter(page, BOLOGNA);
});

test('scelta dalla ricerca: URL, lista, mappa e salvataggio seguono il luogo', async ({ page }) => {
	await page.goto('/');
	await showMap(page);
	await expectCenter(page, MODENA);

	await choose(page, 'Bozen', /Bolzano/); // il nome bilingue trova il comune
	await expect(page).toHaveURL(/[?&]luogo=bolzano/);
	await expect(placeButton(page, 'Bolzano')).toBeVisible();
	await expect(searchBox(page)).toHaveValue(''); // la ricerca si svuota: non resta un filtro testo
	await expectCenter(page, BOLZANO);
	await page.getByRole('tab', { name: 'Lista' }).click();
	await expect(page.getByRole('link', { name: /Mercatino di Natale/ })).toBeVisible();
	const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ev:place')!));
	expect(saved).toMatchObject({ label: 'Bolzano', slug: 'bolzano' });
});

test('"Usa la mia posizione" vicino a un comune coperto: nell’URL solo lo slug, le coordinate esatte restano nel browser', async ({ page, context }) => {
	await context.grantPermissions(['geolocation']);
	await context.setGeolocation({ latitude: 44.6012, longitude: 10.9045 }); // ~5 km da Modena
	const geocodeCalls: string[] = [];
	await page.route('**/api/geocode**', (route) => (geocodeCalls.push(route.request().url()), route.abort()));
	await page.goto('/');
	await showMap(page);
	await page.getByRole('button', { name: 'Usa la mia posizione' }).click();
	await expect(placeButton(page, 'Vicino a Modena')).toBeVisible();
	await expect(page).toHaveURL(/luogo=modena/);
	expect(page.url()).not.toMatch(/lat=|lng=|nome=|44\.6|10\.9/);
	// La mappa si centra sulla posizione esatta, non sul centro del comune.
	await expectCenter(page, { lat: 44.6012, lng: 10.9045 });
	const c = await mapCenter(page);
	expect(Math.abs(c.lat - 44.6458)).toBeGreaterThan(0.02);
	const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ev:place')!));
	expect(saved).toMatchObject({ lat: 44.6012, lng: 10.9045, slug: 'modena', exact: true });
	expect(geocodeCalls).toEqual([]); // nessuna richiesta di reverse geocoding: le coordinate non escono dal browser

	// Al ritorno la posizione esatta si ripristina, sempre senza coordinate nell’URL.
	await page.goto('/');
	await expect(page).toHaveURL(/luogo=modena/);
	await showMap(page);
	await expectCenter(page, { lat: 44.6012, lng: 10.9045 });
	expect(page.url()).not.toMatch(/lat=|lng=|44\.6|10\.9/);
});

test('"Usa la mia posizione" lontano da ogni comune coperto: nessun parametro nell’URL', async ({ page, context }) => {
	await context.grantPermissions(['geolocation']);
	await context.setGeolocation({ latitude: 41.9, longitude: 12.5 }); // Roma: nessun comune coperto entro 30 km
	await page.goto('/');
	await showMap(page);
	await page.getByRole('button', { name: 'Usa la mia posizione' }).click();
	await expect(placeButton(page, 'La tua posizione')).toBeVisible();
	await expect.poll(() => [...new URL(page.url()).searchParams.keys()].filter((k) => k !== 'vista')).toEqual([]);
	expect(page.url()).not.toMatch(/lat=|lng=|nome=/);
	await expectCenter(page, { lat: 41.9, lng: 12.5 });
	const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ev:place')!));
	expect(saved).toMatchObject({ lat: 41.9, lng: 12.5, exact: true });
	await page.reload();
	await expect(placeButton(page, 'La tua posizione')).toBeVisible();
	await expectCenter(page, { lat: 41.9, lng: 12.5 });
});

test('"Usa la mia posizione" da loggato: nel profilo va il comune, non le coordinate esatte', async ({ page, context }) => {
	await context.grantPermissions(['geolocation']);
	await context.setGeolocation({ latitude: 44.6012, longitude: 10.9045 });
	await signInByEmail(page, 'privacy@example.org', '/');
	const uid = await uidOf(page);
	await expect.poll(async () => (await getDocument(`users/${uid}`))?.fields.homePlace).toBeTruthy();
	await page.getByRole('button', { name: 'Usa la mia posizione' }).click();
	await expect(placeButton(page, 'Vicino a Modena')).toBeVisible();
	await page.waitForTimeout(1500); // il tempo di un eventuale salvataggio sbagliato
	const home = (await getDocument(`users/${uid}`))!.fields.homePlace as { mapValue: { fields: Record<string, Record<string, string | number>> } };
	const f = home.mapValue.fields;
	expect(f.label.stringValue).toBe('Modena');
	expect(Number(f.lat.doubleValue)).toBeCloseTo(44.6458, 4);
	expect(JSON.stringify(home)).not.toContain('44.6012');
});

test('"Usa la mia posizione" senza permesso spiega cosa fare', async ({ page }) => {
	await page.goto('/');
	await page.evaluate(() => {
		navigator.geolocation.getCurrentPosition = (_ok, ko) => ko!({ code: 1, PERMISSION_DENIED: 1 } as GeolocationPositionError);
	});
	await page.getByRole('button', { name: 'Usa la mia posizione' }).click();
	await expect(page.getByText('Permesso negato')).toBeVisible();
	await expect(placeButton(page, 'Modena')).toBeVisible();
});

test('cambiando il raggio la mappa cambia zoom restando centrata', async ({ page }) => {
	await page.goto('/');
	await showMap(page);
	const at25 = await mapCenter(page);
	await page.getByLabel('Distanza massima').selectOption('100');
	await expect.poll(async () => (await mapCenter(page)).zoom).toBeLessThan(at25.zoom);
	await expectCenter(page, MODENA);
	await page.getByLabel('Distanza massima').selectOption('10');
	await expect.poll(async () => (await mapCenter(page)).zoom).toBeGreaterThan(at25.zoom);
	await expect(page).toHaveURL(/r=10/);
});

test('link condiviso con ?luogo= e con coordinate libere', async ({ page }) => {
	await page.goto('/?luogo=bolzano&vista=mappa');
	await expect(placeButton(page, 'Bolzano')).toBeVisible();
	await expect(page.getByRole('tab', { name: 'Mappa' })).toHaveAttribute('aria-selected', 'true');
	await expectCenter(page, BOLZANO);
	// Un link condiviso non cancella la zona salvata di chi lo apre.
	expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ev:place')!).label)).toBe('Modena');

	await page.goto('/?nome=Lecce&lat=40.35&lng=18.17&vista=mappa');
	await expect(placeButton(page, 'Lecce')).toBeVisible();
	await expectCenter(page, LECCE);
	// Valori non validi: non si ricade in silenzio su un altro luogo, si chiede di sceglierlo.
	await page.goto('/?luogo=inesistente&lat=999');
	await expect(page.getByRole('heading', { name: 'Dove cerchi eventi?' })).toBeVisible();
});

test('indietro e avanti riportano luogo, lista e mappa', async ({ page }) => {
	await page.goto('/');
	await showMap(page);
	await choose(page, 'bolzano', /^Bolzano Bozen/);
	await expectCenter(page, BOLZANO);
	await choose(page, 'bologna', /^Bologna \(BO\)/);
	await expectCenter(page, BOLOGNA);

	await page.goBack();
	await expect(placeButton(page, 'Bolzano')).toBeVisible();
	await expectCenter(page, BOLZANO);
	await page.goBack();
	await expect(placeButton(page, 'Modena')).toBeVisible();
	await expectCenter(page, MODENA);
	await page.goForward();
	await expect(placeButton(page, 'Bolzano')).toBeVisible();
	await expectCenter(page, BOLZANO);
});

test('"Vedi sulla mappa" da città e regione apre la home centrata', async ({ page }) => {
	await page.goto('/citta/bolzano');
	await page.getByRole('link', { name: 'Vedi sulla mappa' }).click();
	await expect(page).toHaveURL(/\/\?luogo=bolzano&vista=mappa/);
	await expect(placeButton(page, 'Bolzano')).toBeVisible();
	await expectCenter(page, BOLZANO);

	await page.goto('/regione/emilia-romagna');
	await page.getByRole('link', { name: 'Vedi sulla mappa' }).click();
	await expect(page).toHaveURL(/luogo=emilia-romagna/);
	await expect(placeButton(page, 'Emilia-Romagna')).toBeVisible();
	await expect(page.getByLabel('Distanza massima')).toHaveValue('100');
	await expect(page.getByRole('region', { name: 'Mappa degli eventi' })).toBeVisible();
});

// Nel seed Lecce ha eventi ma non è nel documento coverage (copertura vecchia): il luogo si ricava dagli eventi.
test('?luogo= di una città con eventi ma fuori copertura si risolve dagli eventi, non ricade su Modena', async ({ page }) => {
	await page.goto('/citta/lecce');
	const link = page.getByRole('link', { name: 'Vedi sulla mappa' });
	await expect(link).toHaveAttribute('href', '/?luogo=lecce&vista=mappa');
	await link.click();
	await expect(placeButton(page, 'Lecce')).toBeVisible();
	await expectCenter(page, LECCE);
});

test('?luogo= sconosciuto apre la scelta del luogo con un messaggio, non Modena', async ({ page }) => {
	await page.goto('/?luogo=atlantide');
	await expect(page.getByRole('heading', { name: 'Dove cerchi eventi?' })).toBeVisible();
	await expect(page.getByRole('status').filter({ hasText: 'Non trovo il luogo «atlantide»' })).toBeVisible();
	await expect(page.getByRole('button', { name: /Modena/ })).toHaveCount(0);
});

test('città con eventi ma senza fonte comunale (Cesena, Bozen) è tra i luoghi, senza Nominatim né "Pochi eventi"', async ({ page }) => {
	await page.route('**/api/geocode*', (route) => route.abort()); // se la ricerca cadesse su Nominatim il test fallirebbe
	await page.goto('/');
	await searchBox(page).fill('cesena');
	const option = page.getByRole('option', { name: /^Cesena \(FC\)/ });
	await expect(option).toContainText('1 evento');
	await expect(option).not.toContainText('Pochi eventi');
	await searchBox(page).fill('bozen');
	await expect(page.getByRole('option', { name: /Bolzano/ })).toBeVisible();
	await searchBox(page).fill('cesena');
	await page.getByRole('option', { name: /^Cesena \(FC\)/ }).click();
	await expect(page).toHaveURL(/luogo=cesena/);
	await expect(placeButton(page, 'Cesena')).toBeVisible();
});

test('scegliere una regione allarga il raggio a 100 km', async ({ page }) => {
	await page.goto('/');
	await choose(page, 'trentino', /Trentino-Alto Adige/);
	await expect(page).toHaveURL(/luogo=trentino-alto-adige/);
	await expect(page).toHaveURL(/r=100/);
	await expect(page.getByLabel('Distanza massima')).toHaveValue('100');
});

test('combobox: frecce, Invio, Esc e annunci', async ({ page }) => {
	await page.goto('/');
	const box = searchBox(page);
	await box.fill('bo');
	await expect(box).toHaveAttribute('aria-expanded', 'true');
	await expect(page.getByRole('listbox')).toBeVisible();
	await expect(page.getByRole('status').filter({ hasText: /luoghi/ })).toContainText('6 luoghi');

	await box.press('Escape');
	await expect(box).toHaveAttribute('aria-expanded', 'false');
	await expect(box).toHaveValue('bo'); // Esc chiude soltanto

	await box.press('ArrowDown');
	await expect(box).toHaveAttribute('aria-expanded', 'true');
	await box.press('ArrowDown'); // secondo luogo
	const activeId = await box.getAttribute('aria-activedescendant');
	expect(activeId).toBeTruthy();
	await expect(page.locator(`#${activeId}`)).toHaveAttribute('aria-selected', 'true');
	await box.press('ArrowUp');
	await expect(page.locator(`#${activeId}`)).toHaveAttribute('aria-selected', 'false');
	await box.press('Enter');
	await expect(page).toHaveURL(/luogo=bologna/);
	await expect(placeButton(page, 'Bologna')).toBeVisible();
});

test('un evento tra i suggerimenti porta al dettaglio', async ({ page }) => {
	await page.goto('/');
	await searchBox(page).fill('gnocco');
	await expect(page.getByRole('group', { name: 'Eventi' })).toBeVisible();
	await page.getByRole('option', { name: /Sagra del gnocco fritto/ }).click();
	await expect(page).toHaveURL(/\/eventi\/sagra-del-gnocco-fritto/);
});

test('0 eventi con il nome di un luogo: propone "Vai a" e ci porta', async ({ page }) => {
	await page.goto('/');
	await showMap(page);
	await searchBox(page).fill('Bolzano');
	await searchBox(page).press('Enter');
	await page.getByRole('tab', { name: 'Lista' }).click();
	await expect(page.getByRole('heading', { name: /Nessun evento con «Bolzano» qui vicino/ })).toBeVisible();
	await page.getByRole('button', { name: 'Vai a Bolzano' }).click();
	await expect(page).toHaveURL(/luogo=bolzano/);
	await expect(page).not.toHaveURL(/q=/);
	await expect(placeButton(page, 'Bolzano')).toBeVisible();
	await expect(page.getByRole('link', { name: /Mercatino di Natale/ })).toBeVisible();
});

test('località non coperta: Nominatim, avviso "Pochi eventi" e scelta', async ({ page }) => {
	await page.route('**/api/geocode**', (route) =>
		route.fulfill({
			json: [{ label: 'Torre Chianca, Lecce, Puglia, Italia', lat: 40.3515, lng: 18.175, place: { city: 'Lecce', citySlug: 'lecce', province: 'LE', region: 'Puglia' } }]
		})
	);
	await page.goto('/');
	await searchBox(page).fill('Torre Chianca'); // una frazione: non è un comune, quindi si ripiega su Nominatim
	const option = page.getByRole('option', { name: /Lecce/ });
	await expect(option).toContainText('Pochi eventi in questa zona', { timeout: 8000 });
	await expect(page.getByText('OpenStreetMap / Nominatim')).toBeVisible();
	await option.click();
	await expect(page).toHaveURL(/nome=Lecce&lat=40\.35&lng=18\.18/);
	await expect(placeButton(page, 'Lecce')).toBeVisible();
	await expect(page.getByRole('link', { name: /Festa del barocco leccese/ })).toBeVisible();
});

test.describe('schermo stretto', () => {
	test.use({ viewport: { width: 360, height: 740 } });

	test('360 px: nessuno scroll orizzontale con la ricerca aperta e la riga posizione', async ({ page }) => {
		await page.goto('/');
		await searchBox(page).fill('bo');
		await expect(page.getByRole('listbox')).toBeVisible();
		expect(await noOverflow(page)).toBe(true);
		const box = await page.getByRole('listbox').boundingBox();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.x + box!.width).toBeLessThanOrEqual(360);
		await searchBox(page).press('Escape');
		await expect(page.getByRole('button', { name: 'Usa la mia posizione' })).toBeVisible();
		expect(await noOverflow(page)).toBe(true);
	});

	test('il nome del luogo nella riga sopra la lista apre i suggerimenti', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('.summary')).toContainText(/eventi · entro \d+ km da/);
		await placeButton(page, 'Modena').click();
		await expect(searchBox(page)).toBeFocused();
		await expect(page.getByRole('option', { name: /Modena/ })).toBeVisible(); // i più frequenti, senza scrivere
	});
});
