import { parseArgs } from 'node:util';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCatalog } from '../lib/catalog.mjs';
import { planOfflineRemovals, renderRemovalPullRequest } from '../lib/offline.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = value => JSON.stringify(value, null, 2) + '\n';

async function main() {
  const { values } = parseArgs({ options: {
    apply: { type: 'boolean', default: false },
    catalog: { type: 'string', default: join(root, 'data/instances.json') },
    'data-dir': { type: 'string', default: join(root, 'data') },
    'out-dir': { type: 'string', default: join(root, '.cleanup') },
  } });
  const catalogPath = resolve(values.catalog);
  const document = JSON.parse(await readFile(catalogPath, 'utf8'));
  const catalog = validateCatalog(document);
  const directory = resolve(values['data-dir']);
  const snapshot = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
  let names;
  try { names = await readdir(join(directory, 'history')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
  const history = [];
  for (const name of names.filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort()) {
    const day = JSON.parse(await readFile(join(directory, 'history', name), 'utf8'));
    if (day.schema_version !== 1 || !Array.isArray(day.instances)
        || typeof day.generated_at !== 'string' || day.generated_at.slice(0, 10) !== name.slice(0, 10)) {
      throw new Error('Invalid history file: ' + name);
    }
    history.push(day);
  }
  const plan = planOfflineRemovals(catalog, snapshot, history);
  const output = resolve(values['out-dir']);
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'plan.json'), json(plan));
  await writeFile(join(output, 'pull-request.md'), renderRemovalPullRequest(plan));
  if (values.apply && plan.candidates.length) {
    const remove = new Set(plan.candidates.map(item => item.id));
    const proposed = { ...document, instances: document.instances.filter(item => !remove.has(item.id)) };
    validateCatalog(proposed);
    await writeFile(catalogPath, json(proposed));
  }
  console.log(plan.suppressed ?? (plan.candidates.length + ' instance(s) eligible for a removal PR.'));
  console.log(values.apply ? 'Prepared catalog changes for review; no Git operations performed.' : 'Plan only; catalog unchanged.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
