<script lang="ts">
	import Seo from '$lib/components/Seo.svelte';
	import { TOOLS } from '$lib/cookies';
	let { data } = $props();

	const where = { localStorage: 'localStorage', indexedDB: 'IndexedDB', cacheStorage: 'Cache del browser', sessionStorage: 'sessionStorage', cookie: 'Cookie' } as const;
</script>

<Seo title="Cookie e archiviazione" description="Quali strumenti tecnici Eventi Vicini scrive nel tuo browser, a cosa servono e quanto durano. Nessun banner: non c'è nulla da accettare." />

<article class="container narrow prose">
	<h1>Cookie e archiviazione</h1>
	<p class="muted">Ultimo aggiornamento: {data.updated}</p>

	<p>
		Il sito non imposta cookie. Usa solo strumenti tecnici del browser, strettamente necessari a farlo funzionare: per questo
		non c’è nessun banner e non c’è nulla da accettare. Non ci sono cookie di profilazione, pubblicità, social o
		strumenti che ti riconoscano da un sito all’altro.
	</p>

	<h2>Statistiche</h2>
	<p>
		{#if data.analytics}
			Contiamo le visite in forma aggregata con Cloudflare Web Analytics, che non usa cookie né archiviazione nel browser e
			non identifica i singoli visitatori. Non c’è tracciamento individuale.
		{:else}
			Al momento non raccogliamo statistiche. Se le attiveremo useremo solo Cloudflare Web Analytics, che non usa cookie né
			archiviazione nel browser e non identifica i singoli visitatori, e aggiorneremo questa pagina.
		{/if}
	</p>

	<h2>Strumenti tecnici</h2>
	<!-- Regione scorrevole: va raggiunta da tastiera (WCAG 2.1.1). -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div class="table-wrap" role="region" aria-label="Elenco degli strumenti tecnici" tabindex="0">
		<table>
			<thead>
				<tr><th scope="col">Nome</th><th scope="col">Dove</th><th scope="col">A cosa serve</th><th scope="col">Durata</th><th scope="col">Chi lo scrive</th></tr>
			</thead>
			<tbody>
				{#each TOOLS as t (t.kind + t.label)}
					<tr>
						<th scope="row"><code>{t.label}</code>{#if t.account}<br /><span class="muted small">solo con un account</span>{/if}</th>
						<td>{where[t.kind]}</td>
						<td>{t.purpose}</td>
						<td>{t.duration}</td>
						<td>{t.origin}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<h2>Come cancellarli</h2>
	<p>
		Dalle impostazioni del browser puoi cancellare i dati del sito in qualsiasi momento: perdi la zona, i preferiti locali e
		la sessione, non altro. Altre informazioni sul trattamento dei dati sono nell’<a href="/privacy">informativa privacy</a>.
	</p>
</article>

<style>
	.table-wrap {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--text-sm);
	}
	th,
	td {
		padding: var(--space-2);
		border-bottom: 1px solid var(--border);
		text-align: left;
		vertical-align: top;
	}
	thead th {
		white-space: nowrap;
	}
	code {
		overflow-wrap: anywhere;
	}
</style>
