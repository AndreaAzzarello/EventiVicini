<script lang="ts">
	import Map from '@lucide/svelte/icons/map';
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import EventList from '$lib/components/EventList.svelte';
	import FilterBar from '$lib/components/FilterBar.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import { EMPTY_FILTER, applyFilter, filterFromParams, filterToParams, type Filter } from '$lib/filters';
	import { fmtNum } from '$lib/format';

	let { data } = $props();
	let now = $state(Date.now());
	onMount(() => (now = Date.now()));
	const name = $derived(data.cityAlt ? `${data.city} / ${data.cityAlt}` : data.city);
	const where = $derived(data.province ? `${name} (${data.province})` : name);
	// Stessi filtri della home (data, gratis, bambini, categoria) nell'URL; il raggio qui non c'è: il luogo è la città.
	let filter = $state<Filter>(filterFromParams(page.url.searchParams));
	const query = $derived(filterToParams(filter).toString());
	const visible = $derived(applyFilter(data.events, filter, now, null));
	const total = $derived(data.events.filter((e) => e.endTime >= now).length);
	function setFilter(f: Filter) {
		filter = f;
		const q = filterToParams(f).toString();
		replaceState(q ? `?${q}` : page.url.pathname, page.state);
	}
</script>

<Seo
	title={`Eventi a ${name}`}
	description={`${fmtNum(data.events.length)} eventi in programma a ${where}${data.region ? `, ${data.region}` : ''}: concerti, sagre, mostre, mercatini e attività per bambini.`}
	path={page.url.pathname}
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
		{visible.length === 1 ? 'Un evento in programma' : `${fmtNum(visible.length)} eventi in programma`}{total !== visible.length ? ` (di ${fmtNum(total)})` : ''} a {where}.
	</p>
	<p class="map-link"><a class="btn btn-sm" href={`/?luogo=${data.slug}&vista=mappa${query ? `&${query}` : ''}`}><Map size={16} aria-hidden="true" /> Vedi sulla mappa</a></p>
	<FilterBar {filter} onchange={setFilter} showRadius={false} />
	<EventList events={visible} {now}>
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
</style>
