/**
 * 面板 `world` —— 存档与玩法。
 *
 * 改动写在 server.properties,而服务器只在**启动时**读一次:停机时改什么都行
 * (下次启动生效),跑着的时候只有**难度**和**默认游戏模式**能当场改(走控制台
 * 指令,只对本轮有效,不落盘)。所以这一屏的禁用规则不是装饰,它就是那条时机规则
 * 的界面形态。
 *
 * 世界生成那几项还多一条时机:它们只在存档**第一次生成**时被读到,对着已有的
 * 世界改毫无作用。所以它们不在"应用"那条路上,而是「开新存档」这个动作的参数。
 *
 * 存档列表按**最近活跃**分组,默认只展开最近的那一组——服务器目录里躺着几十份
 * 存档时,一条长表格里真正要找的永远是最上面那几份。两种版式:网格(一眼扫过
 * 所有存档)与详情(每份摊开 level.dat 自述)。
 */

import type {
  ConsolePanelContext,
  ConsolePanel,
} from '../../../web/shared/client-panel.ts';
import {
  errText,
  msgLine,
  type MinecraftWorldInfo,
  type MinecraftWorldState,
} from './client.ts';
import { text, type MinecraftPanelText } from './strings.ts';

type Text = MinecraftPanelText['world'];

/** 下标与 level.dat 里的 GameType / Difficulty 数字一致 */
const GAMEMODES = ['survival', 'creative', 'adventure', 'spectator'] as const;
const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'] as const;

const DAY_MS = 86_400_000;

/** 分组:按最近活跃分档,顺序即从近到远。 */
const GROUPS: ReadonlyArray<{ id: keyof Text['groups']; within: number }> = [
  { id: 'today', within: 1 },
  { id: 'week', within: 7 },
  { id: 'month', within: 30 },
  { id: 'older', within: Infinity },
];

/** 本地日历日的差值:23:59 与次日 00:01 是两天,差 2 分钟也算 */
function daysAgo(iso: string, now: Date): number {
  const then = new Date(iso);
  const midnight = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.floor((midnight(now) - midnight(then)) / DAY_MS);
}

function groupOf(world: MinecraftWorldInfo, now: Date): string {
  if (!world.modified) return 'pending';
  const days = daysAgo(world.modified, now);
  return GROUPS.find((g) => days < g.within)!.id;
}

