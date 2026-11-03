import { expect, test } from '@playwright/test';

test('/citta/<comune> senza eventi porta alla home del luogo; uno slug inventato dà 404', async ({ page }) => {
	await page.goto('/citta/ancona');
	await expect(page).toHaveURL(/\/\?luogo=ancona/);
	const res = await page.goto('/citta/cittainventata');
	expect(res?.status()).toBe(404);
});
