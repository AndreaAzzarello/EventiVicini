import { expect, test, type Page } from '@playwright/test';
import { FIRESTORE, getDocument, signInByEmail, uidOf } from './helpers';

// #32: se la verifica del browser (App Check con Turnstile) fallisce, l'utente legge un messaggio chiaro e non l'errore generico.
// L'emulatore non applica App Check, quindi il test fa due cose:
//  1. forza il fallimento del provider (globalThis.__appCheckFail, presente solo nella build dei test) e blocca Turnstile;
//  2. simula l'enforcement: le scritture su preferiti e segnalazioni senza un token App Check valido ricevono 403. Se il provider
//     fallisce l'SDK manda comunque un token fittizio (con l'errore dentro): per questo si confronta il valore, non la presenza.
// Non prova l'enforcement reale di produzione.

const VERIFY = /Non sono riuscito a verificare il browser/;
const VALID_TOKEN = 'emulator-app-check-token'; // quello di emulatorProvider
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

async function failVerification(page: Page, collection: 'favorites' | 'reports') {
	await page.addInitScript(() => ((globalThis as { __appCheckFail?: boolean }).__appCheckFail = true));
	await page.route('https://challenges.cloudflare.com/**', (r) => r.abort());
	await page.route(/127\.0\.0\.1:8080\/.*:commit/, async (route) => {
		const req = route.request();
		if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
		const writes = (req.postData() ?? '').includes(`/${collection}/`) || (req.postData() ?? '').includes(`/${collection}"`);
		if (writes && req.headers()['x-firebase-appcheck'] !== VALID_TOKEN) {
			return route.fulfill({
				status: 403,
				headers: { ...CORS, 'content-type': 'application/json' },
				body: JSON.stringify({ error: { code: 403, message: 'Missing or insufficient permissions.', status: 'PERMISSION_DENIED' } })
			});
		}
		return route.continue();
	});
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('segnalazione con la verifica fallita: messaggio chiaro nel dialogo, leggibile a 360px', async ({ page }) => {
	await page.setViewportSize({ width: 360, height: 740 });
	await failVerification(page, 'reports');
	await page.goto('/eventi/mercato-dellantiquariato-seedMercato');
	await page.getByRole('button', { name: 'Segnala questo evento' }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Spiegazione').fill('La data indicata non corrisponde a quella pubblicata sul sito del Comune.');
	await dialog.getByRole('button', { name: 'Invia la segnalazione' }).click();
	const alert = dialog.getByRole('alert');
	await expect(alert).toContainText(VERIFY);
	await expect(alert).toContainText('Ricarica la pagina e riprova');
	await expect(alert).not.toContainText(/token|App Check|Turnstile|permission/i); // nessun termine tecnico
	expect(await noOverflow(page)).toBe(true);
	const box = await alert.boundingBox();
	expect(box!.x).toBeGreaterThanOrEqual(0);
	expect(box!.x + box!.width).toBeLessThanOrEqual(360);
	// nulla è stato scritto
	const res = await fetch(`${FIRESTORE}/reports`, { headers: { Authorization: 'Bearer owner' } });
	expect(((await res.json()) as { documents?: unknown[] }).documents ?? []).toHaveLength(0);
});

test('preferito con la verifica fallita: messaggio chiaro annunciato, il preferito non si salva', async ({ page }) => {
	await page.setViewportSize({ width: 360, height: 740 });
	await failVerification(page, 'favorites');
	await signInByEmail(page, 'verifica@example.org', '/');
	const uid = await uidOf(page);
	// sessione sincronizzata (letti i preferiti dell'utente): prima il click andrebbe solo nella copia locale
	const synced = page.waitForResponse((r) => /\/users\/[^/]+:runQuery/.test(r.url()));
	await page.goto('/eventi/mercato-dellantiquariato-seedMercato');
	await synced;
	await expect(page.getByRole('link', { name: 'Account' })).toBeVisible();
	await page.getByRole('button', { name: 'Salva', exact: true }).click();
	const toast = page.getByRole('status').filter({ hasText: VERIFY });
	await expect(toast).toBeVisible();
	await expect(toast).toContainText('Ricarica la pagina e riprova');
	expect(await noOverflow(page)).toBe(true);
	expect(await getDocument(`users/${uid}/favorites/seedMercato`)).toBeNull();
});
