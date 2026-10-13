/** 外观页读取 ThemeStudio 状态；调色草稿仅用于预览，卸载时撤销预览。 */

import type { Disposable } from '../../../shared/client-panel.ts';
import type { FeatureContext, FrameworkFeature } from '../feature.ts';
import { pageIntro } from '../../ui/page.ts';
import {
  THEME_APPEARANCE_LABELS,
  THEME_MODES,
  THEME_MODE_LABELS,
  groupedThemeTokens,
  normalizeHex,
  type ThemeMode,
  type ThemePalette,
} from '../../theme/registry.ts';
import { getThemeStudio, type ThemeSnapshot } from '../../theme/studio.ts';
import { S } from './strings.ts';

/** "再点一次确认删除"的解除武装时限。 */
const DELETE_ARM_MS = 4000;
const DELETE_LABEL = S.deleteScheme;

/** 一格颜色的三个节点。改值时按 token key 找回来。 */
interface ColorRow {
  row: HTMLElement;
  picker: HTMLInputElement;
  hex: HTMLInputElement;
}

function schemeIdAt(target: EventTarget | null, stop: HTMLElement): string | null {
  let node = target as HTMLElement | null;
  while (node && node !== stop) {
    const id = node.dataset?.schemeId;
    if (id) return id;
    node = node.parentElement;
  }
  return null;
}

