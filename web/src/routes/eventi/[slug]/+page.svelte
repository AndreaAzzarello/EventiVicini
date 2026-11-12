<script lang="ts">
	import { onMount } from 'svelte';
	import CategoryArt from '$lib/components/CategoryArt.svelte';
	import FavoriteButton from '$lib/components/FavoriteButton.svelte';
	import PinMap from '$lib/components/PinMap.svelte';
	import ReportDialog from '$lib/components/ReportDialog.svelte';
	import Seo from '$lib/components/Seo.svelte';
	import { siteUrl } from '$lib/config';
	import { formatWhen, sentence } from '$lib/dates';
	import { CATEGORY_ICONS } from '$lib/categoryIcons';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Baby from '@lucide/svelte/icons/baby';
	import Calendar from '@lucide/svelte/icons/calendar';
	import Link2 from '@lucide/svelte/icons/link-2';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import Navigation from '@lucide/svelte/icons/navigation';
	import Share2 from '@lucide/svelte/icons/share-2';
	import Ticket from '@lucide/svelte/icons/ticket';
	import { CATEGORIES, PRICE_TYPES, cityPath, eventPath, eventSource, isForKids, runningLabel, ticketLabel, ticketsOffSale, ticketVendor } from '$lib/event';
	import { fmtNum } from '$lib/format';
	import { distanceKm, type ChosenPlace } from '$lib/geo';
	import { imageSources } from '$lib/images';
	import { buildIcs } from '$lib/ics';
	import { eventJsonLd, safeJson } from '$lib/jsonld';
	import { KEYS, readJson } from '$lib/storage';
	import { toast } from '$lib/toast.svelte';

	let { data } = $props();
	const e = $derived(data.event);
	const url = $derived(siteUrl() + eventPath(e));
	let now = $state(Date.now());
	// Il luogo scelto sta solo nel browser: la distanza si calcola qui, non sul server.
	let origin = $state<ChosenPlace | null>(null);
	onMount(() => {
		now = Date.now();
		const saved = readJson<ChosenPlace | null>(KEYS.place, null);
		if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lng)) origin = saved;
	});
	const running = $derived(runningLabel(e));
	const ended = $derived(e.endTime < now);
	const mapsUrl = $derived(`https://www.google.com/maps/search/?api=1&query=${e.lat},${e.lng}`);
	const description = $derived(
		e.shortDescription ||
			`${CATEGORIES[e.category]} a ${e.city || e.address}: ${formatWhen(e.startTime, e.endTime, now)}${e.venueName ? `, ${e.venueName}` : ''}.`
	);

	const Cat = $derived(CATEGORY_ICONS[e.category]);
	const source = $derived(eventSource(e));
	const vendor = $derived(e.ticketUrl ? ticketVendor(e.ticketUrl) : null);
	const offSale = $derived(ticketsOffSale(e));
	const img = $derived(e.imageUrl ? imageSources(e.imageUrl) : null);
	const km = $derived(origin ? distanceKm(origin, e) : null);
	const away = $derived(
		km == null || !origin
			? ''
			: `${km < 1 ? 'a meno di 1 km' : `a ${fmtNum(Math.round(km))} km`} ${origin.exact ? 'da te' : `da ${origin.label}`}`
	);
	const jsonLdTag = $derived('<script type="application/ld+json">' + safeJson(eventJsonLd(e, url)) + '</' + 'script>');

	function downloadIcs() {
		const blob = new Blob([buildIcs(e, url)], { type: 'text/calendar;charset=utf-8' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `${eventPath(e).split('/').pop()}.ics`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 1000);
	}

	async function share() {
		if (navigator.share) {
			try {
				await navigator.share({ title: e.title, text: formatWhen(e.startTime, e.endTime), url });
			} catch {
				// condivisione annullata dall'utente
			}
			return;
		}
		try {
			await navigator.clipboard.writeText(url);
			toast('Link copiato negli appunti.');
		} catch {
			toast('Non sono riuscito a copiarlo: seleziona l’indirizzo dalla barra del browser.');
		}
	}
</script>

<Seo title={e.title} {description} image={e.imageUrl} type="article" path={eventPath(e)} />
<svelte:head>
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- JSON-LD con < > & già codificati da safeJson -->
	{@html jsonLdTag}
</svelte:head>

<article class="container narrow detail" data-cat={e.category}>
	<a class="back" href="/"><ArrowLeft size={20} aria-hidden="true" /> Tutti gli eventi</a>

	{#if ended}
		<p class="notice" role="note"><strong>Evento concluso.</strong> Lo lasciamo qui per memoria: cerca le prossime date in home.</p>
	{/if}

	<div class="hero">
		{#if img}
			<img
				src={img.src}
				srcset={img.srcset}
				sizes="(min-width: 800px) 760px, 100vw"
				alt=""
				width="760"
				height="380"
				loading="eager"
				decoding="async"
				fetchpriority="high"
				referrerpolicy="no-referrer"
			/>
		{:else}
			<CategoryArt category={e.category} size="hero" />
		{/if}
	</div>

	<p class="kicker"><Cat size={16} aria-hidden="true" />{CATEGORIES[e.category]}{#if running}<span> · {running}</span>{/if}</p>
	<h1>{e.title}</h1>

	<section class="brief card" aria-labelledby="brief-h">
		<h2 id="brief-h" class="visually-hidden">In breve</h2>
		<dl>
			<div>
				<dt><Calendar size={20} aria-hidden="true" /> Quando</dt>
				<dd class="when">{sentence(formatWhen(e.startTime, e.endTime, now))}</dd>
			</div>
			<div>
				<dt><MapPin size={20} aria-hidden="true" /> Dove</dt>
				<dd>
					{#if e.venueName}<strong>{e.venueName}</strong><br />{/if}
					{#if e.approxLocation}
						<span class="approx">Luogo da confermare</span>
						<span class="note">Il Comune non ha ancora indicato l’indirizzo preciso.{#if source.href} <a href={source.href} target="_blank" rel="noopener noreferrer">Controlla sulla fonte</a>.{/if}</span>
					{:else}{e.address}{/if}
					{#if e.locality && e.locality !== e.city}<br />{e.locality}, {e.city}{/if}
					{#if away}<span class="away">{away}</span>{/if}
					{#if e.citySlug}<br /><a href={cityPath(e.citySlug)}>Altri eventi a {e.city}</a>{/if}
				</dd>
			</div>
			<div>
				<dt><Ticket size={20} aria-hidden="true" /> Prezzo</dt>
				<dd>{PRICE_TYPES[e.priceType]}</dd>
			</div>
			{#if isForKids(e)}
				<div>
					<dt><Baby size={20} aria-hidden="true" /> Bambini</dt>
					<dd>Adatto ai bambini</dd>
				</div>
			{/if}
			<div>
				<dt><Link2 size={20} aria-hidden="true" /> Fonte</dt>
				<dd>{#if source.href}<a href={source.href} target="_blank" rel="noopener noreferrer">{source.text}</a>{:else}{source.text}{/if}{#if source.license}
						· dati <a href={source.license.href} target="_blank" rel="license noopener noreferrer">{source.license.text}</a>{/if}</dd>
			</div>
		</dl>
	</section>

	<div class="actions">
		{#if e.ticketUrl && offSale}
			<p class="wide off-sale"><Ticket size={20} aria-hidden="true" /> Biglietti non in vendita</p>
		{:else if e.ticketUrl}
			<a class="btn btn-primary wide" href={e.ticketUrl} target="_blank" rel="noopener noreferrer nofollow">
				<Ticket size={20} aria-hidden="true" /> {ticketLabel(e.ticketUrl)}
			</a>
		{/if}
		<button class="btn" onclick={downloadIcs}><Calendar size={20} aria-hidden="true" /> Aggiungi al calendario</button>
		<a class="btn" href={mapsUrl} target="_blank" rel="noopener noreferrer">
			<Navigation size={20} aria-hidden="true" /> {e.approxLocation && e.city ? `Indicazioni per ${e.city}` : 'Indicazioni'}
		</a>
		<button class="btn" onclick={share}><Share2 size={20} aria-hidden="true" /> Condividi</button>
		<FavoriteButton id={e.id} title={e.title} label />
	</div>

	{#if e.shortDescription}
		<p class="desc">{e.shortDescription}</p>
	{/if}

	<section aria-labelledby="map-h" class="where">
		<h2 id="map-h">Come arrivare</h2>
		{#if e.approxLocation}
			<!-- Posizione solo al centro del comune: niente mappa, un pin preciso sarebbe falso. -->
			<p class="muted">Il luogo esatto non è ancora noto: verifica sul sito della fonte. “Indicazioni” porta al centro di {e.city || 'questo comune'}.</p>
		{:else}
			<PinMap lat={e.lat} lng={e.lng} label={`Mappa: ${e.venueName || e.address}`} />
		{/if}
	</section>

	<p class="source muted">
		Verifica sempre date e orari sul sito ufficiale prima di partire.
		{#if vendor && !offSale}I biglietti li vende {vendor}: il pulsante apre il suo sito, dove valgono le sue condizioni.{/if}
	</p>

	<div class="report-row"><ReportDialog eventId={e.id} title={e.title} contact={data.contact} /></div>
</article>

<style>
	.detail {
		padding-top: var(--space-3);
	}
	.back {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		min-height: var(--control);
		color: var(--muted);
		font-weight: var(--fw-strong);
		text-decoration: none;
	}
	.back:hover {
		color: var(--accent);
	}
	.notice {
		margin: var(--space-2) 0 var(--space-3);
	}
	/* Testata: la foto, o il motivo della categoria al suo posto, sempre nella stessa proporzione */
	.hero {
		aspect-ratio: 2 / 1;
		margin: var(--space-2) 0 var(--space-3);
		border-radius: var(--radius);
		overflow: hidden;
		background: var(--surface-2);
	}
	.hero img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.kicker {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		margin: 0 0 var(--space-1);
		font-weight: var(--fw-strong);
		color: var(--ink);
	}
	h1 {
		overflow-wrap: anywhere;
	}
	/* In breve: i quattro fatti che servono a decidere, su una scheda con il filo della categoria */
	.brief {
		margin: var(--space-3) 0;
		padding: var(--space-3);
		border-left: var(--space-1) solid var(--ink);
	}
	.brief dl {
		display: grid;
		gap: var(--space-3) var(--space-4);
		margin: 0;
	}
	.brief dt {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		margin-bottom: var(--space-1);
		font-size: var(--text-sm);
		color: var(--muted);
	}
	.brief dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.when {
		font-weight: var(--fw-strong);
		font-size: var(--text-lg);
	}
	.approx {
		font-weight: var(--fw-strong);
	}
	.note,
	.away {
		display: block;
		color: var(--muted);
		font-size: var(--text-sm);
	}
	.actions {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-2);
		margin: var(--space-3) 0 var(--space-4);
	}
	.actions :global(.btn),
	.actions :global(.fav) {
		width: 100%;
		justify-content: center;
		text-align: center;
	}
	.actions .wide {
		grid-column: 1 / -1;
	}
	.off-sale {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		min-height: var(--control);
		margin: 0;
		color: var(--muted);
		font-weight: var(--fw-strong);
	}
	.desc {
		font-size: var(--text-lg);
		line-height: var(--lh-body);
		white-space: pre-line;
		overflow-wrap: anywhere;
	}
	.where {
		margin-top: var(--space-5);
	}
	.where h2 {
		margin: 0 0 var(--space-3);
	}
	.report-row {
		margin: 0 0 var(--space-3);
	}
	.source {
		margin-top: var(--space-4);
		font-size: var(--text-sm);
	}
	@media (min-width: 600px) {
		.brief dl {
			grid-template-columns: 1fr 1fr;
		}
		.actions {
			grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
		}
		.actions .wide {
			grid-column: auto;
		}
	}
</style>
