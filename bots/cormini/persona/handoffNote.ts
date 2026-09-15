/**
 * 将交接前的 session 消息渲染为纯文本笔记，不做 I/O；变体措辞由 handoffNoteLines 提供。
 * 收录 user 消息、事件帧、工具入参与回执；speak 类调用仅保留最近段，flow 类调用、
 * assistant 正文、思维链和上一份交接笔记不收录。完成状态以回执和后续事件为准。
 * snapshot 事件按 source/type、snapshot 工具按名称保留最后一次；相同条目合并并计数。
 * FrameEventRef 将帧拆为事件，时间取入库 ts 并按分钟分组；旧记录缺 ts 时不标时间，
 * 缺 sidecar 时整帧作为一条。
 * 最近段 speak 使用 foldTokens；其他条目按年龄折叠：最近四分之一给满预算，
 * 再往前四分之一给四分之一预算，更早条目只留开头。由近到远装入 budgetTokens，
 * 超出的早期条目只记录数量。按软阈值分成历史与最近两段，分别投递并标明时间范围。
 */
import { RESERVED_FRAME_NAMES } from 'cortico/core/loop.ts';
import { EVENT_FRAME_HEADER_RE } from 'cortico/core/markers.ts';
import type { ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { hasRole, textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import { estimateTokens } from 'cortico/core/util.ts';

/** 交接笔记自己的事件 type:投递用它,渲染时按它跳过上一份笔记 */
export const HANDOFF_NOTE_TYPE = 'handoff-note';
/** 没拿到预算时整份笔记的兜底 */
export const HANDOFF_NOTE_TOKENS = 4096;
/** 最近那批条目的单条预算,更早的按年龄衰减 */
export const HANDOFF_FOLD_TOKENS = 1024;

export interface HandoffNoteOptions {
  /** speak 类工具名(core 按 'speak' tag 现场给) */
  speechTools: ReadonlySet<string>;
  /** flow 类工具名:整类不进笔记 */
  flowTools?: ReadonlySet<string>;
  /** snapshot 类工具名:同名只留最后一次 */
  snapshotTools?: ReadonlySet<string>;
  /** 笔记落款的时刻 */
  now: Date;
  budgetTokens?: number;
  foldTokens?: number;
  /** 软阈值(epoch ms):不早于它的是最近段;缺失时整份算最近段。有分界但无 ts 的条目归早段。 */
  splitAtMs?: number | null;
}

export interface HandoffNotePart {
  /** 投递用的正文(自带小标题与时间范围) */
  text: string;
  entries: number;
}

export interface HandoffNote {
  /** 存档用的全文(各段拼一起) */
  text: string;
  /** 投递用的非空分段:更早的历史 + 当前语境;空笔记只保留最近段说明 */
  parts: HandoffNotePart[];
  /** 进了笔记的条目数 */
  entries: number;
  /** 因预算没进笔记的更早条目数 */
  dropped: number;
}

interface Entry {
  speech?: boolean;
  ts?: string;
  /** 状态类去重键 */
  key?: string;
  /** 调用类:工具名与入参;事件类没有 */
  call?: { name: string; args: string };
  /** 调用回执,或事件正文 */
  body: string;
  /** 逐字重复合并后的次数 */
  repeats?: number;
}

/** 文件名用的 UTC 时间戳:冒号在 Windows 上不能进文件名,换成横线。 */
export function handoffNoteStamp(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

/** 超过预算的文本只留开头,尾部换成一行痕迹。 */
export function foldToBudget(text: string, budgetTokens: number): string {
  const total = estimateTokens(text);
  if (total <= budgetTokens) return text;
  const keepChars = Math.max(0, Math.floor(text.length * budgetTokens / total));
  return `${text.slice(0, keepChars)}\n…[后面约 ${total - budgetTokens} token 已折叠]`;
}

/** 入库 ISO(config 时区)→「HH:MM」;认不出形状就没有分段标题 */
function minuteOf(ts: string | undefined): string | null {
  if (!ts) return null;
  const m = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/.exec(ts);
  return m ? m[1] : null;
}

/**
 * 单条的折叠预算随年龄衰减:最近四分之一给满,再往前四分之一给四分之一,更早的只留个头。
 * age 是从最新往回数的序号(1 = 最新一条)。
 */
function capFor(age: number, total: number, fold: number): number {
  if (age - 1 < total / 4) return fold;
  if (age - 1 < total / 2) return Math.max(64, Math.round(fold / 4));
  return Math.max(48, Math.round(fold / 16));
}

function renderEntry(e: Entry, cap: number): string {
  const repeat = e.repeats && e.repeats > 1 ? `(同样的一条重复了 ${e.repeats} 次,只留这一次)\n` : '';
  if (!e.call) return `${repeat}${foldToBudget(e.body, cap)}`;
  const args = e.call.args && e.call.args !== '{}' ? ` ${foldToBudget(e.call.args, cap)}` : '';
  return `${repeat}[调用] ${e.call.name}${args}\n[回执] ${foldToBudget(e.body, cap)}`;
}

/**
 * 一条投递消息拆成条目:有 sidecar 就按位置切回逐条事件(帧的表头行不要),事件块之前
 * 的内部行算一条;没有 sidecar 整条算一条。上一份交接笔记跳过。
 */
function deliveryEntries(m: ContextRecord, skipHeader: boolean): Entry[] {
  const refs = m.context.frame?.events;
  if (!refs?.length) {
    const text = skipHeader ? textOf(m).replace(EVENT_FRAME_HEADER_RE, '') : textOf(m);
    return text.trim() ? [{ body: text, ts: m.context.ts }] : [];
  }
  const out: Entry[] = [];
  const first = refs[0].start;
  if (!skipHeader && first > 0) {
    const head = textOf(m).slice(0, first - 1);
    if (head.trim()) out.push({ body: head, ts: m.context.ts });
  }
  for (const r of refs) {
    if (r.type === HANDOFF_NOTE_TYPE) continue;
    const text = textOf(m).slice(r.start, r.start + r.chars);
    if (!text.trim()) continue;
    const entry: Entry = { body: text, ts: r.ts, speech: r.tags?.includes('speak') };
    if (r.tags?.includes('snapshot')) entry.key = `event:${r.source}/${r.type}`;
    out.push(entry);
  }
  return out;
}

/** 按分钟分段渲染一串条目 */
function renderSection(entries: Entry[], caps: number[]): string {
  const out: string[] = [];
  let minute: string | null = null;
  entries.forEach((e, i) => {
    const m = minuteOf(e.ts);
    if (m !== null && m !== minute) {
      minute = m;
      out.push(`## ${m}`);
    }
    out.push(renderEntry(e, caps[i]));
  });
  return out.join('\n\n');
}

function rangeOf(entries: Entry[]): string {
  const stamps = entries.map((e) => minuteOf(e.ts)).filter((m): m is string => m !== null);
  if (stamps.length === 0) return '';
  return stamps[0] === stamps[stamps.length - 1] ? stamps[0] : `${stamps[0]}–${stamps[stamps.length - 1]}`;
}

export function renderHandoffNote(snapshot: readonly ContextRecord[], opts: HandoffNoteOptions): HandoffNote {
  const budget = opts.budgetTokens ?? HANDOFF_NOTE_TOKENS;
  const fold = opts.foldTokens ?? HANDOFF_FOLD_TOKENS;
  const flow = opts.flowTools ?? new Set<string>();
  const snapshots = opts.snapshotTools ?? new Set<string>();
  const splitAt = opts.splitAtMs ?? null;
  const isCurrent = (e: Entry): boolean =>
    splitAt === null || (e.ts !== undefined && Date.parse(e.ts) >= splitAt);
  const results = new Map<string, ContextRecord>();
  for (const m of snapshot) {
    if (m.item.type === 'function_call_output') results.set(m.item.call_id, m);
  }

  const collected: Entry[] = [];
  for (const m of snapshot) {
    if (hasRole(m, 'system') || m.context.head || m.context.ephemeral) continue;
    if (hasRole(m, 'user')) {
      collected.push(...deliveryEntries(m, false));
      continue;
    }
    if (m.item.type !== 'function_call') continue;
    {
      const call = m.item;
      const name = call.name;
      if (flow.has(name)) continue;
      const receipt = results.get(call.call_id);
      if (RESERVED_FRAME_NAMES.has(name)) {
        if (receipt) collected.push(...deliveryEntries(receipt, true));
        continue;
      }
      const entry: Entry = {
        ts: m.context.ts,
        call: { name, args: call.arguments.trim() },
        body: receipt === undefined ? '(还没回来)' : textOf(receipt),
      };
      // 先按原始时间筛选台词,预算裁剪不能把早段重新解释成最近段。
      if (opts.speechTools.has(name)) {
        if (!isCurrent(entry)) continue;
      } else if (snapshots.has(name)) entry.key = `tool:${name}`;
      collected.push(entry);
    }
  }

  // 状态类只留最后一次;逐字相同的也只留最后一次,并把次数记在那一条上
  const eligible = collected.filter(e => !e.speech || isCurrent(e));
  const dupKey = (e: Entry): string => (e.call ? `${e.call.name}\0${e.call.args}\0${e.body}` : e.body);
  const counts = new Map<string, number>();
  for (const e of eligible) counts.set(dupKey(e), (counts.get(dupKey(e)) ?? 0) + 1);
  const lastAt = new Map<string, number>();
  eligible.forEach((e, i) => {
    if (e.key) lastAt.set(e.key, i);
    lastAt.set(`dup:${dupKey(e)}`, i);
  });
  const entries = eligible.filter((e, i) => {
    if (e.key && lastAt.get(e.key) !== i) return false;
    if (lastAt.get(`dup:${dupKey(e)}`) !== i) return false;
    const n = counts.get(dupKey(e)) ?? 1;
    if (n > 1) e.repeats = n;
    return true;
  });

  // 折叠预算按年龄衰减,再从最近一条往前装到整份预算为止
  const caps = entries.map((e, i) => (e.speech || (e.call && opts.speechTools.has(e.call.name)))
    ? fold
    : capFor(entries.length - i, entries.length, fold));
  const sizes = entries.map((e, i) => estimateTokens(renderEntry(e, caps[i])) + 4);
  const overhead = 160; // 为两段标题、时间范围及省略计数预留预算。
  let used = overhead;
  let start = entries.length;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (used + sizes[i] > budget && start < entries.length) break;
    used += sizes[i];
    start = i;
  }
  const kept = entries.slice(start);
  const keptCaps = caps.slice(start);
  const dropped = start;

  const history: Entry[] = [];
  const current: Entry[] = [];
  const historyCaps: number[] = [];
  const currentCaps: number[] = [];
  kept.forEach((e, i) => {
    if (isCurrent(e)) {
      current.push(e);
      currentCaps.push(keptCaps[i]);
    } else {
      history.push(e);
      historyCaps.push(keptCaps[i]);
    }
  });

  // 「现在」的钟点跟着条目自己的时间走(config 时区),不用本机时区重新算一遍。
  const lastClock = [...current].reverse().map((e) => minuteOf(e.ts)).find((m) => m !== null) ?? null;
  const common = '同一项状态读数只留了最后一次,更早的长回执只留了个头。';
  const omitted = dropped > 0 ? `更早的 ${dropped} 条没进这份笔记。` : '';
  // 衔接规则由 handoffNoteLines 提供；段标题只描述时间、收录内容和省略项。
  const parts: HandoffNotePart[] = [];
  if (history.length > 0) {
    const range = rangeOf(history);
    parts.push({
      text:
        `# 交接笔记 · 更早的一段${range ? `(${range})` : ''}\n\n` +
        '这一段已经过去了,只作参考。里面是外来事件和工具调用与回执,对外发言类调用已整条省略。' +
        `${common}\n` +
        (omitted ? `${omitted}\n` : '') +
        `\n${renderSection(history, historyCaps)}\n`,
      entries: history.length,
    });
  }
  const curRange = rangeOf(current);
  if (current.length > 0 || history.length === 0) parts.push({
    text:
      `# 交接笔记 · 最近的一段${curRange ? `(${curRange})` : ''}\n\n` +
      `这一段紧接着现在${lastClock ? `,最后一条是 ${lastClock} 的事` : ''}。` +
      '这里保留对外发言类调用的具体入参与实际回执。' +
      `${common}\n` +
      (history.length === 0 && omitted ? `${omitted}\n` : '') +
      `\n${renderSection(current, currentCaps)}\n`,
    entries: current.length,
  });

  return {
    text: `${parts.map((p) => p.text).join('\n')}`,
    parts,
    entries: kept.length,
    dropped,
  };
}
