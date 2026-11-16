# `scripts/usage-benchmark.ts`: large usage-ledger regression fixture

Run the same isolated HTTP workload against two source checkouts. Each case starts a fresh
child process with that checkout's real `WebApp`, `UsageLog`, `aggregateUsage` and event store.
It does not start a Persona, provider or World and does not contact a deployment.

Install each checkout's locked dependencies first. Use the same Node version for both.

```sh
git worktree add ../before bd4e35e244e9c327afa61a3fe66472cab1e3ba1b
git worktree add ../after v0.2.16
# Run pnpm install --frozen-lockfile in each checkout.
pnpm bench:usage --repo ../before --repo ../after --out scratch/usage-small --bytes 16000000 --repeats 1
pnpm bench:usage --repo ../before --repo ../after --out scratch/usage-334mb --bytes 334000000 --repeats 3
pnpm bench:usage --repo ../before --repo ../after --out scratch/usage-1480mb --bytes 1480000000 --repeats 3
```

The default is a 16 MB generated ledger, with deterministic 2,560-byte records spread over
90 days, multiple roles/models, failures, token counts, prices and Unicode. No vendor or
deployment identity is required. `fixture.json` records its exact byte count and SHA256.
MB in these commands is decimal; memory tables use MiB. Outputs are created exclusively:
choose a new directory for each run.

For a real ledger, use an immutable copy if available:

```sh
pnpm bench:usage --repo ../before --repo ../after --out scratch/usage-private --ledger /path/to/usage.jsonl --snapshot-bytes 1478777845 --repeats 3
# Reuse the same immutable snapshot after verifying its manifest hash:
pnpm bench:usage --repo ../before --repo ../after --out scratch/usage-recheck --fixture scratch/usage-private --repeats 3
```

The tool first copies a fixed byte prefix into the output directory. It never appends to or
clears the original. Later appends are excluded, truncation is detected, and a final partial
line remains visible as a ledger error. Concurrent in-place rewrites are not guaranteed to
be detected. Keep snapshots, job files and raw reports private; report source paths, usage
identities and exact balances only after reviewing them for publication. Do not commit ledgers.

## Measurements

- Real `/api/usage` request duration and separate `read`/`aggregate` phases. Response
  fingerprints are computed in the driver after latency probing, outside the query path.
- Independent-process HTTP probes every 25 ms and a separate 500 ms lane with one request
  in flight, preserving the earlier coarse probe interval. The dense lane allows 16 pending
  requests; skipped sends and failures remain in the report. This cap prevents an unbounded
  queue during a stall; percentiles must be read with skipped counts.
- External event pulses written to the actual JSONL event store and handled by a queued
  callback. This measures host event-loop availability, not Persona reasoning or game latency.
- A 1 ms callback-gap probe, `monitorEventLoopDelay` and GC durations. These are separate
  measurements; callback gaps include timer resolution and scheduling overhead.
- `process.resourceUsage().maxRSS` in bytes, sampled heap/RSS, and memory at phase boundaries.
  OS peak RSS includes startup and preload. Sampled heap peaks are lower bounds and cannot
  see a transient allocation freed within a synchronous phase.
- Full response fingerprints across versions/repeats, independently generated call/token
  totals for synthetic all-time queries, and an input hash check after every matrix.

The matrix covers first storage scan, cached storage count, all-time/30-day queries, three
consecutive queries in one process, two concurrent queries with different filters, aggregation
alone after preloading, and append during a query. Cached storage warms the production count
path before timing; aggregation-only preloads the records instead. Append cases use disposable extra copies.
Temporary append copies are removed when their case exits; the hashed input remains. An append
may appear in the current query or the following one according to timing; the final
read must include it exactly once. The boundary suite also checks duplicate IDs, damaged and
unterminated lines, UTF-8 chunk boundaries, concurrent reads, failed writes, and clear/append
interleaving. Failed invariants remain failed in `boundaries.json` and cause a nonzero exit.

`--scenarios query-all,aggregate-only` selects cases; `--heap-mb 8192` sets the child heap limit.
Cases execute serially. Version order alternates across repeats. OS cache and other machine
workloads are not reset: first process run is not a cold-disk claim. Allow enough free memory
for two concurrent full ledgers plus aggregation, particularly with private rows larger than
the synthetic profile. A child timeout or crash remains a failed result. `--now` fixes the
aggregation reference time: generated ledgers default to their fixed fixture date; private
snapshots default to the matrix start time, shared by all cases and versions.

## Regression gate

`report.json` retains raw probes and per-case phases; `report.md` is a compact table. The
default gate checks correctness, failed HTTP requests and unchanged input. Optional
`--max-status-ms 250` also fails cases exceeding the chosen status-latency ceiling. Set the
ceiling for the host's event-processing budget and record the hardware; it is not a universal
performance promise. Empty timing samples are `null`, not zero. The deterministic fixture
tests are part of `pnpm test`; the large matrix is an explicit manual run.

The v0.2.16 boundary check currently exposes cached-count drift after appending an already
present record ID: reads deduplicate it, while the cached count increments. Keeping that
failure visible lets a subsequent implementation be tested against the same invariant.
