// Riassume per rotta la CPU letta da `wrangler pages deployment tail --format json` (stdin).
//   npx wrangler pages deployment tail <ID-deploy> --project-name eventi-vicini --format json --header "x-bench:1" | node scripts/cpu-tail.mjs
// (l'ID dell'ultimo deploy: `npx wrangler pages deployment list --project-name eventi-vicini --environment production --json`;
//  il filtro --header isola le richieste fatte da te con `curl -H "x-bench: 1"`: niente traffico di altri nel file.)
// Termina con Ctrl+C: la tabella esce alla chiusura dell'input. Unità: millisecondi interi (campi cpuTime e wallTime del tail).
// Rotta: quella della sonda di hooks.server.ts, altrimenti il percorso dell'URL. Freddo = richiesta n=1 dell'isolate (sonda);
// "senza sonda" = risposta statica o servita dalla Cache API dell'adapter (non passa dagli hook), oppure deploy senza sonda.
import { createInterface } from 'node:readline';

const rows = [];
let buf = [];
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
	// wrangler stampa ogni evento come oggetto JSON indentato: inizia con "{" e finisce con "}" in colonna 0 (oppure è su una riga sola)
	if (line === '{' || (buf.length === 0 && line.startsWith('{') && line.endsWith('}'))) buf = [];
	buf.push(line);
	if (line !== '}' && !(buf.length === 1 && line.endsWith('}'))) return;
	let ev;
	try {
		ev = JSON.parse(buf.join('\n'));
	} catch {
		return;
	} finally {
		buf = [];
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
	let path = '?';
	try {
		const u = new URL(ev.event?.request?.url);
		path = u.pathname + (u.search ? '?…' : ''); // mai i parametri: possono contenere la posizione dell'utente
	} catch {
		// evento senza richiesta HTTP
	}
	rows.push({ route: probe?.route ?? path, kind: !probe ? 'senza sonda' : probe.n === 1 ? 'freddo' : 'caldo', cpu, wall: ev.wallTime ?? 0 });
});
rl.on('close', () => {
	const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
	const groups = Map.groupBy(rows, (r) => `${r.route}\t${r.kind}`);
	console.log('rotta\ttipo\tn\tCPU p50 ms\tCPU max ms\twall p50 ms');
	for (const [k, g] of [...groups].sort()) {
		const c = g.map((r) => r.cpu);
		console.log(`${k}\t${g.length}\t${q(c, 0.5)}\t${Math.max(...c)}\t${q(g.map((r) => r.wall), 0.5)}`);
	}
});
