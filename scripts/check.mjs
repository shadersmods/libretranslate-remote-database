import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFile } from 'node:fs/promises';
import { loadCatalog } from '../lib/catalog.mjs';
import { checkAll } from '../lib/checker.mjs';
import { readPrevious, writeOutputs } from '../lib/output.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

async function main() {
  const { values } = parseArgs({ options: {
    validate: { type: 'boolean', default: false },
    catalog: { type: 'string', default: join(root, 'data/instances.json') },
    'out-dir': { type: 'string', default: join(root, 'data') },
    report: { type: 'string', default: join(root, 'STATUS.md') },
    concurrency: { type: 'string', default: '3' },
    timeout: { type: 'string', default: '10' },
    'no-translation': { type: 'boolean', default: false },
  } });
  const concurrency = Number(values.concurrency);
  const timeout = Number(values.timeout);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Concurrency must be 1–8.');
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 30) throw new Error('Timeout must be 1–30 seconds.');
  const instances = await loadCatalog(resolve(values.catalog));
  if (values.validate) {
    console.log(`Validated ${instances.length} instance entries.`);
    return;
  }
  const directory = resolve(values['out-dir']);
  const previous = await readPrevious(directory);
  const results = await checkAll(instances, {
    previous, concurrency, timeoutMs: timeout * 1000, probeTranslation: !values['no-translation'],
    onResult: item => console.log(`${item.id}: ${item.availability}, anonymous API=${item.api_access}, languages=${item.language_count}`),
  });
  const { open, report } = await writeOutputs(directory, results, { reportPath: resolve(values.report) });
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
  console.log(`Checked ${results.length} instances; ${open.instances.length} passed anonymous translation.`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