function fmtBytes(n: number): string {
  if (n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function fmtWhen(W: Text, iso: string | null, now: Date): string {
  if (!iso) return W.notGenerated;
  const days = daysAgo(iso, now);
  const clock = iso.slice(11, 16);
  if (days === 0) return W.today(clock);
  if (days === 1) return W.yesterday(clock);
  if (days < 30) return W.daysAgo(days);
  return iso.slice(0, 10);
}

/** 存档自述里能读出多少写多少;一项都读不出来就不摆这一行 */
function infoRows(W: Text, w: MinecraftWorldInfo, now: Date): Array<{ k: string; v: string }> {
  const rows: Array<{ k: string; v: string }> = [
    { k: W.lastActive, v: `${fmtWhen(W, w.modified, now)}${w.modified ? `(${w.modified.slice(0, 16).replace('T', ' ')})` : ''}` },
    { k: W.diskSize, v: fmtBytes(w.sizeBytes) },
  ];
  const info = w.info;
  if (info) {
    if (info.generator) rows.push({ k: W.worldType, v: W.generators[info.generator] ?? info.generator });
    if (info.seed) rows.push({ k: W.seed, v: info.seed });
    if (info.gameType !== null) rows.push({ k: W.gamemode, v: W.gamemodes[info.gameType] ?? String(info.gameType) });
    if (info.difficulty !== null) {
      rows.push({
        k: W.difficulty,
        v: `${W.difficulties[info.difficulty] ?? info.difficulty}${info.hardcore ? W.hardcoreSuffix : ''}`,
      });
    }
    if (info.version) rows.push({ k: W.version, v: info.version });
    if (info.dayTime !== null) rows.push({ k: W.worldDay, v: W.dayN(Math.floor(info.dayTime / 24_000) + 1) });
    if (info.levelName && info.levelName !== w.name) rows.push({ k: W.levelDatName, v: info.levelName });
  }
  if (w.dimensions.length) {
    rows.push({ k: W.dimensions, v: W.list(w.dimensions.map((d) => (d === 'nether' ? W.nether : W.theEnd))) });
  }
  return rows;
}

export const worldPanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    const { ui, root } = ctx;
    const T = text(ctx.language);
    const W = T.world;

    // -----------------------------------------------------------------------
    // 卡一:存档
    // -----------------------------------------------------------------------
    const card = ui.sheet({ title: W.title, en: 'world & rules', desc: W.desc });
    const s = card.body;
    root.appendChild(card.el);

    const msg = msgLine(ctx);
    s.appendChild(msg.el);

    const stateBox = ui.h('div');
    s.append(ui.section(W.currentWorld), stateBox);

    const layout = ui.segmented(
      [{ value: 'grid', label: W.grid }, { value: 'detail', label: W.detail }],
      {
        value: ctx.memo.get<string>('layout', 'grid'),
        size: 'sm',
        onSelect: (v) => { ctx.memo.set('layout', v); render(cur); },
      },
    );
    const listBar = ui.rowbar();
    listBar.append(ui.h('span', 'grow'), layout.el);
    const listBox = ui.h('div');
    s.append(ui.section(W.saves, W.savesNote), listBar, listBox);

    // ---- 玩法 ----
    const gmSel = ui.select({ options: GAMEMODES.map((value, i) => ({ value, label: W.gamemodes[i]! })) });
    const diffSel = ui.select({ options: DIFFICULTIES.map((value, i) => ({ value, label: W.difficulties[i]! })) });
    const hardcoreIn = ui.checkbox(W.hardcore);
    const pvpIn = ui.checkbox('PVP');
    const monstersIn = ui.checkbox(W.monsters);
    const btnApply = ui.button(T.apply, { size: 'sm', variant: 'primary' });
    const ruleForm = ui.h('div', 'mc-form');
    ruleForm.append(ui.field(W.gamemode, gmSel), ui.field(W.difficulty, diffSel));
    const ruleBar = ui.actions();
    ruleBar.append(hardcoreIn.el, pvpIn.el, monstersIn.el, ui.h('span', 'grow'), btnApply);
    s.append(ui.section(W.gameplay), ruleForm, ruleBar);

    // ---- 世界规则(收起来的那些) ----
    const netherIn = ui.checkbox(W.allowNether);
    const spawnProtIn = ui.input({ type: 'number', value: '16' });
    const viewIn = ui.input({ type: 'number', value: '10' });
    const simIn = ui.input({ type: 'number', value: '10' });
    const borderIn = ui.input({ type: 'number', value: '29999984' });
    const rulesForm = ui.h('div', 'mc-form');
    rulesForm.append(
      ui.field(W.spawnProtection, spawnProtIn),
      ui.field(W.viewDistance, viewIn),
      ui.field(W.simulationDistance, simIn),
      ui.field(W.worldBorder, borderIn),
    );
    const rulesBar = ui.actions();
    rulesBar.append(netherIn.el, ui.h('span', 'grow'));
    const moreRules = fold(ctx, W.moreRules, W.moreRulesNote);
    moreRules.body.append(rulesForm, rulesBar);
    s.append(moreRules.el);

    // -----------------------------------------------------------------------
    // 卡二:开新存档
    // -----------------------------------------------------------------------
    const newCard = ui.sheet({
      title: W.newTitle,
      en: 'new world',
      desc: W.newDesc,
    });
    const n = newCard.body;
    root.appendChild(newCard.el);

    const newName = ui.input({ placeholder: W.newName });
    const newSeed = ui.input({ placeholder: W.seedPlaceholder });
    const typeSel = ui.select();
    const structIn = ui.checkbox(W.structures, { checked: true });
    const typeNote = ui.h('div', 'pagedesc');
    const newForm = ui.h('div', 'mc-form');
    newForm.append(ui.field(W.saveName, newName), ui.field(W.seed, newSeed), ui.field(W.worldType, typeSel));

    const presetSel = ui.select();
    const genText = ui.textarea({ placeholder: W.genPlaceholder, cls: 'mono' });
    const presetNote = ui.h('div', 'pagedesc');
    const moreGen = fold(ctx, W.moreGen, W.moreGenNote);
    const presetForm = ui.h('div', 'mc-form');
    presetForm.append(ui.field(W.flatPreset, presetSel));
    moreGen.body.append(presetForm, presetNote, ui.field(W.generatorSettings, genText));

    const btnCreate = ui.button(W.register, { size: 'sm', variant: 'primary' });
    const newBar = ui.actions();
    newBar.append(structIn.el, ui.h('span', 'grow'), btnCreate);
    n.append(newForm, typeNote, moreGen.el, newBar);

    // -----------------------------------------------------------------------

    /** 服务端那份权威状态。应用玩法时要看它决定提交哪几项。 */
    let cur: MinecraftWorldState | null = null;
    /** 展开着的分组;首次渲染时钉在最近的那一组上,之后跟着用户开合走 */
    let opened: Set<string> | null = null;

    function fillPresets(st: MinecraftWorldState): void {
      if (presetSel.options.length) return;
      const custom = ui.h('option', null, W.custom);
      custom.value = '';
      presetSel.appendChild(custom);
      for (const p of st.flatPresets) {
        const op = ui.h('option', null, p.label);
        op.value = p.id;
        presetSel.appendChild(op);
      }
      presetSel.addEventListener('change', () => {
        const hit = st.flatPresets.find((p) => p.id === presetSel.value);
        presetNote.textContent = hit ? hit.note : '';
        if (!hit) return;
        // 选了平坦预设就是想开一个平坦世界,类型跟着走,免得配方写好了却是默认地形
        genText.value = hit.json;
        typeSel.value = 'minecraft:flat';
        typeSel.dispatchEvent(new Event('change'));
      }, { signal: ctx.signal });
    }

    function fillLevelTypes(st: MinecraftWorldState): void {
      if (typeSel.options.length) return;
      for (const t of st.levelTypes) {
        const op = ui.h('option', null, t.label);
        op.value = t.value;
        typeSel.appendChild(op);
      }
      const note = (): void => {
        typeNote.textContent = st.levelTypes.find((t) => t.value === typeSel.value)?.note ?? '';
      };
      typeSel.addEventListener('change', note, { signal: ctx.signal });
      note();
    }

    /** 一份存档一张卡片。两种版式的差别只在卡片里摆什么。 */
    function worldCard(w: MinecraftWorldInfo, st: MinecraftWorldState, now: Date, detail: boolean): HTMLElement {
      const isCur = w.name === st.settings.levelName;
      const el = ui.h('div', `mc-world${isCur ? ' cur' : ''}`);
      const head = ui.h('div', 'mc-worldhead');
      head.append(ui.h('span', 'mc-worldname', w.name));
      if (isCur) head.append(ui.pill(W.current, 'on'));
      if (!w.generated) head.append(ui.pill(W.notGenerated, 'plain'));
      el.append(head);

      if (detail) {
        el.append(ui.kv(infoRows(W, w, now)));
      } else {
        const meta = ui.h('div', 'mc-worldmeta');
        meta.append(ui.h('span', null, fmtWhen(W, w.modified, now)));
        if (w.sizeBytes > 0) meta.append(ui.h('span', null, fmtBytes(w.sizeBytes)));
        if (w.info?.version) meta.append(ui.h('span', null, w.info.version));
        if (w.info?.generator) {
          meta.append(ui.h('span', null, W.generators[w.info.generator] ?? w.info.generator));
        }
        el.append(meta);
      }

      const acts = ui.h('div', 'mc-worldacts');
      const pick = ui.button(W.switchTo, { size: 'sm' });
      pick.disabled = isCur || !st.configured || st.live;
      pick.addEventListener('click', () => {
        void act(() => ctx.invoke<MinecraftWorldState>('select', [w.name]), W.switching);
      }, { signal: ctx.signal });
      acts.append(pick);
      el.append(acts);
      return el;
    }

    function renderWorlds(st: MinecraftWorldState): void {
      const now = new Date();
      const detail = layout.value === 'detail';
      const buckets = new Map<string, MinecraftWorldInfo[]>();
      for (const w of st.worlds) {
        const id = groupOf(w, now);
        (buckets.get(id) ?? buckets.set(id, []).get(id)!).push(w);
      }
      const order = [...GROUPS.map((g) => ({ id: g.id as string, label: W.groups[g.id] })), { id: 'pending', label: W.notGenerated }]
        .filter((g) => buckets.has(g.id));
      if (opened === null) opened = new Set(order.length ? [order[0].id] : []);

      listBox.replaceChildren();
      if (!order.length) {
        listBox.append(ui.placeholder(W.noSaves));
        return;
      }
      for (const g of order) {
        const items = buckets.get(g.id)!;
        const box = ui.h('details', 'mc-group');
        box.open = opened.has(g.id);
        const sum = ui.h('summary');
        sum.append(ui.h('span', null, g.label), ui.h('span', 'mc-groupcount', W.count(items.length)));
        box.append(sum);
        const grid = ui.h('div', `mc-worlds ${detail ? 'detail' : 'grid'}`);
        for (const w of items) grid.append(worldCard(w, st, now, detail));
        box.append(grid);
        box.addEventListener('toggle', () => {
          if (box.open) opened!.add(g.id);
          else opened!.delete(g.id);
        }, { signal: ctx.signal });
        listBox.append(box);
      }
    }

    function render(st: MinecraftWorldState | null): void {
      if (ctx.signal.aborted) return;
      cur = st;
      if (!st) {
        msg.say(W.unavailable, true);
        stateBox.replaceChildren(ui.placeholder(W.noProperties));
        listBox.replaceChildren(ui.placeholder('—'));
        return;
      }
      const stopped = !st.live;
      fillLevelTypes(st);
      fillPresets(st);

      const genLabel = st.levelTypes.find((t) => t.value === st.settings.levelType)?.label ?? st.settings.levelType;
      stateBox.replaceChildren(ui.kv([
        { k: W.currentSave, v: st.settings.levelName },
        { k: W.seed, v: st.settings.levelSeed || W.random },
        { k: W.worldType, v: `${genLabel}${st.settings.generatorSettings ? W.withGenerator : ''}` },
        { k: T.server, v: ui.pill(
          st.live ? (st.hosted ? T.runningHosted : T.runningExternal) : T.stopped,
          st.live ? 'on' : 'plain',
        ) },
        { k: T.serverDir, v: st.serverDir || T.notConfigured },
      ]));

      renderWorlds(st);

      gmSel.value = st.settings.gamemode;
      diffSel.value = st.settings.difficulty;
      hardcoreIn.setChecked(st.settings.hardcore);
      pvpIn.setChecked(st.settings.pvp);
      monstersIn.setChecked(st.settings.spawnMonsters);
      netherIn.setChecked(st.settings.allowNether);
      spawnProtIn.value = String(st.settings.spawnProtection);
      viewIn.value = String(st.settings.viewDistance);
      simIn.value = String(st.settings.simulationDistance);
      borderIn.value = String(st.settings.maxWorldSize);

      const off = !st.configured;
      newName.disabled = newSeed.disabled = typeSel.disabled = presetSel.disabled = off || !stopped;
      genText.disabled = structIn.input.disabled = btnCreate.disabled = off || !stopped;
      hardcoreIn.input.disabled = pvpIn.input.disabled = monstersIn.input.disabled = off || !stopped;
      netherIn.input.disabled = spawnProtIn.disabled = viewIn.disabled = off || !stopped;
      simIn.disabled = borderIn.disabled = off || !stopped;
      gmSel.disabled = diffSel.disabled = btnApply.disabled = off;
      msg.say(st.detail || (st.live ? W.liveNote : ''));
    }

    const refresh = (): Promise<void> =>
      ctx.invoke<MinecraftWorldState>('state').then(render, () => render(null));

    /**
     * 一次动作:置灰两颗钮 → 调服务端 → 拿回来的新状态重画。
     *
     * **先解锁再重画。** `ui.disable` 恢复的是各自调用前的原值,而重画本身要按
     * 新状态重设这些钮的可用性——顺序反了的话,刚算出来的禁用规则会被恢复动作
     * 原样抹掉。
     */
    async function act(fn: () => Promise<MinecraftWorldState>, working: string): Promise<void> {
      msg.say(working);
      const lock = ui.disable(btnCreate, btnApply);
      let next: MinecraftWorldState | null = null;
      try {
        next = await fn();
      } catch (err) {
        if (!ctx.signal.aborted) msg.say(T.opFailed(errText(err)), true);
      } finally {
        lock.dispose();
      }
      if (next) render(next);
    }

    btnCreate.addEventListener('click', () => {
      void act(() => ctx.invoke<MinecraftWorldState>('create', [newName.value, {
        seed: newSeed.value,
        levelType: typeSel.value,
        generatorSettings: genText.value,
        generateStructures: structIn.checked,
      }]), W.registering);
    }, { signal: ctx.signal });

    btnApply.addEventListener('click', () => {
      // 运行期间仅提交支持热更新的字段。
      const patch = cur?.live
        ? { gamemode: gmSel.value, difficulty: diffSel.value }
        : {
          gamemode: gmSel.value,
          difficulty: diffSel.value,
          hardcore: hardcoreIn.checked,
          pvp: pvpIn.checked,
          spawnMonsters: monstersIn.checked,
          allowNether: netherIn.checked,
          spawnProtection: Number(spawnProtIn.value),
          viewDistance: Number(viewIn.value),
          simulationDistance: Number(simIn.value),
          maxWorldSize: Number(borderIn.value),
        };
      void act(() => ctx.invoke<MinecraftWorldState>('apply', [patch]), T.applying);
    }, { signal: ctx.signal });

    void refresh();
  },
};

/**
 * 卡片内的折叠块。`ui.foldSheet` 折的是整张卡,而这里要的是"卡里那几项平时收着"
 * ——把次要参数摊在主表单里,主表单就没有主次可言了。
 */
function fold(ctx: ConsolePanelContext, title: string, note: string): { el: HTMLElement; body: HTMLElement } {
  const el = ctx.ui.h('details', 'mc-fold');
  const sum = ctx.ui.h('summary', null, title);
  const body = ctx.ui.h('div', 'mc-foldbody');
  if (note) body.append(ctx.ui.h('div', 'pagedesc', note));
  el.append(sum, body);
  return { el, body };
}
