import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { signInByEmail } from './helpers';

test('l’utente scarica i suoi dati in un file JSON', async ({ page }) => {
	await signInByEmail(page, 'esporta@example.org', '/account');
	// un preferito: compare nell'esportazione
	await page.goto('/eventi/mercato-dellantiquariato-seedMercato');
	await page.getByRole('button', { name: 'Salva', exact: true }).click();
	await page.goto('/account');

	await expect(page.getByRole('heading', { name: 'Scarica i tuoi dati' })).toBeVisible();
	const [download] = await Promise.all([
		page.waitForEvent('download'),
		page.getByRole('button', { name: 'Scarica i miei dati' }).click()
	]);
	expect(download.suggestedFilename()).toMatch(/^eventi-vicini-dati-\d{4}-\d{2}-\d{2}\.json$/);
	const data = JSON.parse(readFileSync((await download.path())!, 'utf8'));

	expect(data.account.email).toBe('esporta@example.org');
	expect(data.account.uid).toEqual(expect.any(String));
	expect(data.profilo).toMatchObject({ pendingCount: 0 });
	expect(typeof data.profilo.createdAt).toBe('string'); // timestamp leggibile, non {seconds, nanoseconds}
	expect(data.proposte).toEqual([]);
	expect(data.preferiti.map((f: { eventId: string }) => f.eventId)).toContain('seedMercato');
	expect(data.suQuestoDispositivo).toHaveProperty('ev:session');
	expect(JSON.stringify(data)).not.toMatch(/idToken|refreshToken|accessToken|apiKey/i);
});
