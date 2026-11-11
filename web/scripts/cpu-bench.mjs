// Bench della CPU per rotta, riproducibile in locale (#44). Stima RELATIVA: gira su Node, non su workerd, quindi serve a confrontare
// un commit con l'altro, non a prevedere i millisecondi di Cloudflare. Usa la build (`npm run build`) e gli emulatori:
//   npm run bench:cpu          (emulators:exec avvia gli emulatori, semina i dati e chiude da solo)
// Freddo = processo nuovo: import del bundle + init + prima richiesta. Caldo = mediana di 30 richieste dello stesso processo.
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { build } from 'esbuild';

const OUT = '.svelte-kit/bench';
const ASSETS = '.svelte-kit/cloudflare';
const COLD_RUNS = 5;
const WARM_REQUESTS = 30;
mkdirSync(OUT, { recursive: true });

// Come fa Pages con _worker.js: un solo file con tutte le dipendenze (compresi i JSON), `cloudflare:workers` simulato.
await build({
	entryPoints: [`${ASSETS}/_worker.js`],
	outfile: `${OUT}/worker.mjs`,
	bundle: true,
	format: 'esm',
	platform: 'neutral',
	mainFields: ['module', 'main'],
	conditions: ['workerd', 'worker', 'browser'],
	target: 'es2022',
	logLevel: 'error',
	plugins: [
		{
			name: 'cloudflare-workers-shim',
			setup(b) {
				b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'cf-shim' }));
				b.onLoad({ filter: /.*/, namespace: 'cf-shim' }, () => ({ contents: 'export const env = globalThis.__benchEnv;', loader: 'js' }));
			}
		}
	]
});

const run = (route, warm) =>
	JSON.parse(execFileSync(process.execPath, ['scripts/cpu-bench-child.mjs', `${OUT}/worker.mjs`, ASSETS, route, String(warm)], { encoding: 'utf8' }).trim().split('\n').pop());

// Un evento vero dal seed, per /eventi/<slug>-<id> (lo slug non conta: vale l'id dopo l'ultimo trattino).
const sample = JSON.parse(
	execFileSync(process.execPath, ['scripts/cpu-bench-child.mjs', `${OUT}/worker.mjs`, ASSETS, '/api/events?lat=44.65&lng=10.93&r=25', '0'], {
		encoding: 'utf8',
		env: { ...process.env, BENCH_BODY: '1' }
	}).trim().split('\n').pop()
);
const eventId = JSON.parse(sample.body)[0]?.id;
if (!eventId) throw new Error('Nessun evento nel seed: avvia il bench con `npm run bench:cpu`');

const routes = ['/robots.txt', '/privacy', '/', '/?luogo=modena', '/?luogo=cabiate', '/citta/modena', '/citta/bolzano', '/api/places', '/api/events?lat=44.65&lng=10.93&r=25', '/sitemap.xml', `/eventi/bench-${eventId}`];
console.log(`bytes del bundle del Worker: ${statSync(`${OUT}/worker.mjs`).size}`);
console.log('rotta	stato	import ms	prima richiesta ms	caldo ms	(CPU freddo grezza ms)');
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
for (const route of routes) {
	const runs = Array.from({ length: COLD_RUNS }, (_, i) => run(route, i === 0 ? WARM_REQUESTS : 0));
	const f = (k) => med(runs.map((r) => r[k]));
	console.log(`${route}	${runs[0].status}	${f('import').toFixed(0)}	${f('first').toFixed(0)}	${runs[0].warm.toFixed(1)}	${(f('cold') / 1000).toFixed(0)}`);
}
