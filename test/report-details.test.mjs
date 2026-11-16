import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichCountries, countryName } from '../lib/countries.mjs';
import { renderReport, writeOutputs } from '../lib/output.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const now = new Date('2026-11-16T12:00:00.000Z');
const row = (id = 'test', ip = '8.8.8.8') => ({
  id, name: id, url: 'https://' + id + '.example.org',
  checked_at: now.toISOString(), availability: 'online', api_access: 'open',
  languages: [{ code: 'en' }, { code: 'es' }], language_count: 2,
  supported_files: ['.txt', '.pdf'], files_translation: true, character_limit: 5000,
  endpoints: { languages: { resolved_ip: ip }, translate: { http_status: 200 } },
});
const geoReply = data => ({ status: 200, error: null, text: JSON.stringify(data) });

test('country codes must identify known country or territory names', () => {
  assert.equal(countryName('DE'), 'Germany');
  assert.equal(countryName('BR'), 'Brazil');
  for (const code of [undefined, '', 'de', 'ZZ', 'AA', 'EU', 'UN', 'US" onerror="x']) {
    assert.equal(countryName(code), null);
  }
});

test('geolocation batches unique public IPs and ignores unrelated or invalid results', async () => {
  const calls = [];
  const result = await enrichCountries([row('first'), row('shared'), row('unknown', '1.1.1.1')], {
    now, request: async (url, options) => {
      calls.push({ url, options });
      return geoReply([
        { ip: '8.8.8.8', country: 'DE' }, { ip: '1.1.1.1', country: 'ZZ' },
        { ip: '9.9.9.9', country: 'FR' },
      ]);
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.country.is/');
  assert.deepEqual(calls[0].options.body, ['8.8.8.8', '1.1.1.1']);
  assert.equal(result[0].country.code, 'DE');
  assert.equal(result[1].country.ip, '8.8.8.8');
  assert.equal(result[2].country, null);
  assert.equal(result[0].availability, 'online');
});

test('country cache is reused only for the same IP within 30 days', async () => {
  const prior = {
    ...row(), country: {
      code: 'DE', name: 'Germany', ip: '8.8.8.8',
      source: 'https://country.is', checked_at: '2026-11-15T12:00:00.000Z',
    },
  };
  const cached = await enrichCountries([row()], { previous: [prior], now, request: () => { throw new Error('Must use cache'); } });
  assert.equal(cached[0].country.checked_at, prior.country.checked_at);
  let calls = 0;
  const expired = { ...prior, country: { ...prior.country, checked_at: '2026-10-01T12:00:00.000Z' } };
  const changed = await enrichCountries([row('changed', '1.1.1.1'), row()], {
    previous: [expired], now, request: async (_url, options) => {
      calls++;
      return geoReply(options.body.map(ip => ({ ip, country: 'NL' })));
    },
  });
  assert.equal(calls, 1);
  assert.equal(changed[0].country.code, 'NL');
  assert.equal(changed[1].country.code, 'NL');
});

test('DNS fallback rejects mixed/private addresses and skips disabled instances', async () => {
  const calls = [];
  const entries = [row('public', null), row('private', null), { ...row('disabled', null), availability: 'disabled' }];
  const located = await enrichCountries(entries, {
    resolveMissing: true, now,
    lookup: async host => {
      calls.push(host);
      return host.startsWith('public') ? [{ address: '8.8.8.8', family: 4 }]
        : [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }];
    },
    request: async (_url, options) => {
      assert.deepEqual(options.body, ['8.8.8.8']);
      return geoReply([{ ip: '8.8.8.8', country: 'DE' }]);
    },
  });
  assert.equal(located[0].country.code, 'DE');
  assert.equal(located[1].country, null);
  assert.equal(located[2].country, null);
  assert.equal(calls.length, 2);
});

test('missing probe IPs do not trigger DNS or HTTP requests by default', async () => {
  const result = await enrichCountries([row('unknown', null)], {
    lookup: () => { throw new Error('No DNS expected'); },
    request: () => { throw new Error('No HTTP expected'); },
  });
  assert.equal(result[0].country, null);
});

test('country lookup failures leave translation results unchanged', async () => {
  for (const response of [
    { status: 429, error: null, text: '{}' },
    { status: null, error: 'timeout', text: '' },
    { status: 200, error: null, text: '<html>Not JSON</html>' },
  ]) {
    const result = await enrichCountries([row()], { now, request: async () => response });
    assert.equal(result[0].country, null);
    assert.equal(result[0].api_access, 'open');
    assert.equal(result[0].character_limit, 5000);
  }
});

test('geolocation batches do not exceed the provider limit of 100 IPs', async () => {
  const entries = Array.from({ length: 201 }, (_, index) => row('item-' + index, '8.8.0.' + (index + 1)));
  const sizes = [];
  const result = await enrichCountries(entries, {
    now, request: async (_url, options) => {
      sizes.push(options.body.length);
      return geoReply(options.body.map(ip => ({ ip, country: 'US' })));
    },
  });
  assert.deepEqual(sizes, [100, 100, 1]);
  assert.ok(result.every(item => item.country.code === 'US'));
});

test('report places country images before names and gives counts full hover lists', () => {
  const item = {
    ...row(), country: { code: 'DE', name: 'Germany' },
    languages: [{ code: 'es' }, { code: 'en' }],
    supported_files: ['.txt', '.pdf', '.txt'],
  };
  const report = renderReport({ generated_at: now.toISOString(), instances: [item] });
  assert.match(report, /flagcdn\.com\/16x12\/de\.png/);
  assert.match(report, /title="Germany \(DE\); approximate hosting location"> \[test\]/);
  assert.match(report, /<span title="en, es">2<\/span>/);
  assert.match(report, /<span title="\.pdf, \.txt">2<\/span>/);
  assert.match(report, />5000<\/span>/);
  assert.match(report, /\| File formats \| Character limit \|/);
});

test('unknown countries, disabled files, unlimited and unreported limits stay distinct', () => {
  const items = [
    { ...row('unlimited'), country: { code: 'ZZ' }, character_limit: -1, files_translation: false },
    { ...row('unknown'), character_limit: null, supported_files: [] },
    { ...row('zero'), character_limit: 0 },
  ];
  const report = renderReport({ generated_at: now.toISOString(), instances: items });
  assert.match(report, /Hosting country unknown/);
  assert.ok(!report.includes('/zz.png'));
  assert.match(report, /<span title="File translation disabled">0<\/span>/);
  assert.match(report, />Unlimited<\/span>/);
  assert.match(report, /<span title="No character limit reported">—<\/span>/);
  assert.match(report, />0<\/span>/);
});

test('tooltip values cannot inject attributes, HTML, or table columns', () => {
  const item = {
    ...row(), languages: [{ code: 'en" onmouseover="x' }, { code: '<script>|bad' }],
    supported_files: ['.txt" onmouseover="x', '.pdf|bad'],
  };
  const report = renderReport({ generated_at: now.toISOString(), instances: [item] });
  assert.ok(!report.includes('title="en" onmouseover='));
  assert.ok(!report.includes('<script>'));
  assert.match(report, /&quot;/);
  assert.match(report, /&#124;/);
});

test('working API export keeps country provenance', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lt-country-output-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const country = { code: 'DE', name: 'Germany', ip: '8.8.8.8', source: 'https://country.is', checked_at: now.toISOString() };
  const result = await writeOutputs(directory, [{ ...row(), country }], { now });
  assert.deepEqual(result.open.instances[0].country, country);
});
