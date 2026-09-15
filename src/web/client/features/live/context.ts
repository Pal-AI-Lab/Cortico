/** 使用运行时 token 估算口径，将标准 Item 按显示类别汇总。 */

import { itemText, type ContextRecord } from '../../../../protocol/open-responses/context.ts';
import type { ConsoleUi } from '../../../shared/client-panel.ts';
import { estimateMessagesTokens } from '../../../../protocol/open-responses/tokens.ts';
import {
  contextOf,
  loopOf,
  type StatusSnapshot,
  type ToolSchemaDoc,
} from './protocol.ts';
import { S } from './strings.ts';

/**
 * 字数 → token 估算。与服务端 `estimateTokens` 同一口径:中日韩与全角标点按 0.6,
 * 其余按 0.3。**不是账单**,只求与截断判据同源。
 */
export function estTok(text: unknown): number {
  let cjk = 0;
  let other = 0;
  for (const ch of String(text ?? '')) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x30ff) || (c >= 0xff00 && c <= 0xffef)) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk * 0.6 + other * 0.3);
}

/** 一个 JSON 值折算成 token(工具参数、工具表 schema 都这么算)。 */
export function jsonTok(v: unknown): number {
  return v ? estTok(JSON.stringify(v)) : 0;
}

/** 分类词表。`color` 直接取主题里的图表色变量,随主题走。 */
export interface ContextCategoryDef {
  key: string;
  group: string;
  label: string;
  color: string;
}

const CTX_CATS: readonly ContextCategoryDef[] = [
  { key: 'orient', group: S.groupPrefix, label: S.catOrient, color: 'var(--chart-1)' },
  { key: 'constitution', group: S.groupPrefix, label: S.catConstitution, color: 'var(--chart-5)' },
  { key: 'env', group: S.groupPrefix, label: S.catEnv, color: 'var(--chart-miss)' },
  { key: 'toolsUsage', group: S.groupPrefix, label: S.catToolsUsage, color: 'var(--chart-3)' },
  { key: 'memory', group: S.groupPrefix, label: S.catMemory, color: 'var(--chart-6)' },
  { key: 'prefixMisc', group: S.groupPrefix, label: S.catPrefixMisc, color: 'var(--chart-7)' },
  { key: 'toolsSchema', group: S.groupTools, label: S.catToolsSchema, color: 'var(--chart-hit)' },
  { key: 'head', group: S.groupDialogue, label: S.catHead, color: 'var(--chart-8)' },
  { key: 'reasoning', group: S.groupDialogue, label: S.catReasoning, color: 'var(--chart-3)' },
  { key: 'dialogue', group: S.groupDialogue, label: S.catDialogue, color: 'var(--chart-2)' },
  { key: 'toolIO', group: S.groupDialogue, label: S.catToolIO, color: 'var(--chart-4)' },
];

const CTX_GROUPS: readonly string[] = [S.groupPrefix, S.groupTools, S.groupDialogue];

/** 按 ━━━ 段名 ━━━ 拆分前缀；未匹配的文本归入前言。上下文与提示词页共用。 */
export function parsePrefixSegments(systemText: string): Record<string, string> {
  const map: Record<string, string> = {};
  if (!systemText) return map;
  for (const part of systemText.split(/(?=━━━ .+? ━━━)/)) {
    const m = part.match(/━━━ (.+?) ━━━/);
    const title = m ? m[1].trim() : '(前言)';
    map[title] = part.replace(/━━━ .+? ━━━/, '').trim();
  }
  return map;
}

/** 消息里第一条 system 的正文(没有就是空串)。 */
function systemTextOf(messages: readonly ContextRecord[]): string {
  const first = messages[0];
  return first?.item.type === 'message' && first.item.role === 'system' ? itemText(first.item) : '';
}

export interface ContextCategory extends ContextCategoryDef {
  tok: number;
}

