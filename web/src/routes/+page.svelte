<script lang="ts">
	import List from '@lucide/svelte/icons/list';
	import CalendarPlus from '@lucide/svelte/icons/calendar-plus';
	import Landmark from '@lucide/svelte/icons/landmark';
	import LocateFixed from '@lucide/svelte/icons/locate-fixed';
	import Map from '@lucide/svelte/icons/map';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import { onMount, untrack } from 'svelte';
	import { goto, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import EventList from '$lib/components/EventList.svelte';
	import EventsMap from '$lib/components/EventsMap.svelte';
	import FilterBar from '$lib/components/FilterBar.svelte';
	import SearchBox from '$lib/components/SearchBox.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import { comuniStore } from '$lib/comuni.svelte';
	import { coverageStore } from '$lib/coverage.svelte';
	import type { Event } from '$lib/event';
	import { applyFilter, filterFromParams, type Filter } from '$lib/filters';
	import { DEFAULT_RADIUS_KM, distanceKm, SNAP_MARGIN_KM, snapCoord, type ChosenPlace } from '$lib/geo';
	import { fmtNum } from '$lib/format';
	import { locateMe } from '$lib/locate';
	import { homeUrl, nearestComune, strongPlace } from '$lib/places';
	import { homePlace } from '$lib/session.svelte';
	import { KEYS, readJson, writeJson } from '$lib/storage';

	let { data } = $props();

	let filter = $state<Filter>(filterFromParams(page.url.searchParams));
	// Il luogo vive nell'URL (?luogo= / ?nome=&lat=&lng=): lo risolve la load, il resto della pagina lo segue.
	// La posizione del dispositivo (esatta) vive solo qui e in localStorage: nell'URL c'è al più il comune coperto più vicino.
	let here = $state<ChosenPlace | null>(null);
	const place = $derived<ChosenPlace>(
		here && (here.slug ? data.place.slug === here.slug : !data.fromUrl) ? here : data.place
	);
	let events = $derived<Event[]>(data.events);
	let fetched = $derived(data.fetched);
	let loading = $state(false);
	let error = $derived(data.error);
	let now = $state(Date.now());
	let view = $state<'list' | 'map'>(page.url.searchParams.get('vista') === 'mappa' ? 'map' : 'list');
	let wide = $state(false);
	let highlighted = $state<string | null>(null);
	let search: SearchBox | undefined = $state();
	/** Primo accesso senza posizione salvata né permesso di geolocalizzazione: si sceglie il luogo dalla ricerca. */
	let needsPlace = $state(untrack(() => data.noPlace)); // senza luogo nell'URL si parte dalla scelta, anche nell'HTML del server
	/** Senza luogo nell'URL il server non ha caricato eventi: finché il browser non sa dove cercare non si scarica nulla. */
	const pending = $derived(data.noPlace && !here);
	let locating = $state(false);
	let locateMsg = $state('');

	const visible = $derived(applyFilter(events, filter, now, place));
	const covered = $derived(distanceKm(place, fetched) + filter.radiusKm <= fetched.km);
	const eventMatches = (text: string) => applyFilter(events, { ...filter, q: text }, now, place);
	const placeHit = $derived(filter.q.trim() ? strongPlace(filter.q, coverageStore.regions, comuniStore.index) : null);

	const nav = { keepFocus: true, noScroll: true } as const;

	onMount(() => {
		if (data.unknownPlace !== null) {
			locateMsg = data.unknownPlace ? `Non trovo il luogo «${data.unknownPlace}». Cerca il tuo comune o la tua regione.` : 'Non trovo il luogo del link. Cerca il tuo comune o la tua regione.';
			needsPlace = true;
			document.documentElement.removeAttribute('data-saved-place'); // la scelta del luogo deve vedersi
		}
		const mq = matchMedia('(min-width: 960px)');
		wide = mq.matches;
		mq.onchange = (e) => (wide = e.matches);
		const tick = setInterval(() => (now = Date.now()), 60_000);
		return () => clearInterval(tick);
	});

	// Home senza luogo (anche tornando a "/" dal logo): il luogo salvato nel browser diventa l'indirizzo, altrimenti si chiede dove cercare.
	$effect(() => {
		if (!data.noPlace) return;
		untrack(() => {
			const saved = readJson<ChosenPlace | null>(KEYS.place, null);
			if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lng)) {
				if (saved.exact) here = saved;
				needsPlace = false;
				// Una posizione senza comune coperto non ha parametri da mettere nell'URL: gli eventi si scaricano da qui.
				if (!(saved.exact && !saved.slug)) goto(homeUrl(filter, saved, view), { replaceState: true, ...nav });
			} else {
				document.documentElement.removeAttribute('data-saved-place'); // la CSS nascondeva la scelta in attesa del luogo salvato
				firstVisit();
			}
		});
	});

	// Indietro/avanti cambiano l'URL: i filtri lo seguono. L'URL può chiedere la mappa (?vista=mappa) ma non
	// rimette la lista: dopo un replaceState la voce di cronologia riprende l'URL originale, senza `vista`.
	$effect(() => {
		const f = filterFromParams(page.url.searchParams);
		const wantsMap = page.url.searchParams.get('vista') === 'mappa';
		untrack(() => {
			if (JSON.stringify(f) !== JSON.stringify(filter)) filter = f;
			if (wantsMap) view = 'map';
		});
	});

	// Al login la zona del profilo vince su quella locale, ma non su un link con un luogo esplicito.
	// Si applica una sola volta per valore del profilo e senza dipendere da `place`: altrimenti ogni
	// scelta dell'utente rilanciava l'effetto e la zona (ancora vecchia nel profilo) tornava indietro.
	let appliedProfile: ChosenPlace | null = null;
	$effect(() => {
		const p = homePlace.value;
		if (!p || p === appliedProfile) return;
		appliedProfile = p;
		untrack(() => {
			if (data.fromUrl || data.unknownPlace !== null) return;
			needsPlace = false;
			if (p.lat !== place.lat || p.lng !== place.lng) goto(homeUrl(filter, p, view), { replaceState: true, ...nav });
		});
	});

	$effect(() => {
		if (filter.q) {
			coverageStore.load();
			comuniStore.load();
		}
	});

	/** Con il permesso già concesso si parte dalla posizione; altrimenti si chiede dove cercare, senza partire da Modena. */
	async function firstVisit() {
		const granted = await navigator.permissions
			?.query({ name: 'geolocation' })
			.then((s) => s.state === 'granted')
			.catch(() => false);
		if (granted) await locate();
		if (!granted || locateMsg) needsPlace = true;
	}

	// Ricarica solo se la zona richiesta esce da quella già scaricata.
	$effect(() => {
		if (!covered && !pending) load();
	});

	let seq = 0;
	async function load() {
		const mine = ++seq;
		loading = true;
		error = '';
		const lat = snapCoord(place.lat);
		const lng = snapCoord(place.lng);
		const r = filter.radiusKm;
		try {
			const res = await fetch(`/api/events?lat=${lat}&lng=${lng}&r=${r}`);
			if (!res.ok) throw new Error(String(res.status));
			const list = await res.json();
			if (mine !== seq) return; // nel frattempo l'utente ha cambiato zona: risposta vecchia, la scarto
			events = list;
			fetched = { lat, lng, km: r + SNAP_MARGIN_KM };
		} catch {
			if (mine === seq) error = 'Non riesco a caricare gli eventi. Controlla la connessione e riprova.';
		} finally {
			if (mine === seq) loading = false;
		}
	}

	/** Filtri e vista restano nell'URL accanto al luogo, senza nuove voci nella cronologia. */
	function syncUrl(f: Filter, v = view) {
		replaceState(homeUrl(f, data.fromUrl ? place : null, v), {});
	}

	function setFilter(f: Filter) {
		filter = f;
		syncUrl(f);
	}

	function setView(v: 'list' | 'map') {
		view = v;
		syncUrl(filter, v);
	}

	/** Scelta dell'utente (ricerca, "Usa la mia posizione"): salva, naviga e il resto segue l'URL. */
	function choosePlace(p: ChosenPlace, opts: { radiusKm?: number; profile?: ChosenPlace | null } = {}) {
		// Una località senza slug mette le sue coordinate nell'URL: a ~1 km bastano. La posizione del dispositivo no, mai.
		const chosen = p.slug || p.exact ? p : { ...p, lat: Number(p.lat.toFixed(2)), lng: Number(p.lng.toFixed(2)) };
		const f = { ...filter, q: '', ...(opts.radiusKm ? { radiusKm: opts.radiusKm } : {}) };
		filter = f;
		here = chosen.exact ? chosen : null;
		needsPlace = false;
		locateMsg = '';
		writeJson(KEYS.place, chosen);
		// Nel profilo (su Firestore) la posizione esatta non entra: solo il comune coperto, se c'è.
		const forProfile = opts.profile === undefined ? (chosen.exact ? null : chosen) : opts.profile;
		if (forProfile) homePlace.save(forProfile);
		goto(homeUrl(f, chosen, view), nav);
	}

	async function locate() {
		locating = true;
		locateMsg = '';
		try {
			const pos = await locateMe();
			await coverageStore.load();
			const near = nearestComune(pos, coverageStore.regions);
			choosePlace(
				{ ...pos, label: near ? `Vicino a ${near.label}` : 'La tua posizione', slug: near?.slug, region: near?.region, exact: true },
				{ profile: near }
			);
		} catch (e) {
			locateMsg = (e as Error).message;
		} finally {
			locating = false;
		}
	}

	/** Nessun evento vicino al luogo scelto: il raggio è stato allargato fino a trovarne (vedi autoRadius). */
	const widened = $derived(data.quiet && data.fromUrl && filter.radiusKm > DEFAULT_RADIUS_KM && !loading && !error && !pending && !filter.q.trim() && visible.length > 0);
	const count = $derived(visible.length === 1 ? '1 evento' : `${fmtNum(visible.length)} eventi`);
