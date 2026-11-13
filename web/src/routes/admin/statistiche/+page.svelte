<script lang="ts">
	import { onMount } from 'svelte';
	import ErrorMessage from '$lib/components/ErrorMessage.svelte';
	import { listStats, type RegionMonth } from '$lib/admin';
	import { fmtNum, monthKeys, monthName } from '$lib/format';

	const keys = monthKeys();
	const when = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
	const fmtWhen = (ms: number | null) => (ms ? when.format(ms) : '–');
	let rows: RegionMonth[] | null = $state(null);
	let failed = $state(false);
	// Il dato più vecchio: se una regione non si aggiorna da giorni si vede subito.
	const oldest = $derived.by(() => {
		const t = (rows ?? []).map((r) => r.updatedAt).filter((x): x is number => x !== null);
		return t.length ? Math.min(...t) : null;
	});

	onMount(async () => {
		try {
			const all = await listStats([keys.cur]);
			rows = all.filter((r) => r.month === keys.cur).sort((a, b) => a.name.localeCompare(b.name, 'it'));
		} catch {
			failed = true;
		}
	});
</script>

<h1>Statistiche</h1>
<p class="muted">
	<strong>{monthName(keys.cur)}</strong>: eventi con date nel mese, contati ogni giorno dall’import (un evento già finito resta nel totale).
	<strong>Prossimi 60 giorni</strong>: eventi in corso o futuri oggi, il numero scende quando finiscono.
	Una regione con 0 a {monthName(keys.cur)} può avere eventi nei mesi dopo.
</p>
{#if oldest}<p class="muted">Dati aggiornati al più tardi il {fmtWhen(oldest)} (ora di Roma).</p>{/if}

{#if failed}
	<ErrorMessage>Non riesco a leggere le statistiche.</ErrorMessage>
{:else if !rows}
	<p class="muted" role="status">Carico…</p>
{:else if !rows.length}
	<p class="muted">Nessuna statistica per {monthName(keys.cur)}: compaiono dopo il prossimo import.</p>
{:else}
	<div class="scroll">
	<table>
		<thead>
			<tr>
				<th scope="col">Regione</th>
				<th scope="col" class="num">A {monthName(keys.cur)}</th>
				<th scope="col" class="num">Prossimi 60 giorni</th>
				<th scope="col" class="num">Comuni</th>
				<th scope="col" class="cities">Città principali</th>
				<th scope="col" class="cities">Aggiornato</th>
			</tr>
		</thead>
		<tbody>
			{#each rows as r (r.region)}
				<tr>
					<th scope="row"><a href="/regione/{r.region}">{r.name}</a></th>
					<td class="num">{fmtNum(r.events)}</td>
					<td class="num">{r.upcoming === null ? '–' : fmtNum(r.upcoming)}</td>
					<td class="num">{fmtNum(r.comuni)}</td>
					<td class="cities">{r.cities.slice(0, 3).map((c) => `${c.name} ${fmtNum(c.n)}`).join(', ')}</td>
					<td class="cities">{fmtWhen(r.updatedAt)}</td>
				</tr>
			{/each}
		</tbody>
	</table>
	</div>
{/if}

<style>
	.scroll {
		overflow-x: auto;
	}
	@media (max-width: 479px) {
		.cities {
			display: none;
		}
		th,
		td {
			padding-inline: var(--space-1);
		}
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--text-sm);
	}
	th,
	td {
		padding: var(--space-2) var(--space-3);
		border-bottom: 1px solid var(--border);
		text-align: left;
		vertical-align: top;
	}
	thead th {
		font-weight: var(--fw-strong);
		color: var(--muted);
	}
	tbody th {
		font-weight: var(--fw-regular);
	}
	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
</style>
