import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { offlineSince, planOfflineRemovals, renderRemovalPullRequest } from '../lib/offline.mjs';
import { checkInstance } from '../lib/checker.mjs';
import { writeOutputs } from '../lib/output.mjs';

const DAY = 86_400_000;
const now = new Date('2026-11-16T12:00:00.000Z');
const iso = time => new Date(time).toISOString();
const dead = {
  id: 'dead', name: 'Dead server', url: 'https://dead.example.org',
  sources: ['https://example.org'], enabled: true, probe_translation: true,
};
const alive = { ...dead, id: 'alive', name: 'Alive server', url: 'https://alive.example.org' };
const catalog = [dead, alive];

function fixture(at = now) {
  const checked_at = at.toISOString();
  const item = {
    ...dead, checked_at, availability: 'offline', api_access: 'unverified',
    offline_since: iso(at.getTime() - 8 * DAY),
    endpoints: { health: { http_status: null, error: 'timeout' }, translate: null },
  };
  const online = {
    ...alive, checked_at, availability: 'online', api_access: 'open', offline_since: null,
    endpoints: { translate: { http_status: 200 } },
  };
  const history = Array.from({ length: 8 }, (_, offset) => {
    const date = iso(at.getTime() - offset * DAY);
    return { schema_version: 1, generated_at: date, instances: [{ ...item, checked_at: date }] };
  });
  return {
    snapshot: { schema_version: 1, generated_at: checked_at, instances: [item, online] },
    history, item,
  };
}
const plan = data => planOfflineRemovals(catalog, data.snapshot, data.history, { now });

test('eligible removal includes eight dated observations and elapsed outage time', () => {
  const result = plan(fixture());
  assert.equal(result.suppressed, null);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].offline_days, 8);
  assert.deepEqual(result.candidates[0].evidence.map(day => day.date),
    ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16']);
});

test('exactly seven days is excluded; seven days and one millisecond qualifies', () => {
  for (const [extra, expected] of [[0, 0], [1, 1]]) {
    const data = fixture();
    const since = iso(now.getTime() - 7 * DAY - extra);
    data.item.offline_since = since;
    for (const day of data.history) day.instances[0].offline_since = since;
    assert.equal(plan(data).candidates.length, expected);
  }
});

test('many same-day failures cannot replace eight daily observations', () => {
  const data = fixture();
  data.history = [data.history[0]];
  data.item.consecutive_failures = 1000;
  assert.equal(plan(data).candidates.length, 0);
});

test('missing dates, recovery, changed URLs and changed outage starts reject candidates', () => {
  const changes = [
    data => data.history.splice(4, 1),
    data => { data.history[4].instances[0].availability = 'degraded'; },
    data => { data.history[4].instances[0].url = 'https://moved.example.org'; },
    data => { data.history[4].instances[0].offline_since = '2026-11-11T12:00:00.000Z'; },
    data => { data.history[4].instances[0].checked_at = '2026-11-13T12:00:00.000Z'; },
    data => { data.history[4].generated_at = 'not a date'; },
    data => { delete data.history[4].instances[0].checked_at; },
  ];
  for (const change of changes) {
    const data = fixture();
    change(data);
    assert.equal(plan(data).candidates.length, 0, change.toString());
  }
});

test('responsive, disabled, key-required and rate-limited instances are kept', () => {
  for (const availability of ['online', 'degraded', 'disabled']) {
    const data = fixture();
    data.item.availability = availability;
    assert.equal(plan(data).candidates.length, 0);
  }
  for (const api_access of ['key_required', 'rate_limited', 'authentication_required']) {
    const data = fixture();
    data.item.availability = 'online';
    data.item.api_access = api_access;
    assert.equal(plan(data).candidates.length, 0);
  }
  const data = fixture();
  assert.equal(planOfflineRemovals([{ ...dead, enabled: false }, alive], data.snapshot, data.history, { now }).candidates.length, 0);
});

test('fresh status must match the current catalog URL', () => {
  const data = fixture();
  data.item.url = 'https://old.example.org';
  assert.equal(plan(data).candidates.length, 0);
});

test('stale and future snapshots or individual observations cannot authorize removal', () => {
  for (const generated_at of [iso(now.getTime() - 37 * 3600000), iso(now.getTime() + 1), 'invalid']) {
    const data = fixture();
    data.snapshot.generated_at = generated_at;
    assert.equal(plan(data).candidates.length, 0);
    assert.ok(plan(data).suppressed);
  }
  for (const checked_at of [iso(now.getTime() - 37 * 3600000), iso(now.getTime() + 1), 'invalid']) {
    const data = fixture();
    data.item.checked_at = checked_at;
    assert.equal(plan(data).candidates.length, 0);
  }
});

test('a whole-network outage suspends cleanup even with old failures', () => {
  const data = fixture();
  data.snapshot.instances[1].availability = 'offline';
  assert.match(plan(data).suppressed, /No enabled instance returned HTTP/);
  assert.equal(plan(data).candidates.length, 0);
  data.snapshot.instances[1].availability = 'degraded';
  data.snapshot.instances[1].endpoints.translate.http_status = 503;
  assert.equal(plan(data).candidates.length, 1);
});

test('retention of 90 days does not reset an otherwise well-evidenced longer outage', () => {
  const data = fixture();
  const since = '2026-07-01T12:00:00.000Z';
  data.item.offline_since = since;
  for (const day of data.history) day.instances[0].offline_since = since;
  assert.equal(plan(data).candidates.length, 1);
});