export function mountAppearance(ctx: FeatureContext, opts: { embedded?: boolean } = {}): void {
  const { ui, root, signal } = ctx;
  const doc = root.ownerDocument;
  const studio = getThemeStudio({ doc });
  const intro = pageIntro(ui, S.pageTitle);

  // 最先登记 = 最后释放:等订阅摘掉之后再撤预览,免得回调打在一个正在拆的页面上。
  ctx.lifecycle.add(() => studio.resetPreview());

  /** 用户正在调、尚未保存的一份调色板。 */
  let draft: ThemePalette = studio.snapshot().palette;
  let deleteArmed = false;
  let disarmTimer: Disposable | null = null;

  // ── 方案卡 ─────────────────────────────────────────────────────────

  const schemeSheet = ui.sheet({
    title: S.schemeSheetTitle,
    en: 'theme schema',
  });
  const modes = ui.segmented(
    THEME_MODES.map((m) => ({ value: m, label: THEME_MODE_LABELS[m] })),
    {
      value: studio.mode,
      size: 'sm',
      onSelect: (value) => {
        studio.setMode(value as ThemeMode);
        setMsg(S.switchedMode(THEME_MODE_LABELS[value as ThemeMode]));
      },
    },
  );
  const modeBar = ui.rowbar();
  modeBar.append(modes.el);
  const schemesBox = ui.h('div', 'theme-schemes');
  schemesBox.addEventListener(
    'click',
    (ev) => {
      const id = schemeIdAt(ev.target, schemesBox);
      if (!id || !studio.select(id)) return;
      setMsg(S.switchedScheme(studio.snapshot().scheme.name));
    },
    { signal },
  );
  schemeSheet.body.append(modeBar, schemesBox);

  // ── 调色盘 ─────────────────────────────────────────────────────────

  const paletteFold = ui.foldSheet('appearance-palette', {
    title: S.paletteSheetTitle,
    en: 'palette',
    desc: S.paletteSheetDesc,
  });
  paletteFold.el.classList.add('theme-palette-fold');
  const nameInput = ui.input({ cls: 'mono', placeholder: S.schemeName });
  nameInput.maxLength = 40;
  const paletteBox = ui.h('div', 'theme-palette');
  const colorRows = new Map<string, ColorRow>();

  for (const bucket of groupedThemeTokens()) {
    const section = ui.h('section', 'theme-color-group');
    section.appendChild(ui.h('h4', null, bucket.group));
    const grid = ui.h('div', 'theme-color-grid');
    for (const token of bucket.tokens) {
      const row = ui.h('label', 'theme-color');
      const picker = ui.h('input');
      picker.type = 'color';
      picker.setAttribute('aria-label', S.colorAria(token.label));
      const hex = ui.h('input');
      hex.type = 'text';
      hex.maxLength = 7;
      hex.spellcheck = false;
      hex.setAttribute('aria-label', S.hexAria(token.label));
      const edit = (value: string, from: HTMLInputElement): void => {
        const normalized = normalizeHex(value);
        row.classList.toggle('invalid', normalized === null);
        if (!normalized) return;
        draft[token.key] = normalized;
        // 只回填**另一个**控件:回填正在打字的那个会把光标弹到末尾。
        if (from !== picker) picker.value = normalized;
        if (from !== hex) hex.value = normalized.toUpperCase();
        studio.preview(draft);
        setMsg(S.previewing);
      };
      picker.addEventListener('input', () => edit(picker.value, picker), { signal });
      picker.addEventListener('change', () => { hex.value = picker.value.toUpperCase(); }, { signal });
      hex.addEventListener('input', () => edit(hex.value, hex), { signal });
      row.append(picker, ui.h('span', 'theme-color-label', token.label), hex);
      grid.appendChild(row);
      colorRows.set(token.key, { row, picker, hex });
    }
    section.appendChild(grid);
    paletteBox.appendChild(section);
  }

  const msg = ui.msgline('');
  msg.className = 'msgline grow';
  msg.setAttribute('aria-live', 'polite');

  const resetBtn = ui.button(S.resetPreview, {
    onClick: () => {
      studio.resetPreview();
      setMsg(S.previewReset);
    },
  });
  const deleteBtn = ui.button(DELETE_LABEL, {
    variant: 'danger',
    onClick: () => {
      const snap = studio.snapshot();
      if (!snap.scheme.custom) return;
      if (!deleteArmed) {
        deleteArmed = true;
        deleteBtn.textContent = S.confirmDelete;
        setMsg(S.aboutToDelete(snap.scheme.name), true);
        disarmTimer?.dispose();
        // 计时器走 lifecycle:离开这一页时自动取消,不会在一个已卸载的页面上回调。
        disarmTimer = ctx.lifecycle.timeout(() => {
          disarmDelete();
          setMsg(S.deleteCancelled);
        }, DELETE_ARM_MS);
        return;
      }
      disarmDelete();
      studio.removeCurrent();
      setMsg(S.deleted(studio.snapshot().scheme.name));
    },
  });
  const copyBtn = ui.button(S.copyAsNew, {
    onClick: () => {
      const snap = studio.snapshot();
      const base = nameInput.value.trim() || snap.scheme.name;
      studio.saveAs(base + (snap.scheme.custom ? S.copySuffix : S.customSuffix), draft);
      setMsg(S.copied);
    },
  });
  const saveBtn = ui.button(S.saveScheme, {
    variant: 'primary',
    onClick: () => {
      const snap = studio.snapshot();
      const raw = nameInput.value.trim();
      if (snap.scheme.custom) {
        studio.saveCurrent(raw || snap.scheme.name, draft);
        setMsg(S.savedVariant(THEME_APPEARANCE_LABELS[snap.appearance]));
      } else {
        studio.saveAs(raw === snap.scheme.name ? S.customName(raw) : raw, draft);
        setMsg(S.savedAsCustom);
      }
    },
  });

  const actions = ui.actions();
  actions.classList.add('theme-actions');
  actions.append(msg, resetBtn, deleteBtn, copyBtn, saveBtn);
  const colors = ui.h('div', 'theme-bench-colors');
  colors.append(ui.field(S.schemeName, nameInput), paletteBox);
  const bench = ui.h('div', 'theme-bench');
  bench.append(colors, specimen(ctx));
  paletteFold.body.append(bench, actions);
  schemeSheet.body.append(paletteFold.el);
  if (!opts.embedded) root.appendChild(intro);
  root.append(schemeSheet.el);

  // ── 刷新 ───────────────────────────────────────────────────────────

  function setMsg(text: string, bad = false): void {
    msg.textContent = text;
    msg.className = `msgline grow${bad ? ' bad' : ''}`;
  }

  function disarmDelete(): void {
    disarmTimer?.dispose();
    disarmTimer = null;
    if (!deleteArmed) return;
    deleteArmed = false;
    deleteBtn.textContent = DELETE_LABEL;
  }

  function renderSchemes(snap: ThemeSnapshot): void {
    schemesBox.textContent = '';
    for (const scheme of snap.schemes) {
      const card = ui.h('button', `theme-scheme${scheme.id === snap.selectedId ? ' active' : ''}`);
      card.type = 'button';
      card.dataset.schemeId = scheme.id;
      card.setAttribute('aria-pressed', scheme.id === snap.selectedId ? 'true' : 'false');
      const head = ui.h('div', 'theme-scheme-head');
      head.append(
        ui.h('span', null, scheme.name),
        ui.h('span', 'theme-scheme-kind', scheme.builtin ? S.builtin : S.custom),
      );
      const swatches = ui.h('div', 'theme-swatches');
      for (const color of scheme.swatches) {
        const sw = ui.h('span');
        sw.style.background = color;
        swatches.appendChild(sw);
      }
      card.append(head, ui.h('div', 'theme-scheme-note', scheme.note), swatches);
      schemesBox.appendChild(card);
    }
  }

  function syncPalette(palette: ThemePalette): void {
    for (const [key, row] of colorRows) {
      const value = palette[key] ?? '#000000';
      row.picker.value = value;
      row.hex.value = value.toUpperCase();
      row.row.classList.remove('invalid');
    }
  }

  function refresh(): void {
    disarmDelete();
    const snap = studio.snapshot();
    draft = snap.palette;
    nameInput.value = snap.scheme.name;
    modes.setValue(snap.mode);
    deleteBtn.classList.toggle('hidden', !snap.scheme.custom);
    saveBtn.textContent = snap.scheme.custom ? S.saveCurrent : S.saveAsCustom;
    renderSchemes(snap);
    syncPalette(snap.palette);
    if (snap.saveError) setMsg(S.saveFailed(snap.saveError), true);
    else setMsg(snap.scheme.builtin ? S.builtinHint : S.customHint);
  }

  // 预览那一串变化不重画自己:值就是这一页刚写进去的,回填只会打断正在打字的输入框。
  ctx.lifecycle.own(studio.onChange((change) => {
    if (!change.preview) refresh();
  }));
  refresh();
}

