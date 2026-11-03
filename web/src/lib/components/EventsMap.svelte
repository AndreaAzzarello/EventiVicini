<script lang="ts">
	import { mount, onMount, unmount } from 'svelte';
	import { CATEGORY_ICONS } from '$lib/categoryIcons';
	import { clusterPoints } from '$lib/cluster';
	import type { Event } from '$lib/event';
	import { fmtNum } from '$lib/format';
	import type { LatLng } from '$lib/geo';
	import { baseMap, cssVar, loadLeaflet, type Leaflet } from '$lib/leaflet';
	import MapPreview from './MapPreview.svelte';

	let {
		events,
		center,
		radiusKm,
		highlighted = null,
		onhover
	}: {
		events: Event[];
		center: LatLng;
		radiusKm: number;
		highlighted?: string | null;
		onhover?: (id: string | null) => void;
	} = $props();

	/** Lato della cella di raggruppamento, in pixel: poco più di un pin. */
	const CELL = 44;
	/** Da questo zoom i cluster non si aprono più zoomando: restano punti con lo stesso indirizzo, si elencano. */
	const STACK_ZOOM = 17;
	const STACK_MAX = 5;

	let el: HTMLDivElement;
	let L: Leaflet | null = $state.raw(null);
	let map: import('leaflet').Map | null = null;
	let layer: import('leaflet').LayerGroup | null = null;
	let markers: Record<string, import('leaflet').Marker> = {};
	let mounted: ReturnType<typeof mount>[] = [];
	let fitting = false;
	let failed = $state(false);
	/** Vista corrente, esposta come data-* per i test E2E. */
	let view = $state<{ lat: number; lng: number; zoom: number } | null>(null);

	onMount(() => {
		let cancelled = false;
		loadLeaflet()
			.then((lib) => {
				if (cancelled) return;
				map = baseMap(lib, el);
				// Guardie su `map`: un evento in coda dopo lo smontaggio non deve toccare una mappa già rimossa.
				map.on('moveend', () => {
					if (!map) return;
					const c = map.getCenter();
					view = { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
				});
				// Cambiando zoom i pin vicini si fondono o si separano.
				map.on('zoomend', () => {
					if (map && !fitting) draw();
				});
				layer = lib.layerGroup().addTo(map);
				L = lib;
			})
			.catch(() => (failed = true));
		return () => {
			cancelled = true;
			mounted.forEach((m) => unmount(m));
			mounted = [];
			const m = map;
			map = null;
			layer = null;
			markers = {};
			if (!m) return;
			m.stop();
			m.off();
			// shortcut: Leaflet 1.9 chiude lo zoom animato con un setTimeout di 250 ms che remove() non annulla e che rompe su una mappa già rimossa (_leaflet_pos); si rimuove dopo. Da rivedere se Leaflet lo corregge.
			setTimeout(() => m.remove(), 300);
		};
	});

	function preview(e: Event) {
		const div = document.createElement('div');
		mounted.push(mount(MapPreview, { target: div, props: { event: e } }));
		return div;
	}

	/** Più eventi allo stesso indirizzo: un elenco di anteprime, non uno zoom infinito. */
	function stack(list: Event[]) {
		const div = document.createElement('div');
		div.className = 'stack';
		for (const e of list.slice(0, STACK_MAX)) div.append(preview(e));
		if (list.length > STACK_MAX) {
			const more = document.createElement('p');
			more.textContent = `E altri ${fmtNum(list.length - STACK_MAX)} eventi qui`;
			div.append(more);
		}
		return div;
	}

	// Pin a goccia nel colore della categoria, con la sua icona: anche chi non distingue i colori la legge dall'icona.
	function pinIcon(lib: Leaflet, e: Event) {
		const pin = document.createElement('span');
		pin.className = 'ev-pin';
		pin.dataset.cat = e.category;
		const icon = document.createElement('span');
		icon.className = 'ev-pin-icon';
		pin.append(icon);
		mounted.push(mount(CATEGORY_ICONS[e.category], { target: icon, props: { size: 16, 'aria-hidden': 'true' } }));
		// la punta della goccia (angolo ruotato di 45°) sta a ~23 px sotto il centro del riquadro da 32
		return lib.divIcon({ className: 'ev-marker-wrap', html: pin, iconSize: [32, 32], iconAnchor: [16, 39], popupAnchor: [0, -39] });
	}

	function clusterIcon(lib: Leaflet, n: number) {
		const el = document.createElement('span');
		el.className = 'ev-cluster';
		el.textContent = fmtNum(n);
		return lib.divIcon({ className: 'ev-marker-wrap', html: el, iconSize: [48, 48], iconAnchor: [24, 24] });
	}

	function applyHighlight() {
		for (const [id, m] of Object.entries(markers)) {
			m.getElement()?.classList.toggle('active', id === highlighted);
			m.setZIndexOffset(id === highlighted ? 1000 : 0);
		}
	}

	/** Ridisegna cerchio, centro e marker (raggruppati allo zoom corrente). */
	function draw() {
		if (!L || !map || !layer) return;
		const lib = L;
		const m = map;
		layer.clearLayers();
		mounted.forEach((x) => unmount(x));
		mounted = [];
		markers = {};
		lib.circle([center.lat, center.lng], {
			radius: radiusKm * 1000,
			color: cssVar('--accent'),
			weight: 2,
			opacity: 0.6,
			fill: false,
			interactive: false
		}).addTo(layer);
		lib.circleMarker([center.lat, center.lng], {
			radius: 6,
			color: cssVar('--surface'),
			weight: 2,
			fillColor: cssVar('--text'),
			fillOpacity: 1,
			interactive: false
		}).addTo(layer);
		const zoom = m.getZoom();
		for (const c of clusterPoints(events, (p) => m.project([p.lat, p.lng], zoom), CELL)) {
			if (c.items.length === 1) {
				const e = c.items[0];
				markers[e.id] = lib
					.marker([e.lat, e.lng], { icon: pinIcon(lib, e), title: e.title })
					.bindPopup(() => preview(e), { minWidth: 200, maxWidth: 280 })
					.on('mouseover', () => onhover?.(e.id))
					.on('mouseout', () => onhover?.(null))
					.addTo(layer);
				continue;
			}
			const bounds = lib.latLngBounds(c.items.map((i): [number, number] => [i.lat, i.lng]));
			const marker = lib
				.marker([c.lat, c.lng], { icon: clusterIcon(lib, c.items.length), title: `${c.items.length} eventi in quest'area` })
				.on('click', () => {
					if (bounds.getNorthEast().equals(bounds.getSouthWest()) || m.getZoom() >= STACK_ZOOM)
						lib.popup({ minWidth: 200, maxWidth: 280, maxHeight: 320 }).setLatLng([c.lat, c.lng]).setContent(stack(c.items)).openOn(m);
					else m.fitBounds(bounds, { padding: [48, 48], maxZoom: STACK_ZOOM });
				})
				.addTo(layer);
			for (const i of c.items) markers[i.id] = marker;
		}
		applyHighlight();
	}

	// Ridisegna quando cambiano eventi, centro o raggio.
	$effect(() => {
		if (!L || !map || !layer) return;
		void [events, center, radiusKm];
		// Senza animazione: Leaflet scarta un nuovo fitBounds mentre uno zoom è ancora in corso, e la mappa restava sulla vista vecchia.
		fitting = true;
		map.fitBounds(L.latLng(center.lat, center.lng).toBounds(radiusKm * 2000), { padding: [16, 16], animate: false });
		fitting = false;
		draw();
	});

	$effect(() => {
		void highlighted;
		applyHighlight();
	});
</script>

<div class="wrap">
	<div
		bind:this={el}
		class="map"
		role="region"
		aria-label="Mappa degli eventi"
		data-lat={view?.lat.toFixed(4)}
		data-lng={view?.lng.toFixed(4)}
		data-zoom={view?.zoom}
	></div>
	{#if !L && !failed}<div class="skeleton cover" aria-hidden="true"></div>{/if}
	{#if failed}<p class="cover fail">La mappa non si carica adesso. La lista funziona lo stesso.</p>{/if}
</div>

<style>
	.wrap {
		position: relative;
		height: 100%;
		min-height: calc(var(--space-7) * 5);
		border-radius: var(--radius);
		overflow: hidden;
		border: 1px solid var(--border);
		background: var(--surface-2);
	}
	.map {
		position: absolute;
		inset: 0;
	}
	.cover {
		position: absolute;
		inset: 0;
		margin: 0;
		border-radius: 0;
	}
	.fail {
		display: grid;
		place-items: center;
		color: var(--muted);
	}
	/* Anteprima al tocco: la superficie e il testo del tema, non il bianco di Leaflet */
	.wrap :global(.leaflet-popup-content-wrapper) {
		background: var(--surface);
		color: var(--text);
		border-radius: var(--radius);
		box-shadow: var(--shadow-lift);
	}
	.wrap :global(.leaflet-popup-tip) {
		background: var(--surface);
	}
	.wrap :global(.leaflet-popup-content) {
		margin: var(--space-3);
		font: inherit;
	}
	.wrap :global(.leaflet-popup-content p) {
		margin: var(--space-1) 0 0;
	}
	.wrap :global(.leaflet-container a.leaflet-popup-close-button) {
		color: var(--muted);
	}
	.wrap :global(.stack) {
		display: grid;
		gap: var(--space-3);
	}
	.wrap :global(.stack > p) {
		margin: 0;
		color: var(--muted);
		font-size: var(--text-sm);
	}
	.wrap :global(.ev-marker-wrap) {
		background: none;
		border: none;
	}
	/* Pin a goccia: un quadrato con tre angoli tondi ruotato di -45°, l'icona controruotata */
	.wrap :global(.ev-pin) {
		display: grid;
		place-items: center;
		width: var(--control-sm);
		height: var(--control-sm);
		box-sizing: border-box;
		border: 2px solid var(--surface);
		border-radius: 50% 50% 50% 0;
		background: var(--ink);
		box-shadow: var(--shadow-card);
		transform: rotate(-45deg);
	}
	.wrap :global(.ev-pin-icon) {
		display: grid;
		color: var(--surface);
		transform: rotate(45deg);
	}
	.wrap :global(.ev-marker-wrap.active .ev-pin) {
		border-color: var(--accent);
		box-shadow: var(--shadow-lift);
	}
	.wrap :global(.ev-cluster) {
		display: grid;
		place-items: center;
		width: var(--control);
		height: var(--control);
		box-sizing: border-box;
		border: 2px solid var(--surface);
		border-radius: var(--radius-full);
		background: var(--accent);
		color: var(--accent-ink);
		font: var(--fw-strong) var(--text-md) var(--font-body);
		font-variant-numeric: tabular-nums;
		box-shadow: var(--shadow-card);
	}
	.wrap :global(.ev-marker-wrap.active .ev-cluster) {
		border-color: var(--text);
		box-shadow: var(--shadow-lift);
	}
</style>
