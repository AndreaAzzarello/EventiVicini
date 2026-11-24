import { expect, type Page } from '@playwright/test';

export const PROJECT = 'demo-eventi';
export const AUTH = 'http://127.0.0.1:9099';
export const FIRESTORE = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`;

/** Accesso reale col link via email, leggendo il codice dall'emulatore Auth. */
export async function signInByEmail(page: Page, email: string, next = '/') {
	await page.goto(`/accedi?next=${encodeURIComponent(next)}`);
	await page.getByLabel('Ricevi un link via email').fill(email);
	await page.getByRole('button', { name: 'Mandami il link' }).click();
	await expect(page.getByText('Controlla la posta.')).toBeVisible();
	const link = await latestLink(email);
	await page.goto(link);
	await page.waitForURL((u) => u.pathname === next || u.pathname === new URL(next, 'http://x').pathname);
}

export async function latestLink(email: string) {
	const res = await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/oobCodes`);
	const { oobCodes } = (await res.json()) as {
		oobCodes: { email: string; requestType: string; oobCode: string; oobLink: string }[];
	};
	const code = oobCodes.filter((c) => c.email === email && c.requestType === 'EMAIL_SIGNIN').at(-1);
	if (!code) throw new Error(`nessun link per ${email}`);
	const continueUrl = new URL(code.oobLink).searchParams.get('continueUrl')!;
	const u = new URL(continueUrl);
	u.searchParams.set('mode', 'signIn');
	u.searchParams.set('oobCode', code.oobCode);
	u.searchParams.set('apiKey', 'demo-key');
	return u.href;
}

export async function accountExists(email: string) {
	const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:query`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', Authorization: 'Bearer owner' },
		body: JSON.stringify({ returnUserInfo: true })
	});
	const body = (await res.json()) as { userInfo?: { email: string }[] };
	return (body.userInfo ?? []).some((u) => u.email === email);
}

export async function getDocument(path: string) {
	const res = await fetch(`${FIRESTORE}/${path}`, { headers: { Authorization: 'Bearer owner' } });
	return res.status === 404 ? null : ((await res.json()) as { fields: Record<string, Record<string, unknown>> });
}

/** Scrive campi di un documento dall'esterno delle regole (emulatore, come amministratore): serve a preparare uno stato di partenza. */
export async function patchDocument(path: string, fields: Record<string, Record<string, unknown>>) {
	const mask = Object.keys(fields).map((k) => `updateMask.fieldPaths=${k}`).join('&');
	const res = await fetch(`${FIRESTORE}/${path}?${mask}`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json', Authorization: 'Bearer owner' },
		body: JSON.stringify({ fields })
	});
	if (!res.ok) throw new Error(`PATCH ${path}: ${res.status}`);
}

/** Il geocoding passa da /api/geocode: nei test risponde una fixture, Nominatim non viene mai chiamato. */
export async function mockGeocode(page: Page) {
	await page.route('**/api/geocode**', (route) => {
		const url = new URL(route.request().url());
		const place = { city: 'Modena', citySlug: 'modena', province: 'MO', region: 'Emilia-Romagna' };
		if (url.searchParams.has('lat'))
			return route.fulfill({ json: [{ label: 'Modena', lat: Number(url.searchParams.get('lat')), lng: Number(url.searchParams.get('lng')), place }] });
		return route.fulfill({ json: [{ label: 'Via Emilia Centro 100, Modena', lat: 44.6466, lng: 10.9262, place }] });
	});
}

export async function uidOf(page: import('@playwright/test').Page): Promise<string> {
	return page.evaluate(async () => {
		const req = indexedDB.open('firebaseLocalStorageDb');
		const db: IDBDatabase = await new Promise((ok, ko) => ((req.onsuccess = () => ok(req.result)), (req.onerror = ko)));
		const all: { value: { uid: string } }[] = await new Promise((ok) => {
			const r = db.transaction('firebaseLocalStorage').objectStore('firebaseLocalStorage').getAll();
			r.onsuccess = () => ok(r.result);
		});
		return all.find((x) => x.value?.uid)!.value.uid;
	});
}

/**
 * Apre l'anteprima della mappa scendendo nei cluster (zoom sui loro confini, oppure elenco se gli eventi hanno lo stesso
 * indirizzo). Nessuna attesa a tempo: dopo ogni clic si aspetta che l'anteprima compaia o che la vista (data-*) cambi.
 */
export async function openMapSheet(page: Page) {
	const map = page.getByRole('region', { name: 'Mappa degli eventi' });
	const sheet = page.getByTestId('map-sheet');
	await expect(map.locator('.ev-pin, .ev-cluster').first()).toBeVisible();
	const viewOf = async () => [await map.getAttribute('data-lat'), await map.getAttribute('data-lng'), await map.getAttribute('data-zoom')].join(',');
	for (let i = 0; i < 10 && !(await sheet.isVisible()); i++) {
		const before = await viewOf();
		await map.locator('.ev-cluster, .ev-pin').first().click();
		await expect.poll(async () => (await sheet.isVisible()) || (await viewOf()) !== before).toBe(true);
	}
	await expect(sheet).toBeVisible();
	return { map, sheet };
}

/** Se l'anteprima mostra l'elenco di un luogo, sceglie il primo evento. */
export async function pickFirstEvent(sheet: ReturnType<Page['getByTestId']>) {
	const first = sheet.locator('.pick button').first();
	if (await first.isVisible()) await first.click();
	await expect(sheet.getByRole('link', { name: 'Apri scheda' })).toBeVisible();
}

/** Home con la ricerca aperta su `text`: aspetta che compaiano i suggerimenti. */
export async function openSuggestions(page: Page, text = 'civ') {
	await page.goto('/?luogo=modena');
	await page.waitForLoadState('networkidle');
	const q = page.locator('#q');
	await q.click();
	await q.pressSequentially(text, { delay: 30 });
	await expect(suggestions(page).first()).toBeVisible();
}

/** I suggerimenti della ricerca (non le <option> del select della distanza). */
export const suggestions = (page: Page) => page.getByRole('listbox', { name: 'Suggerimenti' }).getByRole('option');

/**
 * Per ogni suggerimento il cui centro sta dentro il menu e nell'area visibile (sopra la tastiera, se simulata):
 * l'elemento in primo piano in quel punto deve essere il suggerimento stesso, non il selettore sticky né altro.
 */
export function suggestionsOnTop(page: Page) {
	return page.evaluate(() => {
		const vv = window.visualViewport!;
		const bottom = vv.offsetTop + vv.height;
		const pop = document.querySelector<HTMLElement>('.pop:not([hidden])')!.getBoundingClientRect();
		return [...document.querySelectorAll<HTMLElement>('[role=option]')]
			.filter((o) => o.offsetParent)
			.map((o) => {
				const r = o.getBoundingClientRect();
				const x = r.left + r.width / 2;
				const y = r.top + r.height / 2;
				const checked = y >= Math.max(0, pop.top) && y <= Math.min(bottom, pop.bottom);
				const el = checked ? document.elementFromPoint(x, y) : null;
				return { name: (o.textContent ?? '').trim().slice(0, 30), checked, ok: !checked || (!!el && o.contains(el)), covered: el && !o.contains(el) ? `${el.tagName}.${el.className}` : '' };
			});
	});
}
