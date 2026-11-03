<script lang="ts">
	import Baby from '@lucide/svelte/icons/baby';
	import Clock from '@lucide/svelte/icons/clock';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import Ticket from '@lucide/svelte/icons/ticket';
	import { CATEGORY_ICONS } from '$lib/categoryIcons';
	import { allDay, formatTime, romeParts, sentence, shortDate, shortDay } from '$lib/dates';
	import { CATEGORIES, eventPath, isForKids, isFree, PRICE_TYPES, runningLabel, type Event } from '$lib/event';
	import { fmtNum } from '$lib/format';
	import { distanceKm, type LatLng } from '$lib/geo';
	import { imageSources } from '$lib/images';
	import CategoryArt from './CategoryArt.svelte';
	import FavoriteButton from './FavoriteButton.svelte';

	let {
		event,
		origin = null,
		now,
		highlighted = false,
		compact = false,
		onhover
	}: {
		event: Event;
		origin?: LatLng | null;
		now: number;
		highlighted?: boolean;
		/** Mostre e rassegne lunghe: una riga più bassa, senza data grande né immagine. */
		compact?: boolean;
		onhover?: (id: string | null) => void;
	} = $props();

	const MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
	const WEEKDAYS = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
	// La data del riquadro è quella di oggi per gli eventi già iniziati.
	const start = $derived(romeParts(Math.max(event.startTime, Math.min(now, event.endTime))));
	const ongoing = $derived(event.startTime < now && event.endTime > now);
	const startedToday = $derived(shortDate(event.startTime) === shortDate(now));
	const running = $derived(runningLabel(event));
	const km = $derived(origin ? distanceKm(origin, event) : null);
	const CategoryIcon = $derived(CATEGORY_ICONS[event.category]);
	const whenText = $derived(
		running || (ongoing && !startedToday)
			? `Fino al ${shortDate(event.endTime)}`
			: `${ongoing ? 'Oggi' : sentence(shortDay(event.startTime, now))} · ${
					allDay(event.startTime, event.endTime) ? 'Tutto il giorno' : `${ongoing ? 'dalle ' : ''}${formatTime(event.startTime)}`
				}`
	);
	const place = $derived(event.venueName || event.address);
	const img = $derived(event.imageUrl ? imageSources(event.imageUrl) : null);
	let broken = $state(false);

	// Niente onerror inline (la CSP lo blocca): se l'errore è avvenuto prima dell'idratazione lo si legge da complete/naturalWidth.
	function watchBroken(img: HTMLImageElement) {
		if (img.complete && img.naturalWidth === 0) broken = true;
		const fail = () => (broken = true);
		img.addEventListener('error', fail);
		return () => img.removeEventListener('error', fail);
	}
</script>

<article
	class="ev card"
	class:highlighted
	class:compact
	data-cat={event.category}
	onmouseenter={() => onhover?.(event.id)}
	onmouseleave={() => onhover?.(null)}
