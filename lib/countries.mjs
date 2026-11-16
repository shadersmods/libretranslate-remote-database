import { lookup as systemLookup } from 'node:dns/promises';
import { isPublicAddress } from './catalog.mjs';
import { requestEndpoint } from './http.mjs';

const SOURCE = 'https://country.is';
const regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });

export function countryName(code) {
  if (typeof code !== 'string' || !/^[A-Z]{2}$/.test(code)
      || ['ZZ', 'EU', 'UN', 'XA', 'XB'].includes(code)) return null;
  return regionNames.of(code) ?? null;
}

async function resolvePublicIp(url, lookup, timeoutMs) {
  let timer;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    const addresses = await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
    ]);
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) return null;
    return (addresses.find(item => item.family === 4) ?? addresses[0]).address;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

// Country lookup is optional metadata. Its failure must not change API status.
// Use the IP actually selected by the probe. DNS-only fallback is for enriching
// older results that predate resolved_ip, without repeating translation probes.
export async function enrichCountries(instances, {
  previous = [], request = requestEndpoint, now = new Date(),
  resolveMissing = false, lookup = systemLookup, timeoutMs = 5000,
  cacheDays = 30,
} = {}) {
  const results = instances.map(item => ({ ...item, country: null }));
  const cached = new Map();
  for (const item of previous) {
    const country = item.country;
    const age = now.getTime() - Date.parse(country?.checked_at);
    if (countryName(country?.code) && isPublicAddress(country?.ip)
        && country.source === SOURCE && age >= 0 && age < cacheDays * 86_400_000) {
      cached.set(country.ip, country);
    }
  }
  const pending = new Map();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, results.length) }, async () => {
    while (cursor < results.length) {
      const index = cursor++;
      const item = results[index];
      if (item.availability === 'disabled') continue;
      const endpoints = item.endpoints ?? {};
      let ip = [endpoints.translate, endpoints.languages, endpoints.health, endpoints.homepage, endpoints.settings]
        .map(endpoint => endpoint?.resolved_ip).find(address => isPublicAddress(address));
      if (!ip && resolveMissing) ip = await resolvePublicIp(item.url, lookup, timeoutMs);
      if (!ip) continue;
      if (cached.has(ip)) {
        item.country = { ...cached.get(ip), name: countryName(cached.get(ip).code) };
      } else {
        const indexes = pending.get(ip) ?? [];
        indexes.push(index);
        pending.set(ip, indexes);
      }
    }
  });
  await Promise.all(workers);
  const ips = [...pending.keys()];
  for (let offset = 0; offset < ips.length; offset += 100) {
    const batch = ips.slice(offset, offset + 100);
    try {
      const response = await request('https://api.country.is/', {
        method: 'POST', body: batch, timeoutMs, maxBytes: 262144,
      });
      if (response.error || response.status !== 200) continue;
      const data = JSON.parse(response.text);
      if (!Array.isArray(data)) continue;
      for (const entry of data) {
        if (!entry || !batch.includes(entry.ip)) continue;
        const code = typeof entry.country === 'string' ? entry.country.toUpperCase() : '';
        const name = countryName(code);
        if (!name) continue;
        const country = { code, name, ip: entry.ip, source: SOURCE, checked_at: now.toISOString() };
        for (const index of pending.get(entry.ip)) results[index].country = country;
      }
    } catch { /* Keep an unknown country when the metadata service is unavailable. */ }
  }
  return results;
}