export interface ContextBreakdown {
  /** 分类占用,按 core 报的总数等比缩放(上游只给总数,分类只能本地估) */
  cats: ContextCategory[];
  /** core 报的下一次请求输入数;没报时本地估算之和 */
  total: number;
  /** total 里上游数过的部分;0 = 整份估算 */
  countedTokens: number;
  /** 圈的分母:Persona的阶段预算,没报时模型物理上限;两者都没有则 null */
  maxTokens: number | null;
  /** 软预警线比例;Persona没报则 null(不画黄线) */
  softRatio: number | null;
  keepOn: boolean;
  /** 摘除历史思维链省掉的量(只用于脚注) */
  strippedThinking: number;
  /** 工具表里有几个工具(脚注里印) */
  toolCount: number;
}

export interface ContextInput {
  messages: readonly ContextRecord[];
  /** messages 之外的合成开头；估算包含其 reasoning，不应用历史思维链摘除规则。 */
  head?: readonly ContextRecord[];
  toolSchemas: readonly ToolSchemaDoc[];
  status: StatusSnapshot | null;
}

/** 每条消息的结构开销,与服务端 `estimateMessagesTokens` 一致。 */
const PER_MESSAGE_OVERHEAD = 8;

/** 分类占用。没有消息时返回 null(调试通道还没连上,不是"占用为 0")。 */
export function computeCtx(input: ContextInput): ContextBreakdown | null {
  const msgs = input.messages;
  if (!msgs.length) return null;
  const cx = contextOf(input.status);
  const maxTokens = cx.maxTokens ?? cx.hardTokens ?? null;
  const softRatio = cx.softRatio ?? null;
  const keepOn = cx.keepPastThinking !== false;
  const tok: Record<string, number> = {};
  for (const c of CTX_CATS) tok[c.key] = 0;

  // 1) 系统前缀按段拆;prefixMisc 兜住分隔线、前言与结构开销。
  const sys = systemTextOf(msgs);
  if (msgs[0].item.type === 'message' && msgs[0].item.role === 'system') {
    const seg = parsePrefixSegments(sys);
    tok.orient = estTok(seg['ORIENTATION'] || '');
    tok.constitution = estTok(seg['宪法'] || '');
    tok.toolsUsage = estTok(seg['Using your tools'] || '');
    tok.memory = estTok(seg['记忆'] || '');
    for (const k of Object.keys(seg)) if (/^环境/.test(k)) tok.env += estTok(seg[k]);
    const sysTotal = PER_MESSAGE_OVERHEAD + estTok(sys);
    tok.prefixMisc = Math.max(
      0,
      sysTotal - tok.orient - tok.constitution - tok.env - tok.toolsUsage - tok.memory,
    );
  }

  // 合成开头单独计入估算，包含其中的 reasoning。
  for (const m of input.head ?? []) {
    tok.head += estimateMessagesTokens([m]);
  }

  // 2) 工具表 schema:作为 tools 参数随每次调用发送,与消息分开计。
  tok.toolsSchema = input.toolSchemas.reduce(
    (s, t) => s + estTok(t.name) + estTok(t.description) + jsonTok(t.parameters),
    0,
  );

  const first = msgs[0].item;
  const rest = first.type === 'message' && first.role === 'system' ? msgs.slice(1) : msgs;
  let strippedThinking = 0;
  for (const entry of rest) {
    const tokens = estimateMessagesTokens([entry]);
    if (entry.context.head) tok.head += tokens;
    else if (entry.item.type === 'reasoning') {
      if (keepOn) tok.reasoning += tokens;
      else strippedThinking += tokens;
    } else if (entry.item.type === 'function_call' || entry.item.type === 'function_call_output') {
      tok.toolIO += tokens;
    } else tok.dialogue += tokens;
  }

  const local = CTX_CATS.map((c) => ({ ...c, tok: tok[c.key] }));
  const localTotal = local.reduce((s, c) => s + c.tok, 0);
  const reported = loopOf(input.status).estTokens;
  const total = typeof reported === 'number' ? reported : localTotal;
  const scale = localTotal > 0 ? total / localTotal : 0;
  const cats: ContextCategory[] = local.map((c) => ({ ...c, tok: Math.round(c.tok * scale) }));
  return {
    cats,
    total,
    countedTokens: cx.countedTokens ?? 0,
    maxTokens,
    softRatio,
    keepOn,
    strippedThinking,
    toolCount: input.toolSchemas.length,
  };
}

