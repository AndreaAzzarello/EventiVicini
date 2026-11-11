// Bench in workerd vero (#51): avvia `wrangler pages dev` sulla build e misura da fuori ogni rotta, a freddo e a caldo, più un profilo CPU
// via inspector (CDP). Va lanciato dentro gli emulatori con i dati «da bench»:
//   npm run bench:workerd      (emulators:exec; lo script semina da sé con SEED_BENCH=1; serve `npm run build` prima)
// Cosa misura: tempo di parete di richieste in sequenza con `cache-control: no-cache` (salta la cache dell'adapter, come nel tail di
// produzione). Per codice sincrono (render, ordinamenti, Intl) è quasi la CPU; le rotte con Firestore a freddo includono la latenza
// dell'emulatore. Il pavimento di scala è /robots.txt (nessun lavoro). Non sono i ms di Cloudflare: servono a confrontare un commit con
// l'altro e a ordinare dove va il tempo. La CPU vera in produzione si legge con il tail (scripts/cpu-tail.mjs).
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

// Dati «da bench»: 114 eventi a Modena e copertura di tutta Italia (vedi seed-emulator.mjs).
execFileSync(process.execPath, ['scripts/seed-emulator.mjs'], { stdio: 'inherit', env: { ...process.env, SEED_BENCH: '1' } });

const PORT = 8789;
const INSPECTOR = 9239;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const WARM = Number(process.env.BENCH_WARM ?? 40);
const RESTARTS = Number(process.env.BENCH_RESTARTS ?? 3);
const ROUTES = [
	'/robots.txt',
	'/',
	'/?luogo=modena',
	'/citta/modena',
	'/regione/emilia-romagna',
	'/api/events?lat=44.65&lng=10.93&r=25',
	'/api/places',
	'/sitemap.xml'
];
const PROFILE_ROUTE = process.env.BENCH_PROFILE_ROUTE ?? '/?luogo=modena';

const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot() {
	const state = mkdtempSync(join(tmpdir(), 'wrangler-bench-'));
	// Le variabili passano da riga di comando: valgono sopra wrangler.toml e .dev.vars (emulatori, nessun segreto reale).
	const args = [
		'node_modules/wrangler/bin/wrangler.js', 'pages', 'dev', '.svelte-kit/cloudflare',
		'--ip', '127.0.0.1', '--port', String(PORT), '--inspector-port', String(INSPECTOR), '--persist-to', state,
		'-b', 'PUBLIC_USE_EMULATORS=true', '-b', 'FIRESTORE_EMULATOR_HOST=127.0.0.1:8080', '-b', 'PUBLIC_FIREBASE_PROJECT_ID=demo-eventi',
		'-b', `PUBLIC_SITE_URL=${ORIGIN}`, '-b', 'PUBLIC_FIREBASE_API_KEY=bench', '-b', 'PUBLIC_TURNSTILE_SITEKEY='
	];
	const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'ignore'] });
	for (let i = 0; i < 120; i++) {
		await sleep(500);
		try {
			if ((await fetch(`${ORIGIN}/robots.txt`)).status === 200) return { child, state };
		} catch {
			// non ancora in ascolto
		}
	}
	child.kill();
	throw new Error('wrangler pages dev non è partito entro 60 s');
}

async function stop({ child, state }) {
	child.kill();
	await sleep(500);
	// su Windows il figlio di wrangler (workerd) può restare vivo: lo si chiude per porta
	try {
		if (process.platform === 'win32') {
			const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${PORT},${INSPECTOR} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique`], { encoding: 'utf8' });
			for (const pid of out.split(/\s+/).filter(Boolean)) execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
		}
	} catch {
		// niente da chiudere
	}
	rmSync(state, { recursive: true, force: true });
}

async function timed(route) {
	const t = performance.now();
	const res = await fetch(ORIGIN + route, { headers: { 'cache-control': 'no-cache' }, redirect: 'manual' });
	await res.arrayBuffer();
	return { ms: performance.now() - t, status: res.status };
}

// 1) freddo: ogni riavvio, prima richiesta di ogni rotta (la prima in elenco, robots.txt, include l'avvio del modulo)
const first = Object.fromEntries(ROUTES.map((r) => [r, []]));
const second = Object.fromEntries(ROUTES.map((r) => [r, []]));
const statusOf = {};
for (let i = 0; i < RESTARTS; i++) {
	const w = await boot();
	for (const r of ROUTES) {
		const x = await timed(r);
		first[r].push(x.ms);
		statusOf[r] = x.status;
		second[r].push((await timed(r)).ms);
	}
	await stop(w);
}

// 2) caldo + profilo, su un solo avvio
const w = await boot();
const warm = {};
for (const r of ROUTES) {
	await timed(r);
	const s = [];
	for (let i = 0; i < WARM; i++) s.push((await timed(r)).ms);
	warm[r] = s;
}

let profile = null;
try {
	const list = await (await fetch(`http://127.0.0.1:${INSPECTOR}/json`)).json();
	const url = list.find((t) => t.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
	if (url) {
		const ws = new WebSocket(url);
		await new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej)));
		let id = 0;
		const pending = new Map();
		ws.on('message', (m) => {
			const d = JSON.parse(String(m));
			if ('result' in d || 'error' in d) pending.get(d.id)?.(d); // l'inspector rimanda anche l'eco delle richieste: si ignora
		});
		const call = (method, params = {}) => new Promise((res) => ((pending.set(++id, res), ws.send(JSON.stringify({ id, method, params })))));
		// enable/start non rispondono con un result sull'inspector di workerd: si inviano e basta; si attende solo stop
		ws.send(JSON.stringify({ id: ++id, method: 'Profiler.enable' }));
		ws.send(JSON.stringify({ id: ++id, method: 'Profiler.start' }));
		await sleep(500);
		for (let i = 0; i < WARM; i++) await timed(PROFILE_ROUTE);
		const stopped = await Promise.race([call('Profiler.stop'), sleep(20_000).then(() => null)]);
		profile = stopped?.result?.profile ?? null;
		ws.close();
	}
} catch (e) {
	console.error(`profilo CPU non disponibile: ${e.message}`);
}
await stop(w);

// 2ª richiesta = stesso processo, codice non ancora ottimizzato dal JIT: è il caso tipico di un isolate di produzione (poche richieste).
// Il pavimento di scala è /robots.txt (overhead HTTP del proxy locale incluso).
console.log(`rotta\tstato\t1ª richiesta ms\t2ª richiesta ms\tcaldo ms (dopo ${WARM})\t[mediane di ${RESTARTS} avvii]`);
for (const r of ROUTES) console.log(`${r}\t${statusOf[r]}\t${med(first[r]).toFixed(0)}\t${med(second[r]).toFixed(0)}\t${med(warm[r]).toFixed(1)}`);

if (profile) {
	const self = new Map();
	const byId = new Map(profile.nodes.map((n) => [n.id, n]));
	profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + profile.timeDeltas[i]));
	const total = [...self.values()].reduce((a, b) => a + b, 0);
	const agg = new Map();
	for (const [id, t] of self) {
		const cf = byId.get(id).callFrame;
		const k = `${cf.functionName || '(anonima)'} ${cf.url.split(/[\\/]/).pop()}:${cf.lineNumber}`;
		agg.set(k, (agg.get(k) ?? 0) + t);
	}
	console.log(`\nprofilo CPU di ${PROFILE_ROUTE} (${WARM} richieste calde, ${(total / 1000).toFixed(0)} ms campionati, funzioni per tempo proprio):`);
	for (const [k, v] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log(`${((v / total) * 100).toFixed(1)}%\t${k}`);
}
