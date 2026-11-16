import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { checkInstance } from '../lib/checker.mjs';
import { requestEndpoint } from '../lib/http.mjs';
import { confirmedRefusal, eligibleOffline } from '../lib/reachability.mjs';
import { renderReport } from '../lib/output.mjs';

const instance = { id: 'test', name: 'Test server', url: 'https://test.example.org',
  sources: ['https://example.org'], enabled: true, probe_translation: true };
const now = () => new Date('2026-11-16T12:00:00.000Z');
const languages = [{ code: 'en', targets: ['es'] }, { code: 'es', targets: ['en'] }];
const failed = (code = 'ETIMEDOUT', error = 'timeout', stage = 'request') => ({
  status: null, error, error_code: code, error_stage: stage, latency_ms: 1,
  resolved_ip: stage === 'dns' ? null : '93.184.216.34', text: '',
});
const response = (status, body) => ({
  status, error: null, error_code: null, error_stage: null,
  resolved_ip: '93.184.216.34', text: JSON.stringify(body), latency_ms: 1,
});
const options = { now, sleep: async () => {} };

test('routing, TLS and address-filter failures are unreachable and never retried', async () => {
  for (const reply of [
    { ...failed('ENETUNREACH', 'connection_error'), resolved_ip: '2606:4700:4700::1111' },
    failed('EHOSTUNREACH', 'connection_error'),
    failed('EADDRNOTAVAIL', 'connection_error'),
    failed('ERR_TLS_CERT_ALTNAME_INVALID', 'tls_error'),
    failed(null, 'non_public_address', 'dns'),
    failed(null, 'unsafe_url', 'dns'),
  ]) {
    let calls = 0;
    const item = await checkInstance(instance, {
      ...options, request: async () => { calls++; return reply; },
      sleep: () => { throw new Error('No recheck expected'); },
    });
    assert.equal(calls, 4);
    assert.equal(item.availability, 'unreachable');
    assert.equal(item.offline_since, null);
    assert.equal(eligibleOffline(item), false);
    assert.equal(item.down_check.confirmation, null);
    assert.ok(item.availability_reason.length > 0);
    if (reply.error_code === 'ENETUNREACH') assert.match(item.availability_reason, /IPv6 route/);
    if (reply.error === 'tls_error') assert.match(item.availability_reason, /ERR_TLS_CERT_ALTNAME_INVALID/);
  }
});

test('DNS failures, timeouts and connection resets get one delayed GET but no offline countdown', async () => {
  for (const reply of [
    failed('EAI_AGAIN', 'dns_error', 'dns'),
    failed('ENOTFOUND', 'dns_error', 'dns'),
    failed(), failed('ECONNRESET', 'connection_error'),
    failed(null, 'connection_error'),
  ]) {
    const calls = [], sleeps = [];
    const item = await checkInstance(instance, {
      ...options,
      request: async (url, settings) => { calls.push({ url, settings }); return reply; },
      sleep: async duration => sleeps.push(duration),
    });
    assert.equal(calls.length, 5);
    assert.deepEqual(sleeps, [2000]);
    assert.equal(calls[4].url, instance.url + '/languages');
    assert.equal(calls[4].settings.method, undefined);
    assert.equal(calls[4].settings.timeoutMs, 15000);
    assert.equal(calls[4].settings.avoidAddress, reply.resolved_ip ?? undefined);
    assert.equal(item.availability, 'unreachable');
    assert.equal(item.offline_since, null);
    assert.equal(eligibleOffline(item), false);
    assert.equal(item.down_check.confirmation.error_code, reply.error_code);
  }
});

test('a successful delayed language GET recovers API discovery and sends just one translation', async () => {
  const calls = [];
  const item = await checkInstance(instance, {
    ...options, request: async (url, settings) => {
      calls.push({ url, settings });
      if (calls.length <= 4) return failed();
      if (url.endsWith('/languages')) return response(200, languages);
      assert.equal(url, instance.url + '/translate');
      return response(200, { translatedText: 'hola' });
    },
  });
  assert.equal(item.availability, 'online');
  assert.equal(item.availability_reason, null);
  assert.equal(item.api_access, 'open');
  assert.equal(item.language_count, 2);
  assert.equal(item.offline_since, null);
  assert.equal(calls.filter(call => call.settings.method === 'POST').length, 1);
  assert.equal(item.down_check.primary.languages.error_code, 'ETIMEDOUT');
  assert.equal(item.down_check.confirmation.http_status, 200);
});

