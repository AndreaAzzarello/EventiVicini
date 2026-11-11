// Le pagine prerenderizzate (/privacy, /termini, /cookie, /offline) sono scritte in build e non rileggono l'ambiente del Worker.
// wrangler.toml [vars] è la fonte dei valori pubblici di produzione, ma Cloudflare Pages non li passa alla build: li legge questa
// funzione, e svelte.config.js li mette nell'ambiente di build solo per le chiavi che non ci sono già (processo o .env).
import { readFileSync } from 'node:fs';

/**
 * Coppie chiave/valore stringa della sezione [vars] di un wrangler.toml (basta il sottoinsieme che usiamo: KEY = "valore").
 * @param {string} toml
 * @returns {Record<string, string>}
 */
export function parseVars(toml) {
	/** @type {Record<string, string>} */
	const vars = {};
	let inVars = false;
	for (const raw of toml.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith('[')) inVars = line === '[vars]';
		else if (inVars) {
			const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(line);
			if (m) vars[m[1]] = m[2].replace(/\\(["\\])/g, '$1');
		}
	}
	return vars;
}

/**
 * Riempie `target` con i [vars] di `file` per le chiavi che né `target` né `already` hanno. Ritorna le chiavi aggiunte.
 * @param {string | URL} file
 * @param {Record<string, string | undefined>} target
 * @param {Record<string, string | undefined>} [already]
 * @returns {string[]}
 */
export function fillFromWrangler(file, target, already = {}) {
	/** @type {Record<string, string>} */
	let vars;
	try {
		vars = parseVars(readFileSync(file, 'utf8'));
	} catch {
		return [];
	}
	/** @type {string[]} */
	const added = [];
	for (const [k, v] of Object.entries(vars)) {
		if (target[k] === undefined && already[k] === undefined) {
			target[k] = v;
			added.push(k);
		}
	}
	return added;
}
