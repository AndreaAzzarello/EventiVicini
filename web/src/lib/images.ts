// Immagini di terze parti: dall'URL salvato si deriva, in lettura, una variante più piccola quando lo schema della fonte è noto.
// Nessun dato cambia in Firestore. Gli URL di fonti sconosciute (Maggioli, ASP.NET, Halley, Drupal, Open Data Hub, proposte) restano
// l'originale. Se la variante non carica, imageFallback.ts torna all'originale.

export type ImageUse = 'thumb' | 'hero';
export type ImageSources = { src: string; srcset?: string; sizes: string; original: string };

// Miniature: riquadro 64 px (96 da 520 px). Le immagini sono per lo più orizzontali (~1,6:1) e il riquadro è quadrato con
// object-fit: cover, quindi la larghezza deve coprire l'altezza: a 64 px di altezza un'immagine 1,6:1 è larga ~102 px (154 da 520 px): a 360 px con DPR 2 il browser sceglie mini (200w),
// a DPR 1 thumb (128w), da 520 px con DPR 2 preview (400w).
const THUMB_SIZES = '(min-width: 520px) 154px, 102px';
// Hero: colonna di 760 px al massimo, padding laterale di 16 px.
const HERO_SIZES = '(min-width: 800px) 760px, calc(100vw - 32px)';

// Larghezze delle scale standard Plone (plone.app.imaging / Plone 6).
const PLONE_SCALES: Record<string, number> = { thumb: 128, mini: 200, preview: 400, teaser: 600, large: 800, larger: 1000, great: 1200, huge: 1600 };

// Volto salva l'URL con scala e hash (image-800-<hash>.jpeg); le scale senza hash (image/mini) rispondono 200 ma con
// Cache-Control: max-age=0, must-revalidate (limite noto: visita ripetuta con richieste condizionali).
const PLONE = /^(.*\/@@images\/image)(?:-(\d+)-[0-9a-f]{32}\.\w+|\/(thumb|mini|preview|teaser|large|larger|great|huge))(\?.*)?$/;
const WORDPRESS = /^(.*\/wp-content\/uploads\/.+?)(?:-scaled)?(?:-\d+x\d+)?(\.(?:jpe?g|png|webp))(\?.*)?$/i;
const TICKETMASTER = /^(https:\/\/s1\.ticketm\.net\/dam\/.+?)_([A-Z_]+)_16_9\.jpg$/;

export function imageSources(url: string, use: ImageUse = 'thumb'): ImageSources {
	const sizes = use === 'hero' ? HERO_SIZES : THUMB_SIZES;
	const plain: ImageSources = { src: url, sizes, original: url };

	const p = PLONE.exec(url);
	if (p) {
		const [, base, hashedWidth, scaleName, qs = ''] = p;
		const at = (name: string) => `${base}/${name}${qs}`;
		if (use === 'thumb') {
			return { src: at('mini'), srcset: `${at('thumb')} 128w, ${at('mini')} 200w, ${at('preview')} 400w`, sizes, original: url };
		}
		const width = hashedWidth ? Number(hashedWidth) : PLONE_SCALES[scaleName];
		// Dall'originale in giù: preview e teaser solo se più piccoli dell'originale.
		if (!width || width <= 400) return plain;
		const smaller = ['preview', 'teaser'].filter((n) => PLONE_SCALES[n] < width).map((n) => `${at(n)} ${PLONE_SCALES[n]}w`);
		return { src: url, srcset: [...smaller, `${url} ${width}w`].join(', '), sizes, original: url };
	}

	if (use === 'thumb') {
		const w = WORDPRESS.exec(url);
		if (w) return { src: `${w[1]}-150x150${w[2]}${w[3] ?? ''}`, sizes, original: url };
	}

	const t = TICKETMASTER.exec(url);
	if (t) {
		const small = `${t[1]}_RETINA_PORTRAIT_16_9.jpg`;
		if (use === 'thumb') return { src: small, sizes, original: url };
		if (t[2] === 'TABLET_LANDSCAPE') return { src: url, srcset: `${small} 640w, ${url} 1024w`, sizes, original: url };
	}
	return plain;
}
