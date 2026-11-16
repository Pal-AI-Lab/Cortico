import { fork, execFileSync, type ForkOptions } from 'node:child_process';
import { mkdir, writeFile, copyFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { cpus, freemem, totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { generateLedger, snapshotLedger, hashFile, distribution, digest, FIXED_NOW } from './usage-benchmark/fixture.ts';
import { checkBoundaries } from './usage-benchmark/boundaries.ts';
import { readTextFile } from '../src/core/util.ts';

const args = process.argv.slice(2).filter(x => x !== '--');
function values(key: string) { return args.flatMap((x, i) => x === `--${key}` ? [args[i + 1]] : []); }
const value = (key: string, fallback: string) => values(key)[0] ?? fallback;
if (args.includes('--help')) {
  console.log('pnpm bench:usage --repo <before> --repo <after> --out <new-directory> [--bytes 334000000 | --ledger <private-jsonl> --snapshot-bytes N | --fixture <previous-output-dir>] [--repeats 3] [--scenarios storage-first,storage-cached,query-all,query-30d,query-repeat,concurrent,aggregate-only,append] [--probe-ms 25] [--heap-mb 8192] [--max-status-ms 250]');
  process.exit(0);
}
const repos = values('repo').map(x => resolve(x));
if (!repos.length) repos.push(resolve(fileURLToPath(new URL('..', import.meta.url))));
const out = resolve(value('out', `scratch/usage-benchmark-${Date.now()}`));
const repeats = Number(value('repeats', '3')), probeMs = Number(value('probe-ms', '25'));
const heapMb = Number(value('heap-mb', '8192'));
const threshold = values('max-status-ms').length ? Number(values('max-status-ms')[0]) : null;
if (![repeats, probeMs, heapMb].every(x => Number.isSafeInteger(x) && x > 0)) throw new Error('Invalid numeric option');
if (threshold !== null && (!Number.isFinite(threshold) || threshold <= 0)) throw new Error('Invalid --max-status-ms');
const scenarios = value('scenarios', 'storage-first,storage-cached,query-all,query-30d,query-repeat,concurrent,aggregate-only,append').split(',');
const allowed = new Set(['storage-first', 'storage-cached', 'query-all', 'query-30d', 'query-repeat', 'concurrent', 'aggregate-only', 'append']);
if (scenarios.some(s => !allowed.has(s))) throw new Error('Unknown scenario');
await mkdir(out, { recursive: true });
await writeFile(join(out, 'run.lock'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid }), { flag: 'wx' });
const reuse = values('fixture')[0];
if (reuse && (values('ledger').length || values('bytes').length)) throw new Error('--fixture cannot be combined with --ledger or --bytes');
const ledger = reuse ? resolve(reuse, 'ledger.jsonl') : join(out, 'ledger.jsonl');
const fixture = reuse ? JSON.parse(readTextFile(resolve(reuse, 'fixture.json'))) : values('ledger').length ? await snapshotLedger(resolve(values('ledger')[0]), ledger,
  values('snapshot-bytes').length ? Number(values('snapshot-bytes')[0]) : undefined)
  : await generateLedger(ledger, Number(value('bytes', '16000000')), Number(value('row-bytes', '2560')));
if (reuse) {
  const actual = await hashFile(ledger);
  if (actual.sha256 !== fixture.sha256 || actual.bytes !== fixture.bytes) throw new Error('Reused fixture does not match its manifest');
}
await writeFile(join(out, 'fixture.json'), JSON.stringify(fixture, null, 2));
const require = createRequire(import.meta.url);
const loader = pathToFileURL(require.resolve('tsx')).href;
const childFile = fileURLToPath(new URL('./usage-benchmark/child.ts', import.meta.url));
const git = (repo: string, ...argv: string[]) => execFileSync('git', ['-C', repo, ...argv], { encoding: 'utf8', windowsHide: true }).trim();
const sources = await Promise.all(repos.map(async repo => ({ repo, commit: git(repo, 'rev-parse', 'HEAD'),
  dirty: git(repo, 'status', '--porcelain'), version: JSON.parse(readTextFile(join(repo, 'package.json'))).version,
  usageLog: await hashFile(join(repo, 'src/core/usage-log.ts')), cost: await hashFile(join(repo, 'src/core/cost.ts')) })));
const harness = await Promise.all(['usage-benchmark.ts', 'usage-benchmark/fixture.ts', 'usage-benchmark/child.ts', 'usage-benchmark/boundaries.ts']
  .map(async file => ({ file, ...await hashFile(fileURLToPath(new URL(`./${file}`, import.meta.url))) })));
const environment = { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model,
  cpuCount: cpus().length, totalMemoryBytes: totalmem(), freeMemoryAtStart: freemem(), heapMb, probeMs,
  queryNow: value('now', fixture.kind === 'synthetic' ? FIXED_NOW : new Date().toISOString()),
  diskCache: 'uncontrolled OS cache; new process per case, alternating version order per repeat; no cache flush' };
if (Number.isNaN(Date.parse(environment.queryNow))) throw new Error('Invalid --now timestamp');
const results: any[] = [];
const boundaries = [];
for (let i = 0; i < repos.length; i++) boundaries.push({ repoIndex: i, ...await checkBoundaries(repos[i], join(out, `boundaries-v${i}`)) });
await writeFile(join(out, 'boundaries.json'), JSON.stringify(boundaries, null, 2));
const epoch = () => performance.timeOrigin + performance.now();

async function runCase(repoIndex: number, scenario: string, repeat: number) {
  const dir = join(out, `r${repeat}-v${repoIndex}-${scenario}`);
  await mkdir(dir, { recursive: true });
  const mutableLedger = scenario === 'append' ? join(dir, 'ledger.jsonl') : ledger;
  if (mutableLedger !== ledger) await copyFile(ledger, mutableLedger);
  const jobPath = join(dir, 'job.json');
  await writeFile(jobPath, JSON.stringify({ repo: repos[repoIndex], ledger: mutableLedger, dataDir: join(dir, 'data'), scenario, timezone: value('timezone', 'Asia/Shanghai'), now: environment.queryNow }));
  const forkOptions: ForkOptions & { windowsHide: boolean } = { execArgv: [`--max-old-space-size=${heapMb}`, '--import', loader], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true };
  const child = fork(childFile, [jobPath], forkOptions);
  let stderr = '', stdout = '', exited = false;
  child.stderr?.on('data', b => { stderr += String(b); }); child.stdout?.on('data', b => { stdout += String(b); });
  const waiters = new Map<string, { resolve: (value: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const wait = (type: string) => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(type); reject(new Error(`${type} timed out`)); }, 180000);
    waiters.set(type, { resolve, reject, timer });
  });
  const eventSamples: any[] = [], httpSamples: any[] = [], queryBodies: { sample: any; text: string }[] = [], pendingEvents = new Set<number>();
  let eventId = 0, skippedEvents = 0, skippedHttp = 0, eventTimer: ReturnType<typeof setInterval> | undefined;
  let httpTimer: ReturnType<typeof setInterval> | undefined, legacyTimer: ReturnType<typeof setInterval> | undefined;
  const outstanding = new Set<Promise<unknown>>();
  child.on('message', (m: any) => {
    if (m.type === 'event-ack') { pendingEvents.delete(m.id); eventSamples.push({ ...m, receivedAt: epoch(), ms: m.handledAt - m.sentAt }); }
    const w = waiters.get(m.type); if (w) { clearTimeout(w.timer); waiters.delete(m.type); w.resolve(m); }
  });
  child.on('exit', code => { exited = true; for (const w of waiters.values()) { clearTimeout(w.timer); w.reject(new Error(`child exited ${code}`)); } waiters.clear(); });
  child.on('error', e => { for (const w of waiters.values()) { clearTimeout(w.timer); w.reject(e); } waiters.clear(); });
  try {
    const ready = await wait('ready');
    const base = `http://127.0.0.1:${ready.port}`;
    const request = async (path: string, lane = 'query') => {
      const start = epoch();
      try {
        const r = await fetch(base + path, { signal: AbortSignal.timeout(120000) });
        const text = await r.text();
        const body = path.startsWith('/api/usage') ? null : JSON.parse(text);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const sample = { path, lane, start, end: epoch(), ms: epoch() - start, ok: true,
          ...(lane === 'query' && body ? { digest: digest(body), calls: body.totals?.calls ?? null, storage: body.parts ?? null } : {}) };
        if (path.startsWith('/api/usage')) queryBodies.push({ sample, text });
        httpSamples.push(sample); return { sample, body };
      } catch (e) {
        const cause = e instanceof Error ? e.cause as { code?: string; message?: string } | undefined : undefined;
        httpSamples.push({ path, lane, start, end: epoch(), ms: epoch() - start, ok: false, error: String(e), cause: cause ? { code: cause.code, message: cause.message } : null }); throw e;
      }
    };
    await request('/api/status', 'baseline');
    await delay(150);
    const started = wait('started'); child.send({ type: 'start' }); await started;
    let densePending = 0, legacyPending = false;
    const statusProbe = (lane: 'dense' | 'legacy-500ms') => {
      if ((lane === 'dense' && densePending >= 16) || (lane !== 'dense' && legacyPending)) { skippedHttp++; return; }
      if (lane === 'dense') densePending++; else legacyPending = true;
      const p = request('/api/status', lane).catch(() => {}).finally(() => { if (lane === 'dense') densePending--; else legacyPending = false; outstanding.delete(p); });
      outstanding.add(p);
    };
    httpTimer = setInterval(() => statusProbe('dense'), probeMs);
    legacyTimer = setInterval(() => statusProbe('legacy-500ms'), 500);
    eventTimer = setInterval(() => {
      if (pendingEvents.size >= 16) { skippedEvents++; return; }
      const id = eventId++; pendingEvents.add(id); child.send({ type: 'event', id, sentAt: epoch() });
    }, probeMs);
    statusProbe('legacy-500ms');
    const startedAt = epoch();
    let storageFinal: any = null;
    if (scenario.startsWith('storage')) {
      await request('/api/storage');
      if (scenario === 'storage-first') {
        const deadline = Date.now() + 120000;
        do {
          const result = await request('/api/status', 'count-poll'); storageFinal = result.body.count;
          if (storageFinal !== null) break;
          if (Date.now() > deadline) throw new Error('initial count scan timed out');
          await delay(25);
        } while (true);
      }
      await request('/api/storage');
    } else if (scenario === 'concurrent') {
      await Promise.all([request('/api/usage?bucket=day'), request('/api/usage?bucket=day&days=30')]);
    } else {
      const n = scenario === 'query-repeat' ? 3 : 1;
      for (let i = 0; i < n; i++) await request(scenario === 'query-30d' ? '/api/usage?bucket=day&days=30' : '/api/usage?bucket=day');
    }
    const finishedAt = epoch();
    clearInterval(httpTimer); clearInterval(legacyTimer); clearInterval(eventTimer);
    await Promise.all(outstanding);
    const finish = wait('result'); child.send({ type: 'finish' }); const measured = await finish;
    // Hash large responses only after latency probes finish, on the driver process.
    for (const q of queryBodies) {
      const body = JSON.parse(q.text);
      q.sample.digest = digest(body);
      q.sample.calls = body.totals?.calls ?? null;
      q.sample.promptTokens = body.totals?.promptTokens ?? null;
      q.sample.completionTokens = body.totals?.completionTokens ?? null;
    }
    let appendVerification = null;
    if (scenario === 'append') { const v = wait('append-result'); child.send({ type: 'verify-append' }); appendVerification = await v; }
    const sampleSummary = (lane: string) => ({ ...distribution(httpSamples.filter(s => s.lane === lane && s.ok).map(s => s.ms)), failures: httpSamples.filter(s => s.lane === lane && !s.ok).length });
    const result = { repoIndex, scenario, repeat, ok: true, startedAt, finishedAt, elapsedMs: finishedAt - startedAt,
      query: sampleSummary('query'), status: sampleSummary('dense'), legacyStatus: sampleSummary('legacy-500ms'),
      events: { ...distribution(eventSamples.map(s => s.ms)), sent: eventId, pending: pendingEvents.size, skipped: skippedEvents },
      skippedHttp, storageFinal, appendVerification, ...measured, httpSamples, eventSamples };
    await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2)); return result;
  } catch (e) {
    const result = { repoIndex, scenario, repeat, ok: false, error: String(e), httpSamples, eventSamples };
    await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2)); return result;
  } finally {
    clearInterval(httpTimer); clearInterval(legacyTimer); clearInterval(eventTimer);
    if (!exited) {
      child.send({ type: 'stop' });
      await Promise.race([new Promise<void>(r => child.once('exit', () => r())), delay(3000)]);
      if (!exited) child.kill();
    }
    await writeFile(join(dir, 'child.log'), stdout + stderr);
    if (mutableLedger !== ledger) await unlink(mutableLedger);
  }
}

