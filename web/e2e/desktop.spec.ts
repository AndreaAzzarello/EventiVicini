import { expect, test } from '@playwright/test';
import { openMapSheet, openSuggestions, pickFirstEvent, suggestions, suggestionsOnTop } from './helpers';

test('mappa: i pin vicini fanno un cluster numerato e il tocco apre l’anteprima dell’evento', async ({ page }) => {
	await page.goto('/?luogo=modena');
	const { sheet } = await openMapSheet(page);
	await pickFirstEvent(sheet);
	await expect(sheet.getByRole('link', { name: 'Apri scheda' })).toHaveAttribute('href', /\/eventi\//);
});

test('su desktop lista e mappa sono affiancate', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('tab', { name: 'Mappa' })).toBeHidden();
	await expect(page.getByRole('link', { name: 'Jazz in Piazza Grande' })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Mappa degli eventi' })).toBeVisible();
	// Navigazione da tastiera: il primo Tab porta al link "Vai al contenuto".
	await page.keyboard.press('Tab');
	await expect(page.getByRole('link', { name: 'Vai al contenuto' })).toBeFocused();
});

// Il menu dei suggerimenti sta sopra il selettore Lista/Mappa anche da PC: a 1280 e 1920 px il selettore non c'è (≥ 960),
// ma in una finestra stretta (900 px, o zoom/scala di Windows) sì, e lì il difetto era identico a quello del telefono.
for (const [width, height] of [
	[1280, 800],
	[1920, 1080],
	[900, 800]
] as const) {
	test(`suggerimenti della ricerca in primo piano a ${width}×${height}`, async ({ page }) => {
		await page.setViewportSize({ width, height });
		await openSuggestions(page);
		await expect(page.locator('.toolbar')).toBeVisible({ visible: width < 960 });
		const hits = await suggestionsOnTop(page);
		expect(hits.filter((h) => h.checked).length).toBeGreaterThanOrEqual(5);
		expect(hits.filter((h) => !h.ok)).toEqual([]); // al centro di ogni suggerimento c'è il suggerimento
		await page.keyboard.press('ArrowUp'); // dall'ultimo
		const n = await suggestions(page).count();
		await expect(suggestions(page).nth(n - 1)).toHaveAttribute('aria-selected', 'true');
		expect((await suggestionsOnTop(page)).filter((h) => !h.ok)).toEqual([]);
		await page.keyboard.press('Escape');
		await expect(page.locator('.pop')).toBeHidden();
	});
}
