// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	/** Costante di compilazione (vite.config.ts): vera solo nella build dei test e2e (E2E_HOOKS=1), mai in produzione. */
	const __E2E_HOOKS__: boolean;
	namespace App {
		interface Error {
			message: string;
		}
	}
}

export {};
