import { readFile } from 'node:fs/promises';
import { isIP, BlockList } from 'node:net';

const blocked4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked4.addSubnet(address, prefix, 'ipv4');
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
const blocked6 = new BlockList();
for (const [address, prefix] of [['2001:db8::', 32], ['2001::', 32], ['2002::', 16]]) {
  blocked6.addSubnet(address, prefix, 'ipv6');
}

export function isPublicAddress(address) {
  if (isIP(address) === 4) return !blocked4.check(address, 'ipv4');
  if (isIP(address) === 6) return global6.check(address, 'ipv6') && !blocked6.check(address, 'ipv6');
  return false;
}

export function normalizeUrl(value, { allowInsecureHttp = false } = {}) {
  if (typeof value !== 'string' || value !== value.trim() || /[\s\\]/u.test(value)) {
    throw new Error('Instance URLs must be strings without whitespace or backslashes.');
  }
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && allowInsecureHttp === true))
      || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTPS base URL, or explicitly opt in to HTTP, without credentials, query parameters, or a fragment.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
      || (isIP(hostname) && !isPublicAddress(hostname))) {
    throw new Error('Instance URLs must address public servers.');
  }
  return url.href.replace(/\/+$/, '');
}

export function validateCatalog(catalog) {
  if (catalog?.schema_version !== 1 || !Array.isArray(catalog.instances) || !catalog.instances.length) {
    throw new Error('Expected schema_version: 1 and a nonempty instances array.');
  }
  if (Object.keys(catalog).some(key => !['$schema', 'schema_version', 'instances'].includes(key))) {
    throw new Error('Unknown catalog property.');
  }
  const ids = new Set();
  const urls = new Set();
  const allowed = ['id', 'name', 'url', 'sources', 'enabled', 'probe_translation', 'allow_insecure_http', 'notes'];
  for (const item of catalog.instances) {
    if (!item || Object.keys(item).some(key => !allowed.includes(key))) throw new Error('Unknown instance property.');
    if (typeof item.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) || ids.has(item.id)) {
      throw new Error('Instance IDs must be unique lowercase slugs.');
    }
    if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100 || /[\x00-\x1f]/.test(item.name)) {
      throw new Error(`Invalid name for ${item.id}.`);
    }
    if (item.allow_insecure_http !== undefined && typeof item.allow_insecure_http !== 'boolean') {
      throw new Error('allow_insecure_http must be a boolean.');
    }
    const url = normalizeUrl(item.url, { allowInsecureHttp: item.allow_insecure_http === true });
    if (urls.has(url)) throw new Error(`Duplicate URL: ${url}`);
    if (!Array.isArray(item.sources) || !item.sources.length || item.sources.some(source => {
      try { return !['https:', 'http:'].includes(new URL(source).protocol); } catch { return true; }
    })) throw new Error(`Supply public source links for ${item.id}.`);
    for (const key of ['enabled', 'probe_translation']) {
      if (typeof item[key] !== 'boolean') throw new Error(`${item.id}.${key} must be a boolean.`);
    }
    if (item.notes !== undefined && typeof item.notes !== 'string') throw new Error('Notes must be text.');
    ids.add(item.id);
    urls.add(url);
  }
  return catalog.instances.map(item => ({ ...item, url: normalizeUrl(item.url, { allowInsecureHttp: item.allow_insecure_http === true }) })).sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

export async function loadCatalog(path) {
  return validateCatalog(JSON.parse(await readFile(path, 'utf8')));
}
