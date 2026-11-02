<script lang="ts">
	import Seo from '$lib/components/Seo.svelte';
	let { data } = $props();
</script>

<Seo title="Termini di utilizzo" description="Le regole per usare Eventi Vicini e proporre eventi." />

<article class="container narrow prose">
	<h1>Termini di utilizzo</h1>
	<p class="muted">Ultimo aggiornamento: {data.updated}</p>

	<h2>Il servizio</h2>
	<p>
		Eventi Vicini è un’agenda gratuita, offerta da {data.controller}, che raccoglie eventi pubblicati dai siti
		istituzionali dei Comuni (sempre citati come fonte), concerti e spettacoli dall’API di Ticketmaster e proposte degli utenti. Il servizio è fornito “così com’è”:
		facciamo il possibile perché le informazioni siano corrette, ma date, orari e prezzi possono cambiare.
		<strong>Verifica sempre sulla fonte ufficiale</strong> prima di partire.
	</p>

	<h2>Account</h2>
	<p>
		L’account è facoltativo e serve per conservare i preferiti e proporre eventi. Devi avere almeno 14 anni. Sei
		responsabile dell’uso del tuo account; puoi eliminarlo in qualsiasi momento da <a href="/account">Il mio account</a>.
	</p>

	<h2>Proporre un evento</h2>
	<ul>
		<li>Proponi solo eventi reali e aperti al pubblico, con informazioni corrette.</li>
		<li>Non inserire dati personali di terzi, contenuti offensivi, illegali o pubblicitari non pertinenti.</li>
		<li>Usa per le immagini solo link a contenuti che hai il diritto di condividere.</li>
		<li>Puoi avere al massimo 5 proposte in attesa di revisione.</li>
		<li>
			Ogni proposta viene revisionata: possiamo approvarla, modificarla o rifiutarla indicandone il motivo. Inviandola ci
			autorizzi a pubblicarla gratuitamente nell’agenda.
		</li>
	</ul>

	<h2>Segnalare un contenuto</h2>
	<p>
		Se un evento è illegale, falso o ingannevole, o contiene dati personali che non dovrebbe, usa “Segnala questo
		evento” nella sua pagina: non serve un account. Indica il motivo e spiega cosa non va; l’email è facoltativa e serve
		solo per risponderti. Esaminiamo ogni segnalazione a mano e non decidiamo in modo automatico. Chi segnala in modo
		ripetuto e palesemente infondato può vedersi ignorare le segnalazioni successive.
	</p>

	<h2>Decisioni e motivazioni</h2>
	<ul>
		<li>Ogni decisione di rimuovere un evento, rifiutare una proposta o sospendere un account è motivata. Il motivo di una proposta rifiutata lo vede l’autore nel suo account.</li>
		<li>Gli eventi pubblicati non restano collegati a chi li ha proposti: la motivazione di una rimozione la comunichiamo a chi ha segnalato, se ha lasciato l’email.</li>
		<li>Se non sei d’accordo con una decisione scrivici{#if data.email} a <a href="mailto:{data.email}">{data.email}</a>{/if}: la riesaminiamo e ti rispondiamo con una nuova motivazione. Resta salva la possibilità di rivolgerti all’autorità giudiziaria.</li>
		<li>Se veniamo a conoscenza di informazioni che fanno sospettare un reato che minaccia la vita o la sicurezza delle persone, informiamo le autorità competenti.</li>
	</ul>

	<h2>Punto di contatto</h2>
	<p>
		Per le autorità degli Stati membri, la Commissione europea e le persone che usano il servizio (Regolamento (UE)
		2022/2065, “DSA”, artt. 11 e 12) il punto di contatto unico è {data.controller}{#if data.email}, <a href="mailto:{data.email}">{data.email}</a>{/if}.
		Rispondiamo in italiano e in inglese.
	</p>

	<h2>Responsabilità</h2>
	<p>
		Non organizziamo gli eventi elencati e non rispondiamo del loro svolgimento. I link esterni (biglietti, fonti)
		portano a siti di terzi con le proprie condizioni. I concerti e gli spettacoli sono forniti da Ticketmaster tramite la sua API: i biglietti si acquistano sul suo sito, alle sue condizioni, e Eventi Vicini non riceve commissioni né affiliazioni. Se Ticketmaster chiede di togliere un contenuto lo rimuoviamo entro 24 ore. Possiamo sospendere account che violano questi termini.
	</p>

	<h2>Modifiche e legge applicabile</h2>
	<p>
		Possiamo aggiornare questi termini: la data in alto indica l’ultima versione. Si applica la legge italiana.
		{#if data.email}Contatti: <a href="mailto:{data.email}">{data.email}</a>.{/if}
	</p>
	<p>Per il trattamento dei dati vedi l’<a href="/privacy">informativa privacy</a>.</p>
</article>
