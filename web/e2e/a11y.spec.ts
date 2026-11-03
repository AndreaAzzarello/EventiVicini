import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { signInByEmail } from './helpers';

// Accessibilità WCAG 2.1 AA: nessuna violazione seria o critica. Il contrasto dei colori lo controlla già design.test.ts
// (axe lo stima sul rendering e sulle tile della mappa darebbe falsi positivi).
async function violations(page: Page) {
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.disableRules(['color-contrast'])
		.analyze();
	return violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}

const PAGES: [string, string][] = [
	['home', '/?luogo=modena'],
	['home con filtro data', '/?luogo=modena&dal=2099-01-01'],
	['mappa', '/?luogo=modena&vista=mappa'],
	['città', '/citta/modena'],
	['regione', '/regione/emilia-romagna'],
	['evento', '/eventi/jazz-in-piazza-grande-seedJazz'],
	['accedi', '/accedi'],
	['privacy', '/privacy'],
	['cookie', '/cookie'],
	['termini', '/termini']
];

for (const [name, path] of PAGES) {
	test(`a11y: ${name}`, async ({ page }) => {
		await page.goto(path);
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
		expect(await violations(page)).toEqual([]);
	});
}

test('a11y: prima visita (nessun luogo salvato)', async ({ browser }) => {
	const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const page = await ctx.newPage();
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Dove cerchi eventi?' })).toBeVisible();
	expect(await violations(page)).toEqual([]);
	await ctx.close();
});

test('a11y: selettore delle date e modulo di segnalazione, aperti', async ({ page }) => {
	await page.goto('/?luogo=modena');
	await page.getByRole('button', { name: 'Scegli date' }).click();
	await expect(page.getByRole('dialog', { name: 'Scegli le date' })).toBeVisible();
	expect(await violations(page)).toEqual([]);

	await page.goto('/eventi/jazz-in-piazza-grande-seedJazz');
	await page.getByRole('button', { name: 'Segnala questo evento' }).click();
	await expect(page.getByRole('dialog')).toBeVisible();
	expect(await violations(page)).toEqual([]);
});

test('a11y: account e proponi', async ({ page }) => {
	await signInByEmail(page, 'a11y@example.org', '/account');
	await expect(page.getByRole('heading', { name: 'Scarica i tuoi dati' })).toBeVisible();
	expect(await violations(page)).toEqual([]);
	await page.goto('/proponi');
	await expect(page.getByRole('button', { name: 'Invia la proposta' })).toBeVisible();
	expect(await violations(page)).toEqual([]);
});

test('a11y: area segnalazioni (admin)', async ({ page }) => {
	await signInByEmail(page, 'eventivicini.info@gmail.com', '/admin/segnalazioni');
	await expect(page.getByRole('heading', { name: 'Segnalazioni', exact: true })).toBeVisible();
	expect(await violations(page)).toEqual([]);
});
