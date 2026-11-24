<script lang="ts">
	import { goto } from '$app/navigation';
	import CalendarDays from '@lucide/svelte/icons/calendar-days';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import Search from '@lucide/svelte/icons/search';
	import { comuniStore } from '$lib/comuni.svelte';
	import { coverageStore } from '$lib/coverage.svelte';
	import { eventPath, type Event } from '$lib/event';
	import type { Filter } from '$lib/filters';
	import { fmtNum } from '$lib/format';
	import type { ChosenPlace } from '$lib/geo';
	import { debounce, searchPlaces } from '$lib/geocode';
	import { nearCovered, popularPlaces, rankPlaces, REGION_RADIUS_KM, type PlaceHit } from '$lib/places';

	let {
		filter,
		onfilter,
		onplace,
		eventMatches,
		placesOnly = false,
		label = 'Cerca eventi o luoghi'
	}: {
		filter: Filter;
		onfilter: (f: Filter) => void;
		onplace: (p: ChosenPlace, opts?: { radiusKm?: number }) => void;
		/** Eventi che corrispondono al testo, già nel raggio e con i filtri attuali. */
		eventMatches: (text: string) => Event[];
		/** Solo luoghi (prima visita): non filtra gli eventi. */
		placesOnly?: boolean;
		label?: string;
	} = $props();

	const uid = $props.id();
	const listId = `${uid}-list`;

	let input: HTMLInputElement | undefined = $state();
	let box: HTMLDivElement | undefined = $state();
	let pop: HTMLDivElement | undefined = $state();
	let typed = $state<string | null>(null); // testo digitato, prima che il filtro lo recepisca
	let open = $state(false);
	let active = $state(-1);
	let showPopular = $state(false);
	let remote = $state<PlaceHit[]>([]);
	let remoteBusy = $state(false);

	const text = $derived(typed ?? (placesOnly ? '' : filter.q));

	// Il filtro ha recepito il testo (o è stato azzerato da fuori): torna a essere lui la fonte.
	$effect(() => {
		if (!placesOnly) {
			void filter.q;
			typed = null;
		}
	});
	const trimmed = $derived(text.trim());
	const local = $derived(rankPlaces(trimmed, coverageStore.regions, 6, comuniStore.index));
	const events = $derived(placesOnly || trimmed.length < 2 ? [] : eventMatches(trimmed).slice(0, 3));
	const places = $derived(
		trimmed.length < 2 ? (showPopular ? popularPlaces(coverageStore.regions) : []) : local.length ? local : remote
	);
	const options = $derived([
		...places.map((hit) => ({ type: 'place' as const, hit })),
		...events.map((event) => ({ type: 'event' as const, event }))
	]);
	const expanded = $derived(open && options.length > 0);
	const status = $derived(
		open && trimmed.length >= 2
			? `${places.length} luoghi${placesOnly ? '' : `, ${events.length} eventi`}`
			: remoteBusy
				? 'Cerco il luogo…'
				: ''
	);

	// `gen` invalida un commit già in attesa: scegliendo un luogo prima che scatti, il testo non deve rientrare nel filtro.
	let gen = 0;
	const commit = debounce((v: string, g: number) => g === gen && onfilter({ ...filter, q: v }), 250);

	// Località non coperte: solo se il testo non è né un luogo coperto né un evento, e con più pazienza
	// (Nominatim non è pensato per l'autocompletamento: debounce lungo, cache, 1 richiesta al secondo).
	const searchRemote = debounce(async (v: string) => {
		await comuniStore.load(); // prima di cercare altrove si guarda in tutti i comuni
		if (v !== trimmed || v.length < 4 || rankPlaces(v, coverageStore.regions, 6, comuniStore.index).length || (!placesOnly && eventMatches(v).length)) return;
		remoteBusy = true;
		try {
			const found = await searchPlaces(v, 'city');
			if (v !== trimmed) return; // nel frattempo il testo è cambiato
			remote = found.slice(0, 4).map((r) => ({
				kind: 'comune' as const,
				place: { lat: r.lat, lng: r.lng, label: r.place?.city ?? r.label.split(',')[0] },
				detail: r.label,
				events: nearCovered(r, coverageStore.regions) ? 1 : 0,
				score: 0
			}));
		} catch {
			remote = [];
		} finally {
			remoteBusy = false;
		}
	}, 800);

	export function openPlaces() {
		showPopular = true;
		open = true;
		load();
		input?.focus();
	}

	function oninput() {
		const v = input!.value;
		typed = v;
		if (!placesOnly) commit(v, ++gen);
		showPopular = false;
		remote = [];
		open = true;
		active = -1;
		load();
		searchRemote(v.trim());
	}

	/** Copertura (eventi per comune) ed elenco di tutti i comuni: al primo uso della barra, non prima. */
	function load() {
		coverageStore.load();
		comuniStore.load();
	}

	function onfocus() {
		load();
		if (placesOnly) {
			showPopular = true;
			open = true;
		}
	}

	function close() {
		open = false;
		active = -1;
	}

	function pick(i: number) {
		const o = options[i];
		if (!o) return;
		close();
		gen++;
		if (o.type === 'event') return void goto(eventPath(o.event));
		typed = null;
		showPopular = false;
		remote = [];
		onplace(o.hit.place, o.hit.kind === 'regione' ? { radiusKm: REGION_RADIUS_KM } : undefined);
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			if (!options.length) return;
			e.preventDefault();
			open = true;
			const step = e.key === 'ArrowDown' ? 1 : -1;
			active = (active + step + options.length) % options.length;
		} else if (e.key === 'Enter') {
			e.preventDefault();
			if (expanded && active >= 0) pick(active);
			else if (!placesOnly) {
				onfilter({ ...filter, q: input!.value });
				close();
			}
		} else if (e.key === 'Escape' && expanded) {
			e.preventDefault();
			close();
		}
	}

	/**
	 * Altezza del menu = area realmente visibile sotto il campo. Con la tastiera di iOS il layout viewport non si ridimensiona:
	 * conta il visualViewport (ripiego: innerHeight, e il valore di default del CSS). Se restano meno di 3 righe, il campo sale
	 * sotto l'header (scroll-margin-top) per far posto ai suggerimenti.
	 */
	function fit() {
		if (!pop || !box || !input) return;
		const row = input.offsetHeight || 48;
		const vv = window.visualViewport;
		const room = () => (vv ? vv.offsetTop + vv.height : innerHeight) - pop!.getBoundingClientRect().top - 8;
		if (room() < 3 * row) box.scrollIntoView({ block: 'start' });
		pop.style.setProperty('--pop-max', `${Math.max(2 * row, Math.floor(room()))}px`);
	}

	$effect(() => {
		if (!expanded) return;
		fit();
		const vv = window.visualViewport;
		vv?.addEventListener('resize', fit);
		vv?.addEventListener('scroll', fit);
		addEventListener('resize', fit);
		return () => {
			vv?.removeEventListener('resize', fit);
			vv?.removeEventListener('scroll', fit);
			removeEventListener('resize', fit);
		};
	});

	// Con le frecce l'opzione attiva resta dentro il menu che scorre.
	$effect(() => {
		if (expanded && active >= 0) document.getElementById(`${uid}-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
	});

	function onfocusout(e: FocusEvent) {
		if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) close();
	}
</script>

<div class="box" bind:this={box} onfocusout={onfocusout}>
	<label for={placesOnly ? `q-${uid}` : 'q'} class="visually-hidden">{label}</label>
	<Search size={20} aria-hidden="true" />
	<input
		id={placesOnly ? `q-${uid}` : 'q'}
		bind:this={input}
		type="search"
		role="combobox"
		aria-expanded={expanded}
		aria-controls={listId}
		aria-autocomplete="list"
		aria-activedescendant={expanded && active >= 0 ? `${uid}-opt-${active}` : undefined}
		placeholder={label}
		value={text}
		{oninput}
		{onkeydown}
		{onfocus}
		autocomplete="off"
		enterkeyhint="search"
	/>
	<p class="visually-hidden" role="status">{status}</p>
	<div class="pop" bind:this={pop} hidden={!expanded}>
		<ul id={listId} role="listbox" aria-label="Suggerimenti">
			{#if places.length}
				<li role="presentation" class="group">
					<span class="group-title" aria-hidden="true">Luoghi</span>
					<ul role="group" aria-label="Luoghi">
						{#each places as hit, i (hit.place.label + hit.place.lat)}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<li
								id="{uid}-opt-{i}"
								role="option"
								aria-selected={active === i}
								class:on={active === i}
								onmousedown={(e) => e.preventDefault()}
								onclick={() => pick(i)}
							>
								<MapPin size={16} aria-hidden="true" />
								<span class="grow"><span class="name">{hit.place.label}</span> <span class="muted">{hit.detail}</span></span>
								<span class="n">
									{#if hit.events > 0 && hit.place.slug !== undefined}{hit.events === 1 ? '1 evento' : `${fmtNum(hit.events)} eventi`}{:else if hit.place.slug === undefined && hit.events === 0}Pochi eventi in questa zona{/if}
								</span>
							</li>
						{/each}
					</ul>
				</li>
			{/if}
			{#if events.length}
				<li role="presentation" class="group">
					<span class="group-title" aria-hidden="true">Eventi</span>
					<ul role="group" aria-label="Eventi">
						{#each events as event, j (event.id)}
							{@const i = places.length + j}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<li
								id="{uid}-opt-{i}"
								role="option"
								aria-selected={active === i}
								class:on={active === i}
								onmousedown={(e) => e.preventDefault()}
								onclick={() => pick(i)}
							>
								<CalendarDays size={16} aria-hidden="true" />
								<span class="grow"><span class="name">{event.title}</span> <span class="muted">{event.city}</span></span>
							</li>
						{/each}
					</ul>
				</li>
			{/if}
		</ul>
		{#if remote.length && !local.length}
			<p class="attribution">Ricerca luoghi: &copy; OpenStreetMap / Nominatim</p>
		{/if}
	</div>
</div>

<style>
	.box {
		position: relative;
		display: flex;
		align-items: center;
		scroll-margin-top: calc(var(--header-offset) + var(--space-2));
	}
	.box > :global(svg) {
		position: absolute;
		left: var(--space-3);
		color: var(--muted);
		pointer-events: none;
	}
	input {
		padding-left: var(--space-6);
		min-height: var(--control);
		border-radius: var(--radius);
		font-size: var(--text-md);
	}
	.pop {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		z-index: var(--z-menu);
		margin-top: var(--space-1);
		/* --pop-max: area visibile sotto il campo (la imposta fit() in px); di partenza il 60% dell'altezza minima dello schermo */
		--pop-max: 60svh;
		max-height: min(var(--w-dialog), var(--pop-max));
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: var(--space-2);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		box-shadow: var(--shadow-overlay);
	}
	.pop[hidden] {
		display: none;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.group + .group {
		margin-top: var(--space-2);
	}
	.group-title {
		display: block;
		padding: var(--space-1) var(--space-2);
		color: var(--muted);
		font-size: var(--text-sm);
		font-weight: var(--fw-strong);
	}
	[role='option'] {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-height: var(--control);
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}
	[role='option']:hover,
	[role='option'].on {
		background: var(--surface-2);
	}
	[role='option'].on {
		outline: 2px solid var(--focus);
		outline-offset: 0;
	}
	[role='option'] :global(svg) {
		flex: none;
		color: var(--accent);
	}
	.grow {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.name {
		font-weight: var(--fw-strong);
	}
	.muted,
	.n {
		color: var(--muted);
		font-size: var(--text-sm);
	}
	.n {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.attribution {
		margin: var(--space-2) var(--space-2) 0;
		color: var(--muted);
		font-size: var(--text-xs);
	}
</style>
