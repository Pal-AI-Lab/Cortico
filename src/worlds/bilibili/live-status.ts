/**
 * 直播间实时战况:Minecraft 死亡计数与目标表(从事件库读)、弹幕投票。
 *
 * 跨 World 没有订阅机制,只有共用的事件库;这里按游标增量扫 source=minecraft 的事件,
 * 只认带结构化 meta 的两种:`meta.event === 'death'`(minecraft.event)与
 * `meta.event === 'goals'`(minecraft.goals,只归档)。正文不解析 —— 正文是给她读的。
 *
 * 状态只在内存里。重启后死亡数要等下一次死亡才补齐,目标要等下一次 mc_goal 写入;
 * 启动时会回看一段事件库把最近一次的读数捡回来,补上这个空窗。
 */
import type { EventEnvelope, EventStoreReader } from '../../core/types.ts';
import type { LivePollState, LiveStatusGoal, LiveStatusState, OverlayToast } from './overlay/types.ts';

/** 启动时回看多少条事件找最近的死亡与目标读数 */
const BACKFILL_EVENTS = 2000;

export interface PollOpenSpec {
  question: string;
  options: string[];
  durationSec: number;
}

export interface PollResult {
  question: string;
  options: Array<{ key: string; label: string; votes: number }>;
  voters: number;
  winners: string[];
}

export class LiveBoard {
  private cursor = 0;
  private state: LiveStatusState = { deaths: null, goals: [], poll: null };
  /** uid(或匿名时的昵称) → 选项键;一人一票,改票以最后一次为准 */
  private ballots = new Map<string, string>();
  private pollSeq = 0;

  constructor(private readonly hooks: {
    changed: (state: LiveStatusState) => void;
    toast: (toast: OverlayToast) => void;
  }) {}

  get current(): LiveStatusState {
    return structuredClone(this.state);
  }

  /** 启动或重连时调用:游标置到事件库末尾,回看一段捡回最近读数 */
  attach(store: EventStoreReader): void {
    const latest = store.latestCursor();
    const from = Math.max(1, latest - BACKFILL_EVENTS + 1);
    let deaths: LiveStatusState['deaths'] = null;
    let goals: LiveStatusGoal[] | null = null;
    for (const e of store.range({ source: 'minecraft', fromCursor: from })) {
      deaths = deathOf(e) ?? deaths;
      goals = goalsOf(e) ?? goals;
    }
    this.cursor = latest;
    if (deaths) this.state.deaths = deaths;
    if (goals) this.state.goals = goals;
    if (deaths || goals) this.hooks.changed(this.current);
  }

  /** 增量扫一次:新到的死亡弹窗,目标表变化刷新战况 */
  poll(store: EventStoreReader): void {
    const latest = store.latestCursor();
    if (latest <= this.cursor) return;
    const events = store.range({ source: 'minecraft', fromCursor: this.cursor + 1, toCursor: latest });
    this.cursor = latest;
    let changed = false;
    for (const e of events) {
      const death = deathOf(e);
      if (death) {
        this.state.deaths = death;
        changed = true;
        this.hooks.toast({
          kind: 'death',
          title: `羽书阵亡 · 今日第 ${death.today} 次`,
          body: death.lastCause ? `死因:${death.lastCause}` : '死因不明',
        });
      }
      const goals = goalsOf(e);
      if (goals) {
        this.state.goals = goals;
        changed = true;
      }
    }
    if (changed) this.hooks.changed(this.current);
  }

  openPoll(spec: PollOpenSpec, now = Date.now()): LivePollState {
    if (this.state.poll && this.state.poll.closedAt === null) {
      throw new Error(`上一个投票「${this.state.poll.question}」还没结束;先用 action:"close" 结束它`);
    }
    const question = spec.question.trim();
    if (!question) throw new Error('question 不能为空');
    const labels = spec.options.map((o) => o.trim()).filter(Boolean);
    if (labels.length < 2 || labels.length > 6) throw new Error('options 要 2 到 6 个非空选项');
    const duration = Math.round(spec.durationSec);
    if (!Number.isFinite(duration) || duration < 15 || duration > 600) throw new Error('durationSec 要在 15 到 600 秒之间');
    this.ballots.clear();
    this.state.poll = {
      id: ++this.pollSeq,
      question: question.slice(0, 60),
      options: labels.map((label, i) => ({ key: String(i + 1), label: label.slice(0, 20), votes: 0 })),
      endsAt: now + duration * 1000,
      closedAt: null,
      voters: 0,
    };
    this.hooks.changed(this.current);
    return structuredClone(this.state.poll);
  }

