<script lang="ts">
	import { onMount } from 'svelte';
	import AudioLines from '@lucide/svelte/icons/audio-lines';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Baby from '@lucide/svelte/icons/baby';
	import Calendar from '@lucide/svelte/icons/calendar';
	import Check from '@lucide/svelte/icons/check';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import Heart from '@lucide/svelte/icons/heart';
	import Landmark from '@lucide/svelte/icons/landmark';
	import List from '@lucide/svelte/icons/list';
	import LocateFixed from '@lucide/svelte/icons/locate-fixed';
	import Mail from '@lucide/svelte/icons/mail';
	import Map from '@lucide/svelte/icons/map';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import Moon from '@lucide/svelte/icons/moon';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';
	import Share2 from '@lucide/svelte/icons/share-2';
	import ShoppingBasket from '@lucide/svelte/icons/shopping-basket';
	import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
	import Sun from '@lucide/svelte/icons/sun';
	import Tag from '@lucide/svelte/icons/tag';
	import Ticket from '@lucide/svelte/icons/ticket';
	import Trash from '@lucide/svelte/icons/trash';
	import Trophy from '@lucide/svelte/icons/trophy';
	import User from '@lucide/svelte/icons/user';
	import Utensils from '@lucide/svelte/icons/utensils';
	import X from '@lucide/svelte/icons/x';
	import CategoryArt from '$lib/components/CategoryArt.svelte';
	import ErrorMessage from '$lib/components/ErrorMessage.svelte';
	import EventCard from '$lib/components/EventCard.svelte';
	import GoogleLogo from '$lib/components/GoogleLogo.svelte';
	import { CATEGORIES, type Category, type Event } from '$lib/event';
	import { fmtNum, monthKeys, monthLine } from '$lib/format';

	const space = [1, 2, 3, 4, 5, 6, 7];
	const grays = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900];
	const roles = ['bg', 'surface', 'surface-2', 'border', 'border-strong', 'text', 'muted', 'accent', 'accent-hover', 'accent-soft', 'accent-border', 'danger'];
	const sizes = ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl'];
	const icons = { MapPin, Calendar, Heart, Share2, Map, List, Ticket, Search, User, Plus, Sun, Moon, X, Check, LocateFixed, ArrowLeft, Mail, SlidersHorizontal, Trash, Pencil, ExternalLink };
	const categoryIcons = { music: AudioLines, food: Utensils, sport: Trophy, culture: Landmark, kids: Baby, market: ShoppingBasket, other: Tag };
	const keys = monthKeys();
	const now = Date.now();
	const sample = {
		id: 'stile',
		title: 'Jazz in Piazza Grande',
		category: 'music',
		priceType: 'free',
		startTime: now + 3_600_000,
		endTime: now + 7_200_000,
		venueName: 'Piazza Grande',
		city: 'Modena',
		tags: [],
		approxLocation: false,
		longRunning: false,
		lat: 44.6471,
		lng: 10.9252
	} as unknown as Event;

	// Colori risolti dal browser (light-dark() compreso) e contrasto sullo sfondo.
	let resolved: Record<string, { rgb: string; onBg: string; onSurface: string }> = $state({});
	// Per ogni categoria: contrasto dell'inchiostro sulla superficie e sulla sua tinta tenue, e del testo sulla tinta
	let cats: Record<string, { ink: string; soft: string; inkOnSurface: string; inkOnSoft: string; textOnSoft: string }> = $state({});
	const catKeys = Object.keys(CATEGORIES) as Category[];
	let probe: HTMLSpanElement;

	const lum = (rgb: string) => {
		const [r, g, b] = (rgb.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
			const c = Number(v) / 255;
			return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const ratio = (a: string, b: string) => {
		const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
		return ((x + 0.05) / (y + 0.05)).toFixed(1).replace('.', ',');
	};

	function measure() {
		const get = (name: string) => {
			probe.style.backgroundColor = `var(--${name})`;
			return getComputedStyle(probe).backgroundColor;
		};
		const bg = get('bg');
		const surface = get('surface');
		resolved = Object.fromEntries(
			[...roles, ...grays.map((g) => `gray-${g}`)].map((n) => {
				const rgb = get(n);
				return [n, { rgb, onBg: ratio(rgb, bg), onSurface: ratio(rgb, surface) }];
			})
		);
		const text = get('text');
		cats = Object.fromEntries(
			catKeys.map((c) => {
				const ink = get(`cat-${c}`);
				const soft = get(`cat-${c}-soft`);
				return [c, { ink, soft, inkOnSurface: ratio(ink, surface), inkOnSoft: ratio(ink, soft), textOnSoft: ratio(text, soft) }];
			})
		);
	}

	onMount(() => {
		measure();
		// Il tema può cambiare mentre la pagina è aperta.
		const mo = new MutationObserver(measure);
		mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
		const mq = matchMedia('(prefers-color-scheme: dark)');
		mq.addEventListener('change', measure);
		return () => {
			mo.disconnect();
			mq.removeEventListener('change', measure);
		};
	});
</script>

<span bind:this={probe} class="probe" aria-hidden="true"></span>

<h1>Stile</h1>
<p class="muted">Riferimento del design system. I valori stanno in <code>src/lib/styles/tokens.css</code>; <code>design.test.ts</code> fallisce se il codice li aggira.</p>

<section aria-labelledby="s-space">
	<h2 id="s-space">Spaziatura</h2>
	<p class="muted">Multipli di 8, più il 4 per i dettagli. Margini, padding, gap, raggi e controlli usano solo questi token.</p>
	<ul class="plain">
		{#each space as n (n)}
			<li class="space-row">
				<code>--space-{n}</code>
				<span class="bar" style="width: var(--space-{n})"></span>
			</li>
		{/each}
	</ul>
	<p class="muted">Raggi: <code>--radius-sm</code>, <code>--radius</code>, <code>--radius-full</code> (solo avatar e interruttori). Controlli: <code>--control</code>, <code>--control-sm</code>.</p>
</section>

<section aria-labelledby="s-col">
	<h2 id="s-col">Colore</h2>
	<p class="muted">Sfondo «carta calda» nel tema chiaro e «notte calda» nel scuro. Dieci grigi caldi e un solo accento, il terracotta, per azioni primarie, link, focus, stato attivo e — in tinta tenue (<code>--accent-soft</code>, 10% sulla superficie; <code>--accent-border</code>, 45% sul bordo) — per evidenziare. Le categorie hanno una loro tinta (sezione sotto), solo come inchiostro e fondo tenue. Mai gradienti né glow. Il rosso d’errore è un cremisi più freddo e compare sempre con icona e testo. Contrasti calcolati nel tema in uso.</p>
	<h3>Ruoli</h3>
	<ul class="plain swatches">
		{#each roles as n (n)}
			<li>
				<span class="chipcolor" style="background: var(--{n})"></span>
				<span><code>--{n}</code> <span class="muted num">{resolved[n]?.rgb ?? ''}</span></span>
				<span class="num muted">{resolved[n] ? `${resolved[n].onBg} su sfondo · ${resolved[n].onSurface} su superficie` : ''}</span>
			</li>
		{/each}
	</ul>
	<h3>Categorie</h3>
		<p class="muted">
			Toni naturali italiani: prugna, ocra, verde acqua, oliva, corallo, sabbia, grigio caldo. Ogni categoria ha un inchiostro (<code>--cat-*</code>: icone, pin della mappa, motivi, etichette) e una tinta tenue
			(<code>--cat-*-soft</code>, 14% sulla superficie: fondo del riquadro data e del placeholder). Il testo sulla tinta è sempre <code>--text</code> o <code>--muted</code>; la categoria si legge anche dall’icona e dal nome.
		</p>
		<ul class="plain cat-grid">
			{#each catKeys as c (c)}
				<li data-cat={c}>
					<div class="cat-art"><CategoryArt category={c} /></div>
					<div>
						<strong>{CATEGORIES[c]}</strong>
						<span class="muted num">{cats[c]?.ink ?? ''}</span>
						<span class="num muted">{cats[c] ? `inchiostro ${cats[c].inkOnSurface} su superficie · ${cats[c].inkOnSoft} su tinta · testo ${cats[c].textOnSoft} su tinta` : ''}</span>
					</div>
				</li>
			{/each}
		</ul>
	<h3>Unica eccezione: il logo Google</h3>
	<p class="muted">
		Le linee guida di “Accedi con Google” richiedono la “G” ufficiale a quattro colori, quindi <code>GoogleLogo.svelte</code> è l’unico file
		con esadecimali fuori da <code>tokens.css</code>. <code>design.test.ts</code> ammette solo quel file e solo i quattro colori ufficiali.
	</p>
	<p class="row"><GoogleLogo size={24} /> <GoogleLogo size={20} /> <GoogleLogo size={16} /></p>
	<h3>Scala dei grigi</h3>
	<ul class="plain grays">
		{#each grays as g (g)}
			<li><span class="chipcolor" style="background: var(--gray-{g})"></span><code>{g}</code></li>
		{/each}
	</ul>
</section>

<section aria-labelledby="s-type">
	<h2 id="s-type">Tipografia</h2>
	<p class="muted">Due pesi, 400 e 600. Titoli in Fraunces, testo con il font di sistema. Mai tutto maiuscolo. Unica eccezione: il <strong>corsivo Fraunces 600</strong> terracotta (<code>.display-em</code>), solo per il titolo display della home e per il logo.</p>
	<p class="display-sample display">Cosa succede <span class="display-em">vicino a te</span></p>
	<p class="logo-sample">Eventi <em class="display-em">Vicini</em> <span class="muted">· <code>--text-display</code>: 40 px, 64 px da 720 px</span></p>
	<ul class="plain">
		{#each sizes as s (s)}
			<li class="type-row"><code>--text-{s}</code><span style="font-size: var(--text-{s})">Concerto in piazza, ott 2026</span></li>
		{/each}
	</ul>
	<p><span style="font-weight: var(--fw-regular)">Peso 400, testo corrente.</span> <span style="font-weight: var(--fw-strong)">Peso 600, etichette e titoli.</span></p>
	<p>Numeri con cifre tabellari: <span class="num">{fmtNum(1234)} · {fmtNum(56)} · {fmtNum(7)}</span></p>
</section>

<section aria-labelledby="s-icon">
	<h2 id="s-icon">Icone</h2>
	<p class="muted">Solo Lucide, a linea, 16/20/24 con tratto 2. Decorative con <code>aria-hidden</code>; le icone senza testo hanno l’etichetta sul bottone.</p>
	<ul class="plain icon-grid">
		{#each Object.entries(icons) as [name, Icon] (name)}
			<li><Icon size={20} aria-hidden="true" /><code>{name}</code></li>
		{/each}
	</ul>
	<h3>Categorie</h3>
	<p class="muted">Ogni categoria ha la sua icona, che accompagna sempre il nome (mai il solo colore).</p>
	<ul class="plain icon-grid">
		{#each Object.entries(categoryIcons) as [key, Icon] (key)}
			<li><Icon size={20} aria-hidden="true" />{CATEGORIES[key as keyof typeof CATEGORIES]}</li>
		{/each}
	</ul>
	<p class="sizes"><MapPin size={16} aria-hidden="true" /> 16 <MapPin size={20} aria-hidden="true" /> 20 <MapPin size={24} aria-hidden="true" /> 24</p>
</section>

<section aria-labelledby="s-comp">
	<h2 id="s-comp">Componenti</h2>
	<h3>Bottoni</h3>
	<p class="row">
		<button class="btn btn-primary" type="button"><Plus size={20} aria-hidden="true" /> Primario</button>
		<button class="btn" type="button">Secondario</button>
		<button class="btn btn-ghost" type="button">Ghost</button>
		<button class="btn btn-sm" type="button">Piccolo</button>
		<button class="btn btn-danger" type="button"><Trash size={20} aria-hidden="true" /> Elimina</button>
		<button class="btn" type="button" disabled>Disabilitato</button>
	</p>
	<h3>Campi e filtri</h3>
	<div class="field">
		<label for="st-in">Titolo</label>
		<input id="st-in" type="text" value="Jazz in piazza" />
		<span class="hint">Suggerimento sotto il campo.</span>
	</div>
	<p class="row">
		<button class="chip" type="button" aria-pressed="false">Oggi</button>
		<button class="chip" type="button" aria-pressed="true"><AudioLines size={16} aria-hidden="true" />Musica</button>
		<button class="chip" type="button" aria-pressed="false"><Trophy size={16} aria-hidden="true" />Sport</button>
	</p>
	<p class="muted">Chip: inattivo con bordo (in hover tinta tenue), attivo in accento pieno con testo <code>--accent-ink</code>. Le categorie portano la loro icona.</p>
	<h3>Card evento</h3>
	<p class="muted">Un biglietto: a sinistra il riquadro data su tinta di categoria (giorno in Fraunces, mese e giorno della settimana piccoli) separato da uno strappo tratteggiato; poi categoria, titolo e una riga di fatti con icone (ora, luogo e distanza, prezzo, bambini); a destra l’immagine (proporzione fissa) o il motivo della categoria. Bordo sottile e <code>--shadow-card</code>; in hover bordo <code>--accent-border</code> e leggero sollevamento con <code>--shadow-lift</code> (fermo con il movimento ridotto). Mostre e rassegne lunghe usano la variante compatta.</p>
		<EventCard event={sample} {now} />
	<EventCard event={{ ...sample, id: 'stile2', title: 'Mostra di fotografia', category: 'culture', priceType: 'low', approxLocation: true, longRunning: true, startTime: now - 7 * 86_400_000, endTime: now + 30 * 86_400_000, tags: ['mostra'] } as unknown as Event} {now} compact />
	<h3>Messaggi</h3>
	<p class="notice">Avviso neutro, senza colore.</p>
	<ErrorMessage>Errore con icona e testo, mai solo colore.</ErrorMessage>
	<h3>Elemento sovrapposto</h3>
	<div class="overlay-sample">
		<p><strong>Dialog, menu e toast</strong> usano <code>--shadow-overlay</code>; le card <code>--shadow-card</code>. Non esistono altre ombre.</p>
	</div>
	<h3>Riga delle statistiche mensili</h3>
	<p class="num">{monthLine(412, 374, keys)}</p>
</section>

<style>
	.probe {
		position: absolute;
		visibility: hidden;
	}
	section {
		margin-top: var(--space-6);
	}
	.plain {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.space-row,
	.type-row {
		display: grid;
		/* minmax(0, 1fr): senza, la colonna non scende sotto la parola più lunga del campione e, con un font di sistema largo
		   (DejaVu su Linux), la pagina sfora a 360 px (#48). */
		grid-template-columns: calc(var(--space-7) * 2) minmax(0, 1fr);
		align-items: center;
		gap: var(--space-3);
		padding-block: var(--space-1);
	}
	@media (max-width: 479px) {
		/* il campione a 48 px ha bisogno di tutta la larghezza: l'etichetta va sopra */
		.type-row {
			grid-template-columns: minmax(0, 1fr);
			gap: var(--space-1);
		}
	}
	.bar {
		height: var(--space-3);
		background: var(--accent);
	}
	.swatches li {
		display: grid;
		grid-template-columns: var(--space-6) 1fr;
		gap: var(--space-1) var(--space-3);
		align-items: center;
		padding-block: var(--space-2);
		border-bottom: 1px solid var(--border);
	}
	.swatches li > :last-child {
		grid-column: 2;
		font-size: var(--text-sm);
	}
	.chipcolor {
		display: block;
		width: var(--space-6);
		height: var(--space-6);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
	}
	.cat-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(calc(var(--space-7) * 4), 1fr));
		gap: var(--space-3);
	}
	.cat-grid li {
		display: grid;
		grid-template-columns: calc(var(--space-7) * 1.5) 1fr;
		gap: var(--space-3);
		align-items: center;
		font-size: var(--text-sm);
	}
	.cat-grid li > div:last-child {
		display: grid;
		gap: var(--space-1);
	}
	.cat-art {
		aspect-ratio: 1;
		border-radius: var(--radius-sm);
		overflow: hidden;
	}
	.grays {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
	}
	.grays li {
		display: grid;
		justify-items: center;
		gap: var(--space-1);
	}
	.icon-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(calc(var(--space-7) * 2), 1fr));
		gap: var(--space-3);
	}
	.icon-grid li {
		display: grid;
		justify-items: center;
		gap: var(--space-1);
		text-align: center;
		font-size: var(--text-xs);
	}
	.sizes {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
	.num {
		font-variant-numeric: tabular-nums;
	}
	.display-sample {
		margin: var(--space-3) 0;
	}
	.logo-sample {
		font: var(--fw-strong) var(--text-xl) / 1 var(--font-display);
	}
	.logo-sample .muted {
		font: var(--fw-regular) var(--text-sm) / var(--lh-body) var(--font-body);
	}
	.overlay-sample {
		padding: var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		box-shadow: var(--shadow-overlay);
	}
	code {
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}
</style>
