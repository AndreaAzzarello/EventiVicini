<script lang="ts">
	import Map from '@lucide/svelte/icons/map';
	import { onMount, untrack } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import EventList from '$lib/components/EventList.svelte';
	import FilterBar from '$lib/components/FilterBar.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import type { Event } from '$lib/event';
	import { EMPTY_FILTER, applyFilter, filterFromParams, filterToParams, type Filter } from '$lib/filters';
	import { fmtNum } from '$lib/format';
	import { sections } from '$lib/sections';

	/** Card per pagina: lo stesso numero del server (routes/citta/[slug]/+page.server.ts). */
	const PAGE_SIZE = 24;

	let { data } = $props();
	let now = $state(Date.now());
	let mounted = $state(false);
	onMount(() => {
		now = Date.now();
		mounted = true;
	});
	const name = $derived(data.cityAlt ? `${data.city} / ${data.cityAlt}` : data.city);
	const where = $derived(data.province ? `${name} (${data.province})` : name);
	// Stessi filtri della home (data, gratis, bambini, categoria) nell'URL; il raggio qui non c'è: il luogo è la città.
	let filter = $state<Filter>(filterFromParams(page.url.searchParams));
	const query = $derived(filterToParams(filter).toString());

	// Città grande: l'HTML ha una pagina di card (?pagina=N, già filtrata dal server). La lista completa si scarica da
	// /api/citta/<slug> solo se serve (Mostra altri, cambio di filtro): finché non c'è si mostra la pagina del server.
	let full = $state<Event[] | null>(null);
	let loadingAll = $state(false);
	let loadError = $state('');
	let touched = $state(false); // filtri cambiati nel browser: si riparte dall'inizio della lista filtrata
	let extra = $state(0); // card aggiunte con «Mostra altri»
	$effect(() => {
		void data.slug;
		untrack(() => (full = null)); // un'altra città: la lista scaricata non vale più
	});
	$effect(() => {
		void data;
		untrack(() => {
			extra = 0;
			touched = false;
		});
	});
	const source = $derived<Event[] | null>(data.all ? data.events : full);
	const partial = $derived(!data.all && !touched && full === null);
	const flat = $derived(source ? sections(applyFilter(source, filter, now, null), now) : []);
	const flatEvents = $derived(flat.flatMap((g) => g.events));
	const base = $derived(touched ? 0 : (data.pagina - 1) * PAGE_SIZE);
	const end = $derived(base + PAGE_SIZE + extra);
	const visible = $derived<Event[]>(data.all ? flat.flatMap((g) => g.events) : partial ? data.events : flatEvents.slice(base, end));
	const totalFiltered = $derived(data.all ? visible.length : partial ? data.total : flatEvents.length);
	const counts = $derived(data.all ? null : partial ? data.sectionCounts : Object.fromEntries(flat.map((g) => [g.key, g.events.length])));
	const remaining = $derived(data.all ? 0 : totalFiltered - (partial ? data.pagina * PAGE_SIZE : end));
	const waiting = $derived(!data.all && !source && touched); // filtro cambiato, lista completa in arrivo
	const total = $derived(data.all ? data.events.filter((e) => e.endTime >= now).length : data.liveCount);

	async function ensureAll() {
		if (full || loadingAll) return;
		loadingAll = true;
		loadError = '';
		try {
			const res = await fetch(`/api/citta/${data.slug}`);
			if (!res.ok) throw new Error(String(res.status));
			full = await res.json();
		} catch {
			loadError = 'Non riesco a caricare gli altri eventi. Riprova.';
		} finally {
			loadingAll = false;
		}
	}
	async function more() {
		await ensureAll();
		if (full) extra += PAGE_SIZE;
	}
	function setFilter(f: Filter) {
		filter = f;
		touched = true;
		extra = 0;
		const q = filterToParams(f).toString();
		replaceState(q ? `?${q}` : page.url.pathname, page.state);
		if (!data.all) ensureAll();
	}
	const pageHref = (n: number) => {
		const q = [query, n > 1 ? `pagina=${n}` : ''].filter(Boolean).join('&');
		return `${page.url.pathname}${q ? `?${q}` : ''}`;
	};