  /**
   * 弹幕计票。只认整条弹幕就是一个选项号(「1」「２」「选1」「投 2」),
   * 聊天里顺带出现的数字不算票。返回是否计入(用于决定这条弹幕还要不要进上下文)。
   */
  vote(voter: string, body: string, now = Date.now()): boolean {
    const poll = this.state.poll;
    if (!poll || poll.closedAt !== null || now >= poll.endsAt) return false;
    const key = ballotKey(body);
    if (!key || !poll.options.some((o) => o.key === key)) return false;
    this.ballots.set(voter, key);
    for (const option of poll.options) option.votes = 0;
    for (const choice of this.ballots.values()) {
      const option = poll.options.find((o) => o.key === choice);
      if (option) option.votes += 1;
    }
    poll.voters = this.ballots.size;
    this.hooks.changed(this.current);
    return true;
  }

  /** 到点或手动结束;没有进行中的投票返回 null */
  closePoll(now = Date.now()): PollResult | null {
    const poll = this.state.poll;
    if (!poll || poll.closedAt !== null) return null;
    poll.closedAt = now;
    const top = Math.max(0, ...poll.options.map((o) => o.votes));
    const winners = top === 0 ? [] : poll.options.filter((o) => o.votes === top).map((o) => o.label);
    this.hooks.changed(this.current);
    this.hooks.toast({
      kind: 'poll',
      title: '投票结束',
      body: winners.length === 0 ? `「${poll.question}」没人投票` : `「${poll.question}」:${winners.join(' / ')} 胜出`,
    });
    return {
      question: poll.question,
      options: poll.options.map((o) => ({ ...o })),
      voters: poll.voters,
      winners,
    };
  }

  /** 投票到点了吗(进行中且过了截止) */
  pollDue(now = Date.now()): boolean {
    const poll = this.state.poll;
    return poll !== null && poll.closedAt === null && now >= poll.endsAt;
  }

  /** 结果展示期过了就把投票从叠加层撤下 */
  expirePoll(holdMs: number, now = Date.now()): void {
    const poll = this.state.poll;
    if (poll?.closedAt != null && now - poll.closedAt >= holdMs) {
      this.state.poll = null;
      this.hooks.changed(this.current);
    }
  }
}

/** 投票结果 → 给她的事件正文 */
export function renderPollResult(r: PollResult): string {
  const tally = r.options.map((o) => `${o.key}.${o.label} ${o.votes} 票`).join('、');
  const verdict = r.winners.length === 0
    ? '没人投票,按你自己的判断来'
    : r.winners.length === 1 ? `「${r.winners[0]}」胜出` : `平票:${r.winners.join(' / ')},你来定`;
  return `[投票结束] ${r.question}:${tally}(${r.voters} 人投票),${verdict}`;
}

const FULLWIDTH_DIGITS = '０１２３４５６７８９';

function ballotKey(body: string): string | null {
  const s = body.trim().replace(/[０-９]/g, (d) => String(FULLWIDTH_DIGITS.indexOf(d)));
  const m = /^(?:选|投|投票|vote)?\s*([1-6])\s*[号!！。.]?$/i.exec(s);
  return m ? m[1] : null;
}

function metaOf(e: EventEnvelope): Record<string, unknown> | null {
  return e.meta && typeof e.meta === 'object' ? e.meta : null;
}

function deathOf(e: EventEnvelope): LiveStatusState['deaths'] {
  const m = metaOf(e);
  if (m?.event !== 'death' || typeof m.today !== 'number' || typeof m.total !== 'number') return null;
  return { today: m.today, total: m.total, lastCause: typeof m.cause === 'string' ? m.cause : null };
}

function goalsOf(e: EventEnvelope): LiveStatusGoal[] | null {
  const m = metaOf(e);
  if (m?.event !== 'goals' || !Array.isArray(m.goals)) return null;
  return (m.goals as unknown[]).flatMap((raw) => {
    const g = raw as Record<string, unknown>;
    if (typeof g?.slot !== 'number' || typeof g.text !== 'string') return [];
    const ms = (g.milestones ?? {}) as Record<string, unknown>;
    return [{
      slot: g.slot,
      text: g.text,
      progress: (g.progress as LiveStatusGoal['progress']) ?? null,
      milestones: {
        done: typeof ms.done === 'number' ? ms.done : 0,
        total: typeof ms.total === 'number' ? ms.total : 0,
      },
      next: typeof g.next === 'string' ? g.next : null,
    }];
  });
}
