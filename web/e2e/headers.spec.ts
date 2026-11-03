import { expect, test } from '@playwright/test';

// La CSP non deve bloccare nulla di ciò che il sito usa; qui si guardano le pagine che caricano script e mappe.
// Solo pagine del Worker: gli asset statici (/offline) prendono _headers da Cloudflare, che l'anteprima locale non applica.
const PAGES = ['/', '/accedi', '/proponi', '/privacy', '/cookie'];

for (const path of PAGES) {
	test(`${path}: intestazioni di sicurezza e nessuna violazione CSP`, async ({ page }) => {
		const violations: string[] = [];
		// gen_204 è il ping di telemetria di gapi (apis.google.com): compare in circa 1 caricamento su 40, il login non ne dipende
		// e non vale una voce in connect-src. Ogni altra violazione fa fallire il test.
		page.on('console', (m) => /Content Security Policy|violates the following/i.test(m.text()) && !m.text().includes('apis.google.com/js/gen_204') && violations.push(m.text()));
		const res = await page.goto(path);
		await page.waitForLoadState('networkidle');
		const h = res!.headers();
		expect(h['x-content-type-options']).toBe('nosniff');
		expect(h['x-frame-options']).toBe('DENY');
		expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
		expect(h['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
		expect(h['content-security-policy'] ?? (await page.locator('meta[http-equiv="content-security-policy"]').count() ? 'meta' : '')).toBeTruthy();
		expect(violations).toEqual([]);
	});
}

test('lo script del tema in app.html gira nonostante la CSP', async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem('ev:theme', '"dark"'));
	await page.goto('/privacy');
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