</script>

<Seo
	title={data.pagina > 1 ? `Eventi a ${name} · pagina ${data.pagina}` : `Eventi a ${name}`}
	description={`${fmtNum(data.liveCount)} eventi in programma a ${where}${data.region ? `, ${data.region}` : ''}: concerti, sagre, mostre, mercatini e attività per bambini.`}
	path={data.pagina > 1 ? `${page.url.pathname}?pagina=${data.pagina}` : page.url.pathname}
/>

<div class="container narrow">
	<nav class="crumbs" aria-label="Percorso">
		<a href="/">Eventi Vicini</a> <span aria-hidden="true">›</span>
		{#if data.regionSlug}<a href={`/regione/${data.regionSlug}`}>{data.region}</a> <span aria-hidden="true">›</span>
		{:else if data.region}<span>{data.region}</span> <span aria-hidden="true">›</span>{/if}
		<span aria-current="page">{name}</span>
	</nav>
	<h1>Eventi a {name}</h1>
	<p class="muted lead">
		{totalFiltered === 1 ? 'Un evento in programma' : `${fmtNum(totalFiltered)} eventi in programma`}{total !== totalFiltered ? ` (di ${fmtNum(total)})` : ''} a {where}.
	</p>
	<p class="map-link"><a class="btn btn-sm" href={`/?luogo=${data.slug}&vista=mappa${query ? `&${query}` : ''}`}><Map size={16} aria-hidden="true" /> Vedi sulla mappa</a></p>
	<FilterBar {filter} onchange={setFilter} showRadius={false} />
	<EventList events={visible} {now} {counts} loading={waiting}>
		{#snippet empty()}
			{#if total > 0}
				<h2>Niente con questi filtri</h2>
				<p class="muted">A {data.city} ci sono {fmtNum(total)} eventi: prova a togliere qualche filtro.</p>
				<button class="btn" onclick={() => setFilter(EMPTY_FILTER)}>Azzera i filtri</button>
			{:else}
				<h2>Per ora niente in programma</h2>
				<p class="muted">Conosci un evento a {data.city}? <a href="/proponi">Proponilo</a>.</p>
			{/if}
		{/snippet}
	</EventList>
	{#if data.pages > 1 && !data.all}
		{#if mounted}
			{#if remaining > 0}
				<p class="more">
					<button type="button" class="btn" onclick={more} disabled={loadingAll}>{loadingAll ? 'Carico…' : `Mostra altri (${fmtNum(Math.min(PAGE_SIZE, remaining))} di ${fmtNum(remaining)})`}</button>
				</p>
			{/if}
			{#if loadError}<p class="more" role="status">{loadError}</p>{/if}
		{:else}
			<nav class="pager" aria-label="Pagine degli eventi">
				{#if data.pagina > 1}<a href={pageHref(data.pagina - 1)} rel="prev">Pagina precedente</a>{/if}
				<span aria-current="page">Pagina {data.pagina} di {data.pages}</span>
				{#if data.pagina < data.pages}<a href={pageHref(data.pagina + 1)} rel="next">Pagina successiva</a>{/if}
			</nav>
		{/if}
	{/if}
</div>

<style>
	.crumbs {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		padding: var(--space-4) 0 var(--space-2);
		font-size: var(--text-sm);
		color: var(--muted);
	}
	.lead {
		font-size: var(--text-md);
		margin-bottom: var(--space-3);
	}
	.map-link {
		margin: 0 0 var(--space-3);
	}
	.more {
		margin: var(--space-4) 0 0;
		text-align: center;
		color: var(--muted);
	}
	.pager {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: var(--space-4);
		margin: var(--space-5) 0 0;
	}
</style>
