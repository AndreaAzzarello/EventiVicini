import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SECURITY_HEADERS } from './hooks.server';

// Le pagine del Worker prendono le intestazioni di sicurezza da hooks.server.ts, gli asset statici e le pagine prerenderizzate
// (/offline, /privacy, /termini, /cookie) da _headers: le due liste devono dire la stessa cosa.
describe('intestazioni di sicurezza', () => {
	it('_headers coincide con SECURITY_HEADERS di hooks.server.ts', () => {
		const block = readFileSync('_headers', 'utf8').split(/\r?\n/).filter((l) => /^\s+\S+:\s/.test(l));
		const fromFile = Object.fromEntries(block.map((l) => l.trim().split(/:\s+/, 2)).map(([k, v]) => [k.toLowerCase(), v]));
		expect(fromFile).toEqual(SECURITY_HEADERS);
	});
});
