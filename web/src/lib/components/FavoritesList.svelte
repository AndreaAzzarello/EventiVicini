<script lang="ts">
	import { onMount } from 'svelte';
	import { compareEvents, type Event } from '$lib/event';
	import { errorMessage } from '$lib/errors';
	import { favorites, session } from '$lib/session.svelte';
	import EventList from './EventList.svelte';

	let events = $state<Event[]>([]);
	let loading = $state(true);
	let error = $state('');
	let now = $state(Date.now());
	let loadedKey: string | null = null; // null: mai caricato (la chiave di una lista vuota è '')

	// I dati arrivano da /api/events?ids= (cache all'edge), uguale per chi ha l'account e per chi no.
	async function load(ids: string[]) {
		const key = [...ids].sort().join(',');
		if (key === loadedKey) return;
		loadedKey = key;
		if (!ids.length) {
			events = [];
			loading = false;
			return;
		}
		loading = true;
		error = '';
		try {
			// Blocchi da 25: tanti sono gli id che l'API accetta per richiesta.
			const parts = Array.from({ length: Math.ceil(ids.length / 25) }, (_, i) => ids.slice(i * 25, i * 25 + 25).sort().join(','));
			const lists = await Promise.all(
				parts.map(async (p) => {
					const res = await fetch(`/api/events?ids=${encodeURIComponent(p)}`);
					if (!res.ok) throw new Error();
					return (await res.json()) as Event[];
				})
			);
			events = lists.flat();
		} catch (e) {
			error = errorMessage(e, 'Non riesco a caricare i preferiti.');
			loadedKey = null;
		} finally {
			loading = false;
		}
	}

	onMount(() => (now = Date.now()));
	$effect(() => {
		if (session.status === 'ready') load(favorites.ids);
	});

	// Togliere un preferito lo nasconde subito senza ricaricare.
	const shown = $derived(
		events.filter((e) => favorites.has(e.id)).sort((a, b) => (a.endTime < now ? 1 : 0) - (b.endTime < now ? 1 : 0) || compareEvents(now)(a, b))
	);
</script>

<EventList events={shown} {now} {loading} {error} onretry={() => ((loadedKey = null), load(favorites.ids))}>
	{#snippet empty()}
		<h2>Ancora nessun preferito</h2>
		<p class="muted">Tocca il cuore su un evento per ritrovarlo qui.</p>
		<a class="btn btn-primary" href="/">Scopri gli eventi</a>
	{/snippet}
</EventList>
