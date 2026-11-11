// Processo figlio del bench (vedi cpu-bench.mjs): importa il bundle del Worker, serve una rotta a freddo e poi N volte a caldo.
// Stampa una riga JSON con la CPU (µs, user+system) del freddo (import + init + prima richiesta) e la mediana del caldo.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [bundle, assetsDir, route, warmArg] = process.argv.slice(2);
const warm = Number(warmArg);
const ORIGIN = 'https://bench.invalid';
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css' };

// Cache API finta e sempre vuota: il bench misura il percorso senza hit.
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const env = {
	ASSETS: {
		async fetch(req) {
			const { pathname } = new URL(typeof req === 'string' ? req : req.url);
			try {
				const body = await readFile(join(assetsDir, decodeURIComponent(pathname)));
				const ext = pathname.slice(pathname.lastIndexOf('.'));
				return new Response(body, { headers: { 'content-type': TYPES[ext] ?? 'application/octet-stream' } });
			} catch {
				return new Response('not found', { status: 404 });
			}
		}
	},
	PUBLIC_SITE_URL: ORIGIN,
	PUBLIC_FIREBASE_API_KEY: 'bench',
	PUBLIC_FIREBASE_PROJECT_ID: 'demo-eventi',
	PUBLIC_USE_EMULATORS: 'true',
	FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
	CONTACT_EMAIL: 'bench@example.org',
	CONTROLLER_NAME: 'Bench'
};
globalThis.__benchEnv = env;

const cpu = () => {
	const u = process.cpuUsage();
	return u.user + u.system;
};
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p), passThroughOnException() {} };

async function hit(worker) {
	const res = await worker.fetch(new Request(ORIGIN + route, { redirect: 'manual' }), env, ctx);
	const body = await res.text();
	await Promise.allSettled(pending.splice(0));
	return { status: res.status, body };
}

// process.cpuUsage ha risoluzione di ~15 ms su Windows: per le differenze piccole si usa il tempo di parete, che per codice
// sincrono (import del bundle, SSR) coincide quasi con la CPU. Le rotte con Firestore includono la latenza dell'emulatore.
const now = () => performance.now();
const c0 = cpu();
const t0 = now();
const { default: worker } = await import(pathToFileURL(bundle).href);
const tImport = now() - t0;
const t1 = now();
const first = await hit(worker);
const tFirst = now() - t1;
const cold = cpu() - c0;
const w0 = now();
for (let i = 0; i < warm; i++) await hit(worker);
const warmMs = warm ? (now() - w0) / warm : 0;
console.log(JSON.stringify({ route, status: first.status, import: tImport, first: tFirst, cold, warm: warmMs, bytes: first.body.length, ...(process.env.BENCH_BODY ? { body: first.body } : {}) }));
