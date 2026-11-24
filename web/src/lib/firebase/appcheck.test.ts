import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VERIFY_MESSAGE, errorMessage, isVerifyError, resetAppCheckNote } from '../errors';
import { turnstileProvider } from './appcheck';

// Ambiente node: un DOM minimo per il solo caricamento dello script Turnstile e per il box del widget.
type FakeScript = { src: string; async: boolean; onload?: () => void; onerror?: () => void };
let scriptOutcome: 'load' | 'error';
const denied = Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });

beforeEach(() => {
	resetAppCheckNote();
	scriptOutcome = 'load';
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	const el = () => ({ style: {}, setAttribute() {}, append() {}, remove() {} });
	vi.stubGlobal('window', globalThis);
	vi.stubGlobal('document', {
		createElement: (tag: string) => (tag === 'script' ? ({ src: '', async: false } as FakeScript) : el()),
		head: { append: (s: FakeScript) => queueMicrotask(() => (scriptOutcome === 'load' ? s.onload?.() : s.onerror?.())) },
		body: { append() {} }
	});
	vi.stubGlobal('turnstile', { render: (_: unknown, o: { callback: (t: string) => void }) => (o.callback('tok'), 'w1'), remove() {} });
});
afterEach(() => vi.unstubAllGlobals());

describe('provider App Check con Turnstile', () => {
	it('script Turnstile non caricabile (bloccato): l’errore arriva al chiamante e il messaggio è quello di verifica', async () => {
		scriptOutcome = 'error';
		const err = await turnstileProvider('site').getToken().then(() => null, (e: unknown) => e);
		expect((err as Error).message).toBe('turnstile-load');
		expect(isVerifyError(err)).toBe(true);
		expect(errorMessage(err, 'x')).toBe(VERIFY_MESSAGE);
		// L'SDK manda comunque la richiesta e l'enforcement la rifiuta: da qui il permission-denied è la verifica
		expect(errorMessage(denied, 'x')).toBe(VERIFY_MESSAGE);
	});

	it('/api/appcheck risponde con un errore: l’errore arriva al chiamante e il messaggio è quello di verifica', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
		const err = await turnstileProvider('site').getToken().then(() => null, (e: unknown) => e);
		expect((err as Error).message).toBe('appcheck-503');
		expect(errorMessage(err, 'x')).toBe(VERIFY_MESSAGE);
		expect(errorMessage(denied, 'x')).toBe(VERIFY_MESSAGE);
	});

	it('token ottenuto: un permission-denied successivo è delle regole e mantiene il testo di sempre', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{"token":"t","expireTimeMillis":1}', { status: 200 })));
		expect(await turnstileProvider('site').getToken()).toEqual({ token: 't', expireTimeMillis: 1 });
		expect(errorMessage(denied, 'Testo di sempre.')).toBe('Testo di sempre.');
	});

	it('fallimento seguito da un successo: la causa non è più la verifica', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{}', { status: 503 })).mockResolvedValueOnce(new Response('{"token":"t","expireTimeMillis":1}')));
		await turnstileProvider('site').getToken().catch(() => {});
		expect(isVerifyError(denied)).toBe(true);
		await turnstileProvider('site').getToken();
		expect(isVerifyError(denied)).toBe(false);
	});
});
