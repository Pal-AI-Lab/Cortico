/**
 * 按标准 Open Responses Item 渲染 session 时间线。
 * 连续的同 responseId assistant 侧 Item 合为一组；无 responseId 的连续 Item 也合组，
 * 回执或输入结束当前组。function_call_output 按 call_id 回填，未匹配时单独显示。
 * 原始 Item 包含 phase、status 与加密载荷；明文计字数，加密载荷计字符数。
 * #n 对应 session 记录 index；合成开头不落盘且无序号。
 * 打字机由 lifecycle.frame 管理，监听使用 signal，滚动保持由 shouldStick 判断。
 */

import type { ConsoleUi, Disposable } from '../../../shared/client-panel.ts';
import type { Lifecycle } from '../../core/lifecycle.ts';
import { shouldStick } from '../../ui/index.ts';
import { estTok } from './context.ts';
import { S } from './strings.ts';
import type { ContextRecord, Item } from '../../../../protocol/open-responses/context.ts';

/** 距底部在此像素阈值以内时保持尾部粘滞。 */
const STICK_PX = 60;
/** 超过这个长度的正文折起来,折叠行只印字数。 */
const FOLD_CHARS = 500;
/** 打字机每帧推进的字数。 */
const TYPE_CHARS_PER_FRAME = 8;
/** 事件投递帧的工具名(与 core/loop.ts 的 EXTERNAL_EVENT_FRAME 同名;那边不对浏览器包导出)。 */
const EXTERNAL_EVENT_FRAME = 'external_event_frame';
/** bot 头像。不带缓存破坏参数:一条时间线上几十个组共用同一份缓存。 */
const AVATAR_URL = '/api/avatar';

function toggleClass(el: HTMLElement, cls: string, on: boolean): void {
  const set = new Set(el.className.split(' ').filter((s) => s !== ''));
  if (on) set.add(cls);
  else set.delete(cls);
  el.className = [...set].join(' ');
}

type MessageItem = Extract<Item, { type: 'message' }>;
type ReasoningItem = Extract<Item, { type: 'reasoning' }>;
type CallItem = Extract<Item, { type: 'function_call' }>;
type OutputItem = Extract<Item, { type: 'function_call_output' }>;

/** 文本原样显示，其他内容部件显示类型标记。 */
function partsText(content: MessageItem['content'] | OutputItem['output']): string {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    const p = part as { type?: string; text?: string; refusal?: string };
    if (typeof p.text === 'string') return p.text;
    if (typeof p.refusal === 'string') return p.refusal;
    return `[${p.type ?? 'part'}]`;
  }).join('\n');
}

function isAssistantSide(item: Item): boolean {
  return item.type === 'reasoning' || item.type === 'function_call'
    || (item.type === 'message' && item.role === 'assistant');
}

function isPrefix(item: Item): boolean {
  return item.type === 'message' && (item.role === 'system' || item.role === 'developer');
}

function isEventFrame(item: Item): boolean {
  return item.type === 'function_call' && item.name === EXTERNAL_EVENT_FRAME;
}

interface Turn {
  responseId: string;
  grp: HTMLElement;
  body: HTMLElement;
  status: HTMLElement;
  entries: ContextRecord[];
}

/** 合成首轮的 Item 没有 session 序号。 */
type Ordinal = number | null;

export interface TimelineDeps {
  ui: ConsoleUi;
  lifecycle: Lifecycle;
  signal: AbortSignal;
}

