import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { digest, fixtureRecord } from './fixture.ts';
import type { UsageLog } from '../../src/core/usage-log.ts';
import { readTextFile } from '../../src/core/util.ts';

/** Checks invariants against either synchronous or asynchronous UsageLog implementations. */
export async function checkBoundaries(repo: string, dir: string) {
  const { UsageLog: Log } = await import(pathToFileURL(join(repo, 'src/core/usage-log.ts')).href) as { UsageLog: typeof UsageLog };
  await mkdir(dir, { recursive: true });
  const checks: { name: string; passed: boolean; expected: unknown; actual: unknown }[] = [];
  const check = (name: string, actual: unknown, expected: unknown) => checks.push({ name, passed: digest(actual) === digest(expected), expected, actual });
  const file = join(dir, 'boundaries.jsonl');
  const rows = Array.from({ length: 2200 }, (_, i) => ({ ...fixtureRecord(i), detail: '界'.repeat(1400) }));
  const raw = rows.map(r => JSON.stringify(r)).join('\r\n') + '\n' + JSON.stringify(rows[0]) + '\n{broken\n' + JSON.stringify(fixtureRecord(3000));
  await writeFile(file, raw, { flag: 'wx' });
  const log = new Log(file, () => {});
  const initial = await log.readAll();
  check('chunk boundaries, Unicode, damaged line, duplicate id and final unterminated record', initial.map(r => r.recordId), [...rows.map(r => r.recordId), 'fixture-3000']);
  check('read does not rewrite damaged input', digest(readTextFile(file)), digest(raw));
  check('count matches unique readable records after scan', log.count(), initial.length);
  log.append(fixtureRecord(3001));
  check('cached count includes one appended record', log.count(), initial.length + 1);
  log.append(fixtureRecord(3001));
  const duplicateCount = log.count();
  const deduplicated = await log.readAll();
  check('cached count stays equal to deduplicated reads after duplicate append', duplicateCount, deduplicated.length);

  const during = new Log(file, () => {});
  const reading = Promise.resolve(during.readAll());
  const append = yieldTurn().then(() => during.append(fixtureRecord(3002)));
  const concurrent = Promise.resolve(during.readAll());
  const [a, b] = await Promise.all([reading, concurrent]);
  await append;
  check('concurrent reads return unique ids', [new Set(a.map(r => r.recordId)).size, new Set(b.map(r => r.recordId)).size], [a.length, b.length]);
  const final = await during.readAll();
  check('append during read retained exactly once', final.filter(r => r.recordId === 'fixture-3002').length, 1);
  check('count converges after concurrent reads and append', during.count(), final.length);

  const clearing = new Log(file, () => {});
  clearing.count();
  const pendingRead = Promise.resolve(clearing.readAll());
  await clearing.clear();
  clearing.append(fixtureRecord(4000));
  await pendingRead;
  await yieldTurn();
  check('pre-clear scan cannot overwrite post-clear count', clearing.count(), 1);
  check('clear followed by append retains only the new record', (await clearing.readAll()).map(r => r.recordId), ['fixture-4000']);

  const failedDir = join(dir, 'blocked');
  await writeFile(failedDir, 'occupied');
  const failed = new Log(join(failedDir, 'usage.jsonl'), () => {});
  failed.append(fixtureRecord(5000));
  check('failed write remains pending and visible', { pending: failed.status().pending, records: (await failed.readAll()).length }, { pending: 1, records: 1 });
  return { checks, passed: checks.every(c => c.passed), boundary: 'Disposable files only. Known failures are recorded as failures; they are not redefined as correct behavior.' };
}