// ---------------------------------------------------------------------------
// 画面
// ---------------------------------------------------------------------------

/** 一行脚注:纯文本片段与要加粗的片段交替。 */
function footLine(ui: ConsoleUi, parts: readonly (string | { b: string })[]): HTMLDivElement {
  const line = ui.h('div');
  line.appendChild(ui.h('span', null, '· '));
  for (const p of parts) {
    if (typeof p === 'string') line.appendChild(ui.h('span', null, p));
    else line.appendChild(ui.h('b', null, p.b));
  }
  return line;
}

/**
 * 分类分布面板。定位由终端输入器里的 `.ctxanchor` 提供。
 */
export function buildCtxPanel(ui: ConsoleUi, d: ContextBreakdown | null): HTMLElement {
  const box = ui.h('div', 'ctxpanel');
  if (!d || !d.total) {
    box.appendChild(ui.h('div', 'cx-sub', S.ctxNone));
    return box;
  }
  const head = ui.h('div', 'cx-head');
  head.appendChild(ui.h('div', 'cx-title', S.ctxUsage));
  const total = ui.h('div', 'cx-total');
  total.appendChild(ui.h('b', null, `${d.countedTokens > 0 ? '' : '~'}${ui.fmt.count(d.total)}`));
  total.appendChild(ui.h('span', null, d.maxTokens === null ? ' tok' : ` / ${ui.fmt.count(d.maxTokens)} tok`));
  head.appendChild(total);
  box.appendChild(head);
  box.appendChild(
    ui.h(
      'div',
      'cx-sub',
      S.ctxSub(d.maxTokens === null ? null : ui.fmt.percent(d.total / d.maxTokens), d.keepOn),
    ),
  );

  const bar = ui.h('div', 'cx-bar');
  for (const c of d.cats) {
    if (c.tok <= 0) continue;
    const sp = ui.h('span');
    sp.setAttribute('style', `width:${(c.tok / d.total) * 100}%;background:${c.color}`);
    sp.title = `${c.label} · ${ui.fmt.count(c.tok)}`;
    bar.appendChild(sp);
  }
  box.appendChild(bar);

  for (const g of CTX_GROUPS) {
    const inG = d.cats.filter((c) => c.group === g && c.tok > 0);
    if (!inG.length) continue;
    box.appendChild(ui.h('div', 'cx-grp', g));
    for (const c of inG) {
      const row = ui.h('div', 'cx-row');
      const sw = ui.h('span', 'cx-sw');
      sw.setAttribute('style', `background:${c.color}`);
      row.appendChild(sw);
      const lbl = ui.h('span', 'cx-lbl', c.label);
      if (c.key === 'toolsSchema') lbl.appendChild(ui.h('span', 'cx-note', S.toolCount(d.toolCount)));
      row.appendChild(lbl);
      row.appendChild(ui.h('span', 'cx-pctcol', ui.fmt.percent(c.tok / d.total)));
      row.appendChild(ui.h('span', 'cx-val', ui.fmt.count(c.tok)));
      box.appendChild(row);
    }
  }

  const foot = ui.h('div', 'cx-foot');
  foot.appendChild(
    footLine(
      ui,
      d.countedTokens > 0
        ? [S.footCountedPre, { b: ui.fmt.count(d.countedTokens) }, S.footCountedPost]
        : [S.footEstimated],
    ),
  );
  foot.appendChild(footLine(ui, [{ b: S.footSchemaB }, S.footSchemaPost]));
  if (!d.keepOn && d.strippedThinking > 0) {
    foot.appendChild(
      footLine(ui, [
        S.footStrippedPre,
        { b: ui.fmt.count(d.strippedThinking) },
        S.footStrippedPost,
      ]),
    );
  }
  if (d.maxTokens !== null) {
    foot.appendChild(
      footLine(
        ui,
        d.softRatio === null
          ? [S.footHardPre, { b: ui.fmt.count(d.maxTokens) }, S.footHardPost]
          : [S.footSoftPre, { b: ui.fmt.count(Math.round(d.maxTokens * d.softRatio)) }, S.footSoftPost(ui.fmt.count(d.maxTokens))],
      ),
    );
  }
  box.appendChild(foot);
  return box;
}
