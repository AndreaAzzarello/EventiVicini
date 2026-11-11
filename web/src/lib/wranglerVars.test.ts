import { describe, expect, it } from 'vitest';
import { fillFromWrangler, parseVars } from '../../wrangler-vars.js';

describe('parseVars', () => {
	it('legge solo la sezione [vars], con commenti e a capo Windows', () => {
		const toml = 'name = "x"\r\n[vars]\r\nA = "uno" # nota\r\nB = "con \\"virgolette\\""\r\n# C = "no"\r\n[altro]\r\nD = "no"\r\n';
		expect(parseVars(toml)).toEqual({ A: 'uno', B: 'con "virgolette"' });
	});
	it('il wrangler.toml vero espone i valori che servono alle pagine legali', () => {
		const added: Record<string, string> = {};
		fillFromWrangler('wrangler.toml', added);
		expect(added.CONTACT_EMAIL).toMatch(/@/);
		expect(added.CONTROLLER_NAME).toBeTruthy();
		expect(added.PUBLIC_TURNSTILE_SITEKEY).toBeTruthy();
	});
});

describe('fillFromWrangler', () => {
	it('non sovrascrive ciò che c’è già, né nel processo né in .env', () => {
		const target: Record<string, string> = { CONTACT_EMAIL: 'processo@example.org' };
		const added = fillFromWrangler('wrangler.toml', target, { CONTROLLER_NAME: 'da .env' });
		expect(target.CONTACT_EMAIL).toBe('processo@example.org');
		expect(target.CONTROLLER_NAME).toBeUndefined();
		expect(added).not.toContain('CONTACT_EMAIL');
		expect(added).not.toContain('CONTROLLER_NAME');
	});
	it('file mancante: nessun effetto', () => {
		const target: Record<string, string> = {};
		expect(fillFromWrangler('non-esiste.toml', target)).toEqual([]);
		expect(target).toEqual({});
	});
});