for (let repeat = 0; repeat < repeats; repeat++) {
  for (const scenario of scenarios) {
    const order = repos.map((_, i) => i); if (repeat % 2) order.reverse();
    for (const repoIndex of order) {
      console.log(JSON.stringify({ stage: 'start', repoIndex, scenario, repeat, freeMemoryBytes: freemem() }));
      const r = await runCase(repoIndex, scenario, repeat); results.push(r);
      console.log(JSON.stringify({ stage: 'result', repoIndex, scenario, repeat, ok: r.ok, query: r.query, status: r.status, memory: r.memory?.processPeakRss, error: r.error }));
      await writeFile(join(out, 'results.partial.json'), JSON.stringify(results, null, 2));
    }
  }
}
const fingerprints = new Map<string, Set<string>>();
for (const r of results) if (r.ok && r.scenario !== 'append') {
  for (const s of r.httpSamples.filter((s: any) => s.ok && s.path.startsWith('/api/usage'))) {
    const set = fingerprints.get(s.path) ?? new Set<string>(); set.add(s.digest); fingerprints.set(s.path, set);
  }
}
const consistency = [...fingerprints].map(([query, hashes]) => ({ query, matching: hashes.size === 1, fingerprints: [...hashes] }));
const syntheticTotals = fixture.kind === 'synthetic' ? results.flatMap(r => r.ok && r.scenario !== 'append'
  ? r.httpSamples.filter((s: any) => s.ok && s.path === '/api/usage?bucket=day').map((s: any) => ({
    repoIndex: r.repoIndex, scenario: r.scenario, repeat: r.repeat,
    matching: s.calls === fixture.records && s.promptTokens === fixture.promptTokens && s.completionTokens === fixture.completionTokens,
    actual: { records: s.calls, promptTokens: s.promptTokens, completionTokens: s.completionTokens },
  })) : []) : [];
