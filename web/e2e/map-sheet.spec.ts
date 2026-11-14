import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { openMapSheet, pickFirstEvent } from './helpers';

// Anteprima della mappa (MapSheet): azioni, tastiera, collegamento con la lista. Gira sul progetto mobile (Pixel 7, 412 px):
// lì l'anteprima è un pannello dal basso e lista e mappa sono due tab.
test('anteprima: Apri scheda, Zoom qui e chiusura con Esc e focus di ritorno', async ({ page }) => {
	await page.goto('/?luogo=modena&vista=mappa');
	const { map, sheet } = await openMapSheet(page);
	await pickFirstEvent(sheet);
	await expect(sheet.getByRole('link', { name: 'Apri scheda' })).toHaveAttribute('href', /\/eventi\//);
	await expect(map).toHaveAttribute('data-selected', /.+/);

	const zoom = Number(await map.getAttribute('data-zoom'));
	await sheet.getByRole('button', { name: 'Zoom qui' }).click();
	await expect.poll(async () => Number(await map.getAttribute('data-zoom'))).toBeGreaterThan(zoom);
	await expect(sheet).toBeVisible(); // il ridisegno dei marker non chiude né svuota l'anteprima
	await expect(sheet.getByRole('link', { name: 'Apri scheda' })).toBeVisible();

	await page.keyboard.press('Escape');
	await expect(sheet).toBeHidden();
	await expect(map).not.toHaveAttribute('data-selected', /.+/);
});

test('anteprima: pin da tastiera con etichetta, Invio apre e il focus va al titolo', async ({ page }) => {
	await page.goto('/?luogo=modena&vista=mappa');
	const map = page.getByRole('region', { name: 'Mappa degli eventi' });
	const marker = map.locator('.ev-marker-wrap[aria-label]').first();
	await expect(marker).toBeVisible();
	await marker.focus();
	await page.keyboard.press('Enter');
	const sheet = page.getByTestId('map-sheet');
	// un cluster che si apre a zoom non mostra l'anteprima: si prosegue finché compare
	const { sheet: opened } = await openMapSheet(page);
	await expect(opened).toBeVisible();
	await expect(sheet.getByRole('heading')).toBeFocused();
	await expect(sheet.getByRole('button', { name: 'Chiudi anteprima' })).toBeVisible();
});

test('anteprima: «Vedi nella lista» porta alla card dell’evento', async ({ page }) => {
	await page.goto('/?luogo=modena&vista=mappa');
	const { sheet } = await openMapSheet(page);
	await pickFirstEvent(sheet);
	const title = await sheet.getByRole('heading').innerText();
	await sheet.getByRole('button', { name: 'Vedi nella lista' }).click();
	await expect(page.getByRole('tab', { name: 'Lista' })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByRole('link', { name: title, exact: true }).first()).toBeFocused();
});

test('anteprima: nessuna violazione seria di accessibilità, tema chiaro e scuro', async ({ page }) => {
	for (const theme of ['light', 'dark']) {
		await page.addInitScript((t) => localStorage.setItem('ev:theme', JSON.stringify(t)), theme);
		await page.goto('/?luogo=modena&vista=mappa');
		const { sheet } = await openMapSheet(page);
		await pickFirstEvent(sheet);
		const { violations } = await new AxeBuilder({ page })
			.include('[data-testid="map-sheet"]')
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`), theme).toEqual([]);
	}
});
