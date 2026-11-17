import { defineConfig, devices } from '@playwright/test';

// Richiede gli emulatori Firebase attivi (npm run test:e2e li avvia da sé con emulators:exec).
export default defineConfig({
	testDir: 'e2e',
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	expect: { timeout: 10_000 },
	reporter: [['list']],
	globalSetup: './e2e/global-setup.ts',
	use: {
		baseURL: 'http://localhost:4300',
		// Chi ha già scelto la zona: senza, la home apre la scelta regione → comune (vedi first-visit.spec.ts).
		storageState: {
			cookies: [],
			origins: [
				{
					origin: 'http://localhost:4300',
					localStorage: [{ name: 'ev:place', value: JSON.stringify({ lat: 44.6471, lng: 10.9252, label: 'Modena' }) }]
				}
			]
		},
		locale: 'it-IT',
		timezoneId: 'Europe/Rome',
		trace: 'retain-on-failure'
	},
	projects: [
		{ name: 'mobile', use: { ...devices['Pixel 7'] }, testIgnore: /desktop\.spec\.ts/ },
		// Safari su iPhone: solo la home mobile (pulsante flottante, safe area). WebKit di Playwright non simula notch né barra di Safari: env() vale 0.
		{ name: 'iphone', use: { ...devices['iPhone 15'] }, testMatch: /(^|[\\/])home-mobile\.spec\.ts$/ },
		{ name: 'desktop', use: { ...devices['Desktop Chrome'] }, testMatch: /desktop\.spec\.ts/ }
	],
	webServer: {
		command: 'npm run build && npx vite preview --port 4300 --strictPort',
		port: 4300,
		reuseExistingServer: !process.env.CI,
		timeout: 180_000
	}
});
