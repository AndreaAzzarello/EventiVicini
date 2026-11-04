import { describe, expect, it } from 'vitest';
import { xssDue, xssUno } from './hostileEvents';
import { eventJsonLd, safeJson } from './jsonld';

// Come in routes/eventi/[slug]/+page.svelte: <script type="application/ld+json">{@html safeJson(...)}</script>
const tag = (json: string) => `<script type="application/ld+json">${json}</script>`;

describe('safeJson dentro <script>: contenuto ostile', () => {
	for (const [nome, e] of [['xssUno', xssUno()], ['xssDue', xssDue()]] as const) {
		it(`${nome}: nessun terminatore di script né commento HTML, e il JSON torna uguale`, () => {
			const data = eventJsonLd(e, 'https://example.test/eventi/x');
			const json = safeJson(data);
			expect(json).not.toMatch(/[<>&]/);
			expect(tag(json).match(/<\/script>/g)).toHaveLength(1); // solo la chiusura vera
			expect(tag(json)).not.toContain('<!--');
			expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(data)));
		});
	}
	it('U+2028 e U+2029 restano nel testo (ammessi nei letterali JS da ES2019) e <!-- diventa \\u003c!--', () => {
		const data = eventJsonLd(xssUno(), 'https://example.test/x');
		const json = safeJson(data);
		expect(JSON.parse(json).description).toContain('    <!-- fine');
		expect(json).toContain('\\u003c!-- fine');
	});
	it('<!-- da solo', () => {
		expect(safeJson({ d: 'a <!-- b' })).toBe('{"d":"a \\u003c!-- b"}');
	});
});
