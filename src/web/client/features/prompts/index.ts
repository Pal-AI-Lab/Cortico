/**
 * 系统提示词以单个编辑器中的一份文档呈现，分段表示为行区间。段与模板源的映射来自后端 PrefixSegment.sourceKey。
 * 编辑不自动保存，用户通过 Ctrl+S 写回；未保存状态在界面显示。
 */

import { get, post } from '../../core/api.ts';
import { pageIntro } from '../../ui/page.ts';
import type { FeatureContext, FrameworkFeature } from '../feature.ts';
import { estTok } from '../live/context.ts';
import { createPrefixEditor, type PrefixBlock } from './editor.ts';
import { S } from './strings.ts';
import { varWarnings, type PromptDoc, type PromptVar } from './view.ts';

const PROMPTS_ROUTE = 'prompts';

/**
 * 两侧栏宽度保存在模块作用域，切换控制台页面时保留，浏览器刷新后恢复默认值。
 */
const colWidth = { flags: 158, rail: 190 };
const COL_MIN = 96;
const COL_MAX = 460;

interface PrefixSegment {
  title: string;
  text: string;
  sourceKey?: string;
}

/** 段按来源分三档上色:人格自有 / World 环境 / 运行时现拼。 */
function segmentTone(sourceKey: string | undefined): PrefixBlock['tone'] {
  if (!sourceKey) return 'derived';
  return sourceKey.startsWith('worlds.') ? 'world' : 'persona';
}

