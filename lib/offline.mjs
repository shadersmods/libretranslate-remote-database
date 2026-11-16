import { eligibleOffline } from './reachability.mjs';

const DAY = 86_400_000;
const MAX_GAP = 36 * 60 * 60 * 1000;

function timestamp(value) {
  if (typeof value !== 'string') return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : NaN;
}

// Count elapsed time, never failed runs. Missing days and every observed recovery
// break the streak, including recoveries later overwritten in daily summaries.
export function offlineSince(current, previous) {
  if (!eligibleOffline(current)) return null;
  const checked = timestamp(current.checked_at);
  const prior = timestamp(previous?.checked_at);
  const since = timestamp(previous?.offline_since);
  const dayGap = Math.floor(checked / DAY) - Math.floor(prior / DAY);
  return previous?.id === current.id && previous?.url === current.url
    && eligibleOffline(previous) && since <= prior && prior <= checked
    && checked - prior <= MAX_GAP && dayGap <= 1
    ? previous.offline_since : current.checked_at;
}

export function planOfflineRemovals(catalog, snapshot, history, { now = new Date() } = {}) {
  const generated = timestamp(snapshot?.generated_at);
  if (snapshot?.schema_version !== 1 || !Array.isArray(snapshot.instances)) {
    throw new Error('Invalid current status file.');
  }
  const result = { schema_version: 1, generated_at: now.toISOString(), candidates: [], suppressed: null };
  if (!Number.isFinite(generated) || generated > now.getTime() || now.getTime() - generated > MAX_GAP) {
    return { ...result, suppressed: 'Current status is stale or future-dated; run the checker first.' };
  }
  const current = instance => snapshot.instances.find(item => item.id === instance.id && item.url === instance.url);
  const fresh = item => {
    const checked = timestamp(item?.checked_at);
    return checked <= generated && now.getTime() - checked <= MAX_GAP;
  };
  // An outage of the checker's own network must not propose deleting the catalog.
  const responding = catalog.some(instance => {
    const item = current(instance);
    return instance.enabled && fresh(item) && ['online', 'degraded'].includes(item.availability)
      && Object.values(item.endpoints ?? {}).some(endpoint =>
        Number.isInteger(endpoint?.http_status) && endpoint.http_status >= 100 && endpoint.http_status <= 599);
  });
  if (!responding) return { ...result, suppressed: 'No enabled instance returned HTTP; cleanup is suspended.' };

  const days = new Map(history.map(day => [day.generated_at?.slice(0, 10), day]));
  for (const instance of catalog) {
    const item = current(instance);
    if (!instance.enabled || !fresh(item) || !eligibleOffline(item)) continue;
    const checked = timestamp(item.checked_at);
    const since = timestamp(item.offline_since);
    if (!(checked - since > 7 * DAY)) continue;
    const evidence = [];
    let later = checked;
    for (let offset = 0; offset < 8; offset++) {
      const date = new Date(Math.floor(checked / DAY) * DAY - offset * DAY).toISOString().slice(0, 10);
      const day = days.get(date);
      const observed = day?.instances?.find(row => row.id === item.id && row.url === item.url);
      const time = timestamp(observed?.checked_at);
      if (day?.schema_version !== 1 || !(timestamp(day.generated_at) >= time && timestamp(day.generated_at) <= generated)
          || !eligibleOffline(observed) || observed.offline_since !== item.offline_since
          || !(time >= since && time <= later && later - time <= MAX_GAP)
          || observed.checked_at.slice(0, 10) !== date) break;
      evidence.push({ date, checked_at: observed.checked_at });
      later = time;
    }
    if (evidence.length !== 8) continue;
    result.candidates.push({
      id: item.id, name: instance.name, url: item.url,
      offline_since: item.offline_since, checked_at: item.checked_at,
      offline_days: Math.floor((checked - since) / DAY * 100) / 100,
      evidence: evidence.reverse(),
    });
  }
  return result;
}

const cell = value => String(value).replace(/[\r\n]/g, ' ').replace(/[\\\x60*_[\]<>|]/g, '\\$&');

export function renderRemovalPullRequest(plan) {
  return [
    'Daily checks repeatedly received connection refusals for these instances for more than seven days.',
    'This PR removes only their catalog entries. A maintainer must review and merge it.',
    '',
    '| Instance | First offline check | Latest offline check | Elapsed days | Daily evidence (UTC) |',
    '| --- | --- | --- | ---: | --- |',
    ...plan.candidates.map(item => '| ' + cell(item.name) + ' (' + cell(item.url) + ') | '
      + item.offline_since + ' | ' + item.checked_at + ' | ' + item.offline_days + ' | '
      + item.evidence.map(day => '[' + day.date + '](https://github.com/shadersmods/libretranslate-remote-database/blob/HEAD/data/history/' + day.date + '.json)').join(', ') + ' |'),
    '',
    'Eligibility requires eight consecutive UTC dates of offline checks for the same URL and outage start time. '
      + 'Each observation must include refused connections on all four endpoints and a refused delayed GET recheck. '
      + 'Timeouts, DNS, TLS, routing failures, any HTTP response, recovery, disabled entries, or missed days prevent removal. '
      + 'Checks are observations from one network, not proof of continuous downtime.',
    '',
    'The next daily run updates this PR if candidates recover or change, and closes it when none remain.',
    'Validation: the proposed catalog passes catalog validation and the offline test suite before this PR is created.',
    '',
    'GitHub may require a maintainer to approve workflow runs on PRs created with GITHUB_TOKEN. Approve the pending runs or run the Validation workflow manually '
      + 'on this branch if your branch rules require hosted checks.',
    '',
    ...(plan.suppressed ? [plan.suppressed, ''] : []),
  ].join('\n');
}
