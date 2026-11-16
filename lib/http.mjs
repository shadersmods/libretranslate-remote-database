import { lookup as systemLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { isPublicAddress } from './catalog.mjs';

const USER_AGENT = 'LibreTranslateRemoteDatabase/1.0 (+https://github.com/shadersmods/libretranslate-remote-database)';

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

// DNS is resolved, checked and pinned for each request. Redirects are recorded,
// never followed: a public catalog entry must not reach a private network.
export async function requestEndpoint(address, {
  method = 'GET', body, timeoutMs = 10_000, maxBytes = 1_048_576,
  lookup = systemLookup, request, allowInsecureHttp = false, avoidAddress,
} = {}) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  let status = null;
  let resolvedIp = null;
  let stage = 'validation';
  try {
    const url = new URL(address);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && allowInsecureHttp === true))
        || url.username || url.password) throw new Error('unsafe_url');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    stage = 'dns';
    const addresses = await abortable(lookup(hostname, { all: true, verbatim: true }), controller.signal);
    if (!addresses.length || addresses.some(record => !isPublicAddress(record.address))) throw new Error('non_public_address');
    const alternatives = addresses.filter(record => record.address !== avoidAddress);
    const candidates = alternatives.length ? alternatives : addresses;
    const target = candidates.find(record => record.family === 4) ?? candidates[0];
    resolvedIp = target.address;
    stage = 'request';
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const send = request ?? (url.protocol === 'http:' ? httpRequest : httpsRequest);
    const data = await new Promise((resolve, reject) => {
      const req = send(url, {
        method, agent: false, signal: controller.signal,
        family: target.family, autoSelectFamily: false,
        // A synchronous lookup can fail before ClientRequest attaches the TLS
        // socket's error listener. Defer it like a real asynchronous DNS lookup.
        lookup: (_hostname, options, callback) => queueMicrotask(() => {
          if (options.all) callback(null, [target]);
          else callback(null, target.address, target.family);
        }),
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json, text/html;q=0.5',
          'Accept-Encoding': 'identity',
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
        },
      }, response => {
        status = response.statusCode ?? null;
        const chunks = [];
        let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > maxBytes) req.destroy(new Error('response_too_large'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('aborted', () => reject(new Error('incomplete_response')));
        response.on('end', () => resolve({
          status, content_type: String(response.headers['content-type'] ?? ''),
          retry_after: String(response.headers['retry-after'] ?? '').slice(0, 100) || null,
          text: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      req.on('error', reject);
      req.end(payload);
    });
    return { ...data, resolved_ip: resolvedIp, latency_ms: Math.round(performance.now() - started), error: null, error_code: null, error_stage: null };
  } catch (error) {
    const known = ['unsafe_url', 'non_public_address', 'response_too_large', 'incomplete_response'];
    let reason = controller.signal.aborted ? 'timeout' : known.includes(error.message) ? error.message : 'connection_error';
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(error.code)) reason = 'dns_error';
    if (/CERT|TLS|SSL/.test(String(error.code)) || ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(error.code)) reason = 'tls_error';
    const code = controller.signal.aborted ? 'ETIMEDOUT' : error.code;
    const error_code = typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? code : null;
    return { status, resolved_ip: resolvedIp, latency_ms: Math.round(performance.now() - started), error: reason, error_code, error_stage: stage, text: '', content_type: '', retry_after: null };
  } finally {
    clearTimeout(timer);
  }
}