</script>

<!-- Il canonical resta "/" (Seo con path="/"); il titolo segue il luogo dell'URL, deciso dal server. -->
<Seo title={data.fromUrl ? `Eventi a ${data.place.label} e dintorni` : 'Cosa fare oggi e nel weekend vicino a te'} path="/" />

<div class="container home">
	<section class="intro" aria-labelledby="h1">
		<h1 id="h1" class="display">Cosa succede <span class="display-em">vicino a te</span></h1>
		{#if !needsPlace}
			<div class="where">
				<p class="summary" aria-live="polite">
					{#if loading || pending}Cerco eventi…{:else}<!-- a capo solo tra i gruppi: «vicino a» resta con il luogo -->
						{#if error}<span class="nowrap">Elenco non disponibile</span>{:else}<span class="nowrap">{count}</span>{/if}
						<span class="nowrap">{error ? 'per' : 'vicino a'}
							<button type="button" class="place-link" onclick={() => search?.openPlaces()} aria-haspopup="listbox">
								<MapPin size={16} aria-hidden="true" />{place.label}</button></span> <span class="nowrap">· entro {filter.radiusKm} km</span>{/if}
				</p>
				<button type="button" class="btn btn-sm" onclick={locate} disabled={locating}>
					<LocateFixed size={16} aria-hidden="true" /> Usa la mia posizione
				</button>
			</div>
		{/if}
	</section>

	{#if needsPlace}
		<section class="first-visit" aria-labelledby="first-title">
			<h2 id="first-title">Dove cerchi eventi?</h2>
			<p class="muted">Scrivi il tuo comune o la tua regione, oppure usa la tua posizione.</p>
			<div class="first-search">
				<SearchBox placesOnly label="Comune o regione" {filter} onfilter={setFilter} onplace={choosePlace} {eventMatches} />
			</div>
			<button class="btn btn-primary" onclick={locate} disabled={locating}>
				<LocateFixed size={20} aria-hidden="true" /> Usa la mia posizione
			</button>
			<p class="hint" role="status">{locateMsg}</p>
			<ul class="welcome">
				<li><Landmark size={20} aria-hidden="true" /> Eventi pubblici vicino a te, dai Comuni e da fonti aperte</li>
				<li><ShieldCheck size={20} aria-hidden="true" /> Gratis, senza pubblicità né tracciamento</li>
				<li><CalendarPlus size={20} aria-hidden="true" /> Salva i preferiti e aggiungi gli eventi al calendario</li>
			</ul>
		</section>
		{#if data.popular && (data.popular.regions.length || data.popular.cities.length)}
			<nav class="popular" aria-labelledby="pop-title">
				<h2 id="pop-title">Oppure sfoglia per luogo</h2>
				{#if data.popular.cities.length}
					<ul class="pills" aria-label="Città con più eventi">
						{#each data.popular.cities as c (c.slug)}
							<li><a class="chip" href="/citta/{c.slug}">{c.name} <span class="n">{fmtNum(c.events)}</span></a></li>
						{/each}
					</ul>
				{/if}
				{#if data.popular.regions.length}
					<ul class="pills" aria-label="Regioni">
						{#each data.popular.regions as r (r.slug)}
							<li><a class="chip" href="/regione/{r.slug}">{r.name} <span class="n">{fmtNum(r.events)}</span></a></li>
						{/each}
					</ul>
				{/if}
			</nav>
		{/if}
		<!-- Chi ha già un luogo salvato (lo segnala app.html) vede lo scheletro delle card, non la scelta, mentre arriva il suo luogo -->
		<div class="pending-list" aria-hidden="true"><EventList events={[]} {now} loading /></div>
	{:else}
		<FilterBar {filter} onchange={setFilter}>
			<SearchBox bind:this={search} {filter} onfilter={setFilter} onplace={choosePlace} {eventMatches} />
		</FilterBar>

		<div class="toolbar">
			<div class="tabs" role="tablist" aria-label="Vista">
				<button role="tab" id="tab-list" aria-controls="panel-list" aria-selected={view === 'list'} onclick={() => setView('list')}>
					<List size={20} aria-hidden="true" /> Lista
				</button>
				<button role="tab" id="tab-map" aria-controls="panel-map" aria-selected={view === 'map'} onclick={() => setView('map')}>
					<Map size={20} aria-hidden="true" /> Mappa
				</button>
			</div>
		</div>
		<p class="hint" role="status">{locateMsg}</p>

		<div class="split" data-view={view}>
			<div id="panel-list" class="list-pane" role="tabpanel" aria-labelledby="tab-list">
				<h2 class="visually-hidden">Eventi in programma</h2>
				{#if widened}
					<p class="widened" role="status">
						<span class="strong">Nessun evento a {place.label} nei prossimi giorni.</span> Ti mostriamo gli eventi entro {filter.radiusKm} km.
					</p>
				{/if}
				<EventList
					events={visible}
					{now}
					origin={place}
					loading={loading || pending}
					{error}
					{highlighted}
					onhover={(id) => (highlighted = id)}
					onretry={load}
				>
					{#snippet empty()}
						{#if placeHit}
							<h2>Nessun evento con «{filter.q.trim()}» qui vicino</h2>
							<p class="muted">Cercavi il luogo? Vai a {placeHit.place.label}.</p>
							<div class="actions">
								<button
									class="btn btn-primary"
									onclick={() => choosePlace(placeHit.place, placeHit.kind === 'regione' ? { radiusKm: 100 } : {})}
								>
									Vai a {placeHit.place.label}
								</button>
							</div>
						{:else if data.quiet && data.nearest.length && !events.length}
							<h2>Nessun evento a {place.label} nei prossimi giorni</h2>
							<p class="muted">Gli eventi più vicini sono qui.</p>
							<div class="actions">
								{#each data.nearest as n (n.slug)}
									<button
										class="btn"
										onclick={() => choosePlace({ lat: n.lat, lng: n.lng, label: n.label, slug: n.slug, region: n.region })}
									>
										{n.label} · {fmtNum(n.km)} km
									</button>
								{/each}
							</div>
						{:else}
							<h2>
								{({ today: 'Oggi qui è tranquillo', tomorrow: 'Domani qui è tranquillo', weekend: 'Questo weekend qui è tranquillo', week: 'Nei prossimi giorni qui è tranquillo', range: 'In quelle date qui è tranquillo', any: 'Qui è tutto tranquillo' })[filter.when]}
							</h2>
							<p class="muted">
								Prova ad allargare la distanza{filter.when === 'weekend' ? '' : ', guarda il weekend'} o togli qualche filtro.
							</p>
							<div class="actions">
								{#if filter.when !== 'weekend'}
									<button class="btn" onclick={() => setFilter({ ...filter, when: 'weekend', from: '', to: '' })}>Guarda il weekend</button>
								{/if}
								{#if filter.radiusKm < 100}
									<button class="btn btn-primary" onclick={() => setFilter({ ...filter, radiusKm: filter.radiusKm < 50 ? 50 : 100 })}>
										Cerca più lontano
									</button>
								{/if}
								<a class="btn" href="/proponi">Proponi un evento</a>
							</div>
						{/if}
					{/snippet}
				</EventList>
			</div>
			<div id="panel-map" class="map-pane" role="tabpanel" aria-labelledby="tab-map">
				{#if wide || view === 'map'}
					<EventsMap
						events={visible}
						center={place}
						radiusKm={filter.radiusKm}
						{highlighted}
						onhover={(id) => (highlighted = id)}
					/>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	/* Uno schermo intero in ogni stato: il passaggio lista → prima visita non sposta il footer (CLS). */
	.home {
		min-height: 100svh;
	}
	.first-visit {
		margin: var(--space-4) 0;
		padding: var(--space-4);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		display: grid;
		justify-items: start;
		gap: var(--space-2);
	}
	.first-visit h2,
	.first-visit p {
		margin: 0;
	}
	.welcome {
		list-style: none;
		margin: var(--space-2) 0 0;
		padding: var(--space-3) 0 0;
		border-top: 1px dashed var(--border);
		width: 100%;
		display: grid;
		gap: var(--space-2);
	}
	.welcome li {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		color: var(--muted);
	}
	.welcome :global(svg) {
		flex: none;
		color: var(--accent);
	}
	.first-search {
		width: 100%;
	}
	/* Testata: un tagliando in tinta d'accento con un motivo a tratti (maschera SVG senza colori), come un manifesto */
	.intro {
		position: relative;
		margin: var(--space-3) 0;
		padding: var(--space-3);
		border: 1px solid var(--accent-border);
		border-radius: var(--radius);
		background: var(--accent-soft);
		overflow: hidden;
	}
	.intro::before {
		content: '';
		position: absolute;
		inset: 0;
		background: var(--accent);
		opacity: 0.1;
		-webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M3 21 8 16M15 9 21 3' stroke='black' stroke-width='1.5' stroke-linecap='round' fill='none'/%3E%3C/svg%3E");
		mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M3 21 8 16M15 9 21 3' stroke='black' stroke-width='1.5' stroke-linecap='round' fill='none'/%3E%3C/svg%3E");
		-webkit-mask-size: var(--space-4);
		mask-size: var(--space-4);
		pointer-events: none;
	}
	.intro > :global(*) {
		position: relative;
	}
	.intro h1 {
		margin: 0 0 var(--space-2);
	}
	.popular {
		margin: var(--space-4) 0;
	}
	.pills {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin: 0 0 var(--space-3);
		padding: 0;
		list-style: none;
	}
	.pills a {
		text-decoration: none;
		color: var(--text);
	}
	.n {
		color: var(--muted);
		font-size: var(--text-sm);
		font-variant-numeric: tabular-nums;
	}
	.pending-list {
		display: none;
	}
	:global(html[data-saved-place]) .first-visit,
	:global(html[data-saved-place]) .popular {
		display: none;
	}
	:global(html[data-saved-place]) .pending-list {
		display: block;
	}
	.hint {
		margin: 0;
		color: var(--muted);
		font-size: var(--text-sm);
	}
	.hint:empty {
		display: none;
	}
	.toolbar {
		display: flex;
		margin: var(--space-3) 0;
	}
	.widened {
		margin: 0 0 var(--space-3);
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--muted);
		font-size: var(--text-sm);
	}
	.widened .strong {
		color: var(--text);
		font-weight: var(--fw-strong);
	}
	.where {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		min-width: 0;
	}
	.summary {
		margin: 0;
		font-weight: var(--fw-strong);
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
	.place-link {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		min-height: var(--control-sm);
		padding: 0 var(--space-1);
		border: none;
		border-radius: var(--radius-sm);
		background: none;
		color: var(--accent-hover);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}
	.place-link:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.tabs {
		display: inline-flex;
		padding: var(--space-1);
		border-radius: var(--radius);
		background: var(--surface-2);
		border: 1px solid var(--border);
	}
	.tabs button {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		min-height: var(--control-sm);
		padding: 0 var(--space-3);
		border: none;
		border-radius: var(--radius-sm);
		background: none;
		color: var(--text);
		font: var(--fw-strong) var(--text-sm) var(--font-body);
		cursor: pointer;
	}
	.tabs [aria-selected='true'] {
		background: var(--surface);
		color: var(--accent);
	}
	/* Passando da lista a mappa il riquadro appare con una dissolvenza (con movimento ridotto è istantanea, vedi app.css) */
	.list-pane,
	.map-pane {
		animation: pane-in var(--dur) var(--ease);
	}
	@keyframes pane-in {
		from {
			opacity: 0;
		}
	}
	.nowrap {
		white-space: nowrap;
	}
	.split {
		margin-top: var(--space-3);
	}
	.split[data-view='list'] .map-pane,
	.split[data-view='map'] .list-pane {
		display: none;
	}
	.map-pane {
		height: calc(100dvh - var(--header-h) - var(--space-7) * 2);
		min-height: calc(var(--space-7) * 5);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: var(--space-2);
	}
	@media (min-width: 960px) {
		.toolbar {
			display: none;
		}
		.split {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr);
			gap: var(--space-4);
			align-items: start;
		}
		.split .list-pane,
		.split .map-pane {
			display: block !important;
		}
		.map-pane {
			position: sticky;
			top: calc(var(--header-h) + var(--space-3));
			height: calc(100vh - var(--header-h) - var(--space-5));
		}
	}
</style>
