import { beforeEach, describe, expect, it } from 'vitest';
import { authMessage } from './auth';
import { VERIFY_MESSAGE, errorMessage, isVerifyError, noteAppCheck, resetAppCheckNote } from './errors';

const FALLBACK = 'Testo di sempre.';
const denied = Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });

beforeEach(resetAppCheckNote);

describe('errori del provider App Check / Turnstile', () => {
	for (const m of ['turnstile-load', 'turnstile-timeout', 'turnstile-error', 'turnstile-expired', 'turnstile-missing', 'appcheck-403', 'appcheck-503']) {
		it(`${m} → messaggio di verifica`, () => {
			expect(isVerifyError(new Error(m))).toBe(true);
			expect(errorMessage(new Error(m), FALLBACK)).toBe(VERIFY_MESSAGE);
		});
	}
	it('errori dell’SDK App Check → messaggio di verifica', () => {
		expect(isVerifyError(Object.assign(new Error('x'), { code: 'appCheck/fetch-network-error' }))).toBe(true);
		expect(isVerifyError(Object.assign(new Error('x'), { code: 'auth/firebase-app-check-token-is-invalid' }))).toBe(true);
	});
});

describe('permission-denied', () => {
	it('dopo un tentativo App Check fallito: è la verifica', () => {
		noteAppCheck(false);
		expect(isVerifyError(denied)).toBe(true);
		expect(errorMessage(denied, FALLBACK)).toBe(VERIFY_MESSAGE);
	});
	it('un successo dopo il fallimento annulla la causa: resta il testo di sempre', () => {
		noteAppCheck(false);
		noteAppCheck(true);
		expect(isVerifyError(denied)).toBe(false);
		expect(errorMessage(denied, FALLBACK)).toBe(FALLBACK);
	});
	it('un permission-denied reale delle regole (utente non admin) con token valido mantiene il testo di sempre', () => {
		noteAppCheck(true);
		expect(errorMessage(denied, FALLBACK)).toBe(FALLBACK);
		expect(authMessage(denied)).toBe('Qualcosa è andato storto. Riprova tra poco.');
	});
	it('senza alcun tentativo App Check (non attivo): testo di sempre', () => {
		expect(errorMessage(denied, FALLBACK)).toBe(FALLBACK);
	});
});

describe('altri errori', () => {
	it('rete, limiti e errori qualsiasi mantengono il loro testo, anche con App Check fallito', () => {
		noteAppCheck(false);
		for (const e of [new TypeError('Failed to fetch'), Object.assign(new Error('x'), { code: 'resource-exhausted' }), Object.assign(new Error('x'), { code: 'unavailable' }), 'stringa', null, undefined]) {
			expect(errorMessage(e, FALLBACK)).toBe(FALLBACK);
		}
	});
	it('authMessage: i codici di Auth restano, la verifica ha il suo testo', () => {
		expect(authMessage(Object.assign(new Error('x'), { code: 'auth/network-request-failed' }))).toBe('Connessione assente o instabile. Riprova.');
		expect(authMessage(new Error('turnstile-load'))).toBe(VERIFY_MESSAGE);
	});
});
