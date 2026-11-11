<script lang="ts">
	import CalendarSearch from '@lucide/svelte/icons/calendar-search';
	import type { Snippet } from 'svelte';
	import type { Event } from '$lib/event';
	import { fmtNum } from '$lib/format';
	import type { LatLng } from '$lib/geo';
	import { sections } from '$lib/sections';
	import ErrorMessage from './ErrorMessage.svelte';
	import EventCard from './EventCard.svelte';

	let {
		events,
		now,
		origin = null,
		loading = false,
		error = '',
		highlighted = null,
		onhover,
		onretry,
		counts = null,
		empty
	}: {
		events: Event[];
		now: number;
		origin?: LatLng | null;
		loading?: boolean;
		error?: string;
		highlighted?: string | null;
		onhover?: (id: string | null) => void;
		onretry?: () => void;
		/** Conteggi dell'elenco intero per sezione, quando `events` ne mostra solo l'inizio (SSR parziale). */
		counts?: Record<string, number> | null;
		empty?: Snippet;
	} = $props();
</script>

{#if loading}
	<ul class="list" aria-hidden="true">
		{#each { length: 5 } as _, i (i)}
			<li class="sk card">
				<div class="skeleton sk-stub"></div>
				<div class="sk-lines">
					<div class="skeleton" style="width: 30%; height: var(--space-3)"></div>
					<div class="skeleton" style="width: 85%; height: var(--space-4)"></div>
					<div class="skeleton" style="width: 60%; height: var(--space-3)"></div>
				</div>
				<div class="skeleton sk-media"></div>
			</li>
		{/each}
	</ul>
	<p class="visually-hidden" role="status">Caricamento degli eventi…</p>
{:else if error}
	<div class="state">
		<h2>Ops, qualcosa non ha funzionato</h2>
		<ErrorMessage>{error}</ErrorMessage>
		{#if onretry}<button class="btn btn-primary" onclick={onretry}>Riprova</button>{/if}
	</div>
{:else if events.length === 0}
	<div class="state">
		<CalendarSearch size={24} aria-hidden="true" />
		{#if empty}{@render empty()}{:else}<h2>Per ora non c’è niente da mostrare</h2>{/if}
	</div>
{:else}
	{#each sections(events, now) as section (section.key)}
		<section class="sect" aria-labelledby="sez-{section.key}">
			<h2 id="sez-{section.key}">{section.title} <span class="count">{fmtNum(counts?.[section.key] ?? section.events.length)}</span></h2>
			<ul class="list">
				{#each section.events as event (event.id)}
					<li><EventCard {event} {now} {origin} highlighted={highlighted === event.id} compact={section.key === 'running'} {onhover} /></li>
				{/each}
			</ul>
		</section>
	{/each}
{/if}

<style>
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--space-3);
	}
	.sect + .sect {
		margin-top: var(--space-5);
	}
	.sect h2 {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		margin: 0 0 var(--space-3);
	}
	.count {
		font: var(--fw-regular) var(--text-sm) / 1 var(--font-body);
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
	/* Lo scheletro ha la forma della card: tagliando, righe di testo, riquadro dell'immagine */
	.sk {
		display: grid;
		grid-template-columns: auto 1fr auto;
		gap: var(--space-3);
		align-items: stretch;
		min-height: calc(var(--space-7) * 2);
	}
	.sk-stub {
		width: var(--space-7);
		border-radius: var(--radius) 0 0 var(--radius);
	}
	.sk-lines {
		display: grid;
		align-content: center;
		gap: var(--space-2);
		padding: var(--space-3) 0;
	}
	.sk-media {
		width: var(--space-7);
		height: var(--space-7);
		margin: var(--space-3) var(--space-3) 0 0;
	}
	.state {
		display: grid;
		justify-items: center;
		text-align: center;
		gap: var(--space-2);
		padding: var(--space-6) var(--space-3);
	}
	.state :global(h2) {
		margin: var(--space-2) 0 0;
	}
	.state :global(p) {
		max-width: 40ch;
	}
</style>
