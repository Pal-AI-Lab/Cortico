import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { estimateTokens, readTextFile } from '../../core/util.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const LEDGER_VERSION = 1;

const AUDIENCE_ADMISSION_DEFAULTS = {
  superchatSingleYuan: 30,
  superchatRollingYuan: 50,
  superchatWindowMs: 30 * DAY_MS,
  superchatLeaseMs: 30 * DAY_MS,
  guardRetentionMs: 35 * DAY_MS,
  interactionWindowMs: 30 * DAY_MS,
  interactionLeaseMs: 30 * DAY_MS,
  /**
   * 互动资格按每场去重活跃分钟计量，不按在线时长计量。所需分钟数和场次数由每个 bot 的 tuning 配置。
   */
  interactionMinutesPerStream: 25,
  interactionStreamCount: 1,
  onlineRankCrowdedOn: 200,
  onlineRankCrowdedOff: 170,
  onlineRankReleaseMs: 120_000,
  onlineRankFreshMs: 90_000,
  onlineRankStaleHoldMs: 300_000,
  lineBudget: 114,
  tokenBudget: 1061,
  importantBudgetShare: 0.5,
  persistIntervalMs: 30_000,
} as const;

export type AudienceAdmissionTuning = {
  -readonly [K in keyof typeof AUDIENCE_ADMISSION_DEFAULTS]: number;
};

type AudienceImportanceReason = 'guard' | 'superchat' | 'interaction';
type AudienceAdmissionLane = 'critical' | 'important' | 'ordinary';

interface AudienceAdmissionObservation {
  /** Bilibili numeric UID. Anonymous UID 0 is ignored. */
  senderKey: string;
  at?: number;
  interaction?: boolean;
  superchatYuan?: number;
  /** A buy, renewal, or roster observation with positive membership evidence. */
  guard?: boolean;
  guardLevel?: number;
}

interface AudienceStreamIdentity {
  roomId?: number;
  liveStartedAt?: number | string | null;
}

export interface AudienceAdmissionCandidate<TMeta = unknown> {
  /** Stable source identity, normally the contributing event cursors. */
  stableKey: string;
  text: string;
  type: string;
  senderKeys: readonly string[];
  critical?: boolean;
  meta?: TMeta;
}

export interface ImportantAudienceParticipant {
  senderKey: string;
  reasons: readonly AudienceImportanceReason[];
}

interface SelectedAudienceCandidate<TCandidate extends AudienceAdmissionCandidate = AudienceAdmissionCandidate> {
  index: number;
  candidate: TCandidate;
  lane: AudienceAdmissionLane;
  importantParticipants: readonly ImportantAudienceParticipant[];
}

interface AudienceLaneMetrics {
  input: number;
  selected: number;
  inputTokens: number;
  selectedTokens: number;
}

interface AudienceAdmissionBatchMetrics {
  limitingActive: boolean;
  overloaded: boolean;
  criticalOverflow: boolean;
  input: number;
  selected: number;
  dropped: number;
  inputLines: number;
  selectedLines: number;
  inputTokens: number;
  selectedTokens: number;
  lineBudget: number;
  tokenBudget: number;
  importantViewers: number;
  crowd: AudienceCrowdMetrics;
  lanes: Record<AudienceAdmissionLane, AudienceLaneMetrics>;
}

interface AudienceCrowdMetrics {
  onlineRankCount: number | null;
  signalAgeMs: number | null;
  signalFresh: boolean;
  active: boolean;
}

interface AudienceAdmissionProjection<TCandidate extends AudienceAdmissionCandidate = AudienceAdmissionCandidate> {
  selected: readonly SelectedAudienceCandidate<TCandidate>[];
  metrics: AudienceAdmissionBatchMetrics;
}

interface AudienceAdmissionSnapshot {
  streamOpen: boolean;
  trackedViewers: number;
  qualifiedViewers: number;
  crowd: AudienceCrowdMetrics;
  totals: {
    batches: number;
    limitedBatches: number;
    input: number;
    selected: number;
    dropped: number;
    inputTokens: number;
    selectedTokens: number;
  };
  lastBatch: AudienceAdmissionBatchMetrics | null;
  persistenceError: string | null;
}

interface AudienceAdmissionOptions {
  file?: string;
  roomId: number;
  tuning?: Partial<AudienceAdmissionTuning>;
  now?: () => number;
  createId?: () => string;
  onPersistError?: (error: Error) => void;
}