test('HTTP auth, challenges, rate limits and server errors on recheck break the outage', async () => {
  for (const status of [301, 401, 403, 429, 503]) {
    let calls = 0;
    const item = await checkInstance(instance, {
      ...options, request: async () => ++calls <= 4 ? failed('ECONNREFUSED', 'connection_error') : response(status, {}),
    });
    assert.equal(item.availability, 'degraded');
    assert.equal(item.offline_since, null);
    assert.equal(eligibleOffline(item), false);
    assert.equal(calls, 5);
    if (status >= 400) assert.match(item.availability_reason, new RegExp('HTTP ' + status));
  }
});

test('only consistent endpoint refusals plus a refused GET recheck start an offline streak', async () => {
  const refused = failed('ECONNREFUSED', 'connection_error');
  const item = await checkInstance(instance, { ...options, request: async () => refused });
  assert.equal(item.availability, 'offline');
  assert.equal(item.offline_since, now().toISOString());
  assert.equal(confirmedRefusal(item.down_check), true);
  assert.equal(eligibleOffline(item), true);
  for (const primary of [failed(), failed('EAI_AGAIN', 'dns_error', 'dns')]) {
    let calls = 0;
    const mixed = await checkInstance(instance, {
      ...options, request: async () => ++calls === 1 ? primary : refused,
    });
    assert.equal(mixed.availability, 'unreachable');
    assert.equal(mixed.offline_since, null);
    assert.equal(eligibleOffline(mixed), false);
  }
});

test('a timeout or routing error on recheck prevents a refusal countdown', async () => {
  for (const final of [failed(), failed('ENETUNREACH', 'connection_error')]) {
    let calls = 0;
    const item = await checkInstance(instance, {
      ...options, request: async () => ++calls <= 4 ? failed('ECONNREFUSED', 'connection_error') : final,
    });
    assert.equal(item.availability, 'unreachable');
    assert.equal(item.offline_since, null);
  }
});

test('transport retains error codes and separates DNS from request failures', async () => {
  const dnsFailure = await requestEndpoint(instance.url, {
    lookup: async () => { throw Object.assign(new Error('DNS unavailable'), { code: 'EAI_AGAIN' }); },
  });
  assert.equal(dnsFailure.error, 'dns_error');
  assert.equal(dnsFailure.error_code, 'EAI_AGAIN');
  assert.equal(dnsFailure.error_stage, 'dns');
  assert.equal(dnsFailure.resolved_ip, null);

  const dnsTimeout = await requestEndpoint(instance.url, { timeoutMs: 10, lookup: () => new Promise(() => {}) });
  assert.equal(dnsTimeout.error_code, 'ETIMEDOUT');
  assert.equal(dnsTimeout.error_stage, 'dns');

  for (const [code, kind] of [
    ['ECONNREFUSED', 'connection_error'], ['ENETUNREACH', 'connection_error'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls_error'], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls_error'],
  ]) {
    const result = await requestEndpoint(instance.url, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: () => {
        const req = new EventEmitter();
        req.end = () => queueMicrotask(() => req.emit('error', Object.assign(new Error('Failed'), { code })));
        return req;
      },
    });
    assert.equal(result.error_code, code);
    assert.equal(result.error_stage, 'request');
    assert.equal(result.error, kind);
  }
});

test('recheck deadlines are capped and POST opt-outs still hold after GET recovery', async () => {
  const calls = [];
  const item = await checkInstance({ ...instance, probe_translation: false }, {
    ...options, timeoutMs: 30000,
    request: async (url, settings) => {
      calls.push({ url, settings });
      return calls.length <= 4 ? failed() : response(200, languages);
    },
  });
  assert.equal(calls.length, 5);
  assert.equal(calls[4].settings.timeoutMs, 30000);
  assert.equal(item.api_access, 'unverified');
  assert.ok(calls.every(call => call.settings.method !== 'POST'));
});

test('report displays the failure reason safely and identifies checker-specific reachability', () => {
  const report = renderReport({
    generated_at: now().toISOString(), instances: [{
      ...instance, availability: 'unreachable', availability_reason: '<script>|ENETUNREACH',
      api_access: 'unverified', language_count: 0, endpoints: {}, languages: [],
    }],
  });
  assert.match(report, /\| Availability \| Check detail \| Anonymous API \|/);
  assert.match(report, /DNS, TLS, routing and timeout failures do not qualify for removal/);
  assert.ok(!report.includes('<script>'));
  assert.match(report, /\\<script\\>\\\|ENETUNREACH/);
});
