import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [sveltekit()],
	// Gancio dei test e2e per simulare il fallimento di App Check: solo con E2E_HOOKS=1 (playwright.config.ts), mai nella build normale.
	define: { __E2E_HOOKS__: JSON.stringify(process.env.E2E_HOOKS === '1') },
	test: { include: ['src/**/*.test.ts'] }
});
