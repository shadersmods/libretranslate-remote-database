import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPublicAddress, normalizeUrl, validateCatalog, loadCatalog } from '../lib/catalog.mjs';
import { requestEndpoint } from '../lib/http.mjs';
import { checkAll, checkInstance, choosePair, classifyTranslation, parseLanguages } from '../lib/checker.mjs';
import { readPrevious, renderReport, writeOutputs } from '../lib/output.mjs';

const instance = {
  id: 'example', name: 'Example', url: 'https://example.org/prefix',
  sources: ['https://example.org/about'], enabled: true, probe_translation: true,
};
const reply = (status, body, error = null) => ({
  status, text: typeof body === 'string' ? body : JSON.stringify(body),
  latency_ms: 4, error, content_type: 'application/json', retry_after: null,
});
const languageData = [{ code: 'en', name: 'English', targets: ['es'] }, { code: 'es', name: 'Spanish', targets: ['en'] }];
const fixedNow = () => new Date('2026-11-16T10:00:00.000Z');

function fixture(overrides = {}, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    const suffix = url.slice(instance.url.length);
    return overrides[suffix] ?? {
      '/health': reply(200, { status: 'ok' }),
      '/languages': reply(200, languageData),
      '/frontend/settings': reply(200, { keyRequired: false, filesTranslation: true, supportedFilesFormat: ['.txt', '.pdf'], charLimit: 5000 }),
      '/': reply(200, '<h5>LibreTranslate v1.9.6</h5>'),
      '/translate': reply(200, { translatedText: 'hola' }),
    }[suffix];
  };
}

test('catalog validates URLs and rejects duplicate normalized addresses and unknown fields', () => {
  assert.equal(normalizeUrl('https://example.org/prefix/'), instance.url);
  assert.equal(validateCatalog({ schema_version: 1, instances: [instance] })[0].url, instance.url);
  assert.throws(() => validateCatalog({ schema_version: 1, instances: [instance, { ...instance, id: 'other', url: `${instance.url}/` }] }), /Duplicate URL/);
  assert.throws(() => validateCatalog({ schema_version: 1, instances: [{ ...instance, api_key: 'never-store-secrets' }] }), /Unknown/);
  assert.throws(() => validateCatalog({ schema_version: 1, instances: [{ ...instance, enabled: 'true' }] }), /boolean/);
});

test('catalog rejects credentials, private URLs, unsafe schemes and fragments', () => {
  for (const url of [
    'http://example.org', 'https://user:password@example.org', 'https://example.org?api_key=x',
    'https://example.org/#x', 'https://localhost', 'https://demo.localhost', 'https://demo.local',
    'https://127.0.0.1', 'https://2130706433', 'https://[::1]', ' https://example.org', 'file:///etc/passwd',
  ]) assert.throws(() => normalizeUrl(url), undefined, url);
});