>
	<div class="stub" aria-hidden="true">
		{#if compact}
			<CategoryIcon size={20} />
		{:else}
			<span class="wd">{WEEKDAYS[start.weekday]}</span>
			<span class="d">{start.day}</span>
			<span class="m">{MONTHS[start.month - 1]}</span>
		{/if}
	</div>
	<div class="body">
		<p class="kicker"><CategoryIcon size={16} aria-hidden="true" />{CATEGORIES[event.category]}{#if running === 'Mostra'}<span> · Mostra</span>{/if}</p>
		<h3><a href={eventPath(event)} class="stretched">{event.title}</a></h3>
		<ul class="facts">
			<li><Clock size={16} aria-hidden="true" /><span>{whenText}</span></li>
			<li>
				<MapPin size={16} aria-hidden="true" />
				<span>
					{#if event.approxLocation}
						{event.venueName ? `${event.venueName} · ` : ''}<span class="approx">Luogo da confermare</span>{#if event.city}, {event.city}{/if}
					{:else}
						{place}{#if event.city && !place.includes(event.city)}, {event.city}{/if}
					{/if}
					{#if km != null}<span class="km"> · {km < 1 ? '< 1' : fmtNum(Math.round(km))} km</span>{/if}
				</span>
			</li>
			<li class:free={isFree(event)}><Ticket size={16} aria-hidden="true" /><span>{PRICE_TYPES[event.priceType]}</span></li>
			{#if isForKids(event) && event.category !== 'kids'}
				<li><Baby size={16} aria-hidden="true" /><span>Per bambini</span></li>
			{/if}
		</ul>
	</div>
	<div class="side">
		{#if !compact}
			<div class="media">
				{#if img && !broken}
					<img
						src={img.src}
						srcset={img.srcset}
						sizes="96px"
						alt=""
						loading="lazy"
						decoding="async"
						width="96"
						height="96"
						referrerpolicy="no-referrer"
						{@attach watchBroken}
					/>
				{:else}
					<CategoryArt category={event.category} />
				{/if}
			</div>
		{/if}
		<div class="fav"><FavoriteButton id={event.id} title={event.title} /></div>
	</div>
</article>

<style>
	.ev {
		position: relative;
		display: grid;
		grid-template-columns: auto 1fr auto;
		column-gap: var(--space-3);
		transition:
			border-color var(--dur),
			box-shadow var(--dur) var(--ease),
			transform var(--dur) var(--ease);
	}
	.ev:hover {
		border-color: var(--accent-border);
		box-shadow: var(--shadow-lift);
		transform: translateY(var(--lift));
	}
	.ev:active {
		box-shadow: var(--shadow-card);
		transform: none;
	}
	.highlighted {
		border-color: var(--accent);
		box-shadow: var(--shadow-lift);
	}
	.ev:focus-within {
		border-color: var(--accent);
	}
	/* Il tagliando: la data sta a sinistra su fondo di categoria, separata da uno strappo tratteggiato. */
	.stub {
		display: grid;
		align-content: center;
		justify-items: center;
		gap: var(--space-1);
		width: var(--space-7);
		padding: var(--space-3) var(--space-2);
		border-radius: var(--radius) 0 0 var(--radius);
		border-right: 1px dashed var(--ink);
		background: var(--tint);
		color: var(--ink);
		text-align: center;
		line-height: 1;
	}
	.wd,
	.m {
		font-size: var(--text-xs);
		color: var(--muted);
	}
	.d {
		font: var(--fw-strong) var(--text-2xl) / 1 var(--font-display);
		color: var(--text);
	}
	.compact .stub {
		width: var(--space-6);
	}
	.body {
		min-width: 0;
		padding: var(--space-3) 0;
	}
	.kicker {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		margin: 0 0 var(--space-1);
		font-size: var(--text-sm);
		font-weight: var(--fw-strong);
		color: var(--ink);
	}
	h3 {
		margin: 0 0 var(--space-2);
		font-size: var(--text-lg);
		overflow-wrap: anywhere;
	}
	.compact h3 {
		font-size: var(--text-md);
	}
	h3 a {
		color: var(--text);
		text-decoration: none;
	}
	/* Tutta la card è cliccabile, ma resta un solo link per lo screen reader. */
	.stretched::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: var(--radius);
	}
	.stretched:focus-visible {
		outline: none;
	}
	.stretched:focus-visible::after {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: var(--text-sm);
		color: var(--muted);
	}
	.facts li {
		display: flex;
		align-items: flex-start;
		gap: var(--space-1);
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.facts :global(svg) {
		flex: none;
		margin-top: 2px;
	}
	.free {
		color: var(--accent-hover);
		font-weight: var(--fw-strong);
	}
	.km {
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.side {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-1);
		padding: var(--space-3) var(--space-3) var(--space-1) 0;
	}
	.media {
		width: var(--space-7);
		aspect-ratio: 1;
		border-radius: var(--radius-sm);
		overflow: hidden;
		background: var(--surface-2);
	}
	.media img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.fav {
		position: relative;
		z-index: 1;
	}
	@media (min-width: 520px) {
		.media {
			width: calc(var(--space-7) * 1.5);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.ev:hover {
			transform: none;
		}
	}
</style>
