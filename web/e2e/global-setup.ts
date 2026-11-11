import { execFileSync } from 'node:child_process';
import { AUTH, PROJECT } from './helpers';

// Emulatori puliti e dati di prova a ogni esecuzione.
export default async function globalSetup() {
	await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
	await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
	// SEED_BIG: 60 eventi a Torino (lontana da ogni altro luogo di prova) per le liste lunghe: SSR parziale e paginazione di /citta.
	execFileSync(process.execPath, ['scripts/seed-emulator.mjs'], { stdio: 'inherit', env: { ...process.env, SEED_BIG: '1' } });
}
