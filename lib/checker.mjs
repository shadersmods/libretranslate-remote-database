import { requestEndpoint } from './http.mjs';

const parse = response => {
  if (response?.error || response?.status < 200 || response?.status >= 300) return null;
  try { return JSON.parse(response.text); } catch { return null; }
};
const codePattern = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/;

export function parseLanguages(response) {
  const data = parse(response);
  if (!Array.isArray(data) || !data.length || data.length > 500) return [];
  const codes = new Set();
  const result = [];
  for (const item of data) {
    if (!item || typeof item.code !== 'string' || !codePattern.test(item.code) || codes.has(item.code)
        || (item.targets !== undefined && (!Array.isArray(item.targets)
        || item.targets.some(target => typeof target !== 'string' || !codePattern.test(target))))) return [];
    codes.add(item.code);
    result.push({
      code: item.code,
      name: typeof item.name === 'string' ? item.name.slice(0, 100) : item.code,
      ...(item.targets === undefined ? {} : { targets: [...new Set(item.targets)].sort() }),
    });
  }
  return result.sort((a, b) => a.code.localeCompare(b.code, 'en'));
}

export function choosePair(languages) {
  const codes = new Set(languages.map(language => language.code));
  const options = languages.flatMap(language => {
    const targets = language.targets ?? [...codes];
    return targets.filter(target => target !== language.code && codes.has(target))
      .map(target => ({ source: language.code, target }));
  });
  return options.find(pair => pair.source === 'en' && pair.target === 'es')
    ?? options.find(pair => pair.source === 'en') ?? options[0] ?? null;
}

export function classifyTranslation(response) {
  if (!response || response.error) return 'unverified';
  let body;
  try { body = JSON.parse(response.text); } catch { return response.status === 429 ? 'rate_limited' : 'blocked'; }
  if (response.status >= 200 && response.status < 300
      && typeof body?.translatedText === 'string' && body.translatedText.trim()) return 'open';
  if (response.status === 429) return 'rate_limited';
  const message = typeof body?.error === 'string' ? body.error : '';
  if ([400, 401, 403].includes(response.status) && /api[ _-]?key/i.test(message)) return 'key_required';
  if (response.status === 401) return 'authentication_required';
  if (response.status === 403) return 'blocked';
  return 'unverified';
}

function summarize(response) {
  if (!response) return null;
  return {
    http_status: response.status,
    resolved_ip: response.resolved_ip ?? null,
    latency_ms: response.latency_ms,
    error: response.error,
    ...(response.retry_after ? { retry_after: response.retry_after } : {}),
  };
}

export async function checkInstance(instance, {
  request = requestEndpoint, timeoutMs = 10_000, now = () => new Date(),
  previous, probeTranslation = true,
} = {}) {
  const checked_at = now().toISOString();
  const base = { id: instance.id, name: instance.name, url: instance.url, checked_at };
  if (!instance.enabled) return {
    ...base, availability: 'disabled', api_access: 'unverified',
    language_count: 0, languages: [], endpoints: {},
    last_open_at: previous?.last_open_at ?? null, consecutive_failures: 0,
  };
  // Sequential requests avoid bursting a small public server. Concurrency is
  // limited across instances, not across endpoints of the same instance.
  const requestOptions = { timeoutMs, allowInsecureHttp: instance.allow_insecure_http === true };
  const health = await request(`${instance.url}/health`, requestOptions);
  const languageReply = await request(`${instance.url}/languages`, requestOptions);
  const settingsReply = await request(`${instance.url}/frontend/settings`, requestOptions);
  const homepage = await request(`${instance.url}/`, requestOptions);
  const languages = parseLanguages(languageReply);
  const healthBody = parse(health);
  const healthy = healthBody?.status === 'ok';
  const info = parse(settingsReply);
  const settings = info && !Array.isArray(info) && typeof info === 'object'
    && ['apiKeys', 'keyRequired', 'filesTranslation', 'supportedFilesFormat'].some(key => key in info) ? info : null;
  const pair = choosePair(languages);
  let translation = null;
  let skipped = null;
  if (!probeTranslation || !instance.probe_translation) skipped = 'disabled';
  else if (!pair) skipped = 'no_supported_language_pair';
  else translation = await request(`${instance.url}/translate`, {
    ...requestOptions, method: 'POST',
    body: { q: 'hello', ...pair, format: 'text', api_key: '' },
  });
  const api_access = classifyTranslation(translation);
  const responses = [health, languageReply, settingsReply, homepage, translation].filter(Boolean);
  const reachable = responses.some(response => response.status !== null);
  const online = languages.length > 0 && (
    ['open', 'key_required', 'authentication_required', 'rate_limited'].includes(api_access)
    || (skipped === 'disabled' && healthy)
  );
  const availability = online ? 'online' : reachable ? 'degraded' : 'offline';
  const version = !homepage.error && homepage.status === 200
    ? homepage.text.replace(/<[^>]*>/g, ' ').match(/LibreTranslate\s+v?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?)/i)?.[1] ?? null : null;
  const supported_files = Array.isArray(settings?.supportedFilesFormat)
    ? [...new Set(settings.supportedFilesFormat.filter(value => typeof value === 'string'
      && /^\.?[a-z0-9]{1,12}$/i.test(value)))].sort() : [];
  return {
    ...base, availability, api_access, version,
    reported_key_required: typeof settings?.keyRequired === 'boolean' ? settings.keyRequired : null,
    files_translation: typeof settings?.filesTranslation === 'boolean' ? settings.filesTranslation : null,
    supported_files,
    character_limit: Number.isSafeInteger(settings?.charLimit) ? settings.charLimit : null,
    language_count: languages.length, languages,
    translation_probe: { pair, skipped, ...summarize(translation) },
    endpoints: {
      health: summarize(health), languages: summarize(languageReply),
      settings: summarize(settingsReply), homepage: summarize(homepage),
      translate: summarize(translation),
    },
    last_open_at: api_access === 'open' ? checked_at : previous?.last_open_at ?? null,
    consecutive_failures: online ? 0 : (previous?.consecutive_failures ?? 0) + 1,
  };
}

export async function checkAll(instances, options = {}) {
  const results = new Array(instances.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(options.concurrency ?? 3, instances.length) }, async () => {
    while (cursor < instances.length) {
      const index = cursor++;
      const instance = instances[index];
      const previous = options.previous?.find(item => item.id === instance.id && item.url === instance.url);
      results[index] = await checkInstance(instance, { ...options, previous });
      options.onResult?.(results[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
