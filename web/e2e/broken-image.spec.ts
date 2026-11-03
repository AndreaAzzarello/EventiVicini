import { expect, test } from '@playwright/test';

// Niente onerror inline (la CSP lo blocca): un'immagine rotta, anche prima dell'idratazione, ripiega sul motivo di categoria.
test('immagine rotta: la card ripiega sul motivo di categoria, senza violazioni CSP', async ({ page }) => {
	const problems: string[] = [];
	page.on('console', (m) => /Content Security Policy|violates the following|hydration_mismatch/i.test(m.text()) && problems.push(m.text()));
	await page.route('https://example.org/**', (r) => r.abort());
	await page.goto('/?luogo=modena');
	const card = page.locator('article', { hasText: 'Mercato dell’antiquariato' });
	await expect(card).toBeVisible();
	await expect(card.locator('img')).toHaveCount(0);
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