test('address filtering covers private, reserved, mapped IPv6 and public addresses', () => {
  for (const address of ['10.1.2.3', '100.64.1.2', '127.0.0.1', '169.254.169.254', '172.20.0.1',
    '192.168.0.1', '192.0.2.1', '198.18.0.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('93.184.216.34'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('the real seed catalog validates without network access', async () => {
  const entries = await loadCatalog(new URL('../data/instances.json', import.meta.url));
  assert.ok(entries.length > 0);
});

test('language responses must be real, unique language lists', () => {
  assert.equal(parseLanguages(reply(200, languageData)).length, 2);
  for (const body of ['<html>Challenge</html>', [], { languages: languageData }, [{ code: 'bad code' }],
    [{ code: 'en', targets: ['bad code'] }], [{ code: 'en' }, { code: 'en' }]]) {
    assert.deepEqual(parseLanguages(reply(200, body)), []);
  }
  assert.deepEqual(parseLanguages(reply(403, languageData)), []);
});

test('pair selection honors advertised target restrictions and older targetless lists', () => {
  assert.deepEqual(choosePair(languageData), { source: 'en', target: 'es' });
  assert.deepEqual(choosePair([{ code: 'fr', targets: ['de'] }, { code: 'de', targets: [] }]), { source: 'fr', target: 'de' });
  assert.equal(choosePair([{ code: 'en', targets: [] }, { code: 'es', targets: [] }]), null);
  assert.deepEqual(choosePair([{ code: 'en' }, { code: 'es' }]), { source: 'en', target: 'es' });
});

test('anonymous access classification does not mistake websites or auth errors for open APIs', () => {
  assert.equal(classifyTranslation(reply(200, { translatedText: 'hola' })), 'open');
  assert.equal(classifyTranslation(reply(200, { translatedText: '' })), 'unverified');
  assert.equal(classifyTranslation(reply(200, '<html>Login</html>')), 'blocked');
  assert.equal(classifyTranslation(reply(403, { error: 'Invalid API key' })), 'key_required');
  assert.equal(classifyTranslation(reply(400, { error: 'Get an api_key' })), 'key_required');
  assert.equal(classifyTranslation(reply(401, { error: 'Login required' })), 'authentication_required');
  assert.equal(classifyTranslation(reply(403, '<html>Challenge</html>')), 'blocked');
  assert.equal(classifyTranslation(reply(429, '<html>Too many requests</html>')), 'rate_limited');
  assert.equal(classifyTranslation(reply(503, { error: 'Unavailable' })), 'unverified');
  assert.equal(classifyTranslation(reply(null, '', 'timeout')), 'unverified');
});

test('a healthy check preserves prefixes and sends exactly one small anonymous request', async () => {
  const calls = [];
  const result = await checkInstance(instance, { request: fixture({}, calls), now: fixedNow });
  assert.equal(result.availability, 'online');
  assert.equal(result.api_access, 'open');
  assert.equal(result.version, '1.9.6');
  assert.equal(result.language_count, 2);
  assert.equal(result.last_open_at, fixedNow().toISOString());
  assert.deepEqual(result.supported_files, ['.pdf', '.txt']);
  assert.equal(calls.length, 5);
  assert.equal(calls[4].url, `${instance.url}/translate`);
  assert.deepEqual(calls[4].options.body, { q: 'hello', source: 'en', target: 'es', format: 'text', api_key: '' });
});

test('actual translation access overrides misleading frontend keyRequired flags', async () => {
  const restricted = await checkInstance(instance, { request: fixture({ '/translate': reply(403, { error: 'Invalid API key' }) }) });
  assert.equal(restricted.availability, 'online');
  assert.equal(restricted.api_access, 'key_required');
  assert.equal(restricted.reported_key_required, false);
  const open = await checkInstance(instance, { request: fixture({ '/frontend/settings': reply(200, { keyRequired: true }) }) });
  assert.equal(open.api_access, 'open');
  assert.equal(open.reported_key_required, true);
});

test('a homepage and health alone never establish an open API', async () => {
  const calls = [];
  const result = await checkInstance(instance, { request: fixture({ '/languages': reply(200, '<html>Challenge</html>') }, calls) });
  assert.equal(result.availability, 'degraded');
  assert.equal(result.api_access, 'unverified');
  assert.equal(result.translation_probe.skipped, 'no_supported_language_pair');
  assert.equal(calls.length, 4);
});

test('disabled instances make no requests; POST opt-outs cannot enter the open list', async () => {
  const disabled = await checkInstance({ ...instance, enabled: false }, { request: () => { throw new Error('Must not request'); } });
  assert.equal(disabled.availability, 'disabled');
  for (const options of [{ probeTranslation: false }, {}]) {
    const calls = [];
    const result = await checkInstance({ ...instance, probe_translation: false }, { ...options, request: fixture({}, calls) });
    assert.equal(result.api_access, 'unverified');
    assert.equal(result.translation_probe.skipped, 'disabled');
    assert.equal(calls.length, 4);
  }
  const calls = [];
  await checkInstance(instance, { probeTranslation: false, request: fixture({}, calls) });
  assert.equal(calls.length, 4);
});

test('outages retain last-open timestamps and increment failure counts without stale success', async () => {
  const previous = { last_open_at: '2026-11-15T10:00:00.000Z', consecutive_failures: 2 };
  const result = await checkInstance(instance, { previous, request: async () => reply(null, '', 'dns_error') });
  assert.equal(result.availability, 'offline');
  assert.equal(result.api_access, 'unverified');
  assert.equal(result.consecutive_failures, 3);
  assert.equal(result.last_open_at, previous.last_open_at);
  assert.deepEqual(result.languages, []);
});

test('rate limits retain Retry-After without retrying the translation', async () => {
  const calls = [];
  const result = await checkInstance(instance, { request: fixture({ '/translate': { ...reply(429, { error: 'Slow down' }), retry_after: '60' } }, calls) });
  assert.equal(result.api_access, 'rate_limited');
  assert.equal(result.endpoints.translate.retry_after, '60');
  assert.equal(calls.length, 5);
});

test('checks run with bounded cross-instance concurrency and preserve catalog order', async () => {
  let active = 0;
  let maximum = 0;
  const entries = Array.from({ length: 7 }, (_, index) => ({ ...instance, id: `item-${index}` }));
  const result = await checkAll(entries, { concurrency: 2, request: async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    return reply(null, '', 'connection_error');
  } });
  assert.ok(maximum <= 2);
  assert.deepEqual(result.map(item => item.id), entries.map(item => item.id));
});

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
function fakeHttps({ status = 200, text = '{}', stalled = false } = {}, observed = []) {
  return (url, options, callback) => {
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = error => { req.destroyed = true; queueMicrotask(() => req.emit('error', error)); };
    const abort = () => req.destroy(options.signal.reason);
    options.signal.addEventListener('abort', abort, { once: true });
    req.end = payload => queueMicrotask(() => {
      observed.push({ url, options, payload });
      const response = new EventEmitter();
      response.statusCode = status;
      response.headers = { 'content-type': 'application/json' };
      callback(response);
      response.emit('data', Buffer.from(text));
      if (!req.destroyed && !stalled) {
        response.emit('end');
        options.signal.removeEventListener('abort', abort);
      }
    });
    return req;
  };
}

test('transport pins validated DNS, verifies TLS by default, and does not follow redirects', async () => {
  const observed = [];
  const response = await requestEndpoint('https://example.org/', { lookup: publicLookup, request: fakeHttps({ status: 302 }, observed) });
  assert.equal(response.status, 302);
  assert.equal(response.resolved_ip, '93.184.216.34');
  assert.equal(observed.length, 1);
  assert.equal(observed[0].options.rejectUnauthorized, undefined);
  assert.equal(observed[0].options.agent, false);
  assert.equal(observed[0].options.family, 4);
  assert.equal(observed[0].options.autoSelectFamily, false);
  for (const all of [false, true]) {
    let synchronous = true;
    const completed = new Promise(resolve => {
      observed[0].options.lookup('example.org', { all }, (...args) => resolve({ synchronous, args }));
    });
    synchronous = false;
    const delivered = await completed;
    assert.equal(delivered.synchronous, false);
    const { args } = delivered;
    assert.deepEqual(args, all ? [null, [{ address: '93.184.216.34', family: 4 }]] : [null, '93.184.216.34', 4]);
  }
});

test('transport refuses mixed public/private DNS answers before opening a connection', async () => {
  const response = await requestEndpoint('https://example.org/', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
    request: () => { throw new Error('Must not connect'); },
  });
  assert.equal(response.error, 'non_public_address');
  assert.equal(response.status, null);
});