interface SuperchatEntry {
  at: number;
  cents: number;
}

interface InteractionStream {
  lastAt: number;
  minutes: number[];
  qualifiedAt?: number;
}

interface ViewerLedger {
  lastSeenAt: number;
  guardExpiresAt?: number;
  superchatExpiresAt?: number;
  superchats: SuperchatEntry[];
  interactionExpiresAt?: number;
  interactionStreams: Record<string, InteractionStream>;
  fairDebt: number;
}

interface OpenStream {
  roomId: number;
  id: string;
}

interface AudienceLedgerFile {
  schemaVersion: 1;
  salt: string;
  openStream: OpenStream | null;
  viewers: Record<string, ViewerLedger>;
}

interface ClassifiedCandidate<TCandidate extends AudienceAdmissionCandidate> {
  index: number;
  candidate: TCandidate;
  lane: AudienceAdmissionLane;
  importantParticipants: ImportantAudienceParticipant[];
  lines: number;
  tokens: number;
}

interface SelectionUsage {
  lines: number;
  tokens: number;
}

const ZERO_TOTALS = {
  batches: 0,
  limitedBatches: 0,
  input: 0,
  selected: 0,
  dropped: 0,
  inputTokens: 0,
  selectedTokens: 0,
};

/**
 * Private Bilibili audience ledger and delivery-time admission controller.
 * Projection reads and updates memory synchronously; persistence runs outside the projection call.
 */
export class AudienceAdmission {
  readonly tuning: AudienceAdmissionTuning;

  private readonly file?: string;
  private readonly roomId: number;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly onPersistError?: (error: Error) => void;
  private ledger: AudienceLedgerFile;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMaintenanceAt = 0;
  private onlineRankCount: number | null = null;
  private onlineRankObservedAt: number | null = null;
  private crowded = false;
  private belowReleaseSince: number | null = null;
  private totals = { ...ZERO_TOTALS };
  private lastBatch: AudienceAdmissionBatchMetrics | null = null;
  private persistenceError: string | null = null;

  constructor(options: AudienceAdmissionOptions) {
    this.file = options.file;
    this.roomId = options.roomId;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.onPersistError = options.onPersistError;
    this.tuning = validateTuning({ ...AUDIENCE_ADMISSION_DEFAULTS, ...options.tuning });
    const loaded = this.load();
    this.ledger = loaded ?? this.freshLedger();
    if (!loaded) this.markDirty();
  }

  startStream(identity: AudienceStreamIdentity = {}): string {
    const roomId = identity.roomId ?? this.roomId;
    const started = normalizedStart(identity.liveStartedAt);
    if (started !== null) {
      const id = `${roomId}:${started}`;
      if (this.ledger.openStream?.id !== id) {
        const previous = this.ledger.openStream;
        if (previous?.roomId === roomId && previous.id.startsWith(`${roomId}:local:`)) {
          this.renameInteractionStream(previous.id, id);
        } else if (previous) {
          this.resetCrowdSignal();
        }
        this.ledger.openStream = { roomId, id };
        this.markDirty();
      }
      return id;
    }

    const current = this.ledger.openStream;
    if (current?.roomId === roomId) return current.id;
    if (current) this.resetCrowdSignal();
    const id = `${roomId}:local:${this.createId()}`;
    this.ledger.openStream = { roomId, id };
    this.markDirty();
    return id;
  }

  endStream(): void {
    this.resetCrowdSignal();
    if (this.ledger.openStream) {
      this.ledger.openStream = null;
      this.markDirty();
    }
  }

  updateTuning(partial: Partial<AudienceAdmissionTuning>): AudienceAdmissionTuning {
    const next = validateTuning({ ...this.tuning, ...partial });
    const changed = (Object.keys(next) as Array<keyof AudienceAdmissionTuning>)
      .some((key) => next[key] !== this.tuning[key]);
    if (!changed) return { ...this.tuning };
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    Object.assign(this.tuning, next);

    if (this.onlineRankCount !== null) {
      if (this.onlineRankCount >= this.tuning.onlineRankCrowdedOn) {
        this.crowded = true;
        this.belowReleaseSince = null;
      } else if (this.crowded && this.onlineRankCount <= this.tuning.onlineRankCrowdedOff) {
        this.belowReleaseSince ??= this.now();
      } else if (this.onlineRankCount > this.tuning.onlineRankCrowdedOff) {
        this.belowReleaseSince = null;
      }
    }
    if (this.dirty) this.markDirty();
    return { ...this.tuning };
  }