const afterHash = await hashFile(ledger);
const gate = { thresholdMs: threshold, failedCases: results.filter(r => !r.ok || r.httpSamples.some((s: any) => !s.ok)
  || (r.appendVerification && r.appendVerification.copies !== 1)
  || (threshold !== null && (r.status?.maxMs ?? 0) > threshold)).map(r => ({ repoIndex: r.repoIndex, scenario: r.scenario, repeat: r.repeat })),
  boundariesPassed: boundaries.every(x => x.passed), consistencyPassed: consistency.every(x => x.matching) && syntheticTotals.every(x => x.matching), snapshotUnchanged: afterHash.sha256 === fixture.sha256 };
const report = { schema: 'cortico-usage-benchmark/v1', at: new Date().toISOString(), environment, fixture, harness, sources, boundaries, consistency, syntheticTotals, gate, results };
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
const lines = ['# Usage ledger benchmark', '', `Node ${environment.node}; ${fixture.bytes} bytes; ${repeats} repeat(s); status probes every ${probeMs} ms.`, '',
  '| Version | Scenario | Repeat | Query max ms | Status max ms | Event max ms | Timer gap max ms | Aggregate max ms | Peak RSS MiB |',
  '|---|---|---:|---:|---:|---:|---:|---:|---:|'];
