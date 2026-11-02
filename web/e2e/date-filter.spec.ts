import { expect, test, type Page } from '@playwright/test';

// Il seed è relativo a oggi: Mercato domani, Letture animate (Formigine) dopodomani, Sagra tra 3 giorni.
const MERCATO = 'Mercato dell’antiquariato';
const SAGRA = 'Sagra del gnocco fritto';

/** "AAAA-MM-GG" di oggi + n giorni, nel calendario di Roma. */
function dayPlus(n: number) {
	const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date()).split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const noOverflow = (page: Page) =>
	page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('chip Domani: filtra la lista e vive nell’URL', async ({ page }) => {
	await page.goto('/?luogo=modena');
	await expect(page.getByRole('link', { name: SAGRA })).toBeVisible();
	const chip = page.getByRole('button', { name: 'Domani', exact: true });
	await chip.click();
	await expect(chip).toHaveAttribute('aria-pressed', 'true');
	await expect(page).toHaveURL(/quando=domani/);
	await expect(page.getByRole('link', { name: MERCATO })).toBeVisible();
	await expect(page.getByRole('link', { name: SAGRA })).toHaveCount(0);
	// niente chip "in corso": è già una sezione della lista
	await expect(page.getByRole('button', { name: /Mostre ed eventi in corso/ })).toHaveCount(0);
	// un secondo tocco toglie il filtro
	await chip.click();
	await expect(page).not.toHaveURL(/quando=/);
	await expect(page.getByRole('link', { name: SAGRA })).toBeVisible();
});

test('i vecchi link ?quando=weekend e ?inCorso=1 non si rompono', async ({ page }) => {
	await page.goto('/?luogo=modena&quando=weekend&inCorso=1');
	await expect(page.getByRole('button', { name: 'Weekend', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('Scegli date: periodo con selettori nativi, URL condivisibile, combinato con Gratis', async ({ page }) => {
	await page.goto('/?luogo=modena');
	await page.getByRole('button', { name: 'Scegli date' }).click();
	const dialog = page.getByRole('dialog', { name: 'Scegli le date' });
	await expect(dialog).toBeVisible();
	expect(await noOverflow(page)).toBe(true);
	// limiti del selettore: da oggi a 60 giorni
	await expect(dialog.getByLabel('Dal', { exact: true })).toHaveAttribute('min', dayPlus(0));
	await expect(dialog.getByLabel('Dal', { exact: true })).toHaveAttribute('max', dayPlus(60));
	await dialog.getByLabel('Dal', { exact: true }).fill(dayPlus(3));
	await dialog.getByRole('button', { name: 'Applica' }).click();
	await expect(dialog).toBeHidden();

	await expect(page).toHaveURL(new RegExp(`dal=${dayPlus(3)}`));
	await expect(page.getByRole('link', { name: SAGRA })).toBeVisible();
	await expect(page.getByRole('link', { name: MERCATO })).toHaveCount(0);
	await expect(page.getByRole('button', { name: /^\d+ \w+/ })).toHaveAttribute('aria-pressed', 'true');

	// l'URL basta a ritrovare lo stesso filtro, anche con ricarica
	await page.reload();
	await expect(page.getByRole('link', { name: SAGRA })).toBeVisible();
	await expect(page.getByRole('link', { name: MERCATO })).toHaveCount(0);

	// si combina con gli altri filtri
	await page.getByRole('button', { name: 'Gratis', exact: true }).click();
	await expect(page).toHaveURL(/dal=.*gratis=1|gratis=1.*dal=/);
	await expect(page.getByRole('link', { name: SAGRA })).toHaveCount(0); // la sagra non è gratis
});

test('un periodo include gli eventi in corso che si sovrappongono', async ({ page }) => {
	// La mostra di Bologna dura fino a tra 20 giorni: compare in ogni periodo che la tocca.
	await page.goto(`/?luogo=bologna&dal=${dayPlus(10)}&al=${dayPlus(12)}`);
	await expect(page.getByRole('link', { name: /Mostra: la Bologna dei portici/ })).toBeVisible();
	await page.goto(`/?luogo=bologna&dal=${dayPlus(30)}&al=${dayPlus(32)}`);
	await expect(page.getByRole('link', { name: /Mostra: la Bologna dei portici/ })).toHaveCount(0);
});

test('la mappa usa lo stesso filtro', async ({ page }) => {
	await page.goto(`/?luogo=modena&vista=mappa&dal=${dayPlus(3)}`);
	await expect(page.getByRole('button', { name: /^\d+ \w+/ })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.locator('.leaflet-marker-icon').first()).toBeVisible();
});

test('pagina città: stessi filtri, senza il raggio, nell’URL', async ({ page }) => {
	await page.goto('/citta/modena');
	await expect(page.getByRole('combobox', { name: 'Distanza massima' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Domani', exact: true }).click();
	await expect(page).toHaveURL(/\/citta\/modena\?quando=domani/);
	await expect(page.getByRole('link', { name: MERCATO })).toBeVisible();
	await expect(page.getByRole('link', { name: /Vedi sulla mappa/ })).toHaveAttribute('href', /vista=mappa.*quando=domani/);
	await page.goto(`/citta/modena?dal=${dayPlus(40)}`);
	await expect(page.getByRole('heading', { name: 'Niente con questi filtri' })).toBeVisible();
	await page.getByRole('button', { name: 'Azzera i filtri' }).click();
	await expect(page.getByRole('link', { name: MERCATO })).toBeVisible();
});

for (const width of [360, 390]) {
	test(`nessuno scroll orizzontale a ${width}px con barra e selettore`, async ({ page }) => {
		await page.setViewportSize({ width, height: 740 });
		for (const path of ['/?luogo=modena', `/?luogo=modena&dal=${dayPlus(2)}&al=${dayPlus(5)}`, '/citta/modena']) {
			await page.goto(path);
			await expect(page.getByRole('button', { name: 'Domani', exact: true })).toBeVisible();
			expect(await noOverflow(page), path).toBe(true);
		}
		await page.getByRole('button', { name: /Scegli date|^\d+ \w+/ }).first().click();
		const box = await page.getByRole('dialog', { name: 'Scegli le date' }).boundingBox();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.x + box!.width).toBeLessThanOrEqual(width);
		expect(await noOverflow(page)).toBe(true);
	});
}
