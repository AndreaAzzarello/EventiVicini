import { describe, expect, it } from 'vitest';
import { safeNext } from './auth';

const O = 'https://eventi-vicini.pages.dev';
const next = (v: string | null) => safeNext(v, O);

describe('safeNext', () => {
	it('percorsi interni passano, con query e hash', () => {
		expect(next('/account')).toBe('/account');
		expect(next('/eventi/x-1?a=1#b')).toBe('/eventi/x-1?a=1#b');
		expect(next('/%09/evil.com')).toBe('/%09/evil.com'); // %09 non è un tab: resta un percorso del sito
	});
	it('vuoto o assente: home', () => {
		expect(next(null)).toBe('/');
		expect(next('')).toBe('/');
	});
	it.each(['//evil.com', 'https://evil.com', '/\t/evil.com', '/\\evil.com', '\\\\evil.com', 'javascript:alert(1)', 'http://eventi-vicini.pages.dev'])(
		'%j non esce dal sito',
		(v) => expect(next(v)).toBe('/')
	);
	// Dimostrato il 25/11/2026: prima della correzione questi percorsi tornavano come `//evil.com` (stessa origine, ma il browser
	// li legge come indirizzo con host «evil.com»). SvelteKit 2.70 rifiuta goto() verso un'altra origine, quindi non era un redirect
	// aperto, ma dopo l'accesso non si veniva portati da nessuna parte.
	it.each(['/.//evil.com', '/..//evil.com', '/a/..//evil.com', '/%2e%2e//evil.com', '/%2E/%2e//evil.com', '/a/%2e%2e//evil.com?x=1#y', '///evil.com', '////evil.com'])(
		'%j non produce un percorso che inizia con //',
		(v) => {
			const out = next(v);
			expect(out).toBe('/');
			expect(new URL(out, O).origin).toBe(O);
		}
	);
	it('il risultato risolto resta sempre della stessa origine, per una serie di percorsi ostili', () => {
		for (const v of ['/.//evil.com', '/..//evil.com', '/x/..//evil.com', '/%2e%2e//evil.com', '/./\\evil.com', '/..\\/evil.com', '/%5cevil.com', '/ /evil.com', '/‮//evil.com']) {
			expect(new URL(next(v), O).origin, v).toBe(O);
			expect(next(v).startsWith('//'), v).toBe(false);
		}
	});
	it('un // nell’hash o nella query è innocuo e resta', () => {
		expect(next('/?x=1#//evil.com')).toBe('/?x=1#//evil.com');
		expect(next('/a?u=//evil.com')).toBe('/a?u=//evil.com');
	});
	it('percorsi normali con punti e doppi slash dentro il percorso vero restano validi se non iniziano con //', () => {
		expect(next('/eventi/a/../b')).toBe('/eventi/b');
		expect(next('/eventi//x')).toBe('/eventi//x');
	});
});
