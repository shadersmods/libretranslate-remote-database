import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { countryName } from './countries.mjs';

export async function readPrevious(directory) {
  try {
    const data = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
    if (data.schema_version !== 1 || !Array.isArray(data.instances)) throw new Error('Invalid previous status file.');
    return data.instances;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function atomicWrite(path, content) {
  await writeFile(`${path}.tmp`, content, 'utf8');
  await rename(`${path}.tmp`, path);
}
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const cell = value => String(value ?? '—').replace(/[\r\n]/g, ' ').replace(/[\\`*_[\]<>|]/g, '\\$&');
const link = value => value.replace(/[()]/g, character => encodeURIComponent(character));


const attribute = value => String(value).replace(/[&<>"'|\r\n]/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '|': '&#124;', '\r': ' ', '\n': ' ',
})[character]);

function countryBadge(item) {
  const code = item.country?.code;
  const name = countryName(code);
  if (!name) return '<span title="Hosting country unknown">🌐</span>';
  return '<img src="https://flagcdn.com/16x12/' + code.toLowerCase() + '.png" width="16" height="12" alt="'
    + code + '" title="' + attribute(name + ' (' + code + '); approximate hosting location') + '">';
}

function languageCount(item) {
  const codes = [...new Set((item.languages ?? []).map(language => language.code))].sort();
  const title = codes.length ? codes.join(', ') : item.language_count ? 'Language codes unavailable' : 'No languages detected';
  return '<span title="' + attribute(title) + '">' + cell(item.language_count) + '</span>';
}

function fileCount(item) {
  const formats = [...new Set((item.supported_files ?? []).filter(format => typeof format === 'string'))].sort();
  const disabled = item.files_translation === false;
  const title = disabled ? 'File translation disabled' : formats.length ? formats.join(', ') : 'No file formats reported';
  return '<span title="' + attribute(title) + '">' + (disabled ? 0 : formats.length) + '</span>';
}

function characterLimit(item) {
  const limit = item.character_limit;
  if (!Number.isSafeInteger(limit)) return '<span title="No character limit reported">—</span>';
  const label = limit === -1 ? 'Unlimited' : String(limit);
  return '<span title="Anonymous character limit reported by the server; API-key allowances may differ">' + label + '</span>';
}

export function renderReport(snapshot) {
  const lines = [
    '# Instance status', '', `Last check: **${snapshot.generated_at}** (UTC).`, '',
    '“Open” means a small anonymous API translation succeeded at that time. Reachability is not permission for unlimited use.', '',
    'Unreachable means this checker could not verify the server; DNS, TLS, routing and timeout failures do not qualify for removal.', '',
    'Flags show approximate hosting countries from public server IPs. They do not identify the operator. Hover over language and file-format counts for the full lists.', '',
    '| Instance | Availability | Check detail | Anonymous API | Languages | File formats | Character limit | Version | Translation HTTP |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |',
    ...snapshot.instances.map(item => `| ${countryBadge(item)} [${cell(item.name)}](${link(item.url)}) | ${cell(item.availability)} | ${cell(item.availability_reason)} | ${cell(item.api_access)} | ${languageCount(item)} | ${fileCount(item)} | ${characterLimit(item)} | ${cell(item.version)} | ${cell(item.endpoints.translate?.http_status)} |`),
    '', 'See [data/status.json](data/status.json) for endpoint errors, response times, languages, limits, and file formats.',
    'See [data/open.json](data/open.json) for instances whose anonymous translation probe succeeded.', '',
    'Country lookup: [Country.is](https://country.is/). Flag images: [Flagpedia / Flagcdn](https://flagpedia.net/download/api).', '',
  ];
  return lines.join('\n');
}

export async function writeOutputs(directory, instances, { now = new Date(), reportPath, retentionDays = 90 } = {}) {
  const generated_at = now.toISOString();
  const snapshot = { schema_version: 1, generated_at, instances };
  const open = {
    schema_version: 1, generated_at,
    instances: instances.filter(item => item.availability === 'online' && item.api_access === 'open')
      .map(item => ({ id: item.id, name: item.name, url: item.url, checked_at: item.checked_at, country: item.country ?? null, languages: item.languages,
        files_translation: item.files_translation, supported_files: item.supported_files, character_limit: item.character_limit })),
  };
  await mkdir(join(directory, 'history'), { recursive: true });
  await atomicWrite(join(directory, 'status.json'), json(snapshot));
  await atomicWrite(join(directory, 'open.json'), json(open));
  const summary = {
    schema_version: 1, generated_at,
    instances: instances.map(item => ({ id: item.id, url: item.url, checked_at: item.checked_at,
      offline_since: item.offline_since ?? null, down_check: item.down_check ?? null, availability_reason: item.availability_reason ?? null, availability: item.availability,
      api_access: item.api_access, language_count: item.language_count,
      translation_http_status: item.endpoints.translate?.http_status ?? null })),
  };
  await atomicWrite(join(directory, 'history', `${generated_at.slice(0, 10)}.json`), json(summary));
  const cutoff = new Date(now.getTime() - (retentionDays - 1) * 86_400_000).toISOString().slice(0, 10);
  for (const file of await readdir(join(directory, 'history'))) {
    if (/^\d{4}-\d{2}-\d{2}\.json$/.test(file) && file.slice(0, 10) < cutoff) {
      await unlink(join(directory, 'history', file));
    }
  }
  const report = renderReport(snapshot);
  if (reportPath) await atomicWrite(reportPath, report);
  return { snapshot, open, report };
}