const number = (n: number | null | undefined) => n === null || n === undefined ? 'unknown' : n.toFixed(1);
for (const r of results) lines.push(`| ${sources[r.repoIndex].commit.slice(0, 8)} | ${r.scenario}${r.ok ? '' : ' FAILED'} | ${r.repeat} | ${number(r.query?.maxMs)} | ${number(r.status?.maxMs)} | ${number(r.events?.maxMs)} | ${number(r.eventLoop?.timerGap?.maxMs)} | ${number(r.phases?.filter((p: any) => p.kind === 'aggregate').reduce((m: number, p: any) => Math.max(m, p.elapsedMs), 0))} | ${number(r.memory?.processPeakRss ? r.memory.processPeakRss / 1048576 : null)} |`);
lines.push('', '## Correctness', '', ...boundaries.flatMap(b => b.checks.filter(c => !c.passed).map(c => `- Version ${b.repoIndex}: ${c.name}: expected ${JSON.stringify(c.expected)}, actual ${JSON.stringify(c.actual)}.`)),
  '', `Aggregation fingerprints match: ${gate.consistencyPassed}. Input unchanged: ${gate.snapshotUnchanged}.`, '',
  'No live bot, model or game was started. WebApp, ledger and aggregation are real; event latency covers a synthetic event-store append and queued handler. RSS is the OS process high-water mark, including startup/preload. Heap peaks are sampled lower bounds. OS disk cache is uncontrolled. See report.json for phases, raw probes, failed requests and GC timings.');
await writeFile(join(out, 'report.md'), lines.join('\n') + '\n');
console.log(JSON.stringify({ report: join(out, 'report.json'), gate }));
if (gate.failedCases.length || !gate.boundariesPassed || !gate.consistencyPassed || !gate.snapshotUnchanged) process.exitCode = 1;