  observe(observation: AudienceAdmissionObservation): void {
    const senderKey = uidOf(observation.senderKey);
    if (!senderKey) return;
    const at = timestampOf(observation.at ?? this.now());
    this.maintain(at);
    const viewer = this.viewer(senderKey, at);
    viewer.lastSeenAt = Math.max(viewer.lastSeenAt, at);

    if (observation.interaction) this.noteInteraction(viewer, at);
    if (observation.superchatYuan !== undefined) {
      this.noteSuperchat(viewer, observation.superchatYuan, at);
    }
    if (observation.guard === true || (observation.guardLevel ?? 0) > 0) {
      viewer.guardExpiresAt = Math.max(
        viewer.guardExpiresAt ?? 0,
        at + this.tuning.guardRetentionMs,
      );
    }
    this.markDirty();
  }

  observeOnlineRank(count: number, at = this.now()): void {
    at = timestampOf(at);
    if (!Number.isFinite(count) || count < 0) throw new Error('online rank count must be non-negative');
    count = Math.floor(count);

    if (
      this.onlineRankObservedAt !== null &&
      at - this.onlineRankObservedAt > this.tuning.onlineRankStaleHoldMs
    ) {
      this.crowded = false;
      this.belowReleaseSince = null;
    }

    this.onlineRankCount = count;
    this.onlineRankObservedAt = at;
    if (count >= this.tuning.onlineRankCrowdedOn) {
      this.crowded = true;
      this.belowReleaseSince = null;
      return;
    }
    if (!this.crowded) return;
    if (count > this.tuning.onlineRankCrowdedOff) {
      this.belowReleaseSince = null;
      return;
    }
    if (this.belowReleaseSince === null) {
      this.belowReleaseSince = at;
      return;
    }
    if (at - this.belowReleaseSince >= this.tuning.onlineRankReleaseMs) {
      this.crowded = false;
      this.belowReleaseSince = null;
    }
  }

  importanceOf(senderKey: string, at = this.now()): ImportantAudienceParticipant | null {
    const uid = uidOf(senderKey);
    if (!uid) return null;
    const viewer = this.ledger.viewers[uid];
    if (!viewer) return null;
    const reasons: AudienceImportanceReason[] = [];
    if ((viewer.guardExpiresAt ?? 0) > at) reasons.push('guard');
    if ((viewer.superchatExpiresAt ?? 0) > at) reasons.push('superchat');
    if ((viewer.interactionExpiresAt ?? 0) > at) reasons.push('interaction');
    return reasons.length > 0 ? { senderKey: uid, reasons } : null;
  }

  project<TCandidate extends AudienceAdmissionCandidate>(
    candidates: readonly TCandidate[],
    at = this.now(),
  ): AudienceAdmissionProjection<TCandidate> {
    at = timestampOf(at);
    const classified = candidates.map((candidate, index) => this.classify(candidate, index, at));
    const inputLines = classified.reduce((sum, item) => sum + item.lines, 0);
    const inputTokens = classified.reduce((sum, item) => sum + item.tokens, 0);
    const overloaded = inputLines > this.tuning.lineBudget || inputTokens > this.tuning.tokenBudget;
    const crowd = this.crowdMetrics(at);
    const limitingActive = crowd.active && overloaded;

    const selected = limitingActive
      ? this.selectLimited(classified)
      : classified.map((item) => this.asSelected(item));
    selected.sort((a, b) => a.index - b.index);

    const selectedLines = selected.reduce((sum, item) => sum + classified[item.index]!.lines, 0);
    const selectedTokens = selected.reduce((sum, item) => sum + classified[item.index]!.tokens, 0);
    const metrics = this.batchMetrics(
      classified,
      selected,
      crowd,
      limitingActive,
      overloaded,
      inputLines,
      inputTokens,
      selectedLines,
      selectedTokens,
    );
    this.lastBatch = metrics;
    this.totals.batches += 1;
    if (limitingActive) this.totals.limitedBatches += 1;
    this.totals.input += candidates.length;
    this.totals.selected += selected.length;
    this.totals.dropped += candidates.length - selected.length;
    this.totals.inputTokens += inputTokens;
    this.totals.selectedTokens += selectedTokens;

    return { selected, metrics };
  }

