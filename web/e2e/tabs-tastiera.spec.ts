import { expect, test, type Page } from '@playwright/test';

// #84: selettore Lista/Mappa con il pattern ARIA tabs completo (frecce, Home/Fine, roving tabindex, attivazione al focus).
// Mobile (Pixel 7), iPhone (WebKit) e desktop: il selettore si vede sotto i 960 px, quindi il desktop prova a 900 px e controlla che a 1280 non ci sia.
const tab = (page: Page, name: 'Mappa' | 'Lista') => page.getByRole('tab', { name, exact: true });

async function home(page: Page) {
	await page.goto('/?luogo=modena');
	await expect(page.getByRole('link', { name: 'Jazz in Piazza Grande' })).toBeVisible();
	await page.waitForLoadState('networkidle');
}

async function stato(page: Page, selected: 'Lista' | 'Mappa') {
	const other = selected === 'Lista' ? 'Mappa' : 'Lista';
	await expect(tab(page, selected)).toHaveAttribute('aria-selected', 'true');
	await expect(tab(page, selected)).toHaveAttribute('tabindex', '0');
	await expect(tab(page, other)).toHaveAttribute('aria-selected', 'false');
	await expect(tab(page, other)).toHaveAttribute('tabindex', '-1'); // roving tabindex: un solo tab nella sequenza di Tab
	await expect(tab(page, selected)).toBeFocused();
}

test('da tastiera: frecce, Home e Fine cambiano vista e spostano il focus', async ({ page, isMobile }) => {
	if (!isMobile) await page.setViewportSize({ width: 900, height: 800 });
	await home(page);
	await tab(page, 'Lista').focus();
	await stato(page, 'Lista');

	await page.keyboard.press('ArrowRight');
	await stato(page, 'Mappa');
	await expect(page).toHaveURL(/vista=mappa/);
	await expect(page.locator('.split')).toHaveAttribute('data-view', 'map');
	await expect(page.locator('#panel-map')).toBeVisible();

	await page.keyboard.press('ArrowRight'); // con due tab la freccia torna al primo
	await stato(page, 'Lista');
	await expect(page).not.toHaveURL(/vista=mappa/);

	await page.keyboard.press('ArrowLeft'); // dal primo al secondo
	await stato(page, 'Mappa');
	await page.keyboard.press('ArrowLeft');
	await stato(page, 'Lista');

	await page.keyboard.press('End');
	await stato(page, 'Mappa');
	await page.keyboard.press('End'); // già sull'ultimo: resta
	await stato(page, 'Mappa');
	await page.keyboard.press('Home');
	await stato(page, 'Lista');
	await page.keyboard.press('Home');
	await stato(page, 'Lista');
});

test('Tab entra nel selettore sul tab selezionato ed esce dopo un solo tab', async ({ page, isMobile }) => {
	if (!isMobile) await page.setViewportSize({ width: 900, height: 800 });
	await home(page);
	await tab(page, 'Lista').focus();
	await page.keyboard.press('ArrowRight');
	await stato(page, 'Mappa');
	await page.keyboard.press('Shift+Tab');
	await expect(tab(page, 'Lista')).not.toBeFocused();
	await expect(tab(page, 'Mappa')).not.toBeFocused(); // il tab non selezionato non è nella sequenza
	await page.keyboard.press('Tab');
	await expect(tab(page, 'Mappa')).toBeFocused(); // ritorno: il tab selezionato
});

test('con Alt o Ctrl le frecce restano al browser', async ({ page, isMobile }) => {
	if (!isMobile) await page.setViewportSize({ width: 900, height: 800 });
	await home(page);
	await tab(page, 'Lista').focus();
	await page.keyboard.press('Control+ArrowRight');
	await expect(tab(page, 'Lista')).toHaveAttribute('aria-selected', 'true');
});

test('a 1280 px il selettore non c’è e la lista e la mappa si vedono insieme', async ({ page, isMobile }) => {
	test.skip(isMobile, 'solo desktop');
	await page.setViewportSize({ width: 1280, height: 800 });
	await home(page);
	await expect(page.locator('.toolbar')).toBeHidden();
	await expect(page.locator('#panel-list')).toBeVisible();
	await expect(page.locator('#panel-map')).toBeVisible();
});