export interface TimelineView {
  el: HTMLElement;
  /**
   * 整份重画。`note` 是顶上一条分隔说明,`banner` 是置顶横幅(fork 视图用)。
   *
   * `keepScroll` 给轮询用:用户正往上翻历史时,一次例行重画不该把他弹回底部。
   */
  rebuild(
    messages: readonly ContextRecord[],
    opts?: {
      note?: string | null;
      banner?: HTMLElement | null;
      empty?: string;
      keepScroll?: boolean;
      /** 合成开头显示在开头 system 之后；空数组或未提供时不显示。 */
      head?: readonly ContextRecord[] | null;
    },
  ): void;
  /** 追加一条(实时帧)。`live` 决定要不要动画与打字机。 */
  append(m: ContextRecord, index: number, live: boolean): void;
  /** 说话人展示名。头像图片加载不到时,ASSISTANT 组左栏的占位圆里印它的首字;下一次画到组时生效。 */
  setSpeaker(name: string): void;
  /** 开场引导期间把系统前缀那张卡收起来，下一次重画生效。 */
  setHideSystem(hide: boolean): void;
  /** 在滚动区顶部挂一块外部内容，随时间线一起滚；传 null 取下。重画不动它。 */
  setHeader(node: HTMLElement | null): void;
}

export function createTimeline(deps: TimelineDeps): TimelineView {
  const { ui, lifecycle, signal } = deps;

  const el = ui.h('div', 'tlwrap');
  const scroll = ui.h('div', 'tlscroll');
  const inner = ui.h('div', 'tlinner');
  scroll.appendChild(inner);
  const think = ui.h('div', 'tlthink hidden');
  think.append(ui.h('span', 'pulse'), ui.h('span', null, S.thinking));
  const jump = ui.button(S.jumpBottom, {
    size: 'sm',
    onClick: () => {
      autoScroll = true;
      stick(true);
    },
  });
  jump.className = 'btn sm tljump hidden';
  el.append(scroll, think, jump);

  /** call_id → 那颗卡上等结果的槽位。每次重画清空。 */
  const toolCalls = new Map<string, HTMLElement>();
  /** 正在往里添 Item 的那个 ASSISTANT 组。任何非 assistant 侧的 Item 都会结束它。 */
  let turn: Turn | null = null;
  /** 头像占位圆里的字。 */
  let speakerInitial = 'B';
  /** 收起系统前缀卡。 */
  let hideSystem = false;
  /** 挂在滚动区顶部的外部内容（开场引导）。 */
  let header: HTMLElement | null = null;
  let autoScroll = true;
  /** 正在跑的打字机。重画时全部收掉——否则它们会往脱离文档的节点里继续写。 */
  const typing = new Set<Disposable>();

  const stick = (force?: boolean): void => {
    if (autoScroll || force) scroll.scrollTop = scroll.scrollHeight;
  };

  scroll.addEventListener(
    'scroll',
    () => {
      autoScroll = shouldStick(scroll.scrollTop, scroll.scrollHeight, scroll.clientHeight, STICK_PX);
      toggleClass(jump, 'hidden', autoScroll);
    },
    { signal },
  );

  const stopTyping = (): void => {
    for (const t of [...typing]) t.dispose();
    typing.clear();
  };

  /** 打字机点击后立即完成；帧句柄由 lifecycle 管理。 */
  const typewriter = (target: HTMLElement, text: string): void => {
    toggleClass(target, 'typing', true);
    let i = 0;
    let handle: Disposable | null = null;
    const finish = (): void => {
      target.textContent = text;
      toggleClass(target, 'typing', false);
      if (handle) {
        typing.delete(handle);
        handle.dispose();
        handle = null;
      }
      stick();
    };
    handle = lifecycle.frame(() => {
      i += TYPE_CHARS_PER_FRAME;
      if (i >= text.length) {
        finish();
        return false;
      }
      target.textContent = text.slice(0, i);
      stick();
      return undefined;
    });
    typing.add(handle);
    target.addEventListener('click', finish, { signal });
  };


  const clps = (body: HTMLElement, open: boolean): HTMLElement => {
    const w = ui.h('div', open ? 'clps open' : 'clps');
    const b = ui.h('div');
    b.appendChild(body);
    w.appendChild(b);
    return w;
  };

  const bindToggle = (head: HTMLElement, box: HTMLElement, chev?: HTMLElement | null): void => {
    head.addEventListener(
      'click',
      () => {
        const open = !box.className.split(' ').includes('open');
        toggleClass(box, 'open', open);
        if (chev) toggleClass(chev, 'up', open);
      },
      { signal },
    );
  };

  /** 短的直接铺,长的折起来,折叠行上只印字数。 */
  const foldedPre = (content: string): HTMLElement => {
    const box = ui.h('div');
    if ((content || '').length <= FOLD_CHARS) {
      box.appendChild(ui.h('pre', 'mono', content));
      return box;
    }
    const head = ui.h('div', 'foldhead', S.foldHead(false, content.length));
    const pre = ui.h('pre', 'mono', content);
    const wrap = clps(pre, false);
    head.addEventListener(
      'click',
      () => {
        const open = !wrap.className.split(' ').includes('open');
        toggleClass(wrap, 'open', open);
        head.textContent = S.foldHead(open, content.length);
      },
      { signal },
    );
    box.append(head, wrap);
    return box;
  };

  /** 每个画出来的块都带上它的 Item 身份,时间线上任何一块都能对回记录。 */
  const tag = (node: HTMLElement, entry: ContextRecord): HTMLElement => {
    node.setAttribute('data-item-type', entry.item.type ?? 'item_reference');
    node.setAttribute('data-item-id', entry.item.id ?? '');
    return node;
  };

  const prettyArgs = (raw: string): string => {
    try {
      return JSON.stringify(JSON.parse(raw || '{}'), null, 2);
    } catch {
      return raw; // 参数还在流式拼装中就可能不是合法 JSON;照原文显示
    }
  };

  /** 序号:这条 Item 在 session 记录里的位置。合成首轮没有序号,返回 null。 */
  const ordinal = (index: Ordinal): HTMLElement | null => {
    if (index === null) return null;
    const s = ui.h('span', 'meta ordinal', `#${index}`);
    s.title = S.ordinalTitle(index);
    return s;
  };

  const kv = (key: string, value?: string, label?: string): HTMLElement => {
    const box = ui.h('span', `kv kv-${key}`);
    box.appendChild(ui.h('span', 'kv-k', label ?? key));
    if (value !== undefined) box.appendChild(ui.h('span', 'kv-v', value));
    return box;
  };

  const gutterGlyph = (glyph: string, title: string): HTMLElement => {
    const box = ui.h('div', 'gutter');
    box.appendChild(ui.h('span', 'glyph', glyph));
    box.title = title;
    return box;
  };

  /** ASSISTANT 组左栏的头像:图片加载到就用图片,否则占位圆里印说话人首字。 */
  const avatar = (): HTMLElement => {
    const box = ui.h('div', 'gutter avatar');
    const image = ui.h('img', 'avatar-image hidden');
    image.alt = '';
    const fallback = ui.h('span', 'avatar-fallback', speakerInitial);
    image.addEventListener('load', () => {
      toggleClass(image, 'hidden', false);
      toggleClass(fallback, 'hidden', true);
    }, { signal });
    image.addEventListener('error', () => {
      toggleClass(image, 'hidden', true);
      toggleClass(fallback, 'hidden', false);
    }, { signal });
    image.src = AVATAR_URL;
    box.append(image, fallback);
    return box;
  };

  const group = (cls: string, gutter: HTMLElement, right: boolean): { grp: HTMLElement; col: HTMLElement } => {
    const grp = ui.h('div', right ? `${cls} grp r` : `${cls} grp`);
    const col = ui.h('div', right ? 'gcol r' : 'gcol');
    if (right) grp.append(col, gutter);
    else grp.append(gutter, col);
    return { grp, col };
  };


  const renderSystem = (entry: ContextRecord, live: boolean): HTMLElement => {
    const item = entry.item as MessageItem;
    const text = partsText(item.content);
    const card = tag(ui.h('div', live ? 'tcard syscard anim-in' : 'tcard syscard'), entry);
    const head = ui.h('div', 'cardhead');
    const chev = ui.h('span', 'chev', '▼');
    const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
    head.append(
      ui.h('span', 'badge', item.role.toUpperCase()),
      ui.h('span', 'headtxt', firstLine),
      ui.h('span', 'meta', `~${ui.fmt.count(estTok(text))} tok`),
      chev,
    );
    const box = clps(ui.h('pre', 'mono', text || S.empty), false);
    bindToggle(head, box, chev);
    card.append(head, box);
    return card;
  };

  /** user 消息＝内部系统文本(事件到达通知这类),靠右的 USER 组。 */
  const renderWorld = (entry: ContextRecord, index: Ordinal, live: boolean): HTMLElement => {
    const item = entry.item as MessageItem;
    const { grp, col } = group(
      live ? 'usergrp anim-in' : 'usergrp',
      gutterGlyph('>_', S.userGlyphTitle),
      true,
    );
    tag(grp, entry);
    const head = ui.h('div', 'ghead');
    const ord = ordinal(index);
    if (ord) head.appendChild(ord);
    head.appendChild(ui.h('span', 'badge', 'USER'));
    const world = ui.h('div', 'world');
    for (const line of partsText(item.content).split('\n')) {
      world.appendChild(ui.h('div', live ? 'world-line slide-in' : 'world-line', line));
    }
    col.append(head, world);
    return grp;
  };

  /** reasoning 明文、摘要与加密载荷分别显示；三者皆空时不显示。 */
  const renderReasoning = (entry: ContextRecord, live: boolean): HTMLElement | null => {
    const item = entry.item as ReasoningItem;
    const text = (item.content ?? [])
      .map((part) => (part.type === 'reasoning_text' ? part.text : `[${part.type}]`)).join('\n\n');
    const summary = item.summary
      .map((part) => (part.type === 'summary_text' ? part.text : `[${part.type}]`)).join('\n\n');
    const body = text || summary;
    if (!body && item.encrypted_content == null) return null;
    // 头上按字面报长度:明文按字数,加密载荷按字符数(上下文记录里没有逐条 token 数)
    const block = tag(ui.h('div', 'think'), entry);
    const head = ui.h('div', 'think-head');
    if (body) head.appendChild(ui.h('span', 'think-label', S.visibleReasoning(body.length)));
    if (item.encrypted_content != null) {
      if (body) head.appendChild(ui.h('span', 'meta', '·'));
      head.appendChild(ui.h('span', 'think-label think-enc', S.encryptedReasoning(item.encrypted_content.length)));
    }
    if (!body) {
      block.appendChild(head);
      return block;
    }
    const chev = ui.h('span', 'chev up', '▼');
    head.appendChild(chev);
    const content = ui.h('div');
    const main = ui.h('div', 'think-body');
    content.appendChild(main);
    if (text && summary) {
      const sub = ui.h('div', 'think-sub');
      sub.append(ui.h('span', 'think-label', S.summary), ui.h('div', 'think-body', summary));
      content.appendChild(sub);
    }
    const box = clps(content, true);
    bindToggle(head, box, chev);
    block.append(head, box);
    if (live) typewriter(main, body);
    else main.textContent = body;
    return block;
  };

  /** assistant 正文是直接输出，未发送到 World；拒绝与非 final_answer 的 phase 显示标签。 */
  const renderMonolog = (entry: ContextRecord): HTMLElement[] => {
    const item = entry.item as MessageItem;
    const phase = 'phase' in item && typeof item.phase === 'string' ? item.phase : '';
    const parts = typeof item.content === 'string'
      ? [{ type: 'output_text', text: item.content }]
      : item.content;
    const out: HTMLElement[] = [];
    for (const part of parts) {
      const p = part as { type: string; text?: string; refusal?: string };
      const refusal = typeof p.refusal === 'string';
      const text = typeof p.text === 'string' ? p.text : refusal ? p.refusal! : '';
      if (!text.trim()) continue;
      const mono = tag(ui.h('div', refusal ? 'monolog refusal' : 'monolog'), entry);
      mono.title = S.monologTitle(phase);
      const label = refusal ? S.refusal : p.type !== 'output_text' ? p.type : phase && phase !== 'final_answer' ? phase : '';
      if (label) mono.appendChild(ui.h('div', 'monolog-label', label));
      mono.appendChild(ui.h('div', 'monolog-body', text));
      out.push(mono);
    }
    return out;
  };

  const toolCard = (entry: ContextRecord, cls: string, synthetic: boolean): HTMLElement => {
    const item = entry.item as CallItem;
    const card = tag(ui.h('div', cls), entry);
    const head = ui.h('div', 'toolhead');
    head.append(kv('tool_name', item.name || '?'), kv('call_id', item.call_id));
    // class 键钉死为「合成」(styles.css 的 `.kv-合成` 与测试都按它找),只有印出来的字随语言走
    if (synthetic) head.appendChild(kv('合成', undefined, S.synthetic));
    if (item.status && item.status !== 'completed') head.appendChild(ui.h('span', 'meta', item.status));
    const ab = ui.h('div', 'toolargs');
    ab.appendChild(foldedPre(prettyArgs(item.arguments)));
    const slot = ui.h('div', 'toolresult pending', '…');
    card.append(head, ab, slot);
    toolCalls.set(item.call_id, slot);
    return card;
  };

  /** external_event_frame 合成调用对与普通调用同组，并标为合成。 */
  const renderToolCall = (entry: ContextRecord, live: boolean): HTMLElement => {
    const synthetic = isEventFrame(entry.item);
    const cls = ['toolcall'];
    if (synthetic) cls.push('evframe');
    if (live) cls.push('anim-in');
    return toolCard(entry, cls.join(' '), synthetic);
  };

  /** 工具回执:能对上号就填回那颗卡的槽位(返回 null 表示不新建卡片)。 */
  const renderToolResult = (entry: ContextRecord, index: Ordinal, live: boolean): HTMLElement | null => {
    const item = entry.item as OutputItem;
    const text = partsText(item.output);
    const slot = toolCalls.get(item.call_id);
    if (slot) {
      toggleClass(slot, 'pending', false);
      slot.textContent = '';
      tag(slot, entry);
      slot.appendChild(foldedPre(text || S.empty));
      stick();
      return null;
    }
    const card = tag(ui.h('div', live ? 'tcard standalone anim-in' : 'tcard standalone'), entry);
    const head = ui.h('div', 'cardhead');
    head.append(ui.h('span', 'badge', 'function_call_output'), kv('call_id', item.call_id));
    const ord = ordinal(index);
    if (ord) head.appendChild(ord);
    card.append(head, foldedPre(text || S.empty));
    return card;
  };

  const renderOther = (entry: ContextRecord, index: Ordinal, live: boolean): HTMLElement => {
    const item = entry.item;
    const card = tag(ui.h('div', live ? 'tcard standalone anim-in' : 'tcard standalone'), entry);
    const head = ui.h('div', 'cardhead');
    head.appendChild(ui.h('span', 'badge', (item.type ?? 'item_reference').toUpperCase()));
    const ord = ordinal(index);
    if (ord) head.appendChild(ord);
    card.appendChild(head);
    if (item.type === 'compaction') {
      head.appendChild(ui.h('span', 'think-label think-enc', S.encryptedPayload(item.encrypted_content.length)));
    } else {
      card.appendChild(foldedPre(JSON.stringify(item, null, 2)));
    }
    return card;
  };

  /** 连续同 Response 的 assistant 侧 Item 共用一组；缺 responseId 时按连续性分组。可展开原始 Item。 */
  const ensureTurn = (entry: ContextRecord, index: Ordinal, live: boolean): Turn => {
    const responseId = entry.context.responseId ?? '';
    if (turn && turn.responseId === responseId) return turn;
    const { grp, col } = group(live ? 'tcard turn anim-in' : 'tcard turn', avatar(), false);
    if (responseId) grp.setAttribute('data-response-id', responseId);
    const head = ui.h('div', 'ghead turnhead');
    const status = ui.h('span', 'meta turnstatus');
    head.appendChild(ui.h('span', 'badge', 'ASSISTANT'));
    const ord = ordinal(index);
    if (ord) head.appendChild(ord);
    head.appendChild(status);
    head.appendChild(ui.h('span', 'grow'));
    const rawToggle = ui.h('span', 'meta rawtoggle', S.rawItems);
    rawToggle.setAttribute('role', 'button');
    head.appendChild(rawToggle);
    const body = ui.h('div', 'turnbody');
    const rawPre = ui.h('pre', 'mono');
    const rawBox = clps(rawPre, false);
    toggleClass(rawBox, 'turnraw', true);
    col.append(head, body, rawBox);
    const next: Turn = { responseId, grp, body, status, entries: [] };
    rawToggle.addEventListener('click', () => {
      const open = !rawBox.className.split(' ').includes('open');
      if (open) rawPre.textContent = JSON.stringify(next.entries.map((e) => e.item), null, 2);
      toggleClass(rawBox, 'open', open);
    }, { signal });
    inner.appendChild(grp);
    turn = next;
    return next;
  };

  const renderOne = (entry: ContextRecord, index: Ordinal, live: boolean): void => {
    const item = entry.item;
    if (isAssistantSide(item)) {
      if (live) hideThinking();
      const t = ensureTurn(entry, index, live);
      t.entries.push(entry);
      const status = entry.context.responseStatus;
      t.status.textContent = status && status !== 'completed' ? status : '';
      if (item.type === 'reasoning') {
        const block = renderReasoning(entry, live);
        if (block) t.body.appendChild(block);
      } else if (item.type === 'function_call') t.body.appendChild(renderToolCall(entry, live));
      else t.body.append(...renderMonolog(entry));
      // 一段里全是空 Item(空 reasoning、空正文)时组头孤零零一行,标个「空」
      toggleClass(t.grp, 'empty', t.body.children.length === 0);
      stick();
      return;
    }
    turn = null;
    let node: HTMLElement | null;
    if (item.type === 'message' && item.role === 'user') {
      node = renderWorld(entry, index, live);
      if (live) showThinking();
    } else if (isPrefix(item)) node = hideSystem ? null : renderSystem(entry, live);
    else if (item.type === 'function_call_output') node = renderToolResult(entry, index, live);
    else node = renderOther(entry, index, live);
    if (node) inner.appendChild(node);
    stick();
  };

  const renderHead = (entries: readonly ContextRecord[]): void => {
    turn = null;
    inner.appendChild(ui.h('div', 'divider sessionhead', S.headStart));
    for (const entry of entries) renderOne(entry, null, false);
    turn = null;
    inner.appendChild(ui.h('div', 'divider sessionhead', S.headEnd));
  };

  function showThinking(): void {
    toggleClass(think, 'hidden', false);
    stick();
  }
  function hideThinking(): void {
    toggleClass(think, 'hidden', true);
  }

  return {
    el,
    rebuild(messages, opts) {
      const wasStuck = autoScroll;
      const keepTop = scroll.scrollTop;
      stopTyping();
      hideThinking();
      toolCalls.clear();
      turn = null;
      inner.replaceChildren();
      if (opts?.banner) inner.appendChild(opts.banner);
      if (opts?.note) inner.appendChild(ui.h('div', 'divider', opts.note));
      if (!messages.length) {
        inner.appendChild(ui.placeholder(opts?.empty ?? S.sessionEmpty));
        return;
      }
      // 合成开头插在开头的 system 卡之后(与请求体里的位置一致)。
      const head = opts?.head?.length ? opts.head : null;
      let headDone = !head;
      messages.forEach((entry, i) => {
        if (!headDone && !isPrefix(entry.item)) {
          renderHead(head!);
          headDone = true;
        }
        renderOne(entry, i, false);
      });
      if (!headDone) renderHead(head!);
      if (opts?.keepScroll && !wasStuck) {
        scroll.scrollTop = keepTop;
        return;
      }
      autoScroll = true;
      toggleClass(jump, 'hidden', true);
      stick(true);
    },
    append(entry, index, live) {
      renderOne(entry, index, live);
    },
    setHideSystem(hide) {
      hideSystem = hide;
    },
    setHeader(node) {
      header?.remove();
      header = node;
      if (node) scroll.insertBefore(node, inner);
    },
    setSpeaker(name) {
      speakerInitial = name.trim().slice(0, 1).toUpperCase() || 'B';
    },
  };
}
