import { describe, expect, it } from 'vitest';
import { imageSources } from './images';

const HASH = 'e4aa95d60d3a61a549ea6646641b5e70';
const PLONE_800 = `https://www.comune.modena.it/ev/foo/@@images/image-800-${HASH}.jpeg`;
const B = 'https://www.comune.modena.it/ev/foo/@@images/image';

describe('imageSources: Plone', () => {
	it('miniatura da URL con hash: scale senza hash, originale conservato', () => {
		const r = imageSources(PLONE_800, 'thumb');
		expect(r.src).toBe(`${B}/mini`);
		expect(r.srcset).toBe(`${B}/thumb 128w, ${B}/mini 200w, ${B}/preview 400w`);
		expect(r.original).toBe(PLONE_800);
		expect(r.sizes).toContain('100px');
	});
	it('hero da URL con hash 800: preview, teaser e originale', () => {
		const r = imageSources(PLONE_800, 'hero');
		expect(r.src).toBe(PLONE_800);
		expect(r.srcset).toBe(`${B}/preview 400w, ${B}/teaser 600w, ${PLONE_800} 800w`);
	});
	it('hero da originale 890 px: stesse scale più piccole', () => {
		const u = `${B}-890-${HASH}.jpeg`;
		expect(imageSources(u, 'hero').srcset).toBe(`${B}/preview 400w, ${B}/teaser 600w, ${u} 890w`);
	});
	it('hero da originale piccolo (≤ 400 px): niente srcset', () => {
		expect(imageSources(`${B}-400-${HASH}.png`, 'hero').srcset).toBeUndefined();
	});
	it('URL con scala nominale e query string', () => {
		const r = imageSources(`${B}/large?v=1`, 'thumb');
		expect(r.src).toBe(`${B}/mini?v=1`);
		expect(imageSources(`${B}/large?v=1`, 'hero').srcset).toBe(`${B}/preview?v=1 400w, ${B}/teaser?v=1 600w, ${B}/large?v=1 800w`);
	});
	it('scala original: non toccata', () => {
		const u = `${B}/original`;
		expect(imageSources(u).src).toBe(u);
		expect(imageSources(u).srcset).toBeUndefined();
	});
});

describe('imageSources: Plone con le scale salvate dall’importer (#95)', () => {
	const MINI = `${B}-200-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpeg`;
	const PREVIEW = `${B}-400-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.jpeg`;
	it('miniatura: mini e preview con hash (cache di 1 anno), originale conservato per il ripiego', () => {
		const r = imageSources(PLONE_800, 'thumb', { mini: MINI, preview: PREVIEW });
		expect(r.src).toBe(MINI);
		expect(r.srcset).toBe(`${MINI} 200w, ${PREVIEW} 400w`);
		expect(r.original).toBe(PLONE_800);
		expect(r.sizes).toContain('100px');
	});
	it('solo mini: srcset con una scala', () => {
		expect(imageSources(PLONE_800, 'thumb', { mini: MINI }).srcset).toBe(`${MINI} 200w`);
	});
	it('senza mini (dati scritti prima, altre fonti): la derivazione di sempre', () => {
		expect(imageSources(PLONE_800, 'thumb', {})).toEqual(imageSources(PLONE_800, 'thumb'));
		expect(imageSources(PLONE_800, 'thumb', { preview: PREVIEW }).src).toBe(`${B}/mini`);
		expect(imageSources(PLONE_800, 'thumb', { mini: undefined, preview: undefined }).srcset).toContain('/thumb 128w');
	});
	it('hero: le scale salvate non c’entrano', () => {
		expect(imageSources(PLONE_800, 'hero', { mini: MINI, preview: PREVIEW })).toEqual(imageSources(PLONE_800, 'hero'));
	});
});

describe('imageSources: WordPress', () => {
	it.each([
		['https://c.it/wp-content/uploads/2026/03/foto.jpg', 'https://c.it/wp-content/uploads/2026/03/foto-150x150.jpg'],
		['https://c.it/wp-content/uploads/2026/11/Logo-ST-scaled.jpg', 'https://c.it/wp-content/uploads/2026/11/Logo-ST-150x150.jpg'],
		['https://c.it/wp-content/uploads/2026/11/foto-1024x683.png', 'https://c.it/wp-content/uploads/2026/11/foto-150x150.png'],
		['https://c.it/wp-content/uploads/a/foto.JPEG?x=1', 'https://c.it/wp-content/uploads/a/foto-150x150.JPEG?x=1']
	])('miniatura %s', (u, want) => {
		const r = imageSources(u, 'thumb');
		expect(r.src).toBe(want);
		expect(r.original).toBe(u);
	});
	it('hero: invariato', () => {
		const u = 'https://c.it/wp-content/uploads/2026/03/foto.jpg';
		expect(imageSources(u, 'hero').src).toBe(u);
		expect(imageSources(u, 'hero').srcset).toBeUndefined();
	});
	it('SVG e altri formati: invariati', () => {
		const u = 'https://c.it/wp-content/uploads/logo.svg';
		expect(imageSources(u, 'thumb').src).toBe(u);
	});
});

describe('imageSources: Ticketmaster', () => {
	const tm = 'https://s1.ticketm.net/dam/a/03c/7f13_TABLET_LANDSCAPE_16_9.jpg';
	const small = 'https://s1.ticketm.net/dam/a/03c/7f13_RETINA_PORTRAIT_16_9.jpg';
	it('miniatura: RETINA_PORTRAIT', () => expect(imageSources(tm, 'thumb').src).toBe(small));
	it('hero: srcset 640w e 1024w solo se l’originale è 1024', () => {
		expect(imageSources(tm, 'hero').srcset).toBe(`${small} 640w, ${tm} 1024w`);
		const other = 'https://s1.ticketm.net/dam/a/03c/7f13_RETINA_LANDSCAPE_16_9.jpg';
		expect(imageSources(other, 'hero')).toEqual({ src: other, sizes: imageSources(tm, 'hero').sizes, original: other });
	});
});

describe('imageSources: fonti sconosciute', () => {
	it.each([
		'https://www.comune.rubiera.re.it/s3/720x960/s3/6006/media/eventi/scarpe-rosse.jpg',
		'https://www.comune.granarolo-dellemilia.bo.it/it-it/immagine/img-133210-O-28-1371-0-0-22455226f6ce2057b0f86bba6e86d701?639299927479384710',
		'https://x.it/foto.jpg'
	])('solo src, nessuna variante (%s)', (u) => {
		for (const use of ['thumb', 'hero'] as const) {
			const r = imageSources(u, use);
			expect(r.src).toBe(u);
			expect(r.srcset).toBeUndefined();
			expect(r.original).toBe(u);
		}
	});
});
