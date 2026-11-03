<script lang="ts">
	import Seo from '$lib/components/Seo.svelte';
	let { data } = $props();
</script>

<Seo title="Informativa privacy" description="Quali dati tratta Eventi Vicini, perché, per quanto tempo e con quali fornitori. Nessun tracciamento, nessuna pubblicità." />

<article class="container narrow prose">
	<h1>Informativa privacy</h1>
	<p class="muted">Ultimo aggiornamento: {data.updated}</p>

	<p>
		Eventi Vicini è un’agenda gratuita di eventi. Non usiamo pixel, pubblicità, cookie di profilazione né tracciamento individuale:
		trattiamo solo i dati che servono a farti usare il servizio. Questa informativa è resa ai sensi degli artt. 13–14
		del Regolamento (UE) 2016/679 (GDPR).
	</p>

	<h2>Titolare del trattamento</h2>
	<p>
		Il titolare è {data.controller}.
		{#if data.email}Per qualsiasi richiesta scrivi a <a href="mailto:{data.email}">{data.email}</a>.{/if}
	</p>

	<h2>Quali dati e perché</h2>
	<ul>
		<li>
			<strong>Navigazione senza account.</strong> Non raccogliamo dati personali. La tua posizione (se la condividi o
			cerchi una città), i preferiti e il tema scelto restano <em>solo sul tuo dispositivo</em> (localStorage): non li
				salviamo sui nostri server. Per trovare gli eventi vicini il browser invia al server coordinate arrotondate a
					qualche chilometro, che non vengono registrate. Per mostrarti l’elenco dei preferiti il browser invia al server
					gli identificativi degli eventi salvati: non sono collegati a te e non li registriamo. Se cerchi un luogo per
					nome, il testo cercato viene inviato al nostro server, che lo passa a Nominatim (vedi sotto).
		</li>
		<li>
			<strong>Account (facoltativo).</strong> Se accedi con Google o con un link via email trattiamo: identificativo
				dell’account (uid), nome, indirizzo email, città preferita se la indichi, la zona che scegli per cercare eventi
				(nome e coordinate del comune o della zona, mai la tua posizione esatta, così la ritrovi su un altro dispositivo),
				data di creazione, i tuoi preferiti (con un contatore e la data dell’ultima modifica, che servono a limitare gli abusi: al massimo 200 preferiti e 100 modifiche al giorno) e le proposte di evento che invii, con il loro stato.
		</li>
		<li>
			<strong>Proposte di evento.</strong> I dati dell’evento (titolo, luogo, date, link) vengono pubblicati se approvati.
			Chi ha proposto l’evento non viene mai mostrato pubblicamente e il suo identificativo non è salvato
				nell’evento pubblicato: resta solo nella proposta, leggibile da te e dall’amministratore. Se usi la mappa del
				modulo “Proponi”, le coordinate del segnaposto (arrotondate a circa 11 metri) vengono inviate al nostro server
				per ricavare il comune tramite Nominatim.
		</li>
		<li>
			<strong>Segnalazioni.</strong> Chiunque, anche senza account, può segnalare un evento dalla sua pagina. Conserviamo
			l’evento segnalato, il motivo, la spiegazione che scrivi, l’email se ti va di lasciarla (serve solo per dirti
			l’esito) e la data. Non registriamo altro su chi segnala e la segnalazione non è collegata al tuo account.
			Dopo la decisione conserviamo anche la motivazione.
		</li>
		<li>
			<strong>Dati tecnici.</strong> I fornitori qui sotto trattano l’indirizzo IP e dati di connessione per consegnare le
			pagine e proteggere il servizio da abusi.
		</li>
	</ul>

	<h2>Base giuridica</h2>
	<p>
		Il trattamento è necessario per eseguire il servizio che richiedi (art. 6.1.b GDPR): mostrarti gli eventi,
		conservare i tuoi preferiti, gestire le tue proposte. I dati tecnici di sicurezza si basano sul legittimo interesse
		a mantenere il servizio sicuro e funzionante (art. 6.1.f). Per le segnalazioni la base è l’obbligo di legge di
		prevedere un meccanismo di segnalazione dei contenuti illegali (art. 6.1.c; Regolamento (UE) 2022/2065, art. 16) e il
		legittimo interesse a tenere l’agenda corretta (art. 6.1.f).
	</p>

	<h2>Per quanto tempo</h2>
	<ul>
		<li>Dati dell’account e preferiti: finché non elimini l’account. Puoi farlo in ogni momento da <a href="/account">Il mio account</a> → “Elimina account e dati” (il pulsante è sempre disponibile): cancelliamo profilo, preferiti, proposte e l’account di accesso. In alternativa puoi chiederlo scrivendo{#if data.email} a <a href="mailto:{data.email}">{data.email}</a>{:else} al titolare{/if}.</li>
			<li>Proposte già esaminate: le eliminiamo in automatico, quelle rifiutate dopo 90 giorni e quelle approvate dopo 30 giorni dalla revisione; quelle ancora in attesa restano finché non le ritiri o elimini l’account.</li>
		<li>Segnalazioni: quelle aperte restano finché non le esaminiamo; quelle decise, con la motivazione, le eliminiamo in automatico dopo 180 giorni dalla decisione.</li>
		<li>Gli eventi approvati restano pubblicati come contenuto dell’agenda, senza alcun riferimento visibile a chi li ha proposti.</li>
		<li>Dati sul tuo dispositivo: finché non li cancelli dalle impostazioni del browser.</li>
	</ul>

	<h2>Fornitori e trasferimenti</h2>
	<ul>
		<li><strong>Google Firebase</strong> (Google LLC / Google Ireland Ltd): autenticazione e database. Responsabile del trattamento. Il browser contatta i server di Google (SDK di accesso) solo se accedi o usi funzioni dell’account.</li>
		<li><strong>Cloudflare, Inc.</strong>: hosting e consegna delle pagine{#if data.analytics}, statistiche aggregate (Web Analytics, senza cookie né identificazione dei visitatori){/if}{#if data.appCheck} e verifica anti-bot (Turnstile){/if}. Responsabile del trattamento.{#if data.appCheck} Quando usi funzioni dell’account (accesso, preferiti sincronizzati, proposte, segnalazioni) il browser carica il controllo Turnstile da Cloudflare, che vede il tuo indirizzo IP e le caratteristiche del browser per distinguere le persone dai programmi automatici. Il nostro server riceve solo l’esito, senza il tuo IP, e rilascia un token temporaneo (30 minuti) che Firebase usa per accettare le richieste.{/if}</li>
		<li>
			<strong>OpenStreetMap Foundation</strong> (Regno Unito): le tessere della mappa sono scaricate direttamente dal tuo
			browser, quindi OpenStreetMap vede il tuo indirizzo IP. La ricerca di luoghi (Nominatim) passa dal nostro server,
				quindi Nominatim non riceve il tuo IP, ma riceve il testo cercato e, dal modulo “Proponi”, le coordinate del
				segnaposto. Le risposte restano nella cache di Cloudflare per un giorno.
		</li>
	</ul>
	<p>
		Google e Cloudflare possono trattare dati negli Stati Uniti: il trasferimento è coperto dall’EU-US Data Privacy
		Framework, a cui entrambe le società aderiscono, e dalle clausole contrattuali standard. Per il Regno Unito vale la
		decisione di adeguatezza della Commissione europea.
	</p>

	<h2>Siti di terzi e biglietti</h2>
	<p>
		Alcuni eventi (concerti e spettacoli) arrivano dall’API pubblica di Ticketmaster, che ne è la fonte. Il pulsante
		“Acquista i biglietti” e i link alle fonti sono semplici collegamenti: finché non li apri non inviamo nulla a terzi e
		non carichiamo script di Ticketmaster. L’unico contatto prima del clic sono le immagini degli eventi, che il tuo
			browser scarica direttamente dai server che le ospitano: Ticketmaster, il sito del Comune o dell’ente che
			pubblica l’evento (sono centinaia), Open Data Hub Alto Adige e, per gli eventi proposti dagli utenti, l’indirizzo
			https indicato nella proposta. Il browser non invia l’indirizzo della pagina (niente Referer), ma il server che
			fornisce l’immagine vede il tuo indirizzo IP. Dopo il clic sei sul sito del venditore, che può impostare i propri cookie e
		trattare i tuoi dati con la propria informativa. Non riceviamo commissioni e non
		sappiamo se acquisti.
	</p>

	<h2>Cookie e archiviazione locale</h2>
	<p>
			Non impostiamo cookie. Usiamo solo archiviazione tecnica, strettamente necessaria (localStorage, IndexedDB e la cache del browser): preferiti, posizione, tema, la
				sessione di accesso di Firebase, l’indirizzo email inserito per ricevere il link di accesso (cancellato quando
				l’accesso è completato), la memoria delle ultime ricerche di luoghi, per non ripeterle, l’elenco degli eventi che
				hai già segnalato da questo dispositivo (per non duplicare la segnalazione) e fino a 40 pagine pubbliche già
				visitate, per poterle aprire anche senza rete (restano fuori account, accesso e moduli). Nessun cookie
		di terze parti per pubblicità o statistiche sul nostro sito (quelli dei siti a cui rimandiamo nascono solo dopo il clic), per questo non vedi banner.
		{#if data.analytics}
			Contiamo le visite in forma aggregata con Cloudflare Web Analytics, che non usa cookie né archiviazione nel browser e
			non identifica i singoli visitatori: non c’è tracciamento individuale.
		{:else}
			Non raccogliamo statistiche; se le attivassimo useremmo solo Cloudflare Web Analytics, che non usa cookie né
			archiviazione nel browser e non identifica i singoli visitatori.
		{/if}
		L’elenco completo, con nome, scopo e durata, è nella pagina <a href="/cookie">Cookie e archiviazione</a>.
	</p>

	<h2>I tuoi diritti</h2>
	<p>
		Puoi chiedere accesso, rettifica, cancellazione, limitazione, portabilità dei dati e opporti al trattamento
			(artt. 15–22 GDPR). Con un account puoi scaricare i tuoi dati in un file JSON da <a href="/account">Il mio
			account</a> → “Scarica i miei dati”, e cancellarli con “Elimina account e dati”. Per il resto
			scrivi{#if data.email} a <a href="mailto:{data.email}">{data.email}</a>{:else} al titolare{/if}. Puoi anche proporre
		reclamo al <a href="https://www.garanteprivacy.it" rel="noopener">Garante per la protezione dei dati personali</a>.
	</p>

	<h2>Età minima</h2>
	<p>Per creare un account devi avere almeno 14 anni (art. 2-quinquies del Codice privacy).</p>
</article>
