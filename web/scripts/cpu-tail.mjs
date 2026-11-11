// Riassume per rotta la CPU letta da `wrangler pages deployment tail --format json` (stdin).
//   npx wrangler pages deployment tail --project-name eventi-vicini --environment production --format json | node scripts/cpu-tail.mjs
// Termina con Ctrl+C: la tabella esce alla chiusura dell'input. Unità: millisecondi (campo cpuTime del tail).
// Freddo = richiesta n=1 dell'isolate (sonda in hooks.server.ts); "cache" = evento senza sonda (risposta della Cache API).
import { createInterface } from 'node:readline';

const rows = [];
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
	let ev;
	try {
		ev = JSON.parse(line);
	} catch {
		return;
	}
	const cpu = ev.cpuTime ?? ev.cpuTimeMs;
	if (typeof cpu !== 'number') return;
	const probe = (ev.logs ?? [])
		.flatMap((l) => l.message ?? [])
		.map((m) => {
			try {
				return JSON.parse(m);
			} catch {
				return null;
			}
		})
		.find((p) => p?.probe === 'cpu');
	rows.push({ route: probe?.route ?? '(cache o statica)', kind: !probe ? 'cache' : probe.n === 1 ? 'freddo' : 'caldo', cpu });
});
rl.on('close', () => {
	const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
	const groups = Map.groupBy(rows, (r) => `${r.route}\t${r.kind}`);
	console.log('rotta\ttipo\tn\tp50 ms\tmax ms');
	for (const [k, g] of [...groups].sort()) {
		const c = g.map((r) => r.cpu);
		console.log(`${k}\t${g.length}\t${q(c, 0.5)}\t${Math.max(...c)}`);
	}
});