test('transport bounds response size, DNS waits and stalled response bodies', async () => {
  const tooLarge = await requestEndpoint('https://example.org/', { lookup: publicLookup, maxBytes: 2, request: fakeHttps({ text: 'oversized' }) });
  assert.equal(tooLarge.error, 'response_too_large');
  const dnsTimeout = await requestEndpoint('https://example.org/', { timeoutMs: 15, lookup: () => new Promise(() => {}) });
  assert.equal(dnsTimeout.error, 'timeout');
  const bodyTimeout = await requestEndpoint('https://example.org/', { timeoutMs: 15, lookup: publicLookup, request: fakeHttps({ stalled: true }) });
  assert.equal(bodyTimeout.error, 'timeout');
});

test('outputs exclude stale/non-open instances and retain only bounded daily history', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lt-registry-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.deepEqual(await readPrevious(directory), []);
  await mkdir(join(directory, 'history'));
  await writeFile(join(directory, 'history', '2026-01-01.json'), '{}');
  await writeFile(join(directory, 'history', 'keep-me.txt'), 'unrelated');
  const open = await checkInstance(instance, { request: fixture(), now: fixedNow });
  const restricted = { ...open, id: 'restricted', api_access: 'key_required' };
  const offline = { ...open, id: 'offline', availability: 'offline', api_access: 'unverified' };
  const result = await writeOutputs(directory, [open, restricted, offline], { now: fixedNow(), reportPath: join(directory, 'STATUS.md') });
  assert.deepEqual(result.open.instances.map(item => item.id), ['example']);
  assert.deepEqual((await readPrevious(directory)).map(item => item.id), ['example', 'restricted', 'offline']);
  const history = await readdir(join(directory, 'history'));
  assert.ok(!history.includes('2026-01-01.json'));
  assert.ok(history.includes('2026-11-16.json'));
  assert.ok(history.includes('keep-me.txt'));
  await writeOutputs(directory, [open], { now: fixedNow() });
  assert.equal((await readdir(join(directory, 'history'))).filter(file => file.endsWith('.json')).length, 1);
  assert.match(await readFile(join(directory, 'STATUS.md'), 'utf8'), /Instance status/);
  await writeFile(join(directory, 'status.json'), 'broken');
  await assert.rejects(readPrevious(directory));
});

