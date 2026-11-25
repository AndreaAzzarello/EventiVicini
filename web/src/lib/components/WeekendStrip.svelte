<script lang="ts">
	import type { Event } from '$lib/event';
	import EventCard from './EventCard.svelte';

	// «Questo weekend» (#22): pochi eventi da città e regioni diverse per chi arriva senza un luogo. La scelta è fatta dal server
	// (weekend.ts); qui solo il disegno. Senza eventi non c'è niente.
	let { events, now }: { events: Event[]; now: number } = $props();
</script>

{#if events.length}
	<section class="weekend" aria-labelledby="we-title">
		<h2 id="we-title">Questo weekend</h2>
		<ul class="list">
			{#each events as e (e.id)}
				<li><EventCard event={e} {now} compact /></li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	.weekend {
		margin: var(--space-4) 0;
	}
	.weekend h2 {
		margin: 0 0 var(--space-2);
	}
	.list {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	:global(html[data-saved-place]) .weekend {
		display: none;
	}
</style>