  snapshot(at = this.now()): AudienceAdmissionSnapshot {
    let qualifiedViewers = 0;
    for (const senderKey of Object.keys(this.ledger.viewers)) {
      if (this.importanceOf(senderKey, at)) qualifiedViewers += 1;
    }
    return {
      streamOpen: this.ledger.openStream !== null,
      trackedViewers: Object.keys(this.ledger.viewers).length,
      qualifiedViewers,
      crowd: this.crowdMetrics(at),
      totals: { ...this.totals },
      lastBatch: this.lastBatch,
      persistenceError: this.persistenceError,
    };
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.dirty || !this.file) return;
    try {
      persistLedger(this.file, this.ledger);
      this.dirty = false;
      this.persistenceError = null;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.persistenceError = failure.message;
      throw failure;
    }
  }

  stop(): void {
    this.flush();
  }

  private classify<TCandidate extends AudienceAdmissionCandidate>(
    candidate: TCandidate,
    index: number,
    at: number,
  ): ClassifiedCandidate<TCandidate> {
    const importantParticipants = uniqueUids(candidate.senderKeys)
      .map((senderKey) => this.importanceOf(senderKey, at))
      .filter((participant): participant is ImportantAudienceParticipant => participant !== null);
    return {
      index,
      candidate,
      lane: candidate.critical
        ? 'critical'
        : importantParticipants.length > 0
          ? 'important'
          : 'ordinary',
      importantParticipants,
      lines: lineCount(candidate.text),
      tokens: estimateTokens(candidate.text),
    };
  }

  private selectLimited<TCandidate extends AudienceAdmissionCandidate>(
    items: readonly ClassifiedCandidate<TCandidate>[],
  ): SelectedAudienceCandidate<TCandidate>[] {
    const selected = new Set<number>();
    const usage: SelectionUsage = { lines: 0, tokens: 0 };
    for (const item of items) {
      if (item.lane !== 'critical') continue;
      selected.add(item.index);
      usage.lines += item.lines;
      usage.tokens += item.tokens;
    }

    const important = items.filter((item) => item.lane === 'important');
    const importantUsage: SelectionUsage = { lines: 0, tokens: 0 };
    const importantLimit: SelectionUsage = {
      lines: Math.floor(this.tuning.lineBudget * this.tuning.importantBudgetShare),
      tokens: Math.floor(this.tuning.tokenBudget * this.tuning.importantBudgetShare),
    };
    const activeUids = new Set(important.flatMap((item) => item.importantParticipants.map((p) => p.senderKey)));
    for (const uid of activeUids) {
      const viewer = this.ledger.viewers[uid]!;
      viewer.fairDebt = Math.min(1000, viewer.fairDebt + 1);
    }

    const uidOrder = [...activeUids].sort((a, b) => {
      const debt = this.ledger.viewers[b]!.fairDebt - this.ledger.viewers[a]!.fairDebt;
      return debt || this.rank(`important-viewer:${a}`).localeCompare(this.rank(`important-viewer:${b}`));
    });
    const served = new Set<string>();
    for (const uid of uidOrder) {
      if (served.has(uid)) continue;
      const choices = important
        .filter((item) => !selected.has(item.index) && item.importantParticipants.some((p) => p.senderKey === uid))
        .sort((a, b) => this.itemRank(a).localeCompare(this.itemRank(b)) || a.index - b.index);
      const choice = choices.find((item) => this.fits(item, usage, importantUsage, importantLimit));
      if (!choice) continue;
      this.take(choice, selected, usage, importantUsage);
      for (const participant of choice.importantParticipants) served.add(participant.senderKey);
    }

    const importantRemainder = important
      .filter((item) => !selected.has(item.index))
      .sort((a, b) => {
        const debt = maxDebt(b, this.ledger.viewers) - maxDebt(a, this.ledger.viewers);
        return debt || this.itemRank(a).localeCompare(this.itemRank(b)) || a.index - b.index;
      });
    for (const item of importantRemainder) {
      if (this.fits(item, usage, importantUsage, importantLimit)) {
        this.take(item, selected, usage, importantUsage);
      }
    }

    for (const index of selected) {
      const item = items[index]!;
      if (item.lane !== 'important') continue;
      for (const participant of item.importantParticipants) {
        const viewer = this.ledger.viewers[participant.senderKey]!;
        viewer.fairDebt = Math.max(-1000, viewer.fairDebt - 1);
      }
    }
    if (activeUids.size > 0) this.markDirty();

    const ordinary = items.filter((item) => item.lane === 'ordinary');
    const buckets = new Map<string, ClassifiedCandidate<TCandidate>[]>();
    for (const item of ordinary) {
      const participants = uniqueUids(item.candidate.senderKeys);
      const bucket = participants.length > 0
        ? `viewers:${participants.join(',')}`
        : `event:${item.candidate.stableKey}`;
      const entries = buckets.get(bucket);
      if (entries) entries.push(item);
      else buckets.set(bucket, [item]);
    }
    const bucketOrder = [...buckets.entries()].sort((a, b) =>
      this.rank(`ordinary-bucket:${a[0]}`).localeCompare(this.rank(`ordinary-bucket:${b[0]}`)),
    );
    for (const [, entries] of bucketOrder) {
      entries.sort((a, b) => this.itemRank(a).localeCompare(this.itemRank(b)) || a.index - b.index);
      const choice = entries.find((item) => !selected.has(item.index) && this.fitsTotal(item, usage));
      if (choice) this.take(choice, selected, usage);
    }
    const ordinaryRemainder = ordinary
      .filter((item) => !selected.has(item.index))
      .sort((a, b) => this.itemRank(a).localeCompare(this.itemRank(b)) || a.index - b.index);
    for (const item of ordinaryRemainder) {
      if (this.fitsTotal(item, usage)) this.take(item, selected, usage);
    }

    return [...selected].map((index) => this.asSelected(items[index]!));
  }

  private fits<TCandidate extends AudienceAdmissionCandidate>(
    item: ClassifiedCandidate<TCandidate>,
    usage: SelectionUsage,
    laneUsage: SelectionUsage,
    laneLimit: SelectionUsage,
  ): boolean {
    return this.fitsTotal(item, usage) &&
      laneUsage.lines + item.lines <= laneLimit.lines &&
      laneUsage.tokens + item.tokens <= laneLimit.tokens;
  }

  private fitsTotal<TCandidate extends AudienceAdmissionCandidate>(
    item: ClassifiedCandidate<TCandidate>,
    usage: SelectionUsage,
  ): boolean {
    return usage.lines + item.lines <= this.tuning.lineBudget &&
      usage.tokens + item.tokens <= this.tuning.tokenBudget;
  }

  private take<TCandidate extends AudienceAdmissionCandidate>(
    item: ClassifiedCandidate<TCandidate>,
    selected: Set<number>,
    usage: SelectionUsage,
    laneUsage?: SelectionUsage,
  ): void {
    selected.add(item.index);
    usage.lines += item.lines;
    usage.tokens += item.tokens;
    if (laneUsage) {
      laneUsage.lines += item.lines;
      laneUsage.tokens += item.tokens;
    }
  }

  private asSelected<TCandidate extends AudienceAdmissionCandidate>(
    item: ClassifiedCandidate<TCandidate>,
  ): SelectedAudienceCandidate<TCandidate> {
    return {
      index: item.index,
      candidate: item.candidate,
      lane: item.lane,
      importantParticipants: item.importantParticipants,
    };
  }

  private itemRank<TCandidate extends AudienceAdmissionCandidate>(item: ClassifiedCandidate<TCandidate>): string {
    return this.rank([
      item.candidate.stableKey,
      item.candidate.type,
      uniqueUids(item.candidate.senderKeys).join(','),
    ].join('|'));
  }

  private rank(value: string): string {
    const stream = this.ledger.openStream?.id ?? `${this.roomId}:closed`;
    return createHash('sha256').update(this.ledger.salt).update('\0').update(stream).update('\0').update(value).digest('hex');
  }

  private batchMetrics<TCandidate extends AudienceAdmissionCandidate>(
    input: readonly ClassifiedCandidate<TCandidate>[],
    selected: readonly SelectedAudienceCandidate<TCandidate>[],
    crowd: AudienceCrowdMetrics,
    limitingActive: boolean,
    overloaded: boolean,
    inputLines: number,
    inputTokens: number,
    selectedLines: number,
    selectedTokens: number,
  ): AudienceAdmissionBatchMetrics {
    const selectedIndexes = new Set(selected.map((item) => item.index));
    const lanes = Object.fromEntries((['critical', 'important', 'ordinary'] as const).map((lane) => [
      lane,
      {
        input: input.filter((item) => item.lane === lane).length,
        selected: input.filter((item) => item.lane === lane && selectedIndexes.has(item.index)).length,
        inputTokens: input
          .filter((item) => item.lane === lane)
          .reduce((sum, item) => sum + item.tokens, 0),
        selectedTokens: input
          .filter((item) => item.lane === lane && selectedIndexes.has(item.index))
          .reduce((sum, item) => sum + item.tokens, 0),
      },
    ])) as Record<AudienceAdmissionLane, AudienceLaneMetrics>;
    const importantViewers = new Set(input.flatMap((item) =>
      item.importantParticipants.map((participant) => participant.senderKey),
    )).size;
    const criticalLines = input
      .filter((item) => item.lane === 'critical')
      .reduce((sum, item) => sum + item.lines, 0);
    const criticalTokens = input
      .filter((item) => item.lane === 'critical')
      .reduce((sum, item) => sum + item.tokens, 0);
    return {
      limitingActive,
      overloaded,
      criticalOverflow: criticalLines > this.tuning.lineBudget || criticalTokens > this.tuning.tokenBudget,
      input: input.length,
      selected: selected.length,
      dropped: input.length - selected.length,
      inputLines,
      selectedLines,
      inputTokens,
      selectedTokens,
      lineBudget: this.tuning.lineBudget,
      tokenBudget: this.tuning.tokenBudget,
      importantViewers,
      crowd,
      lanes,
    };
  }

  private crowdMetrics(at: number): AudienceCrowdMetrics {
    const age = this.onlineRankObservedAt === null ? null : Math.max(0, at - this.onlineRankObservedAt);
    return {
      onlineRankCount: this.onlineRankCount,
      signalAgeMs: age,
      signalFresh: age !== null && age <= this.tuning.onlineRankFreshMs,
      active: this.crowded && age !== null && age <= this.tuning.onlineRankStaleHoldMs,
    };
  }

  private resetCrowdSignal(): void {
    this.onlineRankCount = null;
    this.onlineRankObservedAt = null;
    this.crowded = false;
    this.belowReleaseSince = null;
  }

  private noteSuperchat(viewer: ViewerLedger, yuan: number, at: number): void {
    if (!Number.isFinite(yuan) || yuan < 0) throw new Error('superchat amount must be non-negative');
    const cents = Math.round(yuan * 100);
    const cutoff = at - this.tuning.superchatWindowMs;
    viewer.superchats = viewer.superchats.filter((entry) => entry.at >= cutoff);
    if (cents > 0) viewer.superchats.push({ at, cents });
    const rollingCents = viewer.superchats.reduce((sum, entry) => sum + entry.cents, 0);
    if (
      cents >= Math.round(this.tuning.superchatSingleYuan * 100) ||
      rollingCents >= Math.round(this.tuning.superchatRollingYuan * 100)
    ) {
      viewer.superchatExpiresAt = Math.max(
        viewer.superchatExpiresAt ?? 0,
        at + this.tuning.superchatLeaseMs,
      );
    }
  }

  private noteInteraction(viewer: ViewerLedger, at: number): void {
    const streamId = this.ledger.openStream?.id ?? this.startStream();
    let stream = viewer.interactionStreams[streamId];
    if (!stream) {
      stream = { lastAt: at, minutes: [] };
      viewer.interactionStreams[streamId] = stream;
    }
    stream.lastAt = Math.max(stream.lastAt, at);
    if (stream.qualifiedAt !== undefined) return;
    const minute = Math.floor(at / MINUTE_MS);
    if (!stream.minutes.includes(minute)) stream.minutes.push(minute);
    if (stream.minutes.length < this.tuning.interactionMinutesPerStream) return;

    stream.qualifiedAt = at;
    stream.minutes = [];
    const cutoff = at - this.tuning.interactionWindowMs;
    const qualifiedStreams = Object.values(viewer.interactionStreams)
      .filter((entry) => (entry.qualifiedAt ?? -Infinity) >= cutoff)
      .length;
    if (qualifiedStreams >= this.tuning.interactionStreamCount) {
      viewer.interactionExpiresAt = Math.max(
        viewer.interactionExpiresAt ?? 0,
        at + this.tuning.interactionLeaseMs,
      );
    }
  }

  /** 开播推送先到、平台开播时刻后到时，两个键仍是同一场直播。 */
  private renameInteractionStream(from: string, to: string): void {
    for (const viewer of Object.values(this.ledger.viewers)) {
      const source = viewer.interactionStreams[from];
      if (!source) continue;
      const target = viewer.interactionStreams[to];
      if (!target) {
        viewer.interactionStreams[to] = source;
      } else {
        target.lastAt = Math.max(target.lastAt, source.lastAt);
        target.minutes = [...new Set([...target.minutes, ...source.minutes])].sort((a, b) => a - b);
        const qualified = [target.qualifiedAt, source.qualifiedAt]
          .filter((value): value is number => value !== undefined);
        if (qualified.length > 0) target.qualifiedAt = Math.min(...qualified);
      }
      delete viewer.interactionStreams[from];
    }
  }

  private viewer(senderKey: string, at: number): ViewerLedger {
    let viewer = this.ledger.viewers[senderKey];
    if (!viewer) {
      viewer = {
        lastSeenAt: at,
        superchats: [],
        interactionStreams: {},
        fairDebt: 0,
      };
      this.ledger.viewers[senderKey] = viewer;
    }
    return viewer;
  }

  private maintain(at: number): void {
    if (at - this.lastMaintenanceAt < 60 * MINUTE_MS) return;
    this.lastMaintenanceAt = at;
    const interactionCutoff = at - this.tuning.interactionWindowMs;
    const scCutoff = at - this.tuning.superchatWindowMs;
    const inactiveCutoff = at - Math.max(
      this.tuning.guardRetentionMs,
      this.tuning.interactionWindowMs,
      this.tuning.superchatWindowMs,
    );
    let changed = false;
    for (const [senderKey, viewer] of Object.entries(this.ledger.viewers)) {
      const scLength = viewer.superchats.length;
      viewer.superchats = viewer.superchats.filter((entry) => entry.at >= scCutoff);
      if (viewer.superchats.length !== scLength) changed = true;
      for (const [streamId, stream] of Object.entries(viewer.interactionStreams)) {
        const relevant = stream.qualifiedAt !== undefined
          ? stream.qualifiedAt >= interactionCutoff
          : stream.lastAt >= interactionCutoff;
        if (!relevant) {
          delete viewer.interactionStreams[streamId];
          changed = true;
        }
      }
      const active = (viewer.guardExpiresAt ?? 0) > at ||
        (viewer.superchatExpiresAt ?? 0) > at ||
        (viewer.interactionExpiresAt ?? 0) > at;
      if (
        !active &&
        viewer.lastSeenAt < inactiveCutoff &&
        viewer.superchats.length === 0 &&
        Object.keys(viewer.interactionStreams).length === 0
      ) {
        delete this.ledger.viewers[senderKey];
        changed = true;
      }
    }
    if (changed) this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        this.flush();
      } catch (error) {
        this.onPersistError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }, this.tuning.persistIntervalMs);
    this.saveTimer.unref?.();
  }

  private load(): AudienceLedgerFile | null {
    if (!this.file) return null;
    const backup = `${this.file}.bak`;
    if (!existsSync(this.file) && existsSync(backup)) renameSync(backup, this.file);
    if (!existsSync(this.file)) return null;
    try {
      return parseLedger(JSON.parse(readTextFile(this.file)));
    } catch (error) {
      throw new Error(`invalid audience ledger ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private freshLedger(): AudienceLedgerFile {
    return {
      schemaVersion: LEDGER_VERSION,
      salt: this.createId(),
      openStream: null,
      viewers: {},
    };
  }
}

function validateTuning(tuning: AudienceAdmissionTuning): AudienceAdmissionTuning {
  const positive = [
    'superchatSingleYuan',
    'superchatRollingYuan',
    'superchatWindowMs',
    'superchatLeaseMs',
    'guardRetentionMs',
    'interactionWindowMs',
    'interactionLeaseMs',
    'interactionMinutesPerStream',
    'interactionStreamCount',
    'onlineRankCrowdedOn',
    'onlineRankReleaseMs',
    'onlineRankFreshMs',
    'onlineRankStaleHoldMs',
    'lineBudget',
    'tokenBudget',
    'persistIntervalMs',
  ] as const;
  for (const key of positive) {
    if (!Number.isFinite(tuning[key]) || tuning[key] <= 0) throw new Error(`${key} must be positive`);
  }
  if (!Number.isFinite(tuning.onlineRankCrowdedOff) || tuning.onlineRankCrowdedOff < 0) {
    throw new Error('onlineRankCrowdedOff must be non-negative');
  }
  if (tuning.onlineRankCrowdedOff >= tuning.onlineRankCrowdedOn) {
    throw new Error('online rank release threshold must be below activation threshold');
  }
  if (tuning.onlineRankStaleHoldMs < tuning.onlineRankFreshMs) {
    throw new Error('online rank stale hold must cover the fresh interval');
  }
  if (tuning.importantBudgetShare <= 0 || tuning.importantBudgetShare > 1) {
    throw new Error('importantBudgetShare must be in (0, 1]');
  }
  return tuning;
}

function normalizedStart(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('liveStartedAt must be finite');
    return String(value);
  }
  const normalized = value.trim();
  return normalized || null;
}

function uidOf(value: string): string | null {
  const normalized = value.trim();
  return /^[1-9]\d*$/.test(normalized) ? normalized : null;
}

function uniqueUids(values: readonly string[]): string[] {
  return [...new Set(values.map(uidOf).filter((value): value is string => value !== null))].sort();
}

function timestampOf(value: number): number {
  if (!Number.isFinite(value)) throw new Error('timestamp must be finite');
  return Math.floor(value);
}

function lineCount(text: string): number {
  return text.split(/\r?\n/).length;
}

function maxDebt<TCandidate extends AudienceAdmissionCandidate>(
  item: ClassifiedCandidate<TCandidate>,
  viewers: Record<string, ViewerLedger>,
): number {
  return Math.max(...item.importantParticipants.map((participant) => viewers[participant.senderKey]!.fairDebt));
}

function parseLedger(raw: unknown): AudienceLedgerFile {
  if (!isRecord(raw) || raw.schemaVersion !== LEDGER_VERSION || typeof raw.salt !== 'string' || !raw.salt) {
    throw new Error('invalid audience ledger');
  }
  const openStream = parseOpenStream(raw.openStream);
  if (!isRecord(raw.viewers)) throw new Error('invalid audience viewers');
  const viewers: Record<string, ViewerLedger> = {};
  for (const [senderKey, value] of Object.entries(raw.viewers)) {
    if (!uidOf(senderKey) || !isRecord(value)) continue;
    const viewer = parseViewer(value);
    if (viewer) viewers[senderKey] = viewer;
  }
  return { schemaVersion: LEDGER_VERSION, salt: raw.salt, openStream, viewers };
}

function parseOpenStream(raw: unknown): OpenStream | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw) || !Number.isInteger(raw.roomId) || typeof raw.id !== 'string' || !raw.id) {
    throw new Error('invalid open stream');
  }
  return { roomId: raw.roomId as number, id: raw.id };
}

function parseViewer(raw: Record<string, unknown>): ViewerLedger | null {
  if (!finiteNumber(raw.lastSeenAt)) return null;
  const superchats = Array.isArray(raw.superchats)
    ? raw.superchats.flatMap((entry) => {
        if (!isRecord(entry) || !finiteNumber(entry.at) || !finiteNumber(entry.cents) || entry.cents < 0) return [];
        return [{ at: entry.at, cents: entry.cents }];
      })
    : [];
  const interactionStreams: Record<string, InteractionStream> = {};
  if (isRecord(raw.interactionStreams)) {
    for (const [streamId, value] of Object.entries(raw.interactionStreams)) {
      if (!isRecord(value) || !finiteNumber(value.lastAt) || !Array.isArray(value.minutes)) continue;
      const minutes = value.minutes.filter((minute): minute is number => Number.isInteger(minute));
      interactionStreams[streamId] = {
        lastAt: value.lastAt,
        minutes,
        ...(finiteNumber(value.qualifiedAt) ? { qualifiedAt: value.qualifiedAt } : {}),
      };
    }
  }
  return {
    lastSeenAt: raw.lastSeenAt,
    ...(finiteNumber(raw.guardExpiresAt) ? { guardExpiresAt: raw.guardExpiresAt } : {}),
    ...(finiteNumber(raw.superchatExpiresAt) ? { superchatExpiresAt: raw.superchatExpiresAt } : {}),
    superchats,
    ...(finiteNumber(raw.interactionExpiresAt) ? { interactionExpiresAt: raw.interactionExpiresAt } : {}),
    interactionStreams,
    fairDebt: finiteNumber(raw.fairDebt) ? raw.fairDebt : 0,
  };
}

function persistLedger(file: string, ledger: AudienceLedgerFile): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const suffix = `${process.pid}-${randomUUID()}`;
  const temporary = `${file}.tmp-${suffix}`;
  const backup = `${file}.bak`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  if (!existsSync(file)) {
    renameSync(temporary, file);
    return;
  }
  if (existsSync(backup)) rmSync(backup);
  renameSync(file, backup);
  try {
    renameSync(temporary, file);
  } catch (error) {
    renameSync(backup, file);
    throw error;
  }
  rmSync(backup);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
