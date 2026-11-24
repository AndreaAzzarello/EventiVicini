<script lang="ts">
	import CalendarSearch from '@lucide/svelte/icons/calendar-search';
	import { untrack, type Snippet } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import type { Event } from '$lib/event';
	import { fmtNum } from '$lib/format';
	import type { LatLng } from '$lib/geo';
	import { sections, takeFlat, type Grouping } from '$lib/sections';
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
		grouping = null,
		empty,
		inline
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
		/** Intervallo del filtro di date: i gruppi seguono quello (giorni o settimane), non il tempo da adesso. */
		grouping?: Grouping | null;
		empty?: Snippet;
		/** Riga a larghezza piena dentro l'elenco, dopo la INLINE_AFTER-esima card (o in fondo se sono meno): raggiungibile anche con 200+ eventi. */
		inline?: Snippet;
	} = $props();

	// Render a blocchi: montare 200+ card in un colpo è un long task (TBT). Le prime INITIAL card (≥ quelle dell'HTML del server: nessun
	// hydration_mismatch) subito, il resto a passi di CHUNK card nei momenti liberi del thread. Sezioni, titoli e conteggi
	// si calcolano sempre sull'elenco intero; a riempimento finito il DOM è identico a prima.
	const INITIAL = 24; // ≥ INLINE_AFTER: la card che ospita la riga è sempre già montata
	const INLINE_AFTER = 8;
	const CHUNK = 12;
	let limit = $state(INITIAL);
	const groups = $derived(sections(events, now, grouping));
	const total = $derived(events.length);
	const shown = $derived(takeFlat(groups, limit));
	// Sopra la piega (a 360 px una card intera, la seconda spunta sugli schermi alti): le prime due si caricano subito,
	// solo la prima con immagine ha priorità alta di rete. Le altre restano lazy.
	const aboveFold = $derived(shown.flatMap((s) => s.events).slice(0, 2));
	const firstWithImage = $derived(aboveFold.find((e) => e.imageUrl)?.id);
	// Card dopo cui sta la riga `inline`: calcolata sull'elenco intero, quindi non si sposta mentre il render a blocchi riempie la pagina.
	const inlineAfterId = $derived(groups.flatMap((g) => g.events)[Math.min(INLINE_AFTER, total) - 1]?.id);
	/** Cambia quando la lista è un'altra (filtro, luogo), non a ogni minuto in cui `now` ricalcola gli stessi eventi. */
	const signature = $derived(`${total}|${events[0]?.id}|${events.at(-1)?.id}|${grouping?.when ?? ''}`);

	let cancel: (() => void) | null = null;
	function stop() {
		cancel?.();
		cancel = null;
	}
	function fill() {
		stop();
		if (limit >= total) return;
		const step = () => {
			cancel = null;
			limit = Math.min(limit + CHUNK, total);
			fill();
		};
		if ('requestIdleCallback' in window) {
			const id = requestIdleCallback(step, { timeout: 250 });
			cancel = () => cancelIdleCallback(id);
		} else {
			const id = setTimeout(step, 16); // Safari
			cancel = () => clearTimeout(id);
		}
	}
	$effect(() => {
		void signature;
		untrack(() => {
			limit = INITIAL;
			fill();
		});
		return stop;
	});

	/** Tutte le card subito: serve a chi deve raggiungerne una («Vedi nella lista» dalla mappa) o ritrovare lo scroll. */
	export function revealAll() {
		stop();
		limit = total;
	}
	afterNavigate(({ type }) => {
		if (type === 'popstate') revealAll(); // indietro/avanti: il ripristino dello scroll vuole la pagina già lunga
	});
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
	{#each shown as section (section.key)}
		<section class="sect" aria-labelledby="sez-{section.key}">
			<h2 id="sez-{section.key}">{section.title} <span class="count">{fmtNum(counts?.[section.key] ?? section.total)}</span></h2>
			<ul class="list">
				{#each section.events as event (event.id)}
					<li><EventCard {event} {now} {origin} highlighted={highlighted === event.id} compact={section.key === 'running'} from={grouping?.range[0]} eager={aboveFold.includes(event)} high={event.id === firstWithImage} {onhover} /></li>
					{#if inline && event.id === inlineAfterId}<li class="inline">{@render inline()}</li>{/if}
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
	.inline {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2) var(--space-3);
		padding: var(--space-3);
		background: var(--surface-2);
		border-radius: var(--radius);
	}
	.inline :global(p) {
		margin: 0;
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
	@media (max-width: 399px) {
		.sect h2 {
			margin-bottom: var(--space-2);
		}
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
