/**
 * Avvia un workflow di GitHub con workflow_dispatch.
 * - import-events.yml con auto=true (il workflow salta se l'import di oggi è già partito);
 * - scarica-fonti.yml senza input (il suo job `guard` evita le doppie esecuzioni della riserva di GitHub).
 */
export async function dispatch(env, fetchFn = fetch, workflow = env.WORKFLOW, inputs = { auto: 'true' }) {
  if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN mancante: npx wrangler secret put GITHUB_TOKEN');
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`;
  const body = { ref: env.REF };
  if (inputs) body.inputs = inputs;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'eventi-vicini-scheduler'
    },
    body: JSON.stringify(body)
  });
  if (res.status !== 204) throw new Error(`GitHub ha risposto ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status;
}

/** Cron di `wrangler.toml` che avvia scarica-fonti.yml; ogni altro cron avvia l'import. */
export const SCARICA_CRON = '45 6 * * *';

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === SCARICA_CRON) ctx.waitUntil(dispatch(env, fetch, env.SCARICA_WORKFLOW, null));
    else ctx.waitUntil(dispatch(env));
  }
};
