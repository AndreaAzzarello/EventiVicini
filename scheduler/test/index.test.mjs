import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatch } from '../src/index.mjs';

const env = { GITHUB_TOKEN: 't0k', GITHUB_REPO: 'o/r', WORKFLOW: 'import-events.yml', REF: 'main' };

test('chiama workflow_dispatch con ref e auto=true', async () => {
  let call;
  const status = await dispatch(env, async (url, init) => ((call = { url, init }), new Response(null, { status: 204 })));
  assert.equal(status, 204);
  assert.equal(call.url, 'https://api.github.com/repos/o/r/actions/workflows/import-events.yml/dispatches');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer t0k');
  assert.deepEqual(JSON.parse(call.init.body), { ref: 'main', inputs: { auto: 'true' } });
});

test('errore se GitHub non risponde 204', async () => {
  await assert.rejects(dispatch(env, async () => new Response('Bad credentials', { status: 401 })), /401.*Bad credentials/);
});

test('errore chiaro senza token', async () => {
  await assert.rejects(dispatch({ ...env, GITHUB_TOKEN: '' }, async () => assert.fail('non deve chiamare')), /GITHUB_TOKEN/);
});

import worker, { SCARICA_CRON } from '../src/index.mjs';

const full = { ...env, SCARICA_WORKFLOW: 'scarica-fonti.yml' };

async function run(cron) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (calls.push({ url, body: JSON.parse(init.body) }), new Response(null, { status: 204 }));
  try {
    const pending = [];
    await worker.scheduled({ cron }, full, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
  } finally {
    globalThis.fetch = realFetch;
  }
  return calls;
}

test('il cron delle 06:45 avvia scarica-fonti.yml senza input', async () => {
  const [c, ...rest] = await run(SCARICA_CRON);
  assert.equal(rest.length, 0);
  assert.match(c.url, /workflows\/scarica-fonti\.yml\/dispatches$/);
  assert.deepEqual(c.body, { ref: 'main' });
});

test('il cron delle 08:17 avvia ancora l\'import con auto=true', async () => {
  const [c] = await run('17 8 * * *');
  assert.match(c.url, /workflows\/import-events\.yml\/dispatches$/);
  assert.deepEqual(c.body, { ref: 'main', inputs: { auto: 'true' } });
});

test('wrangler.toml dichiara entrambi i cron e il nome del workflow', async () => {
  const { readFileSync } = await import('node:fs');
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.ok(toml.includes(`"${SCARICA_CRON}"`) && toml.includes('"17 8 * * *"'));
  assert.ok(toml.includes('SCARICA_WORKFLOW = "scarica-fonti.yml"'));
});