test('report escapes remote/catalog text rather than inserting HTML or extra table rows', () => {
  const report = renderReport({ generated_at: fixedNow().toISOString(), instances: [{
    ...instance, name: '<script>|[link]', availability: 'online', api_access: 'open',
    language_count: 2, endpoints: {},
  }] });
  assert.ok(!report.includes('<script>'));
  assert.match(report, /\\</);
  assert.match(report, /\\\|/);
});


test('HTTP catalog entries require explicit opt-in and still reject private addresses', () => {
  const url = 'http://186.248.219.194:5001';
  assert.throws(() => normalizeUrl(url));
  assert.equal(normalizeUrl(url + '/', { allowInsecureHttp: true }), url);
  const entry = { ...instance, url, allow_insecure_http: true };
  assert.equal(validateCatalog({ schema_version: 1, instances: [entry] })[0].url, url);
  assert.throws(() => validateCatalog({ schema_version: 1, instances: [{ ...instance, url }] }));
  assert.throws(() => validateCatalog({ schema_version: 1, instances: [{ ...entry, allow_insecure_http: 'true' }] }));
  for (const privateUrl of ['http://127.0.0.1:5001', 'http://169.254.169.254', 'http://[::1]', 'http://2130706433']) {
    assert.throws(() => normalizeUrl(privateUrl, { allowInsecureHttp: true }));
  }
  assert.equal(normalizeUrl('https://funnel4.ghost-tint.ts.net:8443/'), 'https://funnel4.ghost-tint.ts.net:8443');
});

test('HTTP transport is opt-in and keeps public DNS pinning and credential restrictions', async () => {
  const observed = [];
  const denied = await requestEndpoint('http://186.248.219.194:5001/languages', {
    lookup: publicLookup, request: fakeHttps({}, observed),
  });
  assert.equal(denied.error, 'unsafe_url');
  assert.equal(observed.length, 0);
  const accepted = await requestEndpoint('http://186.248.219.194:5001/languages', {
    allowInsecureHttp: true, lookup: publicLookup, request: fakeHttps({}, observed),
  });
  assert.equal(accepted.status, 200);
  assert.equal(observed[0].url.protocol, 'http:');
  assert.equal(observed[0].url.port, '5001');
  const blocked = await requestEndpoint('http://example.org/', {
    allowInsecureHttp: true,
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    request: () => { throw new Error('Must not connect'); },
  });
  assert.equal(blocked.error, 'non_public_address');
  const credentials = await requestEndpoint('http://user:password@example.org/', { allowInsecureHttp: true });
  assert.equal(credentials.error, 'unsafe_url');
});

test('the checker passes the HTTP opt-in to every endpoint and preserves its port', async () => {
  const calls = [];
  const url = 'http://186.248.219.194:5001';
  const result = await checkInstance({ ...instance, url, allow_insecure_http: true }, {
    request: async (address, options) => {
      calls.push({ address, options });
      return fixture()(instance.url + new URL(address).pathname, options);
    },
  });
  assert.equal(result.api_access, 'open');
  assert.equal(result.url, url);
  assert.equal(calls.length, 5);
  for (const call of calls) {
    assert.equal(call.options.allowInsecureHttp, true);
    assert.equal(new URL(call.address).port, '5001');
  }
});

test('immediate IPv4 and IPv6 socket failures cannot crash the checker process', async () => {
  // Exercise real ClientRequest/TLSSocket event ordering in a child process.
  // The connection method is replaced there, so no external sockets are opened.
  const script = `
    import assert from 'node:assert/strict';
    import { Socket } from 'node:net';
    import { requestEndpoint } from './lib/http.mjs';
    const original = Socket.prototype.connect;
    let connections = 0;
    Socket.prototype.connect = function(options) {
      connections++;
      this.connecting = true;
      const all = options.family !== 4 && options.family !== 6;
      options.lookup(options.host, { all }, (error, address, family) => {
        assert.equal(error, null);
        const target = all ? address[0] : { address, family };
        assert.ok(target.family === 4 || target.family === 6);
        this.destroy(Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' }));
      });
      return this;
    };
    try {
      for (const family of [4, 6]) {
        const address = family === 4 ? '93.184.216.34' : '2606:4700:4700::1111';
        for (const protocol of ['http:', 'https:']) {
          const result = await requestEndpoint(protocol + '//unreachable.example.org/health', {
            allowInsecureHttp: true, timeoutMs: 1000,
            lookup: async () => [{ address, family }],
          });
          assert.equal(result.error, 'connection_error');
          assert.equal(result.status, null);
          assert.equal(result.resolved_ip, address);
        }
      }
      assert.equal(connections, 4);
      console.log('All four connection failures were recorded.');
    } finally {
      Socket.prototype.connect = original;
    }
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 5000,
  });
  assert.match(stdout, /All four connection failures were recorded/);
});