export async function mountPrompts(ctx: FeatureContext, opts: { embedded?: boolean } = {}): Promise<void> {
  const { ui, root } = ctx;
  const intro = pageIntro(ui, S.title, S.introDesc);
  const status = ui.msgline('');
  const toolbar = ui.h('div', 'prompt-toolbar');
  toolbar.append(status, ui.h('span', 'grow'));

  // 标签、分割线与右栏均按 blockGeometry 定位。
  const stage = ui.h('div', 'prefix-stage');
  const flags = ui.h('div', 'prefix-flags');
  const host = ui.h('div', 'prefix-host');
  const rail = ui.h('div', 'prefix-rail');
  const gripL = ui.h('div', 'prefix-grip');
  const gripR = ui.h('div', 'prefix-grip');
  // 分割线单独一层:它要从旗尖一路延伸到右栏末端,横跨三列,谁的内部都装不下
  const dividers = ui.h('div', 'prefix-dividers');
  stage.append(flags, gripL, host, gripR, rail, dividers);
  if (ctx.capabilities.sessionControl === true) {
    const reload = ui.button(S.reloadSession, {
      size: 'sm',
      onClick: () => {
        const lock = ui.disable(reload);
        status.textContent = S.reloading;
        void post<{ result?: string }>('/api/session/reload-prefix', undefined, { signal: ctx.signal })
          .then(async (out) => {
            status.textContent = out?.result || S.prefixReloaded;
            await load();
          })
          .catch((err: unknown) => {
            if ((err as { name?: string } | null)?.name === 'AbortError') return;
            ctx.onError(err);
            status.className = 'msgline bad';
            status.textContent = err instanceof Error ? err.message : String(err);
          })
          .finally(() => lock.dispose());
      },
    });
    toolbar.appendChild(reload);
  }
  if (!opts.embedded) root.appendChild(intro);
  root.append(toolbar, stage);

  /** key → 那份模板的声明与 revision(保存要带 baseRevision 做乐观锁)。 */
  const docs = new Map<string, PromptDoc>();
  /** 改过但还没写盘的块文本(按 key 覆盖)。Ctrl+S 之前它只躺在这儿。 */
  const dirty = new Map<string, string>();

  function setStatus(text: string, bad?: boolean): void {
    status.className = bad ? 'msgline bad' : 'msgline';
    status.textContent = text;
  }

  /** 未存的改动别让它随手翻页丢掉——这一页没有自动保存兜底。 */
  ctx.lifecycle.own(ctx.router.addLeaveGuard(
    () => (dirty.size ? S.leaveUnsaved : null),
  ));

  async function flushSaves(): Promise<void> {
    const batch = [...dirty.entries()];
    dirty.clear();
    if (!batch.length) return;
    setStatus(S.saving);
    editor.setSaveState('saving');
    const done: string[] = [];
    for (const [key, text] of batch) {
      const doc = docs.get(key);
      if (!doc) continue;
      try {
        const out = await post<{ error?: string; result?: string; revision?: string }>(
          '/api/prompts',
          { key, content: text, baseRevision: doc.revision },
          { signal: ctx.signal },
        );
        if (out?.error) throw new Error(out.error);
        doc.content = text;
        doc.revision = out?.revision;
        done.push(doc.title);
      } catch (err) {
        if ((err as { name?: string } | null)?.name === 'AbortError') return;
        ctx.onError(err);
        // 保存失败的改动留在待保存队列。
        dirty.set(key, text);
        editor.setSaveState('dirty');
        setStatus(S.saveFailedFor(doc.title, String((err as Error)?.message ?? err)), true);
        return;
      }
    }
    editor.setSaveState('saved');
    setStatus(S.savedList(done.join(S.listSep)));
    refreshRail();
  }

  const editor = createPrefixEditor({
    parent: host,
    onChange: (changed) => {
      for (const c of changed) dirty.set(c.sourceKey, c.text);
      setStatus(S.dirtyCount(dirty.size));
      refreshRail();
    },
    onSave: () => { void flushSaves(); },
    onGeometry: () => positionSides(),
  });
  ctx.lifecycle.own({ dispose: () => editor.dispose() });

  // ── 右栏:每块一格,列它那份模板的占位符;点开是浮层 ─────────────────
  let openPop: HTMLElement | null = null;
  /** 捕获阶段关闭的块键，用于将同键点击处理为关闭。 */
  let justClosed: string | null = null;
  function closePop(): void { openPop?.remove(); openPop = null; }
  ctx.lifecycle.own({ dispose: closePop });

  // 点浮层以外的任何地方都立刻收起来。**用捕获阶段**:chip 自己的 onClick 在冒泡阶段
  // 才跑,所以这里先收、它再决定要不要开,于是"再点一次同一个"照样是收起。
  const onDocClick = (ev: Event): void => {
    if (!openPop) return;
    const t = ev.target as Node | null;
    if (t && openPop.contains(t)) return;
    // 只有点的**正是打开它的那颗 chip** 才算"收起";点别处纯粹是关掉,
    // 不能留下标记——否则下次点那颗 chip 会被当成收起而打不开。
    const chip = t instanceof Element ? t.closest('.varchip') : null;
    const key = openPop.getAttribute('data-var');
    justClosed = chip?.getAttribute('data-chip') === key ? key : null;
    closePop();
  };
  document.addEventListener('click', onDocClick, true);
  ctx.lifecycle.own({ dispose: () => document.removeEventListener('click', onDocClick, true) });
  const onEsc = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') closePop(); };
  document.addEventListener('keydown', onEsc);
  ctx.lifecycle.own({ dispose: () => document.removeEventListener('keydown', onEsc) });

  function varPopup(v: PromptVar): HTMLElement {
    const pop = ui.h('div', 'varpop');
    pop.appendChild(ui.h('div', 'varpop-name mono', `{{${v.name}}}`));
    pop.appendChild(ui.h('div', 'varpop-desc', v.description));
    pop.appendChild(ui.h('div', 'varpop-label', v.multiline ? S.fillNowMultiline : S.fillNow));
    const val = ui.h('pre', 'mono varpop-value');
    val.textContent = v.value === undefined
      ? S.varUnreported
      : v.value === ''
        ? S.varEmpty
        : v.value;
    pop.appendChild(val);
    return pop;
  }

  /** 按块几何重排；测量编辑器内容与 stage 的坐标差以换算位置。 */
  function positionSides(): void {
    const geo = editor.blockGeometry();
    const off = editor.contentTop() - stage.getBoundingClientRect().top;
    for (let i = 0; i < rail.children.length && i < geo.length; i++) {
      const el = rail.children[i] as HTMLElement;
      el.style.top = `${geo[i].top + off}px`;
      el.style.minHeight = `${geo[i].height}px`;
    }
    for (let i = 0; i < flags.children.length && i < geo.length; i++) {
      (flags.children[i] as HTMLElement).style.top = `${geo[i].top + off}px`;
    }
    for (let i = 0; i < dividers.children.length && i < geo.length; i++) {
      const el = dividers.children[i] as HTMLElement;
      el.style.top = `${geo[i].top + off}px`;
      el.style.left = `${flags.offsetWidth}px`;
    }
    const h = `${host.scrollHeight}px`;
    rail.style.height = h;
    flags.style.height = h;
  }

  /** 两侧栏宽度落到 DOM 上。 */
  function applyWidths(): void {
    flags.style.flexBasis = `${colWidth.flags}px`;
    rail.style.flexBasis = `${colWidth.rail}px`;
    positionSides();
  }

  /** document 接收拖动与松手事件，监听随生命周期释放。 */
  function bindGrip(grip: HTMLElement, side: 'flags' | 'rail'): void {
    grip.addEventListener('pointerdown', (ev: Event) => {
      const startX = (ev as MouseEvent).clientX;
      const start = colWidth[side];
      ev.preventDefault();
      grip.className = 'prefix-grip grip-dragging';
      const move = (e: Event): void => {
        const d = (e as MouseEvent).clientX - startX;
        // 右栏在右边:往左拖是变宽,所以它的符号是反的
        const next = start + (side === 'flags' ? d : -d);
        colWidth[side] = Math.max(COL_MIN, Math.min(COL_MAX, next));
        applyWidths();
      };
      const up = (): void => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        grip.className = 'prefix-grip';
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    }, { signal: ctx.signal });
  }
  bindGrip(gripL, 'flags');
  bindGrip(gripR, 'rail');
  applyWidths();
  window.addEventListener('resize', positionSides, { signal: ctx.signal });

  /** 重建左侧标签与右栏(块集合或警告变了时)。 */
  function refreshRail(): void {
    closePop();
    rail.replaceChildren();
    flags.replaceChildren();
    dividers.replaceChildren();
    for (const g of editor.blockGeometry()) {
      const flag = ui.h('div', `prefix-flag tone-${g.tone}${g.sourceKey ? '' : ' flag-readonly'}`);
      flag.appendChild(ui.h('span', 'prefix-flag-text', g.title));
      const origin = g.sourceKey ? docs.get(g.sourceKey)?.origin : undefined;
      flag.title = g.sourceKey
        ? S.flagEditable(g.sourceKey, origin)
        : S.flagReadonly;
      flags.appendChild(flag);
      dividers.appendChild(ui.h('div', `prefix-divider tone-${g.tone}`));

      const cell = ui.h('div', 'prefix-railcell');
      const doc = g.sourceKey ? docs.get(g.sourceKey) : undefined;
      if (!doc) {
        cell.appendChild(ui.h('span', 'prefix-railnote', g.sourceKey ? S.sourceMissing(g.sourceKey) : S.fromCode));
        rail.appendChild(cell);
        continue;
      }
      const text = dirty.get(doc.key) ?? doc.content;
      if (doc.origin) {
        cell.appendChild(ui.h('span', 'prefix-railnote',
          doc.origin === 'deployment' ? S.originDeployment
          : doc.origin === 'package' ? S.originPackage
          : S.originWorld));
      }
      for (const v of doc.vars ?? []) {
        const chip = ui.button(v.name, {
          size: 'sm',
          onClick: () => {
            // 捕获阶段的 onDocClick 已经把浮层收了;这里靠 justClosed 认出"再点同一个"
            if (justClosed === `${doc.key}:${v.name}`) { justClosed = null; return; }
            const pop = varPopup(v);
            pop.setAttribute('data-var', `${doc.key}:${v.name}`);
            cell.appendChild(pop);
            openPop = pop;
          },
        });
        chip.className += ' varchip mono';
        chip.setAttribute('data-chip', `${doc.key}:${v.name}`);
        // 模板里没用到的占位符标灰:它声明了,但这一块此刻不引用它
        if (!text.includes(`{{${v.name}`)) chip.className += ' varchip-unused';
        cell.appendChild(chip);
      }
      const warns = varWarnings(text, doc.vars ?? []);
      if (warns.length) {
        const w = ui.h('div', 'prefix-railwarn');
        w.textContent = warns.join(S.warnSep);
        cell.appendChild(w);
      }
      rail.appendChild(cell);
    }
    positionSides();
  }

  async function load(): Promise<void> {
    try {
      const [docsRes, prefixRes] = await Promise.all([
        get<{ prompts?: PromptDoc[] }>('/api/prompts', { signal: ctx.signal }),
        get<{ segments?: PrefixSegment[] }>('/api/prompts/prefix', { signal: ctx.signal })
          .catch(() => null),
      ]);
      docs.clear();
      for (const d of docsRes?.prompts ?? []) docs.set(d.key, d);
      const segments = prefixRes?.segments ?? [];

      if (!segments.length) {
        setStatus(prefixRes ? S.prefixEmpty : S.prefixUnavailable, true);
        editor.setBlocks([]);
        refreshRail();
        return;
      }

      // 可编辑块装**模板原文**(带 {{}}),只读块装渲染后的文本——后者没有源可给。
      editor.setBlocks(segments.map((seg): PrefixBlock => {
        const doc = seg.sourceKey ? docs.get(seg.sourceKey) : undefined;
        return {
          title: seg.title,
          tone: segmentTone(seg.sourceKey),
          ...(doc ? { sourceKey: doc.key } : {}),
          text: (doc ? doc.content : seg.text).replace(/\s+$/, ''),
        };
      }));
      // 字数不是这条前缀真正的成本,token 才是。口径与截断判据同源(`estTok`),
      // 所以这里报的数和「上下文」页、和真去截断时算的是同一套。
      const tok = estTok(segments.map((s) => s.text).join(''));
      setStatus(S.prefixStats(segments.length, tok.toLocaleString()));
      refreshRail();
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') return;
      ctx.onError(err);
      setStatus(S.loadFailed(String((err as Error)?.message ?? err)), true);
    }
  }

  await load();
}

export const promptsFeature: FrameworkFeature = {
  route: PROMPTS_ROUTE,
  label: S.title,
  icon: 'text',
  navGroup: S.navGroup,
  needsAny: ['prompts'],
  mount: mountPrompts,
};