/** 无交互的主题预览示例。 */
function specimen(ctx: FeatureContext): HTMLElement {
  const { ui } = ctx;
  const box = ui.h('div', 'theme-specimen');

  // USER 组:内容列在前、记号栏在后(镜像)
  const world = ui.h('div', 'grp r usergrp');
  const worldCol = ui.h('div', 'gcol r');
  const worldHead = ui.h('div', 'ghead');
  worldHead.append(ui.h('span', 'meta ordinal', '#1'), ui.h('span', 'badge', 'USER'));
  const worldBubble = ui.h('div', 'world');
  worldBubble.appendChild(ui.h('div', 'world-line', '[system] 2 new events arrived.'));
  worldCol.append(worldHead, worldBubble);
  const worldGutter = ui.h('div', 'gutter');
  worldGutter.appendChild(ui.h('span', 'glyph', '>_'));
  world.append(worldCol, worldGutter);

  // ASSISTANT 组:头像栏 + 内容列
  const turn = ui.h('div', 'tcard turn grp');
  const avatar = ui.h('div', 'gutter avatar');
  avatar.appendChild(ui.h('span', 'avatar-fallback', 'B'));
  const turnCol = ui.h('div', 'gcol');
  const turnHead = ui.h('div', 'ghead turnhead');
  turnHead.append(ui.h('span', 'badge', 'ASSISTANT'), ui.h('span', 'meta ordinal', '#2'));
  const think = ui.h('div', 'think');
  think.append(
    ui.h('div', 'think-label', S.thinkLabel),
    ui.h('div', 'think-body', S.thinkBody),
  );
  const monolog = ui.h('div', 'monolog');
  monolog.appendChild(ui.h('div', 'monolog-body', S.monologBody));
  turnCol.append(turnHead, think, monolog);
  turn.append(avatar, turnCol);

  const chart = ui.h('div', 'theme-chart-preview');
  chart.setAttribute('aria-label', S.chartAria);
  const bars: Array<[string, string]> = [
    ['42%', 'chart-hit'], ['66%', 'chart-miss'], ['86%', 'chart-output'],
    ['58%', 'chart-2'], ['74%', 'chart-3'], ['50%', 'chart-4'],
  ];
  for (const [height, key] of bars) {
    const bar = ui.h('span');
    bar.style.height = height;
    bar.style.background = `var(--${key})`;
    chart.appendChild(bar);
  }

  box.append(world, turn, chart);
  const sample = ui.h('div', 'theme-bench-sample');
  sample.append(ui.h('h4', null, S.specimenTitle), box);
  return sample;
}

/** 不要求框架能力；主题记录经 `/api/theme` 存在部署里。 */
export const appearanceFeature: FrameworkFeature = {
  route: 'appearance',
  label: S.navLabel,
  navMode: 'hidden',
  mount: mountAppearance,
};