test('streak tracking keeps the first check across daily and same-day failures', () => {
  const current = fixture().item;
  const previous = { ...current, checked_at: '2026-11-15T12:00:00.000Z' };
  assert.equal(offlineSince(current, previous), current.offline_since);
  assert.equal(offlineSince(current, { ...previous, checked_at: current.checked_at }), current.offline_since);
});

test('streak tracking resets on recovery, gaps, new URLs, legacy data and bad clocks', () => {
  const current = fixture().item;
  const previous = { ...current, checked_at: '2026-11-15T12:00:00.000Z' };
  for (const overrides of [
    { availability: 'online' }, { availability: 'degraded' }, { availability: 'disabled' },
    { checked_at: '2026-11-14T12:00:00.000Z' },
    { checked_at: '2026-11-14T23:00:00.000Z' },
    { url: 'https://changed.example.org' }, { id: 'changed' }, { offline_since: undefined },
    { offline_since: '2026-11-16T11:00:00.000Z' }, { checked_at: '2026-11-17T12:00:00.000Z' },
  ]) assert.equal(offlineSince(current, { ...previous, ...overrides }), current.checked_at);
  assert.equal(offlineSince({ ...current, checked_at: '2026-11-16T00:00:00.000Z' },
    { ...previous, checked_at: '2026-11-14T23:00:00.000Z' }), '2026-11-16T00:00:00.000Z');
  assert.equal(offlineSince({ ...current, availability: 'online' }, previous), null);
});

test('checker writes and resets offline_since, including recovery within the same day', async () => {
  const current = fixture().item;
  const previous = { ...current, checked_at: '2026-11-15T12:00:00.000Z' };
  const request = async () => ({ status: null, text: '', error: 'timeout', latency_ms: 1 });
  const result = await checkInstance(dead, { previous, now: () => now, request });
  assert.equal(result.offline_since, previous.offline_since);
  const recovered = await checkInstance(dead, {
    previous: result, now: () => now,
    request: async () => ({ status: 503, text: '{}', error: null, latency_ms: 1 }),
  });
  assert.equal(recovered.availability, 'degraded');
  assert.equal(recovered.offline_since, null);
  const failedAgain = await checkInstance(dead, { previous: recovered, now: () => now, request });
  assert.equal(failedAgain.offline_since, now.toISOString());
  const disabled = await checkInstance({ ...dead, enabled: false }, { previous, now: () => now, request });
  assert.equal(disabled.offline_since, null);
});

test('daily output stores exact check time and outage start for future eligibility', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lt-streak-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = fixture();
  data.item.languages = [];
  await writeOutputs(directory, [data.item], { now });
  const day = JSON.parse(await readFile(join(directory, 'history/2026-11-16.json'), 'utf8'));
  assert.equal(day.instances[0].checked_at, data.item.checked_at);
  assert.equal(day.instances[0].offline_since, data.item.offline_since);
});

test('PR body includes dated evidence, review instructions and escaped names', () => {
  const result = plan(fixture());
  result.candidates[0].name = '<script>|bad';
  const body = renderRemovalPullRequest(result);
  assert.match(body, /2026-11-08T12:00:00.000Z/);
  assert.match(body, /history\/2026-11-16.json/);
  assert.match(body, /maintainer must review and merge/);
  assert.ok(!body.includes('<script>'));
});

test('CLI dry-run preserves catalog; prepare removes only eligible entries and preserves metadata', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lt-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = fixture(new Date());
  const catalogPath = join(directory, 'instances.json');
  const document = { $schema: '../schema/instances.schema.json', schema_version: 1, instances: catalog };
  const original = JSON.stringify(document, null, 2) + '\n';
  await writeFile(catalogPath, original);
  await mkdir(join(directory, 'history'));
  await writeFile(join(directory, 'status.json'), JSON.stringify(data.snapshot));
  for (const day of data.history) {
    await writeFile(join(directory, 'history', day.generated_at.slice(0, 10) + '.json'), JSON.stringify(day));
  }
  const args = [
    fileURLToPath(new URL('../scripts/cleanup.mjs', import.meta.url)),
    '--catalog', catalogPath, '--data-dir', directory, '--out-dir', join(directory, 'plan'),
  ];
  const run = promisify(execFile);
  await run(process.execPath, args);
  assert.equal(await readFile(catalogPath, 'utf8'), original);
  const result = JSON.parse(await readFile(join(directory, 'plan/plan.json'), 'utf8'));
  assert.equal(result.candidates.length, 1);
  await run(process.execPath, [...args, '--apply']);
  const proposed = JSON.parse(await readFile(catalogPath, 'utf8'));
  assert.deepEqual(proposed, { ...document, instances: [alive] });
});

test('CLI with no candidates leaves catalog unchanged, allowing an existing PR to close', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lt-cleanup-empty-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = fixture(new Date());
  const original = JSON.stringify({ schema_version: 1, instances: catalog });
  const catalogPath = join(directory, 'instances.json');
  await writeFile(catalogPath, original);
  await writeFile(join(directory, 'status.json'), JSON.stringify(data.snapshot));
  await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../scripts/cleanup.mjs', import.meta.url)),
    '--catalog', catalogPath, '--data-dir', directory, '--out-dir', join(directory, 'plan'), '--apply',
  ]);
  assert.equal(await readFile(catalogPath, 'utf8'), original);
  assert.equal(JSON.parse(await readFile(join(directory, 'plan/plan.json'), 'utf8')).candidates.length, 0);
});
