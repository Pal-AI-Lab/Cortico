/**
 * executor 行为测试 第 4/4 份(见 executor-harness.ts)。
 * 分份只为并行,按实测耗时配平;哪个 describe 落在哪一份没有语义。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  causalNeeds, deriveExpect, describeSkill, Executor, Reflexes, parseSteps,
  skillNeeds, skillProduces, zhErrorText, type SkillCall, type ResourcePlacementGate, type TaskReport,
} from '../../../src/worlds/minecraft/executor.ts';
import { defaultPolicy } from '../../../src/worlds/minecraft/policy.ts';
import { ChestBook } from '../../../src/worlds/minecraft/chests.ts';
import { WorksBook } from '../../../src/worlds/minecraft/works.ts';
import { MinecraftLog } from '../../../src/worlds/minecraft/log.ts';
import {
  log,
  nextTaskId,
  sleep,
  waitUntil,
  SLOW,
  makeExecutor,
  V,
  FakeGoal,
  combatBot,
  makeExecutorOn,
  makeExecutorWith,
  makeExecutorWithWorks,
  craftBot,
  gridCraftBot,
  chestBot,
  furnaceBot,
  drownBot,
  makeReflexes,
} from './executor-harness.ts';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Executor 编排', () => {
  it('submit 立即返回带时刻与调用的受理回执,完成后经 report 汇报', async () => {
    const { exec, reports, bot } = makeExecutor();
    const receipt = exec.submit([{ skill: 'chat', text: 'hi' }]);
    // 时刻 + 回念解析后的调用:交接之后她手上只剩回执,照着它重新规划
    expect(receipt).toMatch(/^\[\d{2}:\d{2}:\d{2}\] /);
    expect(receipt).toContain('{"skill":"chat","text":"hi"}');
    expect(receipt).not.toContain('事件告诉你');
    // 完成通知的预告属于常驻前缀，受理回执不重复。
    expect(receipt).not.toContain('做完了再说一声');
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(bot.said).toEqual(['hi']);
    expect(exec.current).toBeNull();
  });

  it('多步按顺序执行;多步任务的结局回执才带任务名', async () => {
    const { exec, reports, bot } = makeExecutor();
    exec.submit([
      { skill: 'chat', text: '一' },
      { skill: 'chat', text: '二' },
    ]);
    await waitUntil(() => reports.length === 1);
    expect(bot.said).toEqual(['一', '二']);
    // 多步:标签列出全程,好让"受阻于第几件"有参照
    expect(reports[0].text).toContain('「说: 一;说: 二」');
  });

  it('单步任务的结局回执不带标签:那会把同一件事说两遍', async () => {
    const { exec, reports } = makeExecutor();
    exec.submit([{ skill: 'chat', text: 'hi' }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].text).toMatch(
      /^\[\d{2}:\d{2}:\d{2}→\d{2}:\d{2}:\d{2} 共 [\d.]+s\] 任务#1完成: \{"skill":"chat","text":"hi"\}: 说了: hi$/,
    );
    // 单步任务不编号:一步的回执行就是它自己
    expect(reports[0].text).not.toContain('第 1 步');
    // 也不报单步耗时:整条 span 的「共 Xs」已经是同一个数
    expect(reports[0].text).not.toContain('用时');
  });

  /**
   * 结局回执提供受理、完成时刻与总耗时；发生排队时另报排队时长。
   */
  it('结局回执带受理→完成两个时刻与总耗时;排过队才多报排的那一段', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const { exec, reports } = makeExecutorOn(
      combatBot({ goto: async (arrive) => { await gate; arrive(); } }),
    );
    exec.submit([SLOW]);
    exec.submit([{ skill: 'chat', text: '排着的' }], 'append');
    await sleep(1100);
    release!();
    await waitUntil(() => reports.length === 2, 5000);
    // 第一件没排队:只有受理→完成
    expect(reports[0].text).toMatch(/^\[\d{2}:\d{2}:\d{2}→\d{2}:\d{2}:\d{2} 共 [\d.]+s\] /);
    expect(reports[0].text).not.toContain('排队');
    // 第二件等了一秒多:排的那一段单列,与执行耗时分开
    expect(reports[1].text).toContain(',排队 ');
  });

  it('回执与汇报带递增任务号', async () => {
    const { exec, reports } = makeExecutor();
    expect(exec.submit([{ skill: 'chat', text: 'x' }])).toContain('任务#1');
    await waitUntil(() => reports.some((r) => r.kind === 'done'));
    expect(reports.find((r) => r.kind === 'done')!.text).toContain('任务#1');
    expect(exec.submit([{ skill: 'chat', text: 'y' }])).toContain('任务#2');
    await waitUntil(() => reports.filter((r) => r.kind === 'done').length === 2);
  });

  it('preempt:空闲时无动作', async () => {
    const { exec, reports } = makeExecutor();
    exec.preempt('脱离战斗');
    expect(reports).toHaveLength(0);
  });

  it('mc_stop:有任务时叫停并复位,空闲时返回 null 交给 World 措辞', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const { exec } = makeExecutor(gate);
    exec.submit([SLOW]);
    expect(exec.clear()).toContain('已叫停');
    expect(exec.current).toBeNull();
    expect(exec.clear()).toBeNull();
    release!();
  });

  it('pathfinder 的英文报错进事件前翻成中文,认不出的原样保留', () => {
    expect(zhErrorText('Path was stopped before it could be completed! Thus, the desired goal was not reached.'))
      .toBe('寻路半途被叫停');
    expect(zhErrorText('The goal was changed before it could be completed!')).toBe('目标中途被更换');
    expect(zhErrorText('No path to the goal!')).toBe('找不到可行路线');
    expect(zhErrorText('Digging aborted')).toBe('挖到一半被打断了');
    expect(zhErrorText('材料不够')).toBe('材料不够');
  });

  /**
   * 寻路超时只表示未完成搜索，不能推断为不存在路线。
   */
  it('限时没搜完只说没搜完:不替 pathfinder 补"太远或根本没路"', () => {
    const zh = zhErrorText('Took to long to decide path to goal!');
    expect(zh).toBe('限时内没算完');
    expect(zh).not.toContain('太远');
    expect(zh).not.toContain('没路');
  });

  it('shutdown 后迟到回调不改状态、不发汇报', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const { exec, reports } = makeExecutor(gate);
    exec.submit([SLOW]);
    exec.shutdown();
    // 停机投递一次 cancelled；之后迟到的回调不能再次报告。
    expect(reports.map((r) => r.kind)).toEqual(['cancelled']);
    expect(reports[0].text).toContain('被World 停止');
    release!();
    await sleep(50);
    expect(reports).toHaveLength(1);
    expect(exec.submit([{ skill: 'chat', text: 'x' }])).toContain('未启动');
  });

  it('cancelForDeath 清当前与队列:旧异步迟到不汇报、不继续泵,新身体可接新任务', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const { exec, reports, bot } = makeExecutor(gate);
    const clearGoal = vi.spyOn(bot.pathfinder, 'setGoal');
    exec.submit([SLOW]);
    exec.submit([{ skill: 'chat', text: '旧队列' }], 'append');
    expect(exec.status().waiting).toHaveLength(1);

    exec.cancelForDeath();
    expect(exec.status()).toEqual({ running: null, waiting: [], hold: null });
    expect(clearGoal).toHaveBeenLastCalledWith(null);

    exec.submit([{ skill: 'chat', text: '新身体' }]);
    await waitUntil(() => reports.length === 1);
    release!();
    await sleep(50);
    expect(reports.map((r) => [r.kind, r.taskId])).toEqual([['done', 3]]);
    expect(bot.said).toEqual(['新身体']);
    expect(exec.status()).toEqual({ running: null, waiting: [], hold: null });
  });
});

describe('equip:盔甲穿身上,不是全塞主手', () => {
  function wardrobeBot() {
    const equips: Array<[string, string]> = [];
    // equip 到主手要跟着改 heldItem:真 mineflayer 就是这么做的,而推导出来的
    // {holding} 判据读的正是它
    const bot = {
      equips,
      entity: { id: 9, position: new V(0.5, 64, 0.5) },
      entities: {},
      health: 20,
      players: {},
      heldItem: null as { name: string } | null,
      inventory: {
        items: () => [
          { name: 'iron_leggings', type: 1, count: 1 },
          { name: 'shield', type: 2, count: 1 },
          { name: 'stone_sword', type: 3, count: 1 },
        ],
      },
      equip: async (it: { name: string }, dest: string) => {
        equips.push([it.name, dest]);
        if (dest === 'hand') bot.heldItem = it;
      },
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    return bot;
  }

  it('受理刻试算在 equip 开工前读取背包', async () => {
    const helmet = { name: 'iron_helmet', type: 100, count: 1 };
    const bag = [helmet];
    let equipped = false;
    const bot = {
      entity: { id: 9, position: new V(0.5, 64, 0.5), onGround: true },
      entities: {},
      health: 20,
      players: {},
      registry: {
        blocksByName: {},
        items: { 100: { name: 'iron_helmet' } },
        itemsByName: { iron_helmet: { id: 100, equipmentSlot: 'head' } },
      },
      inventory: { items: () => bag },
      equip: async () => {
        equipped = true;
        bag.splice(0, 1);
      },
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    const { exec, reports } = makeExecutorOn(bot);
    const receipt = exec.submit([{ skill: 'equip', item: 'iron_helmet' }]);

    expect(receipt).not.toContain('包里没有铁头盔');
    await waitUntil(() => reports.length === 1);
    expect(equipped).toBe(true);
    expect(reports[0].kind).toBe('done');
  });

  it('护腿进腿槽、盾牌挂副手、剑拿主手,回执按槽位说话', async () => {
    const bot = wardrobeBot();
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([
      { skill: 'equip', item: 'iron_leggings' },
      { skill: 'equip', item: 'shield' },
      { skill: 'equip', item: 'stone_sword' },
    ]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(bot.equips).toEqual([['iron_leggings', 'legs'], ['shield', 'off-hand'], ['stone_sword', 'hand']]);
    expect(reports[0].text).toContain('穿上了铁护腿');
    expect(reports[0].text).toContain('盾牌挂上了副手');
    expect(reports[0].text).toContain('手里拿起了石剑');
  });

  it('item 写简称 leggings 也判得对槽位', async () => {
    const bot = wardrobeBot();
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'equip', item: 'leggings' }]);
    await waitUntil(() => reports.length === 1);
    expect(bot.equips).toEqual([['iron_leggings', 'legs']]);
    expect(reports[0].text).toContain('穿上了铁护腿');
  });

  /**
   * 名字匹配的次序:精确名 → `_后缀` → `前缀_`。
   * 旧的 `includes` 会让 equip "axe" 命中钻石镐(pickaxe 里就带着 axe),
   * 拿到哪一件全看物品栏顺序——那不是她说的意思。
   */
  it('equip 按精确名优先,不用 includes 模糊命中', async () => {
    const picked: string[] = [];
    const bag = [
      { name: 'diamond_pickaxe', type: 1, count: 1 },
      { name: 'iron_axe', type: 2, count: 1 },
      // 精确名排在带前缀的那件后面:照样该由精确名胜出
      { name: 'enchanted_golden_apple', type: 3, count: 1 },
      { name: 'golden_apple', type: 4, count: 1 },
    ];
    const bot = {
      entity: { id: 9, position: new V(0.5, 64, 0.5) },
      entities: {},
      health: 20,
      players: {},
      heldItem: null as { name: string } | null,
      inventory: { items: () => bag },
      equip: async (it: { name: string }, dest: string) => {
        picked.push(it.name);
        if (dest === 'hand') bot.heldItem = it;
      },
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'equip', item: 'axe' }, { skill: 'equip', item: 'golden_apple' }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(picked).toEqual(['iron_axe', 'golden_apple']);
  });

  it('equip 一件都对不上:说清包里名字带这几个字的有哪些', async () => {
    const bot = wardrobeBot();
    const { exec, reports } = makeExecutorOn(bot);
    // "leg" 三条规则都不命中(不是全名、不是 _leg 后缀、不是 leg_ 前缀),
    // 但铁护腿的名字里确实带这几个字:照实列出来,不替她挑
    exec.submit([{ skill: 'equip', item: 'leg' }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('名字带这几个字的有:铁护腿');
  });

  /** 腾手的假 bot:手上拿着鞍。tossOnUnequip = 包满时 mineflayer 把它扔在地上那一支 */
  function handBot(opts: { held?: boolean; tossOnUnequip?: boolean } = {}) {
    const bag = [{ name: 'saddle', type: 1, count: 1 }];
    let held: { name: string; type: number; count: number } | null = opts.held === false ? null : bag[0];
    const unequipped: string[] = [];
    return {
      unequipped,
      entity: { id: 9, position: new V(0.5, 64, 0.5) },
      entities: {},
      health: 20,
      players: {},
      inventory: { items: () => bag },
      get heldItem() { return held; },
      equip: async (it: { name: string; type: number; count: number }) => { held = it; },
      unequip: async (dest: string) => {
        unequipped.push(dest);
        held = null;
        if (opts.tossOnUnequip) bag.splice(0, 1);
      },
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
  }


  it('equip 不写 item = 腾空主手;她写的 "air" 是同一件事', async () => {
    const parsed = parseSteps([{ skill: 'equip', item: 'air' }]);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.steps[0]).toEqual({ skill: 'equip' });
    expect(parsed.notes).toEqual([
      { step: 1, field: 'item', given: 'air', kind: 'rewritten', as: '空手' },
    ]);

    const bot = handBot();
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit(parsed.steps);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(bot.unequipped).toEqual(['hand']);
    expect(reports[0].text).toContain('主手腾空了(原来拿的是鞍)');
  });

  it('手上本来就是空的:不必去动物品栏', async () => {
    const bot = handBot({ held: false });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'equip' }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(bot.unequipped).toEqual([]);
    expect(reports[0].text).toContain('主手本来就是空的');
  });

  // 包满时 mineflayer 的 equipEmpty 把手上这摞 tossStack 掉:东西真的落地了,回执要说
  it('腾手时包是满的:手上那摞被扔在脚下,回执照实报', async () => {
    const bot = handBot({ tossOnUnequip: true });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'equip' }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('包是满的,鞍×1被扔在了脚下');
  });
});

describe('合成:回执报实际入包,不报配方的预期产物', () => {
  it('合成成功时报实际多出来的数量', async () => {
    const bot = craftBot({ logs: 4, gain: 'real' });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'craft', item: 'acacia_planks', count: 4 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('合成出来:金合欢木板×4');
  });

  // grid 形态:她自己摆格子,产物由服务端裁决,执行器只负责把 inShape 摆进去
  it('craft grid:名字二维数组照原样摆进合成格,2×2 以内不占工作台', async () => {
    const bot = gridCraftBot();
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'craft', grid: [['charcoal'], ['stick']], count: 1 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(bot.seen).toHaveLength(1);
    expect(bot.seen[0].inShape).toEqual([[{ id: 11 }], [{ id: 12 }]]);
    expect(bot.seen[0].requiresTable).toBe(false);
    expect(bot.seen[0].table).toBeUndefined();
    // 产量按物品栏净增报,不照配方复述
    expect(reports[0].text).toContain('合成出来:火把×4');
  });

  it('craft grid:超过 2×2 就要工作台,现成的那个进 bot.craft', async () => {
    const bot = gridCraftBot({ tableNearby: true });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{
      skill: 'craft',
      grid: [['oak_planks', 'oak_planks', 'oak_planks'], [null as never, 'stick', null as never]],
      count: 1,
    }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(bot.seen[0].requiresTable).toBe(true);
    expect(bot.seen[0].table).toMatchObject({ name: 'crafting_table' });
    // 空位摆 null,不是"跳过这一格"
    expect(bot.seen[0].inShape).toEqual([
      [{ id: 14 }, { id: 14 }, { id: 14 }],
      [null, { id: 12 }, null],
    ]);
  });

  it('一次一调,不把 times 交给 bot.craft 一次做完', async () => {
    const bot = craftBot({ logs: 4, gain: 'real' });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'craft', item: 'acacia_planks', count: 8 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(bot.crafts).toEqual([1, 1]);
    expect(reports[0].text).toContain('金合欢木板×8');
  });

  it('craft 没报错但东西没进包:按物品栏净增判,报的是一样都没多出来', async () => {
    const bot = craftBot({ logs: 4, gain: 'none' });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'craft', item: 'acacia_planks', count: 4 }]);
    await waitUntil(() => reports.length === 1, 15_000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('一样都没多出来');
    expect(bot.crafts).toEqual([1]);
  }, 20_000);

  /**
   * 配方树没了:中间材料不再自动补齐。材料不齐时报的是这一条配方要的**直接材料**,
   * 她自己决定先去做哪一样("要木镐就自己写合木板;合木棍;合木镐")。
   */
  it('材料不齐:报直接材料要什么,不递归往下找材料的材料', async () => {
    const bot = craftBot({ logs: 0, planks: 8, gain: 'real' });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'craft', item: 'acacia_planks', count: 12 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('金合欢木板的配方要:金合欢原木×1');
    expect(reports[0].text).toContain('包里凑不齐');
    expect(bot.crafts).toEqual([]);
  });

  /**
   * craft 的目标是库存达到要求数量；库存已足够时可达成，并说明本次没有合成。
   */
  it('东西本来就够:配方凑不齐也按做成收,回执说清没现搓', async () => {
    const bot = craftBot({ logs: 0, planks: 8, gain: 'real' });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'craft', item: 'acacia_planks', count: 4 }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('没现搓金合欢木板');
    expect(reports[0].text).toContain('包里本来就有 8 个,够这一步要的 4 个了');
    expect(bot.crafts).toEqual([]);
  });
});

/**
 * 工作台合成夹具:包里有木板和一个自带的工作台,附近没有现成的。
 * 中间材料不再自动补齐(配方树已撤),所以工作台必须是她自己带的。
 * `placement` 覆盖成功、服务端未确认与无候选位置三种结果。
 */

describe('use 开容器:那一眼不白开(记进账本)', () => {
  function useBot(win: Record<string, unknown>, blockName: string) {
    const bot = {
      entity: { id: 1, position: new V(0.5, 64, 0.5) },
      entities: {},
      game: { dimension: 'overworld' },
      registry: { blocksByName: { [blockName]: { id: 54 } }, itemsByName: {} },
      inventory: { items: () => [] },
      heldItem: null,
      currentWindow: null as Record<string, unknown> | null,
      activateBlock: async () => { bot.currentWindow = win; },
      closeWindow: () => { bot.currentWindow = null; },
      blockAt: (p: V) => (p.x === 2 && p.y === 64 && p.z === 0
        ? { name: blockName, position: p, boundingBox: 'block', stateId: 1 }
        : { name: 'air', position: p, boundingBox: 'empty', stateId: 0 }),
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    return bot;
  }

  it('右键箱子:关窗前记账,回执带「箱里」', async () => {
    const book = new ChestBook(null);
    const bot = useBot({ containerItems: () => [{ name: 'melon_slice', count: 32 }], inventoryStart: 27 }, 'chest');
    const { exec, reports } = makeExecutorWith(bot, book);
    exec.submit([{ skill: 'use', at: [2, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('箱里:西瓜片×32');
    expect(book.get('overworld', { x: 2, y: 64, z: 0 })?.items).toEqual([{ name: 'melon_slice', count: 32 }]);
  });

  // use 的 item 指手持物；误把目标方块写成手持物时，受阻回执提供可接受的调用形状。
  it('use 带 item 撞上"那一格就是它":受阻回执给出正确写法', async () => {
    const bot = {
      entity: { id: 1, position: new V(0.5, 64, 0.5) },
      entities: {},
      game: { dimension: 'overworld' },
      registry: { blocksByName: { white_bed: { id: 100 } }, itemsByName: {} },
      inventory: { items: () => [] },
      heldItem: null,
      blockAt: (p: V) => {
        const f = p.floored();
        return f.x === 0 && f.y === 64 && f.z === -1
          ? { name: 'white_bed', position: p, boundingBox: 'block', stateId: 1 }
          : { name: 'air', position: p, boundingBox: 'empty', stateId: 0 };
      },
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'use', item: 'white_bed', at: [0, 64, -1] }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('包里没有白色床');
    expect(reports[0].text).toContain('那一格本身就是白色床');
    expect(reports[0].text).toContain('{"skill":"use","at":[0,64,-1]}');
  });

  it('右键炉子:三槽位入账,没有炉火和进度读数就不估到期', async () => {
    const book = new ChestBook(null);
    const bot = useBot({
      slots: [{ name: 'raw_iron', count: 3 }, null, { name: 'iron_ingot', count: 1 }],
    }, 'furnace');
    const { exec, reports } = makeExecutorWith(bot, book);
    exec.submit([{ skill: 'use', at: [2, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('炉里:输入粗铁×3,燃料空,输出铁锭×1');
    const rec = book.get('overworld', { x: 2, y: 64, z: 0 })!;
    expect(rec.furnace?.input).toEqual({ name: 'raw_iron', count: 3 });
    expect(rec.furnace?.expectedDoneAt).toBeNull();
  });
});

describe('smelt:下料点火就走(B1 解耦)', () => {
  const FURNACE_AT = [{ x: 2, y: 64, z: 0, name: 'furnace' }];

  function slotFurnace(opts: {
    fuelName?: string; fuelCount?: number; rejectFuel?: boolean; inputLimit?: number;
    fuelLevel?: number; progress?: number; consumedFuel?: number; staleTakeFails?: boolean;
  } = {}) {
    const fuelName = opts.fuelName ?? 'coal';
    const { bot: base, inv } = furnaceBot({ inv: { raw_iron: 8, [fuelName]: opts.fuelCount ?? 30 }, furnaces: FURNACE_AT });
    type Stack = { name: string; count: number };
    let input: Stack | null = null;
    let fuel: Stack | null = null;
    let output: Stack | null = opts.staleTakeFails ? { name: 'glass', count: 3 } : null;
    const move = (name: string, count: number): Stack => {
      const n = Math.min(count, inv.get(name) ?? 0);
      inv.set(name, (inv.get(name) ?? 0) - n);
      return { name, count: n };
    };
    const bot = {
      ...base,
      openFurnace: async () => ({
        fuel: opts.fuelLevel ?? 0, progress: opts.progress ?? 0,
        inputItem: () => input, fuelItem: () => fuel, outputItem: () => output,
        putFuel: async (_type: number, _meta: unknown, count: number) => {
          if (!opts.rejectFuel) fuel = move(fuelName, count);
        },
        putInput: async (_type: number, _meta: unknown, count: number) => {
          const accepted = Math.min(count, opts.inputLimit ?? count);
          if (accepted > 0) input = move('raw_iron', accepted);
          if (fuel) {
            fuel.count -= opts.consumedFuel ?? 0;
            if (fuel.count <= 0) fuel = null;
          }
        },
        takeOutput: async () => {
          if (opts.staleTakeFails) throw new Error('No inventory space');
          if (output) inv.set(output.name, (inv.get(output.name) ?? 0) + output.count);
          output = null;
        },
        close() {},
      }),
    };
    return { bot, inv };
  }

  it('燃料槽拒收火把但写入调用返回:回执、日志和账本都按空燃料槽报告', async () => {
    const { bot, inv } = slotFurnace({ fuelName: 'torch', rejectFuel: true });
    const book = new ChestBook(null);
    const diag = new MinecraftLog();
    const reports: TaskReport[] = [];
    const exec = new Executor({ getBot: () => bot as never, report: (r) => reports.push(r),
      log, nextId: nextTaskId(), chests: book, diag });
    exec.submit([{ skill: 'smelt', input: 'raw_iron', count: 8, fuel: 'torch' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(inv.get('raw_iron')).toBe(0);
    expect(inv.get('torch')).toBe(30);
    expect(reports[0].text).toContain('输入槽粗铁×8,燃料槽空,输出槽空');
    expect(reports[0].text).toContain('未确认炉火正在燃烧');
    expect(reports[0].text).toContain('当前不估完成时间');
    expect(reports[0].text).not.toContain('燃料槽火把×30');
    expect(book.get('overworld', { x: 2, y: 64, z: 0 })?.furnace?.expectedDoneAt).toBeNull();
    expect(diag.after(0).find((r) => r.event === 'smelt-loaded')?.data)
      .toMatchObject({ input: { name: 'raw_iron', count: 8 }, fuel: null, fuelLevel: 0, expectedDoneAt: null });
  });

  it.each([0, 3])('输入槽实际只接受 %i 件:不把请求的八件写成已入槽', async (inputLimit) => {
    const { bot, inv } = slotFurnace({ inputLimit });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'smelt', input: 'raw_iron', count: 8, fuel: 'coal' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(inv.get('raw_iron')).toBe(8 - inputLimit);
    expect(reports[0].text).toContain(inputLimit ? '输入槽粗铁×3' : '输入槽空');
    expect(reports[0].text).not.toContain('输入槽粗铁×8');
    expect(reports[0].text).toContain('当前不估完成时间');
  });

  it('燃料槽已消耗为空但炉火与进度仍有效:按实际剩料估时并登记提醒', async () => {
    const { bot } = slotFurnace({ fuelCount: 1, fuelLevel: 0.99, progress: 0.25, consumedFuel: 1 });
    const book = new ChestBook(null);
    const { exec, reports } = makeExecutorWith(bot, book);
    const before = Date.now();
    exec.submit([{ skill: 'smelt', input: 'raw_iron', count: 8, fuel: 'coal' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('燃料槽空');
    expect(reports[0].text).toContain('炉火读数正在燃烧,烧炼进度读数 25%');
    const rec = book.get('overworld', { x: 2, y: 64, z: 0 })!;
    expect(rec.furnace!.expectedDoneAt).toBeGreaterThanOrEqual(before + 77_500);
    expect(rec.furnace!.expectedDoneAt).toBeLessThanOrEqual(Date.now() + 77_500);
    const later = rec.furnace!.expectedDoneAt! + 1;
    expect(book.due(later)).toHaveLength(1);
    book.markNotified('overworld', rec);
    expect(book.due(later)).toHaveLength(0);
  });

  it('有炉火但没有烧炼进度:不把热炉子当作配方已经开始', async () => {
    const { bot } = slotFurnace({ fuelLevel: 0.5 });
    const book = new ChestBook(null);
    const { exec, reports } = makeExecutorWith(bot, book);
    exec.submit([{ skill: 'smelt', input: 'raw_iron', count: 8, fuel: 'coal' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('炉火读数正在燃烧,未确认烧炼进度');
    expect(book.get('overworld', { x: 2, y: 64, z: 0 })?.furnace?.expectedDoneAt).toBeNull();
  });

  it('旧成品取出失败:回执保留实际输出槽,不声称已收走', async () => {
    const { bot, inv } = slotFurnace({ staleTakeFails: true });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'smelt', input: 'raw_iron', count: 8, fuel: 'coal' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('上一炉的玻璃×3仍在输出槽');
    expect(reports[0].text).toContain('输出槽玻璃×3');
    expect(reports[0].text).not.toContain('先收走了');
    expect(inv.get('glass') ?? 0).toBe(0);
  });

  it('下料期间已经烧完:回执给真实三槽位、炉子坐标与取货 JSON', async () => {
    const { bot, inv } = furnaceBot({ inv: { raw_iron: 8, coal: 2 }, furnaces: FURNACE_AT });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'smelt', input: 'raw_iron', count: 8, fuel: 'coal' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('下料后读到');
    expect(reports[0].text).toContain('输入槽空');
    expect(reports[0].text).toContain('燃料槽煤炭×1');
    expect(reports[0].text).toContain('输出槽铁锭×8');
    expect(reports[0].text).toContain('当前不估完成时间');
    expect(reports[0].text).toContain('烧一件约 10 秒');
    expect(reports[0].text).toContain('取货:{"skill":"take","at":[2,64,0],"all":true}');
    expect(reports[0].text).not.toContain('得到');
    // 料真进炉子了,不在包里
    expect(inv.get('raw_iron')).toBe(0);
    expect(inv.get('coal')).toBe(0);
  });

  it('take at 指着炉子收货:输出+剩的燃料各报各的,包里的账对得上', async () => {
    const { bot, inv } = furnaceBot({ inv: { raw_iron: 8, coal: 2 }, furnaces: FURNACE_AT });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'smelt', input: 'raw_iron', count: 8, fuel: 'coal' }]);
    await waitUntil(() => reports.length === 1, 8000);
    exec.submit([{ skill: 'take', at: [2, 64, 0], all: true }]);
    await waitUntil(() => reports.length === 2, 8000);
    expect(reports[1].kind).toBe('done');
    expect(reports[1].text).toContain('输出槽的铁锭×8');
    // 两块煤只烧掉一块,剩的那块取货拿回来——多塞不亏
    expect(reports[1].text).toContain('没烧掉的燃料煤炭×1');
    expect(inv.get('iron_ingot')).toBe(8);
    expect(inv.get('coal')).toBe(1);
  });

  // fuel 现在必写:烧什么由她定,执行器不再替她挑
  it('fuel 必写,写哪样烧哪样;别的燃料一个不动', async () => {
    const { bot, inv } = furnaceBot({
      inv: { raw_iron: 2, coal: 1, oak_planks: 8 },
      furnaces: FURNACE_AT,
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'smelt', input: 'raw_iron', count: 2, fuel: 'oak_planks' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('橡木木板');
    expect(inv.get('coal')).toBe(1);
    // 不写 fuel 当场退回,不猜
    const bad = parseSteps([{ skill: 'smelt', input: 'raw_iron', count: 2 }]);
    expect('error' in bad && bad.error).toContain('fuel');
  });

  // 槽位名照抄原版熔炉界面(input/fuel/output);同一个槽不留第二种拼法。
  // `item` 还是另外 8 个技能的字段名,收作别名就得再有一条两者同时出现时的裁决规则,
  // 而整批退回本来就点名说清是第几步哪个字段。
  it('原料槽只认 input:写别的名字整批退回,并点名要 input', () => {
    const bad = parseSteps([{ skill: 'smelt', item: 'raw_iron', count: 2, fuel: 'coal' }]);
    expect('error' in bad && bad.error).toContain('input');
  });

  it('产物由服务端裁决:回执报告实际输出槽里的木炭', async () => {
    const { bot, inv } = furnaceBot({ inv: { oak_log: 4, coal: 1 }, furnaces: FURNACE_AT });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'smelt', input: 'log', count: 4, fuel: 'coal' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('输出槽木炭×4');
    expect(inv.get('oak_log')).toBe(0);
    exec.submit([{ skill: 'take', at: [2, 64, 0], all: true }]);
    await waitUntil(() => reports.length === 2, 8000);
    expect(reports[1].text).toContain('木炭×4');
    expect(inv.get('charcoal')).toBe(4);
  });

  /**
   * 因缺少指定物品受阻时，回执提供当刻完整背包供核对，不替换物品或提出建议。
   */
  it('包里没有要烧的那样东西:直说没有,不替她换成别的;回执带当刻全量背包', async () => {
    const { bot } = furnaceBot({ inv: { raw_iron: 4, coal: 1 }, furnaces: FURNACE_AT });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'smelt', input: 'iron_ingot', count: 4, fuel: 'coal' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('包里没有铁锭');
    expect(reports[0].text).toContain('[背包] 粗铁×4、煤炭×1');
  });

  it('没有燃料当场直说;取货撞上空炉也照实说', async () => {
    const noFuel = furnaceBot({ inv: { raw_iron: 4 }, furnaces: FURNACE_AT });
    const b = makeExecutorOn(noFuel.bot);
    b.exec.submit([{ skill: 'smelt', input: 'raw_iron', count: 4, fuel: 'coal' }]);
    await waitUntil(() => b.reports.length === 1, 8000);
    expect(b.reports[0].kind).toBe('blocked');
    expect(b.reports[0].text).toContain('包里没有煤炭');

    // 烧不出东西的料(泥土):下料照下——能不能烧由服务端裁决;取货时三个槽都空,照实报
    const dirt = furnaceBot({ inv: { dirt: 1, coal: 1 }, furnaces: FURNACE_AT });
    const a = makeExecutorOn(dirt.bot);
    a.exec.submit([{ skill: 'smelt', input: 'dirt', count: 1, fuel: 'coal' }]);
    await waitUntil(() => a.reports.length === 1, 8000);
    expect(a.reports[0].kind).toBe('done');
    a.exec.submit([{ skill: 'take', at: [2, 64, 0], all: true }]);
    await waitUntil(() => a.reports.length === 2, 8000);
    expect(a.reports[1].kind).toBe('blocked');
    expect(a.reports[1].text).toContain('三个槽都是空的');
  }, 30_000);

  it('附近没炉子就放一个自己带的;一个都没有时说清要先造', async () => {
    const carried = furnaceBot({ inv: { raw_iron: 2, coal: 1, furnace: 1 } });
    const a = makeExecutorOn(carried.bot);
    a.exec.submit([{ skill: 'smelt', input: 'raw_iron', count: 2, fuel: 'coal' }]);
    await waitUntil(() => a.reports.length === 1, 8000);
    expect(a.reports[0].kind).toBe('done');
    expect(carried.placed).toEqual(['furnace']);

    const none = furnaceBot({ inv: { raw_iron: 2, coal: 1 } });
    const b = makeExecutorOn(none.bot);
    b.exec.submit([{ skill: 'smelt', input: 'raw_iron', count: 2, fuel: 'coal' }]);
    await waitUntil(() => b.reports.length === 1, 8000);
    expect(b.reports[0].kind).toBe('blocked');
    expect(b.reports[0].text).toContain('craft 一个熔炉');
  });

  // 炉子这一族不再按料分诊:哪种炉子接哪种料由服务端说了算,最近的那座就是那座
  it('挑最近的那座炉子,不按料先分诊:旁边只有高炉就用高炉,估时按高炉减半', async () => {
    const blast = [{ x: 2, y: 64, z: 0, name: 'blast_furnace' }];
    const ore = furnaceBot({ inv: { raw_iron: 2, coal: 1 }, furnaces: blast });
    const a = makeExecutorOn(ore.bot);
    a.exec.submit([{ skill: 'smelt', input: 'raw_iron', count: 2, fuel: 'coal' }]);
    await waitUntil(() => a.reports.length === 1, 8000);
    expect(a.reports[0].kind).toBe('done');
    expect(a.reports[0].text).toContain('高炉');
    // 原版:高炉/烟熏炉 100 刻一件,熔炉的一半
    expect(a.reports[0].text).toContain('烧一件约 5 秒');
  });

  it('开炉先把上一炉剩在输出槽的成品收走,收走的写进回执', async () => {
    const { bot, inv } = furnaceBot({
      inv: { raw_iron: 2, coal: 1 },
      furnaces: FURNACE_AT,
      stale: { name: 'glass', count: 3 },
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'smelt', input: 'raw_iron', count: 2, fuel: 'coal' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('先收走了上一炉剩在输出槽的玻璃×3');
    expect(inv.get('glass')).toBe(3);
  });

  it('take at:关窗后包里的账没跟着变,报"以包里为准",不冒充没拿到', async () => {
    const { bot } = furnaceBot({
      inv: { raw_iron: 2, coal: 1 },
      furnaces: FURNACE_AT,
      noCopyBack: true,
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'smelt', input: 'raw_iron', count: 2, fuel: 'coal' }]);
    await waitUntil(() => reports.length === 1, 8000);
    exec.submit([{ skill: 'take', at: [2, 64, 0], all: true }]);
    await waitUntil(() => reports.length === 2, 12000);
    expect(reports[1].kind).toBe('done');
    expect(reports[1].text).toContain('输出槽的铁锭×2');
    expect(reports[1].text).toContain('拿没拿到以包里为准');
  });
});

describe('Reflexes 防溺水', () => {
  it('旱地上的残留低氧读数不触发溺水(氧气元数据会冻在旧值)', () => {
    const bot = drownBot('air', 3);
    const { reflexes, reports } = makeReflexes(bot);
    reflexes.start();
    vi.advanceTimersByTime(6_000);
    reflexes.stop();
    expect(reports).toHaveLength(0);
    expect(bot.jumps).toHaveLength(0);
  });

  it('头在水下且持续低氧才触发:上浮 + 一次急报,20s 内不重复', () => {
    const bot = drownBot('water', 3);
    const { reflexes, reports } = makeReflexes(bot);
    reflexes.start();
    vi.advanceTimersByTime(10_000);
    reflexes.stop();
    expect(reports).toHaveLength(1);
    expect(reports[0].text).toContain('氧气 3/20');
    expect(bot.jumps).toContain(true);
  });

  it('刚下水的头两秒不看氧气:旧读数要等元数据跟上', () => {
    const bot = drownBot('water', 3);
    const { reflexes, reports } = makeReflexes(bot);
    reflexes.start();
    vi.advanceTimersByTime(2_000);
    expect(reports).toHaveLength(0);
    reflexes.stop();
  });

  it('浮出水面后复位:松开跳跃,不再报', () => {
    const bot = drownBot('water', 3);
    const { reflexes, reports } = makeReflexes(bot);
    reflexes.start();
    vi.advanceTimersByTime(5_000);
    expect(reports).toHaveLength(1);
    bot.setHead('air');
    vi.advanceTimersByTime(3_000);
    reflexes.stop();
    expect(bot.jumps[bot.jumps.length - 1]).toBe(false);
    expect(reports).toHaveLength(1);
  });

  it('头出水不交还任务,稳定干燥落脚 600ms 后才恢复环境断点', () => {
    let feet = 'water';
    let head = 'water';
    const controls: Array<[string, boolean]> = [];
    const goals: unknown[] = [];
    const pos = new V(10.5, 63, 10.5);
    const entity = { id: 1, position: pos, onGround: false, velocity: new V(0, 0, 0), metadata: [0] };
    const bot = {
      entity,
      oxygenLevel: 3,
      health: 20,
      food: 20,
      entities: {},
      blockAt(p: V) {
        const c = p.floored();
        if (c.x === 10 && c.z === 10 && c.y === 63) return { name: feet, boundingBox: 'empty' };
        if (c.x === 10 && c.z === 10 && c.y === 64) return { name: head, boundingBox: 'empty' };
        if (c.y === 62) return { name: 'stone', boundingBox: 'block' };
        return { name: 'air', boundingBox: 'empty' };
      },
      setControlState(k: string, v: boolean) { controls.push([k, v]); },
      pathfinder: { setGoal(goal: unknown) { goals.push(goal); }, stop() {} },
      on() {},
      removeListener() {},
    };
    const token = { owner: Symbol('drown-test') };
    let held = false;
    const pauses: string[] = [];
    const resumes: unknown[] = [];
    const reports: TaskReport[] = [];
    const reflexes = new Reflexes({
      getBot: () => bot as never,
      report: (report) => reports.push(report),
      log,
      preempt: () => { throw new Error('环境危机不该走破坏性抢占'); },
      pauseEnvironment: (reason) => { pauses.push(reason); held = true; return token; },
      resumeEnvironment: (received) => {
        resumes.push(received);
        const released = held && received === token;
        if (released) held = false;
        return { released, note: released ? '刚才任务#8 接着做' : null };
      },
      stopFallTask: () => null,
      resumeAfterFall: () => false,
      fightBack: () => false,
      fleeHealth: () => 8,
      reactCooldownSec: () => 8,
      antiDrown: () => true,
      antiLava: () => false,
    });
    reflexes.start();
    vi.advanceTimersByTime(2_600);
    expect(pauses).toEqual(['防溺水上浮找岸']);
    expect(goals.length).toBeGreaterThan(0);

    head = 'air';
    vi.advanceTimersByTime(1_000);
    expect(resumes).toEqual([]);
    expect(held).toBe(true);
    expect(reflexes.environmentOwnerKind).toBe('drown');

    feet = 'air';
    entity.onGround = true;
    vi.advanceTimersByTime(1_000);
    reflexes.stop();

    expect(resumes).toEqual([token]);
    expect(held).toBe(false);
    expect(reflexes.environmentOwnerKind).toBeNull();
    expect(reports.some((report) => report.text.includes('刚才任务#8 接着做'))).toBe(true);
    expect(controls).toContainEqual(['jump', false]);
  });

  /**
   * 开阔水域头已出水且氧气恢复时可释放环境租约，不能一直等待脚下干燥。
   */
  it('开阔水域头出水且氧气回满:就地交还队列,不等一个不会来的干燥落脚', () => {
    let head = 'water';
    const pos = new V(10.5, 63, 10.5);
    const entity = { id: 1, position: pos, onGround: false, velocity: new V(0, 0, 0), metadata: [0] };
    const bot = {
      entity,
      oxygenLevel: 3,
      health: 20,
      food: 20,
      entities: {},
      blockAt(p: V) {
        const c = p.floored();
        if (c.x === 10 && c.z === 10 && c.y === 64) return { name: head, boundingBox: 'empty' };
        // 四面八方全是水:脚下没有一格实心的,hasDryFooting 恒假
        return { name: 'water', boundingBox: 'empty' };
      },
      setControlState() {},
      pathfinder: { setGoal() {}, stop() {} },
      on() {},
      removeListener() {},
    };
    const token = { owner: Symbol('open-water') };
    let held = false;
    const pauses: string[] = [];
    const resumes: unknown[] = [];
    const reports: TaskReport[] = [];
    const reflexes = new Reflexes({
      getBot: () => bot as never,
      report: (report) => reports.push(report),
      log,
      preempt: () => { throw new Error('环境危机不该走破坏性抢占'); },
      pauseEnvironment: (reason) => { pauses.push(reason); held = true; return token; },
      resumeEnvironment: (received) => {
        resumes.push(received);
        const released = held && received === token;
        if (released) held = false;
        return { released, note: released ? '刚才任务#3 接着做' : null };
      },
      stopFallTask: () => null,
      resumeAfterFall: () => false,
      fightBack: () => false,
      fleeHealth: () => 8,
      reactCooldownSec: () => 8,
      antiDrown: () => true,
      antiLava: () => false,
    });
    reflexes.start();
    vi.advanceTimersByTime(2_600);
    expect(pauses).toEqual(['防溺水上浮找岸']);
    expect(reflexes.environmentOwnerKind).toBe('drown');

    // 换到一口气:头出水、氧气回满,但人还在水里游 —— 落脚永远不会干
    head = 'air';
    bot.oxygenLevel = 20;
    vi.advanceTimersByTime(400);
    reflexes.stop();

    expect(resumes).toEqual([token]);
    expect(held).toBe(false);
    expect(reflexes.environmentOwnerKind).toBeNull();
    expect(pauses).toEqual(['防溺水上浮找岸']);
    expect(reports.some((report) => report.text.includes('刚才任务#3 接着做'))).toBe(true);
  });

  it('溺水冻结超过 60 秒还没脱险:强制解冻,同一轮不再重新冻结', () => {
    const pos = new V(10.5, 63, 10.5);
    const bot = {
      entity: { id: 1, position: pos, onGround: false, velocity: new V(0, 0, 0), metadata: [0] },
      oxygenLevel: 0,
      health: 20,
      food: 20,
      entities: {},
      blockAt: () => ({ name: 'water', boundingBox: 'empty' }),
      setControlState() {},
      pathfinder: { setGoal() {}, stop() {} },
      on() {},
      removeListener() {},
    };
    const token = { owner: Symbol('stuck-under-water') };
    let held = false;
    const pauses: string[] = [];
    const resumes: unknown[] = [];
    const reports: TaskReport[] = [];
    const reflexes = new Reflexes({
      getBot: () => bot as never,
      report: (report) => reports.push(report),
      log,
      preempt: () => { throw new Error('环境危机不该走破坏性抢占'); },
      pauseEnvironment: (reason) => { pauses.push(reason); held = true; return token; },
      resumeEnvironment: (received) => {
        resumes.push(received);
        const released = held && received === token;
        if (released) held = false;
        return { released, note: released ? '刚才任务#5 接着做' : null };
      },
      stopFallTask: () => null,
      resumeAfterFall: () => false,
      fightBack: () => false,
      fleeHealth: () => 8,
      reactCooldownSec: () => 8,
      antiDrown: () => true,
      antiLava: () => false,
    });
    reflexes.start();
    // 租约是入水约 2.2 秒后起租的:59 秒时还不到点
    vi.advanceTimersByTime(59_000);
    expect(resumes).toEqual([]);
    expect(held).toBe(true);
    vi.advanceTimersByTime(6_000);

    const forced = reports.find((report) => report.text.includes('环境冻结'));
    expect(forced?.text).toContain('环境冻结(溺水)');
    expect(forced?.text).toContain('已解冻队列');
    expect(forced?.text).toContain('当时脚下是水');
    expect(resumes).toEqual([token]);
    expect(held).toBe(false);
    // 危险还在:队列已经交还,就不许再冻一次
    expect(reflexes.environmentOwnerKind).toBe('drown');
    vi.advanceTimersByTime(5_000);
    expect(pauses).toEqual(['防溺水上浮找岸']);
    reflexes.stop();
  });
});

/**
 * 反射逃生通过 setGoal 设置目标；空路径后仍须能够重新规划。
 */
describe('Reflexes 逃生目标看门狗', () => {
  it('低血脱离的目标 5 秒零推进:撤销并重下,案卷记下这条事实', () => {
    const setGoals: unknown[] = [];
    const pf = {
      goal: null as unknown,
      stop() {},
      setGoal(g: unknown) { setGoals.push(g); pf.goal = g; },
      goto: async () => {},
    };
    const zombie = { id: 2, name: 'zombie', type: 'mob', position: new V(2, 64, 0.5), isValid: true };
    const handlers: Array<(e: { id: number }, source?: typeof zombie) => void> = [];
    const bot = {
      entity: { id: 1, position: new V(0.5, 64, 0.5) },
      entities: { '2': zombie },
      health: 6,
      food: 20,
      inventory: { items: () => [] as never[] },
      equip: async () => {},
      lookAt: async () => {},
      attack: () => {},
      blockAt: () => null,
      setControlState: () => {},
      pathfinder: pf,
      on: (event: string, h: (x: { id: number }, source?: typeof zombie) => void) => {
        if (event === 'entityHurt') handlers.push(h);
      },
      removeListener: () => {},
    };
    const diag = new MinecraftLog();
    const reports: TaskReport[] = [];
    const { exec: environmentExec } = makeExecutorOn(bot);
    const reflexes = new Reflexes({
      getBot: () => bot as never,
      pauseEnvironment: (reason) => environmentExec.pauseForEnvironment(reason),
      resumeEnvironment: (token) => environmentExec.resumeAfterEnvironment(token),
      report: (r) => reports.push(r),
      log,
      preempt: () => {},
      stopFallTask: () => null,
      resumeAfterFall: () => false,
      fightBack: () => false,
      fleeHealth: () => 10,
      reactCooldownSec: () => 8,
      antiDrown: () => false,
      antiLava: () => false,
      diag,
    });
    reflexes.start();
    vi.advanceTimersByTime(200); // 受击监听挂在分频的慢路上
    handlers.forEach((h) => h({ id: 1 }, zombie));

    const first = pf.goal;
    expect(first).not.toBeNull();
    expect((first as FakeGoal).constructor.name).toBe('GoalNearXZ');

    // 人一步没动:目标不可达时寻路器就是这个样子(空路径 + 闩锁)
    vi.advanceTimersByTime(5_200);
    reflexes.stop();

    const stalled = diag.after(0).find((e) => e.event === 'escape-goal-stalled');
    expect(stalled?.msg).toContain('低血脱离的逃生目标 5 秒零推进,已撤销重下');
    // 撤销走的是 setGoal(null),随后同一个目标被重新下达
    expect(setGoals).toContain(null);
    expect(setGoals[setGoals.length - 1]).toBe(first);
  });
});



/**
 * 环境冻结只豁免正在自救的那一步；同一任务后续步骤须等待解冻。
 */
describe('环境冻结的作用域是一步,不是一单', () => {
  it('自救那一步照跑到底,后面的步等解冻才开工', async () => {
    let release: (() => void) | null = null;
    const bot = combatBot({
      entities: { '1': { name: 'zombie', type: 'mob', position: new V(2, 64, 2), isValid: true } },
      goto: (arrive) => new Promise<void>((ok) => { release = () => { arrive(); ok(); }; }),
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([
      { skill: 'flee', distance: 24 },
      { skill: 'chat', text: '解冻之后才轮到我' },
    ]);
    await waitUntil(() => release !== null, 5000);

    // 自救那一步正在跑:escape.active 让 hold 不打断它 —— 这一半是有意的
    const token = exec.pauseForEnvironment('逃离岩浆');
    expect(exec.status().running?.id).toBe(1);
    release!();

    // 自救那一步跑完了,而危机还在:第 2 步不许开工
    await sleep(400);
    expect(bot.said).toEqual([]);
    expect(reports).toEqual([]);
    expect(exec.status().hold).toBe('逃离岩浆');

    // 解冻:断点放回队首,从没开工的那一步接着做
    exec.resumeAfterEnvironment(token);
    await waitUntil(() => reports.length === 1, 5000);
    expect(bot.said).toEqual(['解冻之后才轮到我']);
  }, 15_000);
});

describe('probe 逐格/target/差分 + goto 地表 + surface 陆地脱困', () => {
  /**
   * 可挖可垫的格子世界:world 表以外全是空气。wheat 等贴地方块给 empty 碰撞箱,
   * 好验证逐格与 target 读的是方块名,不被空气归并吞掉。
   */
  function probeBot(
    cells: Record<string, string>,
    opts: { unloadedFromX?: number; stock?: Array<{ name: string; count: number; type: number }> } = {},
  ) {
    const world = new Map(Object.entries(cells));
    const NON_SOLID = new Set(['air', 'water', 'lava', 'wheat', 'short_grass', 'torch']);
    const names = new Set(['air', 'stone', 'dirt', 'wheat', 'coal_ore', 'water', 'chest', ...world.values()]);
    const blocksByName: Record<string, { id: number; name: string }> = {};
    let nextId = 1;
    for (const n of names) blocksByName[n] = { id: nextId++, name: n };
    const keyOf = (x: number, y: number, z: number) => `${x},${y},${z}`;
    const bag = opts.stock ?? [];
    const bot = {
      world,
      entity: { id: 9, position: new V(0.5, 64, 0.5), onGround: true },
      entities: {},
      players: {},
      health: 20,
      game: { minY: -64, height: 384 },
      inventory: { items: () => bag },
      registry: { blocksByName, itemsByName: {} },
      equip: async () => {},
      lookAt: async () => {},
      setControlState: (name: string, on: boolean) => {
        if (name !== 'jump') return;
        const p = bot.entity.position;
        if (on) bot.entity.position = new V(p.x, Math.floor(p.y) + 1.2, p.z);
        else {
          const feet = Math.floor(p.y);
          const under = keyOf(Math.floor(p.x), feet - 1, Math.floor(p.z));
          const solid = world.has(under) && !NON_SOLID.has(world.get(under) as string);
          bot.entity.position = new V(p.x, solid ? feet : feet - 1, p.z);
        }
      },
      blockAt: (p: V) => {
        const x = Math.floor(p.x);
        const y = Math.floor(p.y);
        const z = Math.floor(p.z);
        if (opts.unloadedFromX !== undefined && x >= opts.unloadedFromX) return null;
        const name = world.get(keyOf(x, y, z)) ?? 'air';
        return {
          name,
          position: new V(x, y, z),
          boundingBox: NON_SOLID.has(name) ? 'empty' : 'block',
          diggable: true,
          canHarvest: () => true,
        };
      },
      placeBlock: async (ref: { position: V }, face: V) => {
        world.set(keyOf(ref.position.x + face.x, ref.position.y + face.y, ref.position.z + face.z), 'dirt');
        if (bag[0]) bag[0].count--;
      },
      canDigBlock: () => true,
      digTime: () => 10,
      stopDigging: () => {},
      dig: async (b: { position: V }) => {
        world.delete(keyOf(b.position.x, b.position.y, b.position.z));
      },
      // 找块形态走的区块索引扫描:无视遮挡,只看距离(真 findBlocks 的语义)
      findBlocks: (o: { matching: number[]; maxDistance: number; count: number }) => {
        const me = bot.entity.position;
        const out: V[] = [];
        for (const [k, name] of world) {
          const id = blocksByName[name]?.id;
          if (id === undefined || !o.matching.includes(id)) continue;
          const [x, y, z] = k.split(',').map(Number);
          if (Math.hypot(x + 0.5 - me.x, y + 0.5 - me.y, z + 0.5 - me.z) <= o.maxDistance) out.push(new V(x, y, z));
        }
        return out.slice(0, o.count);
      },
      pathfinder: {
        stop() {},
        setGoal() {},
        goto: async (goal: FakeGoal) => {
          const at = bot.entity.position;
          bot.entity.position = new V(goal.x ?? at.x, goal.y ?? at.y, goal.z ?? at.z);
        },
      },
    };
    return bot;
  }

  it('probe ≤27 格逐格报「(x,y,z):方块」,空气只报格数;贴地方块不被并进空气', async () => {
    const bot = probeBot({ '0,64,1': 'stone', '2,64,2': 'coal_ore', '1,64,1': 'wheat' });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'probe', shape: 'box', anchors: [[0, 64, 0], [2, 66, 2]] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('逐格');
    expect(reports[0].text).toContain('(0,64,1):石头');
    expect(reports[0].text).toContain('(2,64,2):煤矿石');
    expect(reports[0].text).toContain('(1,64,1):小麦');
    expect(reports[0].text).toContain('其余 24 格是空气');
  });

  it('probe 超过 27 格回聚合计数,不逐格', async () => {
    const bot = probeBot({ '0,64,1': 'stone' });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'probe', shape: 'box', anchors: [[0, 64, 0], [3, 66, 2]] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('空气×35');
    expect(reports[0].text).not.toContain('逐格');
  });

  it('probe 全空的小体积直说全是空气', async () => {
    const bot = probeBot({});
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'probe', shape: 'line', anchors: [[5, 70, 5], [5, 72, 5]] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('全是空气');
  });

  it('probe 差分:同参同读数只回「与上次相同(第 K 次)」,mc_stop 不清,内容变了就重报', async () => {
    const bot = probeBot({ '0,64,1': 'stone' });
    const { exec, reports } = makeExecutorOn(bot);
    const probe: SkillCall = { skill: 'probe', shape: 'box', anchors: [[0, 64, 0], [2, 66, 2]] };
    exec.submit([probe]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('逐格');
    exec.submit([probe]);
    await waitUntil(() => reports.length === 2, 8000);
    expect(reports[1].text).toContain('与上次探查相同(第 2 次)');
    expect(reports[1].text).toContain('上次:');
    exec.clear();
    exec.submit([probe]);
    await waitUntil(() => reports.length === 3, 8000);
    expect(reports[2].text).toContain('第 3 次');
    bot.world.set('1,64,1', 'coal_ore');
    exec.submit([probe]);
    await waitUntil(() => reports.length === 4, 8000);
    expect(reports[3].text).not.toContain('与上次探查相同');
    expect(reports[3].text).toContain('(1,64,1):煤矿石');
  });

  it('probe 非露天的开放空腔才说连着更大空间(封闭判定另有封死句)', async () => {
    // 头顶 y80 一整片盖板,探查中心非露天
    const cells: Record<string, string> = {};
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) cells[`${x},80,${z}`] = 'stone';
    const bot = probeBot(cells);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'probe', shape: 'line', anchors: [[0, 65, 0], [0, 67, 0]] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('连着更大的空间');
  });

  it('goto 只写 [x,z]:按地表落脚;parseSteps 记 groundY', async () => {
    const parsed = parseSteps([{ skill: 'goto', at: [10, 5] }]);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.steps[0]).toEqual({ skill: 'goto', at: [10, 0, 5], groundY: true });
    const plain = parseSteps([{ skill: 'goto', at: [10, 64, 5] }]);
    if ('error' in plain) throw new Error(plain.error);
    expect(plain.steps[0]).toEqual({ skill: 'goto', at: [10, 64, 5] });

    const bot = probeBot({ '10,70,5': 'stone' });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit(parsed.steps);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('到了 (10, 71, 5)');
  });

  /**
   * 目标区块未加载时不猜测 Y；受阻回执说明可用的输入方式。
   */
  it('goto [x,z] 目标区块没加载:照实受阻,并说清怎么改', async () => {
    const bot = probeBot({}, { unloadedFromX: 50 });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'goto', at: [60, 0, 5], groundY: true }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('(60, 5) 那里还没加载,先走近些再用 [x,z];或者直接给 y');
    expect(reports[0].text).not.toContain('猜不了');
  });

  it('surface 在陆上且露天:秒回已经在露天了', async () => {
    const bot = probeBot({ '0,63,0': 'stone' });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'surface' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('我已经在露天了');
    expect(reports[0].text).toContain('out_of_liquid=true,standing=true,sky_visible=true,final_y=64');
  });

  it('surface 沟底被遮蔽:挖头顶+垫脚上行到露天,报爬了几格', async () => {
    const bot = probeBot(
      { '0,63,0': 'stone', '0,66,0': 'stone', '0,67,0': 'stone' },
      { stock: [{ name: 'dirt', count: 64, type: 5 }] },
    );
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'surface' }]);
    await waitUntil(() => reports.length === 1, 12_000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('我爬到露天了');
    expect(reports[0].text).toContain('上来 2 格');
    expect(reports[0].text).toContain('out_of_liquid=true,standing=true,sky_visible=true,final_y=66');
    // 头顶两块真被挖掉了
    expect(bot.world.has('0,66,0')).toBe(false);
    expect(bot.world.has('0,67,0')).toBe(false);
  });

  it('surface 垫脚格被占:点名那一格里是什么,不只说"垫不上"', async () => {
    // 垫脚目标格被火把占据，回执须点明实际占用物。
    const bot = probeBot(
      { '0,63,0': 'stone', '0,66,0': 'stone', '0,64,0': 'torch' },
      { stock: [{ name: 'dirt', count: 64, type: 5 }] },
    );
    // 服务端不会把方块放进已经被占着的格子;probeBot 默认的 placeBlock 是无条件覆写
    const place = bot.placeBlock;
    bot.placeBlock = async (ref: { position: V }, face: V) => {
      if (bot.world.has(`${ref.position.x + face.x},${ref.position.y + face.y},${ref.position.z + face.z}`)) return;
      await place(ref, face);
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'surface' }]);
    await waitUntil(() => reports.length === 1, 12_000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('那一格现在是火把');
  });

  it('surface 沟底没垫脚方块:带着已爬格数如实受阻', async () => {
    const bot = probeBot({ '0,63,0': 'stone', '0,66,0': 'stone' });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'surface' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('垫脚名单里的方块包里都没有');
  });

  it('surface 垫脚会遵守非通用垫脚料的 reserve 拒绝', async () => {
    const bot = probeBot(
      { '0,63,0': 'stone', '0,66,0': 'stone' },
      { stock: [{ name: 'sandstone', count: 28, type: 5 }] },
    );
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (report) => reports.push(report),
      log,
      nextId: nextTaskId(),
      policy: {
        get: () => ({
          ...defaultPolicy(),
          scaffold: ['sandstone'],
        }),
        defaults: () => ({ scaffold: ['sandstone'], light: ['torch'] }),
      },
      permitResourcePlacement: () => ({ ok: false, reason: 'sandstone 的蓝图 reserve 已收口' }),
    });

    exec.submit([{ skill: 'surface' }]);
    await waitUntil(() => reports.length === 1, 8000);

    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('sandstone 的蓝图 reserve 已收口');
    expect(bot.world.get('0,64,0')).toBeUndefined();
  });

  /**
   * 塔与 surface 的上行是同一条维持条件(垫高一格),差别只在停在哪:
   * surface 停在露天,塔停在她给的那一格。判据同样是"走到终点那一格"。
   */
  it('塔:横向 0 格往上,每一格垫出来,到终点那一格才算到顶', async () => {
    const bot = probeBot({ '0,63,0': 'stone' }, { stock: [{ name: 'dirt', count: 64, type: 5 }] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'tunnel', at: [0, 67, 0] }]);
    await waitUntil(() => reports.length === 1, 15_000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('塔垫了 3/3 格,人在 (0, 67, 0)');
    expect(reports[0].text).toContain('到顶了');
    for (const y of [64, 65, 66]) expect(bot.world.get(`0,${y},0`)).toBe('dirt');
  });

  it('塔没垫脚材料:没到顶就是受阻,垫了几格进现场', async () => {
    const bot = probeBot({ '0,63,0': 'stone' });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'tunnel', at: [0, 67, 0] }]);
    await waitUntil(() => reports.length === 1, 15_000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('塔没到顶');
    expect(reports[0].text).toContain('垫脚名单里的方块包里都没有(泥土、圆石)');
    expect(reports[0].text).toContain('[现场] 塔垫了 0/3 格');
  });

  /**
   * 寻路和维持条件共用垫脚名单，并排除失去支撑会下落的重力方块。
   */
  it('垫脚名单里的重力方块不算数:回执不把沙砾念给她', async () => {
    const bot = probeBot({ '0,63,0': 'stone' });
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      policy: {
        get: () => ({ ...defaultPolicy(), scaffold: ['gravel', 'dirt'] }),
        defaults: () => ({ scaffold: ['dirt', 'cobblestone'], light: ['torch'] }),
      },
    });
    exec.submit([{ skill: 'tunnel', at: [0, 67, 0] }]);
    await waitUntil(() => reports.length === 1, 15_000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('垫脚名单里的方块包里都没有(泥土)');
    expect(reports[0].text).not.toContain('沙砾');
  });

  /**
   * tunnel、surface 的挖掘与垫脚上升都使用六邻岩浆检查，不能只检查正上方柱。
   */
  it('surface 要挖的头顶格侧邻贴着岩浆:不捅,带着已爬格数如实受阻', async () => {
    const bot = probeBot(
      { '0,63,0': 'stone', '0,66,0': 'stone', '0,67,0': 'stone', '1,66,0': 'lava' },
      { stock: [{ name: 'dirt', count: 64, type: 5 }] },
    );
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'surface' }]);
    await waitUntil(() => reports.length === 1, 12_000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('头顶 (0, 66, 0) 旁边贴着岩浆,不敢捅');
    // 那一格真没被挖
    expect(bot.world.get('0,66,0')).toBe('stone');
  });

  it('surface 新落脚格侧邻贴着岩浆:垫脚上升前拦住,不把人送到岩浆边上', async () => {
    // 柱子那两格本来就是空的(digCell/挖顶都摸不到),人升上去才贴上 —— 死#3 的形状
    const bot = probeBot(
      { '0,63,0': 'stone', '0,66,0': 'stone', '0,67,0': 'stone', '1,65,0': 'lava' },
      { stock: [{ name: 'dirt', count: 64, type: 5 }] },
    );
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'surface' }]);
    await waitUntil(() => reports.length === 1, 12_000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('落脚处 (0, 65, 0) 旁边贴着岩浆,不敢上去');
    // 人还站在原地,没被垫上去
    expect(Math.floor(bot.entity.position.y)).toBe(64);
  });

  it('塔:新落脚格侧邻贴着岩浆,垫脚上升前受阻,不谎报到顶', async () => {
    const bot = probeBot(
      { '0,63,0': 'stone', '1,65,0': 'lava' },
      { stock: [{ name: 'dirt', count: 64, type: 5 }] },
    );
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'tunnel', at: [0, 67, 0] }]);
    await waitUntil(() => reports.length === 1, 15_000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('塔没到顶');
    expect(reports[0].text).toContain('(0, 65, 0) 紧贴着岩浆,不敢上去');
  });

  it('竖井:要挖的格子侧邻藏着岩浆,digCell 不挖,停在这', async () => {
    const bot = probeBot({
      '0,63,0': 'stone', '0,62,0': 'stone', '0,61,0': 'stone', '0,60,0': 'stone',
      '1,63,0': 'lava',
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'tunnel', at: [0, 61, 0] }]);
    await waitUntil(() => reports.length === 1, 15_000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('竖井没到底');
    expect(reports[0].text).toContain('(0, 63, 0) 紧贴着岩浆,不敢挖');
    expect(bot.world.get('0,63,0')).toBe('stone');
  });

  /**
   * 挖脚下支撑格时，下方仍为实心才允许逐格下挖；下方悬空时跳过并报告事实。
   */
  it('excavate 拒挖脚下支撑格:下面是空的就跳过,回执只说事实', async () => {
    const bot = probeBot({ '0,63,0': 'stone' });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'excavate', shape: 'line', anchors: [['~', '~-1', '~'], ['~', '~-1', '~']] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('1 格是我此刻站着的支撑(它下面是空气),没动');
    expect(reports[0].text).not.toContain('tunnel'); // 不加启发式建议
    expect(bot.world.get('0,63,0')).toBe('stone');
  });

  it('excavate 脚下支撑格下面还是实心:照挖,就地往下挖的出路不受伤', async () => {
    const bot = probeBot({ '0,63,0': 'stone', '0,62,0': 'stone' });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'excavate', shape: 'line', anchors: [['~', '~-1', '~'], ['~', '~-1', '~']] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('挖开了 1/1 块');
    expect(bot.world.has('0,63,0')).toBe(false);
  });

  it('excavate 的 6 邻岩浆闸抽成 helper 后行为不变:紧贴岩浆的格子跳过并进回执', async () => {
    const bot = probeBot({ '0,63,1': 'stone', '0,63,2': 'lava' });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'excavate', shape: 'line', anchors: [[0, 63, 1], [0, 63, 1]] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('1 块紧贴着岩浆,没动');
    expect(bot.world.get('0,63,1')).toBe('stone');
  });

  it('塔的试算报要垫几格与包里有几块,不动世界', async () => {
    const bot = probeBot({ '0,63,0': 'stone' }, { stock: [{ name: 'dirt', count: 7, type: 5 }] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'tunnel', at: [0, 67, 0], dryRun: true }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('要垫 3 格,包里有 7 个泥土');
    expect(reports[0].text).toContain('没动工');
    expect(bot.world.has('0,64,0')).toBe(false);
  });

  /**
   * 试算不动世界,所以也不该占放置的串行闸:占了会在恰好有放置结算 hold 时,把
   * "上一块材料还在结算,这次放置稍后再试"塞进预览文案 —— 那句话在试算语境里
   * 没有任何意义(这一趟本来就不放东西)。
   */
  it('试算撞上放置结算 hold:预览照报包里有几块,不说结算期的话', async () => {
    const bot = probeBot({ '0,63,0': 'stone' }, { stock: [{ name: 'dirt', count: 7, type: 5 }] });
    const reports: TaskReport[] = [];
    let permits = 0;
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      // 结算期:真 permit 一律拒
      permitResourcePlacement: () => {
        permits++;
        return { ok: false, reason: '上一块材料还在结算,这次放置稍后再试' };
      },
    });
    exec.submit([{ skill: 'tunnel', at: [0, 67, 0], dryRun: true }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('要垫 3 格,包里有 7 个泥土');
    expect(reports[0].text).not.toContain('稍后再试');
    expect(permits).toBe(0);
    expect(bot.world.has('0,64,0')).toBe(false);
  });

  /** 2×2 井筒四根角柱的实心填充:起步脚位那两格留空(人站在里面) */
  function spiralRock(yLo: number, yHi: number): Record<string, string> {
    const cells: Record<string, string> = {};
    for (const [qx, qz] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      for (let y = yLo; y <= yHi; y++) {
        if (qx === 0 && qz === 0 && (y === 64 || y === 65)) continue;
        cells[`${qx},${y},${qz}`] = 'stone';
      }
    }
    return cells;
  }

  // spiral 绕 2×2 井筒下行，每步留出落脚、头部及跳跃三格空间，圈间保留实心地板。
  it('spiral 下行:每级台阶 3 格空,圈间地板完好,到目标 y 才算到底', async () => {
    const bot = probeBot(spiralRock(50, 66));
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'tunnel', at: [0, 56, 0], spiral: true }]);
    await waitUntil(() => reports.length === 1, 15_000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('螺旋楼梯挖了 8/8 格');
    expect(reports[0].text).toContain('到底了');
    const quad = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (let i = 1; i <= 8; i++) {
      const [qx, qz] = quad[i % 4];
      const y = 64 - i;
      // 落脚、头顶、跳跃余量三格全空
      for (const dy of [0, 1, 2]) expect(bot.world.has(`${qx},${y + dy},${qz}`)).toBe(false);
      // 这一级站的地板没被下一圈挖掉
      expect(bot.world.get(`${qx},${y - 1},${qz}`)).toBe('stone');
    }
  });

  /**
   * 天然黑曜石也存在于洞穴与岩浆池边，遇到它停工只能说明挖不动，不能推断维度通道。
   */
  it('spiral 碰到黑曜石就停,但不冒充维度语义:只说挖不动', async () => {
    const rock = spiralRock(50, 66);
    rock['1,63,0'] = 'obsidian';
    const bot = probeBot(rock);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'tunnel', at: [0, 60, 0], spiral: true }]);
    await waitUntil(() => reports.length === 1, 8000);

    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).not.toContain('维度通道边界');
    expect(reports[0].text).toContain('挖不动它');
    expect(reports[0].text).toContain('黑曜石');
    expect(bot.world.get('1,63,0')).toBe('obsidian');
    expect(reports[0].text).toContain('螺旋楼梯挖了 0/4 格');
  });

  it('spiral 碰到真的传送门面照旧给维度文案', async () => {
    const rock = spiralRock(50, 66);
    rock['1,63,0'] = 'nether_portal';
    const bot = probeBot(rock);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'tunnel', at: [0, 60, 0], spiral: true }]);
    await waitUntil(() => reports.length === 1, 8000);

    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('维度通道边界');
    expect(bot.world.get('1,63,0')).toBe('nether_portal');
  });

  it('spiral 试算报井筒与格数,不动世界', async () => {
    const bot = probeBot(spiralRock(50, 66));
    const blockAt = bot.blockAt;
    bot.blockAt = (p: V) => {
      const block = blockAt(p);
      return block?.name === 'stone' ? { ...block, canHarvest: () => false } : block;
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{
      skill: 'tunnel', at: [0, 60, 0], spiral: true, dryRun: true, tool: 'iron_pickaxe',
    }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('试算螺旋楼梯');
    expect(reports[0].text).toContain('2×2 井筒');
    expect(reports[0].text).toContain('要挖 12 格');
    expect(reports[0].text).toContain('现在的家伙挖 石头 不掉东西');
    expect(reports[0].text).toContain('工具预案:包里没有本步指定的铁镐');
    expect(reports[0].text).toContain('没动工');
    expect(bot.world.get('1,63,0')).toBe('stone');
  });

  it('spiral 只认正上/正下:斜着给受阻,报横向差几格', async () => {
    const bot = probeBot({ '0,63,0': 'stone' });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'tunnel', at: ['~5', '~-10', '~'], spiral: true }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('正上/正下');
    expect(reports[0].text).toContain('5 格');
  });

  it('坡度超 45° 的受阻带 spiral 的下一步', async () => {
    const bot = probeBot({ '0,63,0': 'stone' });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'tunnel', at: ['~10', '~-20', '~'] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('spiral');
  });

  it('parseSteps 与任务标签认得 spiral', () => {
    const ok = parseSteps([{ skill: 'tunnel', at: ['~', '~-30', '~'], spiral: true }]);
    if ('error' in ok) throw new Error(ok.error);
    expect(ok.steps[0]).toEqual({ skill: 'tunnel', at: ['~', '~-30', '~'], spiral: true });
    expect(describeSkill({ skill: 'tunnel', at: [0, 34, 0], spiral: true })).toContain('挖螺旋楼梯到');
  });

  it('parseSteps:probe 只认形状与锚点', () => {
    const plain = parseSteps([{ skill: 'probe', shape: 'box', anchors: [[0, 0, 0], [4, 4, 4]] }]);
    if ('error' in plain) throw new Error(plain.error);
    expect(plain.steps[0]).toEqual({ skill: 'probe', shape: 'box', anchors: [[0, 0, 0], [4, 4, 4]] });
  });

  it('probe 聚合模式:作物/火把按名字计数,只有真空气进空气桶', async () => {
    const cells: Record<string, string> = {};
    for (let x = 0; x < 4; x++) for (let z = 0; z < 2; z++) cells[`${x},64,${z}`] = 'wheat';
    cells['0,64,2'] = 'torch';
    const bot = probeBot(cells);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'probe', shape: 'box', anchors: [[0, 64, 0], [3, 66, 2]] }]); // 36 格,走聚合
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('小麦×8');
    expect(reports[0].text).toContain('火把×1');
    expect(reports[0].text).toContain('空气×27');
  });
});

/**
 * 建筑与挖掘的"半步":失败之前先把该做的做完,做不成时把那一格里是什么说出来。
 *
 * 这一组共用一份体素假世界:格子是 name→cell 的 Map,放置写进去、挖掘删掉,
 * 实心与否按名字判——与执行器"这一格变成了要放的东西"那套判据同一口径。
 */
describe('建筑与挖掘:先自救,再照实说', () => {
  const NON_SOLID = new Set(['air', 'torch', 'wall_torch', 'oak_sapling', 'wheat']);

  interface VoxelOptions {
    /** 起始实心格,"x,y,z" */
    cells?: string[];
    /** 起始非实心占位物,"x,y,z" → 方块名 */
    props?: Record<string, string>;
    /** 这些格子服务端一律不认放置 */
    refuse?: string[];
    bag?: Array<{ name: string; count: number }>;
    at?: [number, number, number];
    /** 挂上 prismarine 的光照接口并一律读 0:整片全黑(不挂 = 世界不给光照,采不到样) */
    dark?: boolean;
    /** 认得这些方块名(explore/collect 要查注册表);找不找得到由 findBlocks 说了算 */
    knows?: string[];
  }

  function voxelBot(opts: VoxelOptions = {}) {
    const key = (x: number, y: number, z: number) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
    const world = new Map<string, string>();
    for (const c of opts.cells ?? []) world.set(c, 'stone');
    for (const [c, n] of Object.entries(opts.props ?? {})) world.set(c, n);
    if (opts.dark) Object.assign(world, { getBlockLight: () => 0, getSkyLight: () => 0 });
    const refuse = new Set(opts.refuse ?? []);
    const bag = opts.bag ?? [];
    const start = opts.at ?? [0, 64, 0];
    const equipped: string[] = [];
    const sneaks: boolean[] = [];
    /** 每一次 placeBlock 贴的是哪个方向的面:「火把贴墙不贴地」靠它验 */
    const faces: Array<[number, number, number]> = [];
    /** 同一份记录带上放的是什么:「火把不贴待挖的墙」按名字筛得出来 */
    const placedFaces: Array<{ name: string; face: [number, number, number] }> = [];
    const bot = {
      world,
      equipped,
      sneaks,
      faces,
      placedFaces,
      entity: { id: 9, position: new V(start[0] + 0.5, start[1], start[2] + 0.5), onGround: true },
      entities: {},
      health: 20,
      players: {},
      registry: {
        blocksByName: Object.fromEntries(
          (opts.knows ?? []).map((n, i) => [n, { id: 900 + i, name: n }]),
        ),
        blocks: Object.fromEntries((opts.knows ?? []).map((n, i) => [900 + i, { name: n }])),
        itemsByName: Object.fromEntries(bag.map((item, i) => [item.name, { id: 800 + i, name: item.name }])),
        entitiesByName: {},
      },
      // 这一片没有目标:explore 一路走满都看不见
      findBlocks: () => [],
      inventory: { items: () => bag.filter((i) => i.count > 0) },
      heldItem: null as { name: string } | null,
      equip: async (item: { name: string }) => { equipped.push(item.name); bot.heldItem = item; },
      lookAt: async () => {},
      setControlState: (name: string, on: boolean) => { if (name === 'sneak') sneaks.push(on); },
      blockAt: (p: V) => {
        const name = world.get(key(p.x, p.y, p.z)) ?? 'air';
        return {
          name,
          position: p,
          boundingBox: NON_SOLID.has(name) ? 'empty' : 'block',
          diggable: true,
          canHarvest: () => true,
        };
      },
      placeBlock: async (ref: { position: V }, face: V) => {
        const k = key(ref.position.x + face.x, ref.position.y + face.y, ref.position.z + face.z);
        if (refuse.has(k)) return;
        const held = bot.heldItem?.name;
        if (!held) throw new Error('must be holding an item to place');
        world.set(k, held === 'torch' && face.y === 0 ? 'wall_torch' : held);
        faces.push([face.x, face.y, face.z]);
        placedFaces.push({ name: held, face: [face.x, face.y, face.z] });
        const slot = bag.find((i) => i.name === held);
        if (slot) slot.count--;
      },
      canDigBlock: () => true,
      digTime: () => 20,
      stopDigging: () => {},
      dig: async (block: { position: V }) => {
        world.delete(key(block.position.x, block.position.y, block.position.z));
      },
      pathfinder: {
        stop() {},
        setGoal() {},
        goto: async (goal: FakeGoal) => {
          const p = bot.entity.position;
          bot.entity.position = new V(
            (goal.x ?? Math.floor(p.x)) + 0.5,
            goal.y ?? p.y,
            (goal.z ?? Math.floor(p.z)) + 0.5,
          );
        },
      },
    };
    return bot;
  }

  /** 一整块实心岩体,只有人站的那两格是空的 */
  function massif(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): string[] {
    const out: string[] = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) out.push(`${x},${y},${z}`);
    }
    return out;
  }

  function hasTorch(bot: ReturnType<typeof voxelBot>): boolean {
    return [...bot.world.values()].some((name) => name === 'torch' || name === 'wall_torch');
  }

  it('放不上的时候点名占位的是谁:火把顶不掉,回执要说出"现在是火把"', async () => {
    const bot = voxelBot({
      cells: ['3,63,0', '0,63,0'],
      props: { '3,64,0': 'torch' },
      refuse: ['3,64,0'],
      bag: [{ name: 'dirt', count: 64 }],
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', shape: 'line', material: 'dirt', anchors: [[3, 64, 0], [3, 64, 0]] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('(3, 64, 0) 现在是火把');
  });

  /**
   * 门框材料放置后逐格回读世界中的真实名称。
   */
  it('放黑曜石一类门框材料:回执带一句逐格回读的真名核对', async () => {
    const bot = voxelBot({
      cells: ['3,63,0', '4,63,0', '0,63,0'],
      bag: [{ name: 'obsidian', count: 64 }],
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', shape: 'line', material: 'obsidian', anchors: [[3, 64, 0], [4, 64, 0]] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('门框材料实际是:黑曜石×2');
  });

  /**
   * 耕地和作物不能作为该放置的参照面；提前拒绝发包并说明原因。
   */
  it('六个面只剩耕地可贴:不发那一包,回执说清原版不收耕地当参照面', async () => {
    const bot = voxelBot({
      cells: ['0,63,0'],
      props: { '3,63,0': 'farmland' },
      bag: [{ name: 'torch', count: 8 }],
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', shape: 'line', material: 'torch', anchors: [[3, 64, 0], [3, 64, 0]] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('挨着的是耕地');
    expect(reports[0].text).toContain('服务端必拒,没发');
    // 一包都没发出去
    expect(bot.placedFaces).toHaveLength(0);
  });

  it('作物格同样不当参照面', async () => {
    const bot = voxelBot({
      cells: ['0,63,0'],
      props: { '3,63,0': 'wheat' },
      bag: [{ name: 'torch', count: 8 }],
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', shape: 'line', material: 'torch', anchors: [[3, 64, 0], [3, 64, 0]] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(bot.placedFaces).toHaveLength(0);
  });

  it('普通建材不带这一句:它只在不可再生的门框材料上触发', async () => {
    const bot = voxelBot({ cells: ['3,63,0', '0,63,0'], bag: [{ name: 'dirt', count: 64 }] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', shape: 'line', material: 'dirt', anchors: [[3, 64, 0], [3, 64, 0]] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).not.toContain('门框材料');
  });

  it('放置全程按着 shift:不潜行时右键交互方块是"打开它",不是放方块', async () => {
    const bot = voxelBot({ cells: ['3,63,0', '0,63,0'], bag: [{ name: 'dirt', count: 64 }] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', shape: 'line', material: 'dirt', anchors: [[3, 64, 0], [3, 64, 0]] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(bot.sneaks[0]).toBe(true);
    expect(bot.sneaks.at(-1)).toBe(false);
  });

  it('只剩自己头顶那一格时,回执说的是脑袋,不是"悬空没依托"', async () => {
    const bot = voxelBot({ cells: ['0,63,0'], bag: [{ name: 'dirt', count: 64 }] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', shape: 'line', material: 'dirt', anchors: [['~', '~1', '~'], ['~', '~1', '~']] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('(0, 65, 0) 顶在我脑袋上');
    expect(reports[0].text).not.toContain('悬空没依托');
  });

  it('回执报的"人在"是脚下那一格:与快照、与锚点同一个口径', async () => {
    const bot = voxelBot({ cells: massif(-1, 6, 60, 63, -1, 1), bag: [{ name: 'dirt', count: 64 }] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'excavate', shape: 'line', anchors: [[2, 63, 0], [3, 63, 0]] }]);
    await waitUntil(() => reports.length === 1, 8000);
    // 人站在 (0,64,0),position 是 (0.5, 64, 0.5);四舍五入会报成 (1, 64, 1)
    expect(reports[0].text).toContain('挖完人在 (0, 64, 0)');
  });

  /**
   * 试算点名覆盖范围内登记的工作站，只报告事实，不执行施工。
   */
  it('试算罩住账本里自己放的工作站:点名报出来,照样不动工', async () => {
    const book = new ChestBook(null);
    book.rememberStation('overworld', { x: 1, y: 62, z: 1 }, 'crafting_table', Date.now());
    const bot = voxelBot({ cells: massif(0, 2, 60, 63, 0, 2) });
    const { exec, reports } = makeExecutorWith(bot, book);
    exec.submit([{ skill: 'excavate', shape: 'box', anchors: [[0, 60, 0], [2, 63, 2]], dryRun: true }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('放的工作台 (1, 62, 1)');
    expect(reports[0].text).toContain('没动工');
    // 挖掉那一格之后账随之划掉:再试算不再点名
    exec.submit([{ skill: 'excavate', shape: 'box', anchors: [[1, 62, 1], [1, 62, 1]] }]);
    await waitUntil(() => reports.length === 2, 8000);
    exec.submit([{ skill: 'excavate', shape: 'box', anchors: [[0, 60, 0], [2, 63, 2]], dryRun: true }]);
    await waitUntil(() => reports.length === 3, 8000);
    expect(reports[2].text).not.toContain('工作台');
  });

  it('excavate dryRun 传递精确 tool,缺货在工具预案里说明', async () => {
    const bot = voxelBot({ cells: massif(0, 2, 60, 63, 0, 2) });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{
      skill: 'excavate', shape: 'line', anchors: [[0, 63, 0], [2, 63, 0]],
      dryRun: true, tool: 'diamond_pickaxe',
    }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('工具预案:包里没有本步指定的钻石镐');
    expect(reports[0].text).toContain('没动工');
  });

  /**
   * 成果登记用于报告影响范围与登记时间，不阻止显式挖掘。
   */
  it('excavate 罩住成果登记:回执点名多少格、记于何时,照挖不误', async () => {
    const works = new WorksBook(null);
    works.note('overworld', 1, 62, 1, { kind: 'crop', block: 'wheat', site: null }, 1_700_000_000_000);
    works.note('overworld', 1, 63, 1, { kind: 'farmland', block: 'farmland', site: null }, 1_700_000_000_000);
    const bot = voxelBot({ cells: massif(0, 2, 60, 63, 0, 2) });
    const { exec, reports } = makeExecutorWithWorks(bot, works);
    exec.submit([{ skill: 'excavate', shape: 'box', anchors: [[0, 60, 0], [2, 63, 2]], dryRun: true }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('这一框里有你1 格作物');
    expect(reports[0].text).toContain('1 格耕地');
    expect(reports[0].text).toContain('记于');

    // 真挖:一格都不跳过,登记随之划掉
    exec.submit([{ skill: 'excavate', shape: 'box', anchors: [[1, 62, 1], [1, 63, 1]] }]);
    await waitUntil(() => reports.length === 2, 8000);
    expect(reports[1].kind).toBe('done');
    expect(reports[1].text).toContain('挖开了 2/2 块');
    expect(works.count('overworld')).toBe(0);
  });

  it('登记的回执只陈述,不出现「别挖」「要确认」这类替她决定的词', async () => {
    const works = new WorksBook(null);
    works.note('overworld', 1, 62, 1, { kind: 'blueprint', block: 'oak_planks', site: 'hut' }, 1_700_000_000_000);
    const bot = voxelBot({ cells: massif(0, 2, 60, 63, 0, 2) });
    const { exec, reports } = makeExecutorWithWorks(bot, works);
    exec.submit([{ skill: 'excavate', shape: 'box', anchors: [[0, 60, 0], [2, 63, 2]], dryRun: true }]);
    await waitUntil(() => reports.length === 1, 8000);
    for (const word of ['别挖', '不要挖', '要确认', '建议']) expect(reports[0].text).not.toContain(word);
  });

it('collect 挖之前先把趁手的家伙拿到手上', async () => {
    // 镐在包里、手上拿着面包:空手挖石头 7.5 秒一块且什么都不掉
    const ore = { name: 'stone', position: new V(2, 64, 0) };
    const equipped: string[] = [];
    const bag = [{ name: 'bread', count: 1 }, { name: 'stone_pickaxe', count: 1 }];
    const bot = {
      entity: { id: 9, position: new V(0.5, 64, 0.5) },
      entities: {},
      health: 20,
      players: {},
      world: { raycast: () => ({ position: ore.position, face: 1 }) },
      registry: {
        blocks: { 1: { name: 'stone', drops: [4] } },
        // 拿哪一类家伙什由方块自己的 material/harvestTools 说了算(minecraft-data 原样)
        blocksByName: {
          stone: {
            id: 1, name: 'stone', drops: [4],
            material: 'mineable/pickaxe',
            harvestTools: { 5: true, 6: true },
          },
        },
        items: { 4: { name: 'cobblestone' }, 5: { name: 'wooden_pickaxe' }, 6: { name: 'stone_pickaxe' } },
        itemsByName: { cobblestone: { id: 4 } },
      },
      inventory: { items: () => bag },
      heldItem: bag[0],
      equip: async (item: { name: string }) => { equipped.push(item.name); },
      lookAt: async () => {},
      setControlState: () => {},
      findBlocks: () => [ore.position],
      blockAt: () => ({ ...ore, boundingBox: 'block', canHarvest: () => true }),
      canSeeBlock: () => true,
      canDigBlock: () => true,
      digTime: () => 20,
      dig: async () => { bag.push({ name: 'cobblestone', count: 1 }); },
      stopDigging: () => {},
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'stone', count: 1 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(equipped).toContain('stone_pickaxe');
  });

  /**
   * 挖掘等级台架:方块与物品都照 minecraft-data 的原样声明,
   * `harvestTools` 是 itemId → true,`canHarvest` 照它算 —— 与 prismarine-block 同判据。
   * 铁矿石收石/铁/钻石镐(木镐、金镐都不够级),黑曜石只收钻石镐,石头六把镐都收。
   */
  type TierItem = {
    name: string;
    type: number;
    count: number;
    componentMap?: Map<string, { data: unknown }>;
  };

  function tierBot(opts: { block: string; bag: TierItem[] }) {
    const ITEMS: Record<number, string> = {
      10: 'wooden_pickaxe', 11: 'stone_pickaxe', 12: 'iron_pickaxe', 13: 'diamond_pickaxe',
      14: 'golden_pickaxe', 15: 'iron_shovel', 20: 'raw_iron', 21: 'obsidian', 22: 'cobblestone', 23: 'dirt',
    };
    const DEFS: Record<string, { id: number; drops: number[]; material: string; harvestTools: Record<number, true> }> = {
      iron_ore: { id: 1, drops: [20], material: 'incorrect_for_wooden_tool', harvestTools: { 11: true, 12: true, 13: true } },
      obsidian: { id: 2, drops: [21], material: 'incorrect_for_wooden_tool', harvestTools: { 13: true } },
      stone: { id: 3, drops: [22], material: 'mineable/pickaxe', harvestTools: { 10: true, 11: true, 12: true, 13: true, 14: true } },
      dirt: { id: 4, drops: [23], material: 'mineable/shovel', harvestTools: {} },
    };
    const def = DEFS[opts.block];
    const at = new V(2, 64, 0);
    const bag = [...opts.bag];
    const equipped: string[] = [];
    const bot = {
      equipped,
      dug: 0,
      entity: { id: 9, position: new V(0.5, 64, 0.5) },
      entities: {},
      health: 20,
      players: {},
      world: { raycast: () => ({ position: at, face: 1 }) },
      registry: {
        blocks: Object.fromEntries(Object.entries(DEFS).map(([n, d]) => [d.id, { name: n, drops: d.drops }])),
        blocksByName: Object.fromEntries(Object.entries(DEFS).map(([n, d]) => [n, { name: n, ...d }])),
        items: Object.fromEntries(Object.entries(ITEMS).map(([id, name]) => [id, { name }])),
        itemsByName: Object.fromEntries(Object.entries(ITEMS).map(([id, name]) => [name, { id: Number(id) }])),
      },
      inventory: { items: () => bag },
      heldItem: null as TierItem | null,
      equip: async (item: TierItem) => {
        equipped.push(item.name);
        bot.heldItem = item;
      },
      lookAt: async () => {},
      setControlState: () => {},
      findBlocks: () => [at],
      blockAt: () => ({
        name: opts.block, position: at, boundingBox: 'block',
        canHarvest: (t: number | null) => Object.keys(def.harvestTools).length === 0
          || (t !== null && def.harvestTools[t] === true),
      }),
      canSeeBlock: () => true,
      canDigBlock: () => true,
      digTime: () => 20,
      // 原版:等级不够照样挖得动,只是一点掉落都没有
      dig: async () => {
        bot.dug++;
        if (Object.keys(def.harvestTools).length === 0
          || (bot.heldItem && def.harvestTools[bot.heldItem.type] === true)) {
          bag.push({ name: ITEMS[def.drops[0]], type: def.drops[0], count: 1 });
        }
      },
      stopDigging: () => {},
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    return bot;
  }

  it('collect 显式 fastest:主手石镐时换上钻石镐', async () => {
    const stone = { name: 'stone_pickaxe', type: 11, count: 1 };
    const diamond = {
      name: 'diamond_pickaxe', type: 13, count: 1,
      componentMap: new Map([['enchantments', {
        data: { enchantments: [{ id: 20, level: 2 }], showTooltip: true },
      }]]),
    };
    const bot = tierBot({ block: 'stone', bag: [stone, diamond] });
    bot.heldItem = stone;
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'stone', count: 1, tool: 'fastest' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(bot.equipped[0]).toBe('diamond_pickaxe');
    expect(bot.heldItem).toBe(diamond);
  });

  it('默认 economy:石头用能掉落的最低等级木镐,不消耗铁镐', async () => {
    const wood = { name: 'wooden_pickaxe', type: 10, count: 1 };
    const stone = { name: 'stone_pickaxe', type: 11, count: 1 };
    const iron = { name: 'iron_pickaxe', type: 12, count: 1 };
    const bot = tierBot({ block: 'stone', bag: [iron, stone, wood] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'stone', count: 1 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(bot.heldItem).toBe(wood);
    expect(reports[0].text).toContain('工具:节约模式选:木镐');
  });

  it('fastest 按实际速度档选金镐,不把最高等级当最快', async () => {
    const gold = { name: 'golden_pickaxe', type: 14, count: 1 };
    const diamond = { name: 'diamond_pickaxe', type: 13, count: 1 };
    const bot = tierBot({ block: 'stone', bag: [diamond, gold] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'stone', count: 1, tool: 'fastest' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(bot.heldItem).toBe(gold);
    expect(reports[0].text).toContain('本步临时用最快工具:金镐');
  });

  it('fastest 先避开临损工具:金镐只剩 1 点时改用健康钻石镐', async () => {
    const wornGold = {
      name: 'golden_pickaxe', type: 14, count: 1,
      componentMap: new Map([['damage', { data: 31 }]]),
    };
    const diamond = { name: 'diamond_pickaxe', type: 13, count: 1 };
    const bot = tierBot({ block: 'stone', bag: [wornGold, diamond] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'stone', count: 1, tool: 'fastest' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(bot.heldItem).toBe(diamond);
  });

  it('economy 先避开临损工具,同等级再选剩余耐久更高的', async () => {
    const wornWood = {
      name: 'wooden_pickaxe', type: 10, count: 1,
      componentMap: new Map([['damage', { data: 58 }]]),
    };
    const stone = { name: 'stone_pickaxe', type: 11, count: 1 };
    const bot = tierBot({ block: 'stone', bag: [wornWood, stone] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'stone', count: 1 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(bot.heldItem).toBe(stone);

    const wornStone = {
      name: 'stone_pickaxe', type: 11, count: 1,
      componentMap: new Map([['damage', { data: 80 }]]),
    };
    const healthyStone = { name: 'stone_pickaxe', type: 11, count: 1 };
    const sameTier = tierBot({ block: 'iron_ore', bag: [wornStone, healthyStone] });
    const next = makeExecutorOn(sameTier);
    next.exec.submit([{ skill: 'collect', block: 'iron_ore', count: 1 }]);
    await waitUntil(() => next.reports.length === 1, 8000);
    expect(next.reports[0].kind).toBe('done');
    expect(sameTier.heldItem).toBe(healthyStone);
  });

  it('economy 只剩临损工具时停下，fastest 可按步临时覆盖', async () => {
    const wornWood = {
      name: 'wooden_pickaxe', type: 10, count: 1,
      componentMap: new Map([['damage', { data: 58 }]]),
    };
    const safe = tierBot({ block: 'stone', bag: [wornWood] });
    const economy = makeExecutorOn(safe);
    economy.exec.submit([{ skill: 'collect', block: 'stone', count: 1 }]);
    await waitUntil(() => economy.reports.length === 1, 8000);
    expect(economy.reports[0].kind).toBe('blocked');
    expect(economy.reports[0].text).toContain('临近损坏');
    expect(economy.reports[0].text).toContain('tool:"fastest"');
    expect(safe.dug).toBe(0);

    const override = tierBot({ block: 'stone', bag: [wornWood] });
    const fastest = makeExecutorOn(override);
    fastest.exec.submit([{ skill: 'collect', block: 'stone', count: 1, tool: 'fastest' }]);
    await waitUntil(() => fastest.reports.length === 1, 8000);
    expect(fastest.reports[0].kind).toBe('done');
    expect(override.dug).toBe(1);
    expect(override.heldItem).toBe(wornWood);
  });

  it('精确 tool 是单步覆盖:有货且够级就用它,不按 economy 替换', async () => {
    const stone = { name: 'stone_pickaxe', type: 11, count: 1 };
    const iron = { name: 'iron_pickaxe', type: 12, count: 1 };
    const bot = tierBot({ block: 'iron_ore', bag: [stone, iron] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'iron_ore', count: 1, tool: 'iron_pickaxe' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(bot.heldItem).toBe(iron);
    expect(reports[0].text).toContain('本步临时指定铁镐');
  });

  it('选中的工具 equip 失败时阻断，不拿错误主手继续挖', async () => {
    const wood = { name: 'wooden_pickaxe', type: 10, count: 1 };
    const bot = tierBot({ block: 'stone', bag: [wood] });
    bot.equip = async () => { throw new Error('slot rejected'); };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'stone', count: 1 }]);
    await waitUntil(() => reports.length === 1, 8000);

    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('没能拿到手');
    expect(bot.dug).toBe(0);
  });

  it('精确 tool 缺货或不够级:不替换、不 equip、不 dig', async () => {
    const stone = { name: 'stone_pickaxe', type: 11, count: 1 };
    const missing = tierBot({ block: 'iron_ore', bag: [stone] });
    const a = makeExecutorOn(missing);
    a.exec.submit([{ skill: 'collect', block: 'iron_ore', count: 1, tool: 'diamond_pickaxe' }]);
    await waitUntil(() => a.reports.length === 1, 8000);
    expect(a.reports[0].kind).toBe('blocked');
    expect(a.reports[0].text).toContain('包里没有本步指定的钻石镐');
    expect(missing.equipped).toEqual([]);
    expect(missing.dug).toBe(0);

    const wood = { name: 'wooden_pickaxe', type: 10, count: 1 };
    const wrong = tierBot({ block: 'iron_ore', bag: [wood, stone] });
    const b = makeExecutorOn(wrong);
    b.exec.submit([{ skill: 'collect', block: 'iron_ore', count: 1, tool: 'wooden_pickaxe' }]);
    await waitUntil(() => b.reports.length === 1, 8000);
    expect(b.reports[0].kind).toBe('blocked');
    expect(b.reports[0].text).toContain('本步指定的木镐挖铁矿石不掉东西');
    expect(wrong.equipped).toEqual([]);
    expect(wrong.dug).toBe(0);
  });

  // 正则 `/_ore$|stone|deepslate|cobble/` 认不出黑曜石、安山岩、下界岩这一批,
  // 认不出就是空手挖:黑曜石空手一块 250 秒,还什么都不掉。类别改由方块自己的数据说。
  it('选家伙什按方块自己的 harvestTools/material,不按名字猜:黑曜石也能拿到钻石镐', async () => {
    const bot = tierBot({ block: 'obsidian', bag: [{ name: 'diamond_pickaxe', type: 13, count: 1 }] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'obsidian', count: 1 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(bot.equipped).toContain('diamond_pickaxe');
  });

  it('方块无需工具时先换下上一把耐久工具,不让钻石镐替空手受损', async () => {
    const diamond = { name: 'diamond_pickaxe', type: 13, count: 1 };
    const shovel = { name: 'iron_shovel', type: 15, count: 1 };
    const dirt = { name: 'dirt', type: 23, count: 1 };
    const bot = tierBot({ block: 'dirt', bag: [diamond, shovel, dirt] });
    bot.heldItem = diamond;
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'dirt', count: 1 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(bot.equipped[0]).toBe('dirt');
    expect(bot.heldItem).toBe(dirt);
  });

  it('无掉落门槛的方块只在 fastest 下选加速工具', async () => {
    const shovel = { name: 'iron_shovel', type: 15, count: 1 };
    const bot = tierBot({ block: 'dirt', bag: [shovel] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'dirt', count: 1, tool: 'fastest' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(bot.heldItem).toBe(shovel);
  });

  it('挖掘等级不够:出发前阻断,不让木镐毁掉铁矿', async () => {
    const bot = tierBot({ block: 'iron_ore', bag: [{ name: 'wooden_pickaxe', type: 10, count: 1 }] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'iron_ore', count: 1 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(bot.equipped).toEqual([]);
    expect(bot.dug).toBe(0);
    expect(reports[0].text).toContain('包里没有能保住铁矿石掉落的工具');
    expect(reports[0].text).toContain('要石镐及以上');
    expect(reports[0].text).toContain('没动方块');
  });

  it('够级就一个字都不加:石镐挖铁矿,回执只说采到了什么', async () => {
    const bot = tierBot({ block: 'iron_ore', bag: [{ name: 'stone_pickaxe', type: 11, count: 1 }] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'iron_ore', count: 1 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('实际入包 1 个');
    expect(reports[0].text).not.toContain('及以上');
  });

  it('通道半路一格没底:自己垫过去接着挖,不再整条收工', async () => {
    // x 0→5 一条实心地板,第 3 格底下缺一块
    const cells = massif(0, 5, 60, 63, 0, 0).filter((c) => c !== '3,63,0');
    const bot = voxelBot({ cells, bag: [{ name: 'cobblestone', count: 64 }] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'tunnel', at: [5, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 15000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('通道挖了 5/5 步');
    expect(reports[0].text).toContain('路上有 1 格没底,垫上了');
    // 走到终点才是"挖通了";垫了几格与这句结论分开说
    expect(reports[0].text).toContain('挖通了');
    expect(bot.world.get('3,63,0')).toBe('cobblestone');
  });

  // tunnel 按通道是否贯通验收，只有挖掘进度不代表完成。
  it('垫不上就是没挖通:报受阻,并说清是包里没垫脚材料', async () => {
    const cells = massif(0, 5, 60, 63, 0, 0).filter((c) => c !== '3,63,0');
    const bot = voxelBot({ cells, bag: [] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'tunnel', at: [5, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 15000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('通道没挖通');
    expect(reports[0].text).toContain('(3, 64, 0) 脚下悬空,垫脚也没垫上');
    expect(reports[0].text).toContain('垫脚名单里的方块包里都没有');
    // 挖到哪一格进现场,不与"挖通了"共用一句话
    expect(reports[0].text).toContain('[现场] 通道挖了 2/5 步,人在 (2, 64, 0)');
  });

  it('半路挖不动就是没挖通:走了几步进现场,不报成一句读着像做完的话', async () => {
    // x 0→5 一条实心地板,第 3 格前面碰上岩浆
    const cells = massif(0, 5, 60, 63, 0, 0);
    const bot = voxelBot({ cells, props: { '3,64,0': 'lava' }, bag: [] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'tunnel', at: [5, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 15000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('通道没挖通');
    expect(reports[0].text).toContain('碰上岩浆');
    expect(reports[0].text).toContain('[现场] 通道挖了 2/5 步');
    expect(reports[0].text).not.toContain('挖通了');
  });

  /**
   * 竖井允许水平位移为零，逐格挖到目标终点才算完成。
   */
  it('竖井:横向 0 格往下,一格一格挖到终点才算到底', async () => {
    const bot = voxelBot({ cells: massif(0, 0, 50, 63, 0, 0) });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'tunnel', at: [0, 60, 0] }]);
    await waitUntil(() => reports.length === 1, 15000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('竖井挖了 4/4 格,人在 (0, 60, 0)');
    expect(reports[0].text).toContain('到底了');
    for (const y of [60, 61, 62, 63]) expect(bot.world.has(`0,${y},0`)).toBe(false);
  });

  it('竖井挖穿到空腔:停在这儿报事实,不接着往下捅', async () => {
    // 岩体只到 y=60,下面是空的
    const bot = voxelBot({ cells: massif(0, 0, 60, 63, 0, 0), bag: [] });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'tunnel', at: [0, 55, 0] }]);
    await waitUntil(() => reports.length === 1, 15000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('竖井没到底');
    expect(reports[0].text).toContain('再挖就是往下掉');
    expect(reports[0].text).toContain('[现场] 竖井挖了 3/9 格,人在 (0, 61, 0)');
  });

  it('正上正下 0 格高差才是错写:说清是同一格,不再拿"横向 0 格"打发', async () => {
    const bot = voxelBot({ cells: massif(0, 0, 60, 63, 0, 0) });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'tunnel', at: ['~', '~', '~'] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('终点就是脚下这一格');
    expect(reports[0].text).not.toContain('横向 0 格');
  });

  /**
 * 维持条件的垫桥次数与未垫成原因须分别报告。
 */
  it('垫桥报数与垫不上的原因分开说,原因点名是哪份名单', async () => {
    const cells = massif(0, 5, 60, 63, 0, 0).filter((c) => c !== '3,63,0');
    const ok = voxelBot({ cells, bag: [{ name: 'cobblestone', count: 64 }] });
    const rigOk = makeExecutorOn(ok);
    rigOk.exec.submit([{ skill: 'tunnel', at: [5, 64, 0] }]);
    await waitUntil(() => rigOk.reports.length === 1, 15000);
    expect(rigOk.reports[0].text).toContain('路上有 1 格没底,垫上了');

    const bare = voxelBot({ cells, bag: [] });
    const rigBare = makeExecutorOn(bare);
    rigBare.exec.submit([{ skill: 'tunnel', at: [5, 64, 0] }]);
    await waitUntil(() => rigBare.reports.length === 1, 15000);
    // 缺少垫脚材料时须列出实际生效的名单。
    expect(rigBare.reports[0].text).toContain('垫脚名单里的方块包里都没有(泥土、圆石)');
  });

  it('挖通道时周身黑下来自己插一根,收工报数', async () => {
    const cells = massif(0, 5, 60, 63, 0, 0);
    const bot = voxelBot({ cells, bag: [{ name: 'torch', count: 8 }], dark: true });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'tunnel', at: [5, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 15000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('顺手插了 1 根火把');
    expect(hasTorch(bot)).toBe(true);
  });

  // 脚下那一格就是下一铲:插在地上的火把一挖就跟着掉,贴在井壁上那根整条井都留得住
  it('竖井里的火把贴墙,不贴地', async () => {
    const bot = voxelBot({ cells: massif(-1, 1, 50, 63, -1, 1), bag: [{ name: 'torch', count: 8 }], dark: true });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'tunnel', at: [0, 60, 0] }]);
    await waitUntil(() => reports.length === 1, 15000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('顺手插了 1 根火把');
    // 这一趟唯一的放置就是那根火把,贴的面是横的
    expect(bot.faces.length).toBe(1);
    expect(bot.faces[0][1]).toBe(0);
    expect([...bot.world.values()]).toContain('wall_torch');
    expect(reports[0].text).not.toContain('有一段黑着没插上');
  });

  it('包里没火把:不插也不算受阻,只在回执里说黑着那一段没插上', async () => {
    const cells = massif(0, 5, 60, 63, 0, 0);
    const bot = voxelBot({ cells, bag: [], dark: true });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'tunnel', at: [5, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 15000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('挖通了');
    expect(reports[0].text).toContain('有一段黑着没插上:照明名单里的方块包里都没有(火把)');
  });

  /**
   * lightWhen 决定补光场合，照明名单决定使用材料；默认 dig 仅在挖通道或空间时补光。
   */
  describe('lightWhen:补光的场合', () => {
    function litRig(
      lightWhen: 'dig' | 'anywhere',
      light?: string[],
      permitResourcePlacement?: ResourcePlacementGate,
    ) {
      const bot = voxelBot({
        cells: massif(-1, 40, 60, 63, -1, 1),
        bag: [{ name: 'torch', count: 8 }],
        dark: true,
        knows: ['diamond_ore'],
      });
      const reports: TaskReport[] = [];
      const exec = new Executor({
        getBot: () => bot as never,
        report: (r) => reports.push(r),
        log,
        nextId: nextTaskId(),
        policy: {
          get: () => ({ ...defaultPolicy(), lightWhen, ...(light ? { light } : {}) }),
          defaults: () => ({ scaffold: ['dirt', 'cobblestone'], light: ['torch'] }),
        },
        permitResourcePlacement,
      });
      return { bot, exec, reports };
    }

    it('dig(默认):赶路途中黑着也不补', async () => {
      const rig = litRig('dig');
      rig.exec.submit([{ skill: 'find', target: 'diamond_ore', direction: 'east', distance: 24 }]);
      await waitUntil(() => rig.reports.length === 1, 15000);
      expect(rig.reports[0].kind).toBe('done');
      expect(rig.reports[0].text).not.toContain('火把');
      expect(hasTorch(rig.bot)).toBe(false);
    });

    it('anywhere:赶路途中黑了就补,收工同一句报数', async () => {
      const settled: boolean[] = [];
      const rig = litRig('anywhere', undefined, () => ({
        ok: true,
        finish: (placed) => settled.push(placed),
      }));
      rig.exec.submit([{ skill: 'find', target: 'diamond_ore', direction: 'east', distance: 24 }]);
      await waitUntil(() => rig.reports.length === 1, 15000);
      expect(rig.reports[0].kind).toBe('done');
      expect(rig.reports[0].text).toContain('顺手插了 1 根火把');
      expect(hasTorch(rig.bot)).toBe(true);
      expect(settled).toEqual([true]);
    });

    it('anywhere:火把触到蓝图 reserve 时补光不取得 permit,世界与库存都不动', async () => {
      const rig = litRig('anywhere', undefined, () => ({
        ok: false,
        reason: 'torch 的蓝图 reserve 是 8,随身只有 8;没有可用的材料临时覆盖',
      }));
      rig.exec.submit([{ skill: 'find', target: 'diamond_ore', direction: 'east', distance: 24 }]);
      await waitUntil(() => rig.reports.length === 1, 15000);
      expect(rig.reports[0].kind).toBe('done');
      expect(rig.reports[0].text).toContain('有一段黑着没插上:torch 的蓝图 reserve 是 8');
      expect(hasTorch(rig.bot)).toBe(false);
      expect(rig.bot.inventory.items().find((item) => item.name === 'torch')?.count).toBe(8);
    });

    /**
     * 耕地碰撞盒高 15/16，站在其上时 position.floored() 可仍落在耕地格内；目标格被实心方块占用时不发放置包。
     */
    it('脚下这一格被实心方块占着:不发包,照实说是什么占着', async () => {
      const rig = litRig('anywhere', undefined, () => {
        throw new Error('这一格插不进去,连取料许可都不该问');
      });
      // 整条行军路线的落脚格都是耕地(实心,服务端不收放置)
      for (let x = -1; x <= 40; x++) rig.bot.world.set(`${x},64,0`, 'farmland');
      rig.exec.submit([{ skill: 'find', target: 'diamond_ore', direction: 'east', distance: 24 }]);
      await waitUntil(() => rig.reports.length === 1, 15000);
      expect(rig.reports[0].kind).toBe('done');
      expect(rig.reports[0].text).toContain('火把插不进去');
      expect(rig.reports[0].text).not.toContain('顺手插了');
      // 一个放置包都没发出去
      expect(rig.bot.faces).toEqual([]);
      expect(hasTorch(rig.bot)).toBe(false);
      expect(rig.bot.inventory.items().find((item) => item.name === 'torch')?.count).toBe(8);
    });

    it('名单为空:两档都不补', async () => {
      const rig = litRig('anywhere', []);
      rig.exec.submit([{ skill: 'find', target: 'diamond_ore', direction: 'east', distance: 24 }]);
      await waitUntil(() => rig.reports.length === 1, 15000);
      expect(rig.reports[0].text).not.toContain('火把');
      expect(hasTorch(rig.bot)).toBe(false);
    });
  });

  it('照明名单设成空的:黑着也不插,回执一个字都不提', async () => {
    const cells = massif(0, 5, 60, 63, 0, 0);
    const bot = voxelBot({ cells, bag: [{ name: 'torch', count: 8 }], dark: true });
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      policy: {
        get: () => ({ ...defaultPolicy(), light: [] }),
        defaults: () => ({ scaffold: ['dirt', 'cobblestone'], light: ['torch'] }),
      },
    });
    exec.submit([{ skill: 'tunnel', at: [5, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 15000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).not.toContain('火把');
    expect(hasTorch(bot)).toBe(false);
  });

  it('挖空间也走同一条照明条件,报数进同一句', async () => {
    // 挖旁边那片,脚下那块留着 —— 挖空自己的落脚点时火把没有能贴的面,那是另一回事
    const cells = [...massif(0, 3, 60, 63, 0, 0), ...massif(1, 2, 64, 65, 0, 0)];
    const bot = voxelBot({ cells, bag: [{ name: 'torch', count: 8 }], dark: true });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'excavate', shape: 'box', anchors: [[1, 64, 0], [2, 65, 0]] }]);
    await waitUntil(() => reports.length === 1, 15000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('顺手插了 1 根火把');
  });

  /**
   * 火把不能依附后续待挖的支撑格；贴北墙时 face=[0,0,1]，表示点击北墙的南面。
   */
  it('通道照明不贴接下来要挖的墙:北向通道的火把落在侧墙或地上', async () => {
    const cells = [
      ...massif(-1, 1, 63, 63, -8, 0),   // 地板
      ...massif(-1, -1, 64, 65, -8, 0),  // 西墙
      ...massif(1, 1, 64, 65, -8, 0),    // 东墙
      ...massif(0, 0, 64, 65, -8, -1),   // 前方要挖的芯
    ];
    const bot = voxelBot({ cells, bag: [{ name: 'torch', count: 8 }], dark: true });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'tunnel', at: [0, 64, -7] }]);
    await waitUntil(() => reports.length === 1, 15000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('顺手插了');
    const torches = bot.placedFaces.filter((p) => p.name === 'torch');
    expect(torches.length).toBeGreaterThan(0);
    for (const t of torches) expect(t.face).not.toEqual([0, 0, 1]);
  });

  /**
   * 账本保护的容器和工作站由 excavate 跳过并点名，tunnel 到跟前停步并报告内容。
   */
  it('excavate:账本上的箱子跳过不挖,回执点名;别的格照挖', async () => {
    const bot = voxelBot({ cells: ['2,64,0', '0,63,0', '1,63,0', '2,63,0'], props: { '1,64,0': 'chest' } });
    const chests = new ChestBook(null);
    chests.remember('overworld', { x: 1, y: 64, z: 0 }, [{ name: 'iron_ingot', count: 5 }], 1, 27);
    const { exec, reports } = makeExecutorWith(bot, chests);
    exec.submit([{ skill: 'excavate', shape: 'line', anchors: [[1, 64, 0], [2, 64, 0]] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('挖开了 1/2 块');
    expect(reports[0].text).toContain('账本里的容器/工作站((1, 64, 0) 的箱子)');
    expect(bot.world.get('1,64,0')).toBe('chest'); // 箱子还站着
    expect(bot.world.has('2,64,0')).toBe(false);   // 旁边那格照挖
  });

  /**
   * 账本保护只针对有料的记录，空工作台仍可清除。
   */
  it('excavate:账本记录是空的就不护着,那一格照挖', async () => {
    const bot = voxelBot({ cells: ['0,63,0', '1,63,0'], props: { '1,64,0': 'crafting_table' } });
    const chests = new ChestBook(null);
    chests.rememberStation('overworld', { x: 1, y: 64, z: 0 }, 'crafting_table', Date.now());
    const { exec, reports } = makeExecutorWith(bot, chests);
    exec.submit([{ skill: 'excavate', shape: 'line', anchors: [[1, 64, 0], [1, 64, 0]] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).not.toContain('没动它');
    expect(bot.world.has('1,64,0')).toBe(false);
  });

  /**
   * 工作台不能用 take 清空，collect 按视线寻找且不接受坐标；回执指出先走近再 collect。
   */
  it('excavate:护住的是工作台时,出路说的是走到跟前再 collect', async () => {
    const bot = voxelBot({ cells: ['0,63,0', '1,63,0'], props: { '1,64,0': 'crafting_table' } });
    const chests = new ChestBook(null);
    // 那一格的账本记录还留着上一任箱子的内容:有料才轮得到保护闸
    chests.remember('overworld', { x: 1, y: 64, z: 0 }, [{ name: 'oak_planks', count: 3 }], 1, 27);
    const { exec, reports } = makeExecutorWith(bot, chests);
    exec.submit([{ skill: 'excavate', shape: 'line', anchors: [[1, 64, 0], [1, 64, 0]] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('goto 到它跟前(挨着 (1, 64, 0) 那一格)再 collect');
    expect(reports[0].text).not.toContain('take 掏空');
    expect(bot.world.get('1,64,0')).toBe('crafting_table');
  });

  it('tunnel:挖到账本上有料的熔炉跟前停步,报它里头有什么', async () => {
    const cells = [
      ...massif(0, 4, 63, 63, 0, 0),  // 地板
      ...massif(1, 4, 64, 65, 0, 0),  // 前方要挖的芯
    ];
    const bot = voxelBot({ cells, props: { '2,64,0': 'furnace' } });
    const chests = new ChestBook(null);
    chests.rememberFurnace('overworld', { x: 2, y: 64, z: 0 }, 'furnace',
      { input: { name: 'raw_iron', count: 4 }, fuel: { name: 'coal', count: 1 }, output: null },
      1000, 2000);
    const { exec, reports } = makeExecutorWith(bot, chests);
    exec.submit([{ skill: 'tunnel', at: [4, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('(2, 64, 0) 的熔炉');
    expect(reports[0].text).toContain('账本记着里头有 粗铁×4');
    expect(bot.world.get('2,64,0')).toBe('furnace');
  });

});

/**
 * 执行器按技能推导效果判据；无法准确推导时返回 null，负例与正例都须覆盖。
 */
describe('deriveExpect:验收判据按 (skill,参数) 推导', () => {
  /**
   * 推导只读 registry(掉落表、方块表),不碰位置也不碰物品栏 —— 假件只给 registry,
   * 哪一天它开始读别的,这些用例会当场炸。
   */
  function reg() {
    const ITEMS: Record<number, string> = {
      1: 'cobblestone', 2: 'oak_log', 3: 'coal', 4: 'wheat_seeds', 5: 'oak_planks', 6: 'torch',
    };
    const BLOCKS: Record<string, number[]> = {
      stone: [1], cobblestone: [1], oak_log: [2], spruce_log: [2], coal_ore: [3],
      short_grass: [], oak_leaves: [], torch: [], farmland: [],
    };
    const itemsByName = Object.fromEntries(Object.entries(ITEMS).map(([id, n]) => [n, { id: Number(id), name: n }]));
    return {
      registry: {
        blocksByName: Object.fromEntries(
          Object.entries(BLOCKS).map(([n, drops], i) => [n, { id: i + 100, name: n, drops }]),
        ),
        items: Object.fromEntries(Object.entries(ITEMS).map(([id, name]) => [id, { name }])),
        itemsByName,
      },
      // craft 的直接材料在配方表里:一块原木出四块木板
      recipesAll: () => [{ result: { id: 5, count: 4 }, ingredients: [{ id: 2 }], requiresTable: false }],
    } as unknown as Parameters<typeof deriveExpect>[0];
  }
  const derive = (call: SkillCall) => deriveExpect(reg(), call);

  it('goto:绝对坐标推「人到那儿」', () => {
    expect(derive({ skill: 'goto', at: [10, 64, -20] })).toEqual({ near: [10, 64, -20] });
  });

  // [x,z] 形态的 y 是执行那一刻的地表读数,调用里根本没有;`~` 让它按脚下解析,
  // 判定就收成了纯水平距离 —— 不然拿她写的那个占位 y 去比,站对了也判成没到
  it('goto:只写 [x,z] 时 y 用 `~`,判定收成纯水平距离', () => {
    const [step] = (parseSteps([{ skill: 'goto', at: [10, -20] }]) as { steps: SkillCall[] }).steps;
    expect(derive(step)).toEqual({ near: [10, '~', -20] });
  });

  // 技能按开工那一刻的脚下解析,裁决在收工那一刻再解析一次:人走过之后同一个 `~5`
  // 指的不是同一格,推出来的判据会指向一个谁也没去过的地方
  it('goto:相对锚点不推(两次解析不是同一格)', () => {
    expect(derive({ skill: 'goto', at: ['~5', '~', '~'] })).toBeNull();
  });

  it('goto/build/excavate/tunnel:试算不动世界,没有后置状态', () => {
    expect(derive({ skill: 'goto', at: [1, 2, 3], dryRun: true })).toBeNull();
    expect(derive({ skill: 'build', anchors: [[1, 2, 3]], material: 'torch', dryRun: true })).toBeNull();
    expect(derive({ skill: 'excavate', shape: 'line', anchors: [[1, 2, 3], [1, 2, 3]], dryRun: true })).toBeNull();
    expect(derive({ skill: 'tunnel', at: [1, 2, 3], dryRun: true })).toBeNull();
  });

  it('tunnel:绝对终点推「走得到那儿」,相对的不推', () => {
    expect(derive({ skill: 'tunnel', at: [8, 64, 0] })).toEqual({ near: [8, 64, 0] });
    expect(derive({ skill: 'tunnel', at: ['~', '~-10', '~'] })).toBeNull();
  });

  /**
   * collect.count 计方块，has.count 计物品；掉落数量、名称及是否入包都可能不同。
   * 掉落名称表仍供 skillProduces/causalNeeds 判断产出依赖，不用于推导 collect 的库存验收。
   */
  it('collect:一律不推,退回技能自己按块数与入包数报事实', () => {
    expect(derive({ skill: 'collect', block: 'stone', count: 10 })).toBeNull();
    expect(derive({ skill: 'collect', block: 'coal_ore', count: 3 })).toBeNull();
    expect(derive({ skill: 'collect', block: 'oak_log', count: 2 })).toBeNull();
    expect(derive({ skill: 'collect', block: 'log', count: 4 })).toBeNull();
  });

  it('build:单格推「那一格是这个方块」,贴面形态推的是落点不是参照格', () => {
    expect(derive({ skill: 'build', anchors: [[3, 64, 5]], material: 'torch' }))
      .toEqual({ block: 'torch', at: [3, 64, 5] });
    expect(derive({ skill: 'build', on: [{ at: [3, 63, 5], face: 'up' }], material: 'torch' }))
      .toEqual({ block: 'torch', at: [3, 64, 5] });
  });

  // 搭了多少报多少是 build 的正常结局(一块都没放上才是受阻),多格没有单格判据
  it('build:多格与形状不推,相对锚点不推', () => {
    expect(derive({ skill: 'build', anchors: [[1, 64, 1], [2, 64, 1]], material: 'torch' })).toBeNull();
    expect(derive({ skill: 'build', shape: 'line', anchors: [[1, 64, 1], [4, 64, 1]], material: 'torch' })).toBeNull();
    expect(derive({ skill: 'build', anchors: [['~', '~1', '~']], material: 'torch' })).toBeNull();
  });

  // 种子放下去长出来的是 wheat,按 wheat_seeds 比对必然落空 —— 材料本身得先是个方块
  it('build:材料不是方块时不推', () => {
    expect(derive({ skill: 'build', anchors: [[3, 64, 5]], material: 'wheat_seeds' })).toBeNull();
  });

  it('excavate:锚点全同(就那一格)推「变成空气」,多格不推', () => {
    expect(derive({ skill: 'excavate', shape: 'line', anchors: [[3, 64, 5], [3, 64, 5]] }))
      .toEqual({ block: 'air', at: [3, 64, 5] });
    expect(derive({ skill: 'excavate', shape: 'line', anchors: [[3, 64, 5], [3, 68, 5]] })).toBeNull();
  });

  it('craft:点名产物的推「包里 ≥ count」,自己摆格子的不推(产出槽出什么算什么)', () => {
    expect(derive({ skill: 'craft', item: 'torch', count: 4 }))
      .toEqual({ has: { item: 'torch', count: 4 } });
    expect(derive({ skill: 'craft', grid: [['coal'], ['stick']], count: 2 })).toBeNull();
  });

  /**
   * 三种形态说的是**状态**,不是增减,也不是"目标死了""手上是它"。
   * smelt 更是连产物名都不在调用里 —— 输出槽第一次出东西才知道叫什么。
   */
  it('推不准的一律返回 null', () => {
    const nulls: SkillCall[] = [
      { skill: 'goto_player', name: 'Phant' },
      { skill: 'follow', name: 'Phant' },
      { skill: 'find', target: 'sheep', direction: 'north', distance: 64 },
      { skill: 'flee', distance: 24 },
      { skill: 'surface' },
      { skill: 'fish' },
      { skill: 'probe', shape: 'box', anchors: [[0, 0, 0], [1, 1, 1]] },
      { skill: 'smelt', input: 'iron_ore', count: 3, fuel: 'coal' },
      { skill: 'eat', item: 'bread' },
      { skill: 'attack', target: 'zombie' },
      { skill: 'equip', item: 'iron_sword' },
      { skill: 'pickup' },
      { skill: 'toss', item: 'cobblestone', count: 8 },
      { skill: 'stow', item: 'cobblestone', count: 8 },
      { skill: 'take', item: 'cobblestone', count: 8 },
      { skill: 'chat', text: '喂' },
    ];
    for (const call of nulls) expect([call.skill, derive(call)]).toEqual([call.skill, null]);
  });

  // use 的判据是 (item, 目标方块) → 后置读数那张表,住在 use 自己那儿
  it('use:留给它自己那张效果表', () => {
    expect(derive({ skill: 'use', at: [1, 2, 3], item: 'wooden_hoe' })).toBeNull();
  });

  /**
   * 第四形态 {holding}:手上是什么只有一份真相,不赛跑。只推手持位那一半——
   * 盔甲/盾上身不落在手上,holding 说不了;flee/attack 议过不收(实体表会赛跑)。
   */
  it('equip:手持位推 holding(类别名推实际那件);盔甲、腾手、包里没有的不推', () => {
    const bot = {
      ...(reg() as object),
      inventory: {
        items: () => [
          { name: 'stone_sword', type: 1, count: 1 },
          { name: 'iron_chestplate', type: 2, count: 1 },
        ],
      },
    } as Parameters<typeof deriveExpect>[0];
    expect(deriveExpect(bot, { skill: 'equip', item: 'stone_sword' }))
      .toEqual({ holding: { item: 'stone_sword' } });
    expect(deriveExpect(bot, { skill: 'equip', item: 'sword' }))
      .toEqual({ holding: { item: 'stone_sword' } });
    expect(deriveExpect(bot, { skill: 'equip', item: 'iron_chestplate' })).toBeNull();
    expect(deriveExpect(bot, { skill: 'equip' })).toBeNull();
    expect(deriveExpect(bot, { skill: 'equip', item: 'diamond_sword' })).toBeNull();
  });

  // tunnel 冻结后的锚点为绝对坐标；终点等于脚下时，到达判据恒真，不能据此判断挖通。
  it('tunnel:终点就是脚下那一格时不推(恒真判据不裁决)', () => {
    const bot = {
      ...(reg() as object),
      entity: { position: { x: 3.5, y: 64, z: 5.5 } },
    } as Parameters<typeof deriveExpect>[0];
    expect(deriveExpect(bot, { skill: 'tunnel', at: [3, 64, 5] })).toBeNull();
    expect(deriveExpect(bot, { skill: 'tunnel', at: [8, 64, 5] })).toEqual({ near: [8, 64, 5] });
  });

  /**
   * 产出与入料是同一张表的两半,各自查得到:裁决(上面那些)按产出推后置状态,
   * 因果闸按「后一步的入料 ∩ 前一步的产出 ≠ ∅」判依赖。
   */
  describe('产出/入料表:两个消费者共用一份', () => {
    it('产出:collect 报掉落物,craft 报点名的产物,服务端说了算的报空', () => {
      expect(skillProduces({ skill: 'collect', block: 'stone', count: 4 }, reg())).toEqual(['cobblestone']);
      expect(skillProduces({ skill: 'craft', item: 'oak_planks', count: 4 }, reg())).toEqual(['oak_planks']);
      expect(skillProduces({ skill: 'take', item: 'coal', count: 2 }, reg())).toEqual(['coal']);
      expect(skillProduces({ skill: 'smelt', input: 'iron_ore', count: 1, fuel: 'coal' }, reg())).toEqual([]);
      expect(skillProduces({ skill: 'craft', grid: [['coal']], count: 1 }, reg())).toEqual([]);
      expect(skillProduces({ skill: 'goto', at: [1, 2, 3] }, reg())).toEqual([]);
    });

    it('产出:没有 bot 就报调用里写得出的那个名字(掉落表在 registry 上)', () => {
      expect(skillProduces({ skill: 'collect', block: 'stone', count: 4 }, null)).toEqual(['stone']);
    });

    // 类别名只有整类都掉自己时才认得出:log 掉 oak_log,而 ore 掉的是煤与原矿、
    // leaves 干脆什么都不掉;掉落表为空 = 概率掉落(草掉种子、树叶掉树苗)
    it('产出:类别名只在整类都掉自己时认,概率掉落与不认识的方块报空', () => {
      expect(skillProduces({ skill: 'collect', block: 'log', count: 4 }, reg())).toEqual(['log']);
      expect(skillProduces({ skill: 'collect', block: 'ore', count: 4 }, reg())).toEqual([]);
      expect(skillProduces({ skill: 'collect', block: 'leaves', count: 4 }, reg())).toEqual([]);
      expect(skillProduces({ skill: 'collect', block: 'short_grass', count: 1 }, reg())).toEqual([]);
      expect(skillProduces({ skill: 'collect', block: 'nonexistent_block', count: 1 }, reg())).toEqual([]);
    });

    it('入料:craft 点名产物时查配方表的直接材料,自己摆格子时就是格子里那些名字', () => {
      expect(skillNeeds({ skill: 'craft', item: 'oak_planks', count: 4 }, reg())).toEqual(['oak_log']);
      expect(skillNeeds({ skill: 'craft', grid: [['coal', ''], ['stick', 'coal']], count: 1 }, null))
        .toEqual(['coal', 'stick']);
      expect(skillNeeds({ skill: 'build', anchors: [[1, 2, 3]], material: 'torch' }, null)).toEqual(['torch']);
      expect(skillNeeds({ skill: 'smelt', input: 'iron_ore', count: 1, fuel: 'coal' }, null))
        .toEqual(['iron_ore', 'coal']);
      expect(skillNeeds({ skill: 'collect', block: 'stone', count: 1 }, reg())).toEqual([]);
    });

    // collect oak_log → craft oak_planks 是「真串行」那一类,因果边就落在这个交集上
    it('因果边 = 后一步的入料 ∩ 前一步的产出', () => {
      const produced = new Set(skillProduces({ skill: 'collect', block: 'oak_log', count: 3 }, reg()));
      const needed = skillNeeds({ skill: 'craft', item: 'oak_planks', count: 4 }, reg());
      expect(needed.filter((n) => produced.has(n))).toEqual(['oak_log']);
    });

    it('causalNeeds:只连产出被这一步消费的更早步,类别名双向认', () => {
      const steps: SkillCall[] = [
        { skill: 'pickup', item: 'coal' },
        { skill: 'goto', at: [1, 64, 1] },
        { skill: 'toss', item: 'coal', count: 1 },
      ];
      // 第 3 步只连第 1 步(产煤);第 2 步 goto 不产东西,不成边
      expect(causalNeeds(steps, 2, null)).toEqual([{ step: 1, items: ['coal'] }]);
      // 第 2 步 goto 不消费任何东西:一条边都没有
      expect(causalNeeds(steps, 1, null)).toEqual([]);
      // 类别名:collect log 的产出(降级口径按类别记)接得上 craft 要的 oak_log
      const cat: SkillCall[] = [
        { skill: 'collect', block: 'log', count: 3 },
        { skill: 'build', anchors: [[1, 2, 3]], material: 'oak_log' },
      ];
      expect(causalNeeds(cat, 1, null)).toEqual([{ step: 1, items: ['oak_log'] }]);
    });
  });
});

/**
 * 回执依据每一步的世界效果差分；差分为空时报告受阻。
 */
describe('差分为空就是受阻', () => {
  it('collect:挖掉了但一个都没进包 = 没做成,两个事实一句话里分开说', async () => {
    const bot = mineBot2();
    bot.pathfinder.goto = async () => { bot.entity.position = new V(-8, 50, 8); };
    bot.dig = async () => {}; // 服务端认了这一挖,掉落物没进包
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'coal_ore', count: 1 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    // 方块是否已挖掉与掉落是否进包须分别报告。
    expect(reports[0].text).toContain('挖掉了 1 块煤矿石');
    expect(reports[0].text).toContain('一个都没进包');
  });

  it('craft:服务端给了别的东西、点名那样一个都没多 = 没做成', async () => {
    const bot = craftBot({ logs: 4, gain: 'none' });
    const extra: Array<{ type: number; count: number; name: string }> = [];
    const base = bot.inventory.items;
    bot.inventory.items = () => [...base(), ...extra];
    // 净增不为空(多了个工作台),可点名的木板一个都没多:判据是**这一样东西自己的净增**
    bot.craft = async (_r, times) => {
      bot.crafts.push(times);
      extra.push({ type: 3, count: 1, name: 'crafting_table' });
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'craft', item: 'acacia_planks', count: 4 }]);
    await waitUntil(() => reports.length === 1, 15_000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('金合欢木板一个都没多');
    expect(reports[0].text).toContain('这一步包里多出来的是:工作台×1');
  }, 20_000);

  /**
   * 单次 no-gain 可能来自库存更新迟到，不能立即终止合成；按总净增验收，缺口回执保留未即时入包的记录。
   */
  it('craft:某一次当场没读到入包不当场停,缺口才把它写进回执', async () => {
    const bot = craftBot({ logs: 4, gain: 'none' });
    const extra: Array<{ type: number; count: number; name: string }> = [];
    const base = bot.inventory.items;
    bot.inventory.items = () => [...base(), ...extra];
    bot.craft = async (_r, times) => {
      bot.crafts.push(times);
      if (bot.crafts.length === 2) extra.push({ type: 2, count: 4, name: 'acacia_planks' });
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'craft', item: 'acacia_planks', count: 8 }]);
    await waitUntil(() => reports.length === 1, 20_000);
    // 两次都摆了:第 1 次读到 0 也没停手
    expect(bot.crafts).toEqual([1, 1]);
    expect(reports[0].text).toContain('第 1 次当场没读到入包');
    expect(reports[0].text).toContain('要 8 个,只多出 4 个');
    // 数量没到,这一步仍是没做成
    expect(reports[0].kind).toBe('blocked');
  }, 25_000);

  it('build:六个面都试过服务端不认 = 没做成,回执带那一格的期望与实测', async () => {
    const bot = cellBot({ '1,63,0': 'stone', '0,63,0': 'stone' }, [{ name: 'torch', count: 4 }]);
    bot.placeBlock = async () => { throw new Error('No block has been placed : the block is still air'); };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'build', material: 'torch', anchors: [[1, 64, 0]] } as never]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('一块都没放上');
    expect(reports[0].text).toContain('该步按「(1,64,0) 为火把」核验:落空(实测 空气,读于 ');
  });

  /**
   * 「那片 N 格里没有实心方块,不用挖」对着一池水也照说 —— 与 build「一个箱子都没放上
   * 却报 done」同一形状。挖空这一单的后置状态是那几格变成空气,没变成就是没做成。
   */
  it('excavate:目标区全是液体不是"不用挖",是一块都没挖成', async () => {
    const bot = cellBot({ '0,60,0': 'water', '0,61,0': 'water', '0,62,0': 'water' }, []);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'excavate', shape: 'line', anchors: [[0, 60, 0], [0, 62, 0]] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('一块都没挖');
    expect(reports[0].text).toContain('水×3');
    expect(reports[0].text).not.toContain('不用挖');
  });

  it('excavate:目标区本来就是空气,那才是不用挖', async () => {
    const bot = cellBot({}, []);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'excavate', shape: 'line', anchors: [[0, 60, 0], [0, 62, 0]] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('本来就是空的,不用挖');
  });

  /**
   * 推导出来的**存量**判据只单向用:存量不够一定没做成(推翻"技能报成"),
   * 存量够却推不出这一步做成了 —— 摆下去一个都没多出来时,「包里没多」正是她要读的那句。
   * (材料凑不齐那一路另算:那一步要的量本来就够,craft 自己就按做成收。)
   */
  it('存量判据不翻案:技能报阻照旧受阻,读数照样交出去', async () => {
    const bot = craftBot({ logs: 1, planks: 8, gain: 'none' });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'craft', item: 'acacia_planks', count: 4 }]);
    await waitUntil(() => reports.length === 1, 15_000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('一样都没多出来');
    // 操作未完成与当前库存已足够是两个事实，回执并列报告，避免相互冲突的判决措辞。
    expect(reports[0].text).toContain('没做成');
    expect(reports[0].text).toContain('不过包里现在有 8 个金合欢木板,已经够这一步要的 4 个了');
    expect(reports[0].text).not.toContain('存量'); // 说清够不够就行,不用先教她一套名词
    expect(reports[0].text).not.toContain('核验:达成');
  });

  // 位置判据没有这个歧义:人在不在那儿是状态。走不过去而人已经站在那儿是纯假失败
  it('位置判据照翻案:goto 报走不过去,而人已经在那一格', async () => {
    const bot = combatBot({ goto: async () => { throw new Error('No path to the goal!'); } });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'goto', at: [0, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('技能报受阻(走不过去: 找不到可行路线)');
    expect(reports[0].text).toContain('该步按「距 (0,64,0) 2 格内」核验:达成');
  });

  /**
   * 途中未获服务端确认的放置只作为未确认事实进入回执，不改变技能最终裁决。
   */
  it('路上有放置服务端没认:进回执解释包里为什么少东西,不翻裁决', async () => {
    const bot = combatBot({});
    (bot as unknown as { placeMisses: Array<Record<string, unknown>> }).placeMisses = [];
    bot.pathfinder.goto = async () => {
      (bot as unknown as { placeMisses: Array<Record<string, unknown>> })
        .placeMisses.push({ was: 'water', x: 3, y: 62, z: 4 });
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'goto', at: [0, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('路上还有 1 次放置服务端没认');
    expect(reports[0].text).toContain('(3, 62, 4),那一格还是水');
  });

  /** 只挖一种矿的假件(与上文 mineBot 同形,这一组自带一份免得改动串台) */
  function mineBot2() {
    const ore = { name: 'coal_ore', position: new V(-8, 50, 8) };
    const bag: Array<{ name: string; count: number }> = [];
    const bot = {
      entity: { id: 9, position: new V(0.5, 63, 0.5) },
      entities: {},
      health: 20,
      players: {},
      world: { raycast: () => ({ position: ore.position, face: 1 }) },
      registry: {
        blocks: { 100: { name: 'coal_ore', drops: [802] } },
        blocksByName: { coal_ore: { id: 100, name: 'coal_ore', drops: [802] } },
        items: { 802: { name: 'coal' } },
        itemsByName: { coal: { id: 802 } },
      },
      inventory: { items: () => bag },
      equip: async () => {},
      lookAt: async () => {},
      setControlState: () => {},
      findBlocks: () => [ore.position],
      blockAt: () => ({ ...ore, canHarvest: () => true }),
      canSeeBlock: () => true,
      canDigBlock: () => true,
      digTime: () => 20,
      dig: async () => { bag.push({ name: 'coal', count: 1 }); },
      stopDigging: () => {},
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    return bot;
  }

  /** 可写的方块世界:没写的格子就是空气;water 与 torch 没有碰撞箱 */
  function cellBot(seed: Record<string, string>, bag: Array<{ name: string; count: number }>) {
    const cells = new Map<string, string>(Object.entries(seed));
    const key = (x: number, y: number, z: number) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
    let heldItem: { name: string; count: number } | null = null;
    const bot = {
      cells,
      get heldItem() { return heldItem; },
      entity: { id: 9, position: new V(0.5, 64, 0.5), onGround: true },
      entities: {},
      health: 20,
      players: {},
      registry: { blocksByName: { torch: { states: [] } } as Record<string, unknown> },
      inventory: { items: () => bag },
      equip: async (item: { name: string; count: number }) => { heldItem = item; },
      lookAt: async () => {},
      setControlState: () => {},
      blockAt: (p: V) => {
        const name = cells.get(key(p.x, p.y, p.z)) ?? 'air';
        const empty = name === 'air' || name === 'water' || name === 'torch';
        return {
          name,
          position: new V(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
          boundingBox: empty ? 'empty' : 'block',
          diggable: true,
          canHarvest: () => true,
        };
      },
      placeBlock: async (ref: { position: V }, face: V) => {
        if (!heldItem) throw new Error('must be holding an item to place');
        cells.set(key(ref.position.x + face.x, ref.position.y + face.y, ref.position.z + face.z), heldItem.name);
      },
      canDigBlock: () => true,
      digTime: () => 20,
      dig: async () => {},
      stopDigging: () => {},
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    return bot;
  }
});

/**
 * probe 报告作物 age 原值；collect 的 mature 条件只收 age 达到上限的作物。
 */
describe('作物:probe 带 age,collect 只收熟的', () => {
  function cropBot(ages: Record<string, number | undefined>, opts: { fullInv?: boolean } = {}) {
    const inv = new Map<string, number>();
    // 夹具将背包 36 格塞满杂物，使采集掉落无法进入背包。
    if (opts.fullInv) for (let i = 0; i < 36; i++) inv.set(`junk_${i}`, 1);
    const field = new Map(Object.entries(ages));
    const bot = {
      entity: { id: 1, position: new V(0.5, 64, 0.5) },
      entities: {},
      game: { dimension: 'overworld' },
      registry: {
        blocksByName: { wheat: { id: 7, name: 'wheat', drops: [8] } },
        blocks: { 7: { name: 'wheat', drops: [8] } },
        items: { 8: { name: 'wheat' } },
        itemsByName: { wheat: { id: 8, name: 'wheat' } },
      },
      inventory: { items: () => [...inv].filter(([, n]) => n > 0).map(([name, count]) => ({ name, count, type: 8 })) },
      heldItem: null,
      equip: async () => {},
      // 田里的作物当然看得见:视线闸装回来之后桩要把这一格补上
      canSeeBlock: () => true,
      findBlocks: () => [...field.keys()].map((k) => {
        const [x, y, z] = k.split(',').map(Number);
        return new V(x, y, z);
      }),
      blockAt: (p: V) => {
        // mineflayer.blockAt 调用 pos.floored()；夹具保留这个要求，不能接受只有 x/y/z 的普通对象。
        const f = p.floored();
        const k = `${f.x},${f.y},${f.z}`;
        if (field.has(k)) {
          return {
            name: 'wheat', position: p, boundingBox: 'empty', diggable: true,
            getProperties: () => ({ age: field.get(k) }),
          };
        }
        return { name: p.y < 64 ? 'stone' : 'air', position: p, boundingBox: p.y < 64 ? 'block' : 'empty' };
      },
      canDigBlock: () => true,
      digTime: () => 20,
      stopDigging: () => {},
      dig: async (b: { position: V }) => {
        field.delete(`${b.position.x},${b.position.y},${b.position.z}`);
        // 包满了掉落物进不来:挖了也不入账
        if (!opts.fullInv) inv.set('wheat', (inv.get('wheat') ?? 0) + 1);
      },
      pathfinder: {
        stop() {}, setGoal() {},
        // 真挪过去:gotoGoal 收工要按 goal.isEnd 自验,原地不动会被判"走不过去"
        goto: async (goal: { x?: number; y?: number; z?: number }) => {
          const at = bot.entity.position;
          bot.entity.position = new V(goal.x ?? at.x, goal.y ?? at.y, goal.z ?? at.z);
        },
      },
    };
    return { bot, inv, field };
  }

  /**
   * 要 3 只有 2 格熟:挖 2 收手。缺口由技能自己报——挖了几块、还剩几格没熟、
   * 包里现在几个,三个事实都在句子里,不再叠一条按方块数推出来的核验。
   */
  it('mature:只挖 age 到顶的,没长成的留在地里;差数与原因写进回执', async () => {
    const { bot, inv, field } = cropBot({ '2,64,0': 7, '3,64,0': 5, '4,64,0': 7 });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'wheat', count: 3, mature: true }]);
    await waitUntil(() => reports.length === 1, 10_000);
    expect(reports[0].text).toContain('挖了 2 块小麦(要 3 块)');
    expect(reports[0].text).toContain('还有 1 格没长成的留在地里');
    expect(reports[0].text).not.toContain('核验');
    expect(inv.get('wheat')).toBe(2);
    expect(field.has('3,64,0')).toBe(true); // 没熟的那格没被碰
  });

  it('mature:全都没长成时受阻,带上看得见几格、最高 age', async () => {
    const { bot, field } = cropBot({ '2,64,0': 5, '3,64,0': 6 });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'wheat', count: 1, mature: true }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('都还没长成');
    expect(reports[0].text).toContain('最高 age 6/7');
    expect(field.size).toBe(2);
  });

  it('mature 用在没有 age 状态的东西上:直说用不上,不静默当没写', async () => {
    const { bot } = cropBot({ '2,64,0': undefined });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'wheat', count: 1, mature: true }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('没有 age 状态');
  });

  // 背包满导致采集零入包时，结论须点明背包容量。
  it('包满去挖矿零入包:结论句主语是背包,不是"掉落物没捡到"', async () => {
    const { bot } = cropBot({ '2,64,0': 7 }, { fullInv: true });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'wheat', count: 1 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('背包 36 格全满了,掉的东西进不来');
    expect(reports[0].text).not.toContain('掉落物没捡到');
  });

  // target 命中清单随找块形态一起退役;作物熟度由逐格输出接住,它本来就带 age。
  it('probe 逐格带 age 原值;age 跳档算新读数,不吞进"与上次相同"', async () => {
    const { bot, field } = cropBot({ '2,64,0': 5 });
    const { exec, reports } = makeExecutorOn(bot);
    const probe: SkillCall = { skill: 'probe', shape: 'line', anchors: [[2, 64, 0], [3, 64, 0]] };
    exec.submit([probe]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('(2,64,0):小麦(age 5/7)');
    // 同一片再探:名字没变但 age 跳到 7,是新读数
    field.set('2,64,0', 7);
    exec.submit([probe]);
    await waitUntil(() => reports.length === 2, 8000);
    expect(reports[1].text).not.toContain('与上次探查相同');
    expect(reports[1].text).toContain('(2,64,0):小麦(age 7/7)');
  });
});

/**
 * 战斗挂起冻结 task 与 stepIndex，战后续做；非幂等步骤不重跑。
 */
describe('战斗挂起与恢复(suspend/resume)', () => {
  it('挂起当前任务,resume 从断点续做:战前做完的步不重跑,结局回执照账本把它摆回去', async () => {
    let release: (() => void) | null = null;
    let gotoCalls = 0;
    const bot = combatBot({
      goto: async (arrive) => {
        gotoCalls++;
        if (gotoCalls === 1) await new Promise<void>((r) => { release = r; });
        arrive();
      },
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([
      { skill: 'chat', text: '一' },
      { skill: 'goto', at: [10, 64, 10] },
      { skill: 'chat', text: '二' },
    ]);
    await waitUntil(() => bot.said.length === 1 && gotoCalls === 1, 3000);
    exec.suspend();
    release!();
    await sleep(50);
    expect(reports).toHaveLength(0); // 挂起不是结局,没有回执
    // 挂起的那段时间不是排队:结局回执的时刻段按第一次开跑算
    await sleep(1100);
    const note = exec.resume();
    expect(note).toContain('任务#1');
    expect(note).toContain('接着做');
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    // 第 1 步战前已做完:不重跑(说话只说了一次);它的回执行照账本进结局回执,
    // 这一单没在别处报过它
    expect(bot.said).toEqual(['一', '二']);
    expect(reports[0].text).toContain('"text":"一"');
    expect(reports[0].text).not.toContain('排队');
  });

  it('resume 后断点之前的失败步照账本进闸门:依赖它的下游跳过,结局按没做成报', async () => {
    let release: (() => void) | null = null;
    let gotoCalls = 0;
    const bot = combatBot({
      goto: async (arrive) => {
        gotoCalls++;
        if (gotoCalls === 1) throw new Error('No path to the goal!');
        if (gotoCalls === 2) await new Promise<void>((r) => { release = r; });
        arrive();
      },
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([
      { skill: 'goto', at: [10, 64, 10] },
      { skill: 'goto', at: [20, 64, 20] },
      { skill: 'chat', text: '到了', needs: [1] },
    ]);
    await waitUntil(() => gotoCalls === 2, 3000);
    exec.suspend();
    release!();
    await sleep(50);
    expect(reports).toHaveLength(0);
    exec.resume();
    await waitUntil(() => reports.length === 1, 5000);
    // 第 1 步战前没做成:续做后闸门读到的是账本里的「没做成」,第 3 步跳过、整单 blocked
    expect(reports[0].kind).toBe('blocked');
    expect(bot.said).toEqual([]);
    expect(reports[0].text).toContain('第 1 步');
    expect(reports[0].text).toContain('走不过去');
    expect(reports[0].text).toContain('跳过');
  });

  /**
   * collect 的 count 是"这一趟挖几块",从进门那一刻起算。挂起时把正在跑的那一步的
   * 计数进度冻进断点,续做只挖剩下的;不带进度原样重进,4 块挖到 2 块被打断会再挖 4 块。
   */
  function collectBot(gateAfterDigs: number) {
    const ore = { name: 'stone', position: new V(2, 64, 0) };
    const bag: Array<{ name: string; count: number }> = [{ name: 'stone_pickaxe', count: 1 }];
    const state = { digs: 0, release: null as (() => void) | null };
    let gated = false;
    const bot = {
      entity: { id: 9, position: new V(0.5, 64, 0.5) },
      entities: {},
      health: 20,
      players: {},
      world: { raycast: () => ({ position: ore.position, face: 1 }) },
      registry: {
        blocks: { 1: { name: 'stone', drops: [4] } },
        blocksByName: {
          stone: { id: 1, name: 'stone', drops: [4], material: 'mineable/pickaxe', harvestTools: { 6: true } },
        },
        items: { 4: { name: 'cobblestone' }, 6: { name: 'stone_pickaxe' } },
        itemsByName: { cobblestone: { id: 4 } },
      },
      inventory: { items: () => bag },
      heldItem: bag[0],
      equip: async () => {},
      lookAt: async () => {},
      setControlState: () => {},
      findBlocks: () => [ore.position],
      blockAt: () => ({ ...ore, boundingBox: 'block', canHarvest: () => true }),
      canSeeBlock: () => true,
      canDigBlock: () => true,
      digTime: () => 20,
      dig: async () => { state.digs++; bag.push({ name: 'cobblestone', count: 1 }); },
      stopDigging: () => {},
      pathfinder: {
        stop() {}, setGoal() {},
        // 挖够 gateAfterDigs 块之后的第一次寻路卡住:战斗在这一刻夺手
        goto: async () => {
          if (state.digs === gateAfterDigs && !gated) {
            gated = true;
            await new Promise<void>((r) => { state.release = r; });
          }
        },
      },
    };
    return { bot, state };
  }

  it('collect 挂起再续做只挖剩下的:计数进度跟着断点走,不从当前库存重新起算', async () => {
    const { bot, state } = collectBot(2);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'stone', count: 4 }]);
    await waitUntil(() => state.release !== null, 8000);
    exec.suspend();
    state.release!();
    await sleep(50);
    expect(reports).toHaveLength(0);
    const note = exec.resume();
    expect(note).toContain('打断前已挖到 2/4 块,接着挖剩下的 2 块');
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(state.digs).toBe(4);
    expect(reports[0].text).toContain('挖了 2 块石头');
    expect(reports[0].text).toContain('打断前已挖到 2/4 块');
  });

  it('挂起中的任务被撤:回投带着挂起那一刻正在跑的步与它的计数进度', async () => {
    const { bot, state } = collectBot(2);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'collect', block: 'stone', count: 4 }]);
    await waitUntil(() => state.release !== null, 8000);
    exec.suspend();
    state.release!();
    await sleep(50);
    expect(exec.clear()).not.toBeNull();
    expect(reports).toHaveLength(1);
    expect(reports[0].kind).toBe('cancelled');
    expect(reports[0].text).toContain('做到第 1/1 步(进度 2/4)');
    expect(reports[0].text).toContain('做到一半被撤(进度 2/4)');
  });

  it('环境危机冻结可重跑断点,安全租约释放后续做同一任务', async () => {
    let release: (() => void) | null = null;
    let gotoCalls = 0;
    const bot = combatBot({
      goto: async (arrive) => {
        gotoCalls++;
        if (gotoCalls === 1) await new Promise<void>((resolve) => { release = resolve; });
        arrive();
      },
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([
      { skill: 'chat', text: '前半' },
      { skill: 'goto', at: [10, 64, 10] },
      { skill: 'chat', text: '尾巴' },
    ]);
    await waitUntil(() => gotoCalls === 1, 3000);

    const token = exec.pauseForEnvironment('防溺水上浮找岸');
    release!();
    await sleep(50);
    expect(reports).toEqual([]);
    expect(exec.status().waiting[0]?.label).toContain('(被打断,待续)');

    const resumed = exec.resumeAfterEnvironment(token);
    expect(resumed.released).toBe(true);
    expect(resumed.note).toContain('任务#1');
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports.some((report) => report.kind === 'superseded')).toBe(false);
    expect(gotoCalls).toBe(2);
    expect(bot.said).toEqual(['前半', '尾巴']);
  });

  /**
   * 深坠与环境危机共用同一张 queueHold 令牌,谁最后握着谁解冻(见上一条);战斗
   * 不在这一组里 —— 它走 busyWith 闸,不持令牌。深坠落地释放 hold 时若顺手把战斗
   * 的断点也解了,战斗收工的 resumeTasks() 再去找就是空的:"接着做"那一句与
   * frozenTaskId 一起丢,恢复顺序也乱掉。
   */
  it('深坠落地释放 hold 不解冻战斗冻的断点', async () => {
    let release: (() => void) | null = null;
    let gotoCalls = 0;
    const bot = combatBot({
      goto: async (arrive) => {
        gotoCalls++;
        if (gotoCalls === 1) await new Promise<void>((resolve) => { release = resolve; });
        arrive();
      },
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }, { skill: 'chat', text: '尾巴' }]);
    await waitUntil(() => gotoCalls === 1, 3000);
    exec.suspend('战斗:被僵尸打了');
    release!();
    await waitUntil(() => exec.current === null, 3000);
    expect(exec.status().waiting[0]?.label).toContain('(被打断,待续)');

    // 深坠:此刻没有在跑的任务可停,只拿一张冻结令牌;落地后释放它
    const hold = exec.stopCurrent('深坠落超过 6 格');
    expect(exec.resumeQueue(hold)).toBe(true);
    expect(exec.status().waiting[0]?.label).toContain('(被打断,待续)');
    await sleep(50);
    expect(bot.said).toEqual([]);

    // 战斗收工才是这个断点的解冻者
    const note = exec.resume();
    expect(note).toContain('任务#1');
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(bot.said).toEqual(['尾巴']);
  });

  it('环境冻结期间 queue:now 取消旧断点,安全后只跑新急件', async () => {
    let release: (() => void) | null = null;
    const bot = combatBot({
      goto: async (arrive) => { await new Promise<void>((resolve) => { release = resolve; }); arrive(); },
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }, { skill: 'chat', text: '旧尾巴' }]);
    await waitUntil(() => release !== null, 3000);
    const token = exec.pauseForEnvironment('防溺水上浮找岸');
    release!();
    await sleep(50);

    const receipt = exec.submit([{ skill: 'chat', text: '安全急件' }], 'now');
    expect(receipt).toContain('已叫停');
    expect(bot.said).toEqual([]);
    expect(exec.resumeAfterEnvironment(token).released).toBe(true);
    await waitUntil(() => reports.some((report) => report.taskId === 2 && report.kind === 'done'), 3000);
    expect(bot.said).toEqual(['安全急件']);
    expect(reports.some((report) => report.taskId === 1 && report.kind === 'cancelled')).toBe(true);
  });

  /**
   * mc_stop 清空冻结两槽后通过 onHoldsReleased 通知反射旧令牌失效，仍存在的危机可申请新租约。
   */
  it('mc_stop 清空冻结两槽:onHoldsReleased 回边被调用,没有冻结时不空叫', () => {
    const bot = combatBot({});
    let notified = 0;
    const exec = new Executor({
      getBot: () => bot as never,
      report: () => {},
      log,
      nextId: nextTaskId(),
      onHoldsReleased: () => { notified++; },
    });
    expect(exec.pauseForEnvironment('防溺水上浮找岸')).not.toBeNull();
    exec.clear();
    expect(notified).toBe(1);
    // 两槽本来就空:清队列不再回边,免得反射白折腾一轮重申
    exec.clear();
    expect(notified).toBe(1);
    exec.shutdown();
  });

  it('死亡使环境恢复租约失效,旧断点不能复活', async () => {
    let release: (() => void) | null = null;
    const bot = combatBot({
      goto: async (arrive) => { await new Promise<void>((resolve) => { release = resolve; }); arrive(); },
    });
    const { exec } = makeExecutorOn(bot);
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }, { skill: 'chat', text: '不该说' }]);
    await waitUntil(() => release !== null, 3000);
    const token = exec.pauseForEnvironment('防溺水上浮找岸');
    exec.cancelForDeath();
    release!();

    expect(exec.resumeAfterEnvironment(token)).toEqual({ released: false, note: null });
    await sleep(50);
    expect(bot.said).toEqual([]);
    expect(exec.status()).toEqual({ running: null, waiting: [], hold: null });
  });

  /**
   * 环境与深坠分别持有和释放令牌，两槽都空才恢复队列。
   * 先释放的槽返回 released:true、note:null；最后一槽释放时才将断点放回队首。
   */
  it('环境与深坠各持一槽:先释放的不开闸,两槽都空了才恢复断点', async () => {
    let release: (() => void) | null = null;
    let gotoCalls = 0;
    const bot = combatBot({
      goto: async (arrive) => {
        gotoCalls++;
        if (gotoCalls === 1) await new Promise<void>((resolve) => { release = resolve; });
        arrive();
      },
    });
    const diag = new MinecraftLog();
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never, report: (r) => reports.push(r), log, nextId: nextTaskId(), diag,
    });
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }, { skill: 'chat', text: '落地后继续' }]);
    await waitUntil(() => release !== null, 3000);
    const environment = exec.pauseForEnvironment('防溺水上浮找岸');
    const fall = exec.stopCurrent('深坠落超过 6 格');
    release!();
    await sleep(50);

    // 两槽都冻着:受理句把两条理由一起说
    expect(exec.status().hold).toBe('防溺水上浮找岸、深坠落超过 6 格');

    // 环境先解:这一槽认自己的令牌(不再被深坠盖掉),但队列不开闸
    const envOut = exec.resumeAfterEnvironment(environment);
    expect(envOut.released).toBe(true);
    expect(envOut.note).toBeNull();
    expect(exec.status().hold).toBe('深坠落超过 6 格');
    expect(exec.status().waiting[0]?.label).toContain('(被打断,待续)');
    await sleep(50);
    expect(bot.said).toEqual([]);
    expect(diag.after(0).filter((e) => e.event === 'hold-partial-release')).toHaveLength(1);

    // 末一槽释放才恢复断点
    expect(exec.resumeQueue(fall)).toBe(true);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(gotoCalls).toBe(2);
    expect(bot.said).toEqual(['落地后继续']);
  });

  it('两槽反过来释放也一样:深坠先解不开闸,环境末一个解才恢复', async () => {
    let release: (() => void) | null = null;
    let gotoCalls = 0;
    const bot = combatBot({
      goto: async (arrive) => {
        gotoCalls++;
        if (gotoCalls === 1) await new Promise<void>((r) => { release = r; });
        arrive();
      },
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }, { skill: 'chat', text: '两槽都空才说' }]);
    await waitUntil(() => release !== null, 3000);
    const environment = exec.pauseForEnvironment('防溺水上浮找岸');
    const fall = exec.stopCurrent('深坠落超过 6 格');
    release!();
    await sleep(50);

    expect(exec.resumeQueue(fall)).toBe(true);
    await sleep(50);
    expect(bot.said).toEqual([]);
    expect(exec.status().hold).toBe('防溺水上浮找岸');
    const out = exec.resumeAfterEnvironment(environment);
    expect(out.released).toBe(true);
    expect(out.note).toContain('任务#1');
    await waitUntil(() => reports.length === 1, 5000);
    expect(bot.said).toEqual(['两槽都空才说']);
  });

  it('一槽的令牌不能解另一槽:环境令牌递给 resumeQueue 是空操作', async () => {
    const bot = combatBot({});
    const { exec } = makeExecutorOn(bot);
    const environment = exec.pauseForEnvironment('防溺水上浮找岸');
    expect(exec.resumeQueue(environment)).toBe(false);
    expect(exec.status().hold).toBe('防溺水上浮找岸');
    const fall = exec.stopCurrent('深坠落超过 6 格');
    expect(exec.resumeAfterEnvironment(fall).released).toBe(false);
    expect(exec.status().hold).toBe('防溺水上浮找岸、深坠落超过 6 格');
  });

  it('非幂等步(toss)做到一半被打断:不重跑,按没做成算;后面无因果的步照做', async () => {
    let hung: (() => void) | null = null;
    const said: string[] = [];
    const bot = {
      said,
      chat(text: string) { said.push(text); },
      entity: { id: 9, position: new V(0.5, 64, 0.5) },
      entities: {},
      health: 20,
      players: {},
      inventory: { items: () => [{ name: 'coal', type: 3, count: 4, metadata: 0 }] },
      toss: async () => { await new Promise<void>((r) => { hung = r; }); },
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([
      { skill: 'toss', item: 'coal', count: 1 },
      { skill: 'chat', text: '尾巴' },
    ]);
    await waitUntil(() => hung !== null, 3000);
    exec.suspend();
    exec.resume();
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('做到一半被打断');
    expect(reports[0].text).toContain('重复扣料');
    expect(bot.said).toEqual(['尾巴']); // 扔煤没有产出被说话消费,因果闸放行
    hung!();
  });

  it('busyWith 闸着时受理照实说「排上了」,resume 后才开跑', async () => {
    let busy: string | null = '正在跟怪打';
    const reports: TaskReport[] = [];
    const bot = combatBot({});
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      busyWith: () => busy,
    });
    const receipt = exec.submit([{ skill: 'chat', text: '排着' }]);
    expect(receipt).toContain('排上了');
    expect(receipt).toContain('正在跟怪打');
    expect(receipt).not.toContain('收下了'); // 闸着的时候说「收下了,排在第 1 步」就把排队说成了开工
    await sleep(100);
    expect(bot.said).toEqual([]); // 闸着,真没跑
    busy = null;
    exec.resume();
    await waitUntil(() => reports.length === 1, 3000);
    expect(bot.said).toEqual(['排着']);
  });

  it('queue:now 打断战斗时撤掉冻结断点,急件完成后不遗留永久待续任务', async () => {
    let release: (() => void) | null = null;
    let fighting = false;
    const reports: TaskReport[] = [];
    const bot = combatBot({
      goto: async (arrive) => { await new Promise<void>((r) => { release = r; }); arrive(); },
    });
    const exec = new Executor({
      getBot: () => bot as never,
      report: (report) => reports.push(report),
      log,
      nextId: nextTaskId(),
      busyWith: () => fighting ? '正在跟怪打' : null,
      stopCombat: () => { fighting = false; return '正在跟怪打'; },
    });
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }, { skill: 'chat', text: '旧尾巴' }]);
    await waitUntil(() => release !== null, 3000);
    exec.suspend();
    fighting = true;
    release!();
    await waitUntil(() => exec.status().running === null, 3000);
    expect(exec.status().waiting[0]?.label).toContain('(被打断,待续)');

    const receipt = exec.submit([{ skill: 'chat', text: '急件' }], 'now');

    expect(receipt).toContain('已叫停战斗中待续的任务#1');
    await waitUntil(() => reports.some((report) => report.taskId === 2 && report.kind === 'done'), 3000);
    expect(bot.said).toEqual(['急件']);
    expect(reports.some((report) => report.taskId === 1 && report.kind === 'cancelled')).toBe(true);
    expect(exec.resume()).toBeNull();
    expect(exec.status()).toEqual({ running: null, waiting: [], hold: null });
  });

  it('战斗窗口里环境夺权:挂起待续的任务也被撤掉,resume 不再复活它', async () => {
    let release: (() => void) | null = null;
    const bot = combatBot({
      goto: async (arrive) => { await new Promise<void>((r) => { release = r; }); arrive(); },
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }, { skill: 'chat', text: '后半' }]);
    await waitUntil(() => release !== null, 3000);
    exec.suspend();
    exec.preempt('逃离岩浆');
    await waitUntil(() => reports.length === 1, 3000);
    expect(reports[0].kind).toBe('superseded');
    expect(reports[0].text).toContain('撤');
    expect(exec.resume()).toBeNull();
    expect(bot.said).toEqual([]);
    expect(exec.status()).toEqual({ running: null, waiting: [], hold: null });
  });

  it('mc_stop 连挂起待续的一起撤;状态行把它标成「被打断,待续」', async () => {
    let release: (() => void) | null = null;
    const bot = combatBot({
      goto: async (arrive) => { await new Promise<void>((r) => { release = r; }); arrive(); },
    });
    const { exec } = makeExecutorOn(bot);
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
    await waitUntil(() => release !== null, 3000);
    exec.suspend();
    expect(exec.status().waiting[0].label).toContain('(被打断,待续)');
    const cleared = exec.clear();
    expect(cleared).toContain('任务#1');
    expect(exec.resume()).toBeNull();
  });

  /**
   * 泛化的一条 `death-cancelled` 说不清"这一批本来就没在跑":深坠/环境冻结着队列时
   * 死掉,案卷里看不出计划是被冻住的还是被死亡撤的,对不上账。
   */
  it('冻结着队列时死掉:终态单独说明那份排队计划因死亡作废', async () => {
    const diag = new MinecraftLog();
    const bot = combatBot({});
    const reports: TaskReport[] = [];
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      fleeHealth: () => 0,
      diag,
    });
    exec.pauseForEnvironment('深坠未稳,等落脚');
    exec.submit([{ skill: 'chat', text: '冻着排队的' }]);
    await sleep(50);
    expect(bot.said).toEqual([]); // 冻结期间一步都没开跑
    reports.length = 0;

    exec.cancelForDeath();

    expect(reports.map((r) => r.text).join('\n')).toContain('因死亡作废');
    const death = diag.after(0).filter((e) => e.event === 'death-cancelled');
    expect(death).toHaveLength(1);
    expect(death[0].msg).toContain('因死亡作废');
    expect(death[0].data).toMatchObject({ releasedHold: '深坠未稳,等落脚' });
    exec.shutdown();
  });

  it('cancelForDeath 连冻结断点与排队任务一起失效,resume 不会复活', async () => {
    let release: (() => void) | null = null;
    const bot = combatBot({
      goto: async (arrive) => { await new Promise<void>((r) => { release = r; }); arrive(); },
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }, { skill: 'chat', text: '冻结尾巴' }]);
    exec.submit([{ skill: 'chat', text: '旧队列' }], 'append');
    await waitUntil(() => release !== null, 3000);
    exec.suspend();
    expect(exec.status().waiting).toHaveLength(2);

    exec.cancelForDeath();
    expect(exec.resume()).toBeNull();
    expect(exec.status()).toEqual({ running: null, waiting: [], hold: null });
    release!();
    await sleep(50);
    expect(reports).toEqual([]);
    expect(bot.said).toEqual([]);
  });

  it('断线终结当前与排队任务,旧 Bot 的迟到完成不能汇报或复活队列', async () => {
    let release: (() => void) | null = null;
    const bot = combatBot({
      goto: async (arrive) => { await new Promise<void>((r) => { release = r; }); arrive(); },
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
    exec.submit([{ skill: 'chat', text: '旧队列' }], 'append');
    await waitUntil(() => release !== null, 3000);

    exec.onConnectionLost();

    expect(exec.status()).toEqual({ running: null, waiting: [], hold: null });
    expect(reports.map((report) => [report.taskId, report.kind])).toEqual([
      [1, 'cancelled'], [2, 'cancelled'],
    ]);
    release!();
    await sleep(50);
    expect(reports).toHaveLength(2);
    expect(bot.said).toEqual([]);
  });

  it('断线终结战斗冻结断点,重连后不会留下永久 busy 队列', async () => {
    let release: (() => void) | null = null;
    const bot = combatBot({
      goto: async (arrive) => { await new Promise<void>((r) => { release = r; }); arrive(); },
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }, { skill: 'chat', text: '冻结尾巴' }]);
    exec.submit([{ skill: 'chat', text: '旧队列' }], 'append');
    await waitUntil(() => release !== null, 3000);
    exec.suspend('战斗');
    release!();
    await waitUntil(() => exec.status().running === null, 3000);

    exec.onConnectionLost();

    expect(exec.resume()).toBeNull();
    expect(exec.status()).toEqual({ running: null, waiting: [], hold: null });
    expect(reports.map((report) => [report.taskId, report.kind])).toEqual([
      [1, 'cancelled'], [2, 'cancelled'],
    ]);
    expect(bot.said).toEqual([]);
  });
});


describe('物品使用效果与行军停滞边界', () => {
  function eater(bag: Array<{ name: string; count: number; type?: number }>, food = 13) {
    const bot = {
      entity: { id: 9, position: new V(0.5, 64, 0.5) },
      entities: {},
      health: 20,
      food,
      players: {},
      registry: {
        entitiesByName: {},
        foodsByName: { bread: {}, cooked_beef: {}, golden_apple: {}, enchanted_golden_apple: {}, pufferfish: {} },
      },
      inventory: { items: () => bag },
      equip: async (item: { name: string }) => { bot.eaten = item.name; },
      eaten: null as string | null,
      // eat 的完成判据是这一样食物在包里少了一个,吃下去就得真扣
      consume: async () => {
        const hit = bag.find((entry) => entry.name === bot.eaten);
        if (hit) hit.count -= 1;
      },
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    return bot;
  }

  it('eat 精确吃点名的食物:背包顺序不改变选择,金苹果也必须显式点名', async () => {
    const both = eater([
      { name: 'golden_apple', count: 1 },
      { name: 'bread', count: 2 },
    ]);
    const a = makeExecutorOn(both);
    a.exec.submit([{ skill: 'eat', item: 'bread' }]);
    await waitUntil(() => a.reports.length === 1, 5000);
    expect(a.reports[0].kind).toBe('done');
    expect(a.reports[0].text).toContain('吃了一个面包');
    expect(a.reports[0].text).not.toContain('金苹果');

    const onlyBag = [{ name: 'golden_apple', count: 1 }];
    const only = eater(onlyBag);
    const b = makeExecutorOn(only);
    b.exec.submit([{ skill: 'eat', item: 'golden_apple' }]);
    await waitUntil(() => b.reports.length === 1, 5000);
    expect(b.reports[0].kind).toBe('done');
    expect(b.reports[0].text).toContain('吃了一个金苹果');
    expect(onlyBag[0].count).toBe(0);
  });

  it('满饱食仍把金苹果交给真实 consume 判定并按库存减少验收', async () => {
    const bag = [{ name: 'golden_apple', count: 1 }];
    const bot = eater(bag, 20);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'eat', item: 'golden_apple' }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('吃了一个金苹果');
    expect(bag[0].count).toBe(0);
  });

  it('eat 显式点名河豚时照做,不会被背包里的面包替换', async () => {
    const mixedBag = [
      { name: 'pufferfish', count: 1 },
      { name: 'bread', count: 1 },
    ];
    const withBread = eater(mixedBag);
    const a = makeExecutorOn(withBread);
    // 河豚过毒食确认门:第一单只报后果,原样重发才吃
    expect(a.exec.submit([{ skill: 'eat', item: 'pufferfish' }])).toContain('我没接');
    a.exec.submit([{ skill: 'eat', item: 'pufferfish' }]);
    await waitUntil(() => a.reports.length === 1, 5000);
    expect(a.reports[0].kind).toBe('done');
    expect(withBread.eaten).toBe('pufferfish');
    expect(mixedBag).toEqual([
      { name: 'pufferfish', count: 0 },
      { name: 'bread', count: 1 },
    ]);

    const pufferfishBag = [{ name: 'pufferfish', count: 1 }];
    const onlyPufferfish = eater(pufferfishBag);
    const b = makeExecutorOn(onlyPufferfish);
    expect(b.exec.submit([{ skill: 'eat', item: 'pufferfish' }])).toContain('我没接');
    b.exec.submit([{ skill: 'eat', item: 'pufferfish' }]);
    await waitUntil(() => b.reports.length === 1, 5000);
    expect(b.reports[0].kind).toBe('done');
    expect(onlyPufferfish.eaten).toBe('pufferfish');
    expect(pufferfishBag[0].count).toBe(0);
  });

  it('点名 use 面包和河豚都走完整进食,不会被通用右键提前收手', async () => {
    for (const [name, label] of [['bread', '面包'], ['pufferfish', '河豚']] as const) {
      const bag = [{ name, count: 1 }];
      const bot = eater(bag, 0) as ReturnType<typeof eater> & {
        activateItem?: () => void;
        deactivateItem?: () => void;
      };
      bot.activateItem = () => { throw new Error('食物不应走通用使用'); };
      bot.deactivateItem = () => { throw new Error('食物不应提前收手'); };

      const { exec, reports } = makeExecutorOn(bot);
      // 空手 use 河豚同样过毒食确认门:第一单只报后果
      if (name === 'pufferfish') expect(exec.submit([{ skill: 'use', item: name }])).toContain('我没接');
      exec.submit([{ skill: 'use', item: name }]);
      await waitUntil(() => reports.length === 1, 5000);

      expect(reports[0].kind).toBe('done');
      expect(reports[0].text).toContain(`吃了一个${label}`);
      expect(bag[0].count).toBe(0);
    }
  });

  /**
   * 牛奶桶不在只列饱食度食物的 foods 表中，但 eat/use 都须允许完整饮用流程。
   */
  function milker(bag: Array<{ name: string; count: number }>) {
    const bot = eater(bag) as ReturnType<typeof eater> & {
      activateItem?: () => void;
      deactivateItem?: () => void;
    };
    bot.activateItem = () => { throw new Error('喝的东西不应走通用使用') };
    bot.deactivateItem = () => { throw new Error('喝奶不应提前收手') };
    // 喝完那一桶变成空桶留在同一格
    bot.consume = async () => {
      const hit = bag.find((entry) => entry.name === bot.eaten);
      if (!hit) return;
      hit.count -= 1;
      const empty = bag.find((entry) => entry.name === 'bucket');
      if (empty) empty.count += 1;
      else bag.push({ name: 'bucket', count: 1 });
    };
    return bot;
  }

  it('eat 与 use 都喝得掉牛奶桶,回执报状态效果与空桶而不是饱食度', async () => {
    for (const call of [
      { skill: 'eat', item: 'milk_bucket' },
      { skill: 'use', item: 'milk_bucket' },
    ] as const) {
      const bag = [{ name: 'milk_bucket', count: 1 }];
      const bot = milker(bag);
      const { exec, reports } = makeExecutorOn(bot);
      exec.submit([call]);
      await waitUntil(() => reports.length === 1, 5000);

      expect(reports[0].kind).toBe('done');
      expect(reports[0].text).toContain('喝了一桶奶');
      expect(reports[0].text).toContain('状态效果');
      expect(reports[0].text).toContain('桶回到包里(现在 1 个)');
      // 牛奶不管饱:回执里不能出现饱食度读数
      expect(reports[0].text).not.toContain('饥饿');
      expect(bag).toEqual([{ name: 'milk_bucket', count: 0 }, { name: 'bucket', count: 1 }]);
    }
  });

  it('奶没喝进去时按库存没少判受阻,不拿饱食度圆场', async () => {
    const bag = [{ name: 'milk_bucket', count: 1 }];
    const bot = milker(bag);
    bot.consume = async () => {};
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'eat', item: 'milk_bucket' }]);
    await waitUntil(() => reports.length === 1, 8000);

    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('没喝进去');
    expect(bag[0].count).toBe(1);
  });

  /**
   * 持续挖掘或搭建只使用较长的停滞窗口；始终未接近目标时，25 秒仍须触发停滞处理。
   */
  it('挖-放振荡:全程"在干活"也躲不过卡住闸,25 秒左右跳闸而不是等 120 秒', async () => {
    let rejectGoto: ((e: Error) => void) | null = null;
    const bot = combatBot({});
    bot.pathfinder.goto = (() => new Promise((_, rej) => { rejectGoto = rej; })) as never;
    const baseSetGoal = bot.pathfinder.setGoal;
    (bot.pathfinder as { setGoal: unknown }).setGoal = (g: unknown) => {
      if (g === null && rejectGoto) rejectGoto(new Error('goal was changed'));
      (baseSetGoal as (g: unknown) => void)(g);
    };
    (bot.pathfinder as { isMining?: () => boolean }).isMining = () => true;
    // 人在原地两点间来回蹭:净位移 0.71 格凑不满 8 格,靠近的那 0.71 格也够不到
    // GOTO_STALL_EPS 的 1 格,两条刷新无进展计时的路都不通。
    // 两点写死不取随机:随机抖动的改善幅度最大到 1.5×√2 格,约 2% 的场次要到二十几
    // 秒才抖出「近满 1 格」的一步,计时跟着归零,25 秒的闸推到 waitUntil 的 40 秒之外。
    bot.entity.position = new V(1, 64, 1);
    const wiggle = setInterval(() => {
      bot.entity.position = bot.entity.position.x === 1 ? new V(1.5, 64, 1.5) : new V(1, 64, 1);
    }, 300);
    try {
      const { exec, reports } = makeExecutorOn(bot);
      const t0 = Date.now();
      exec.submit([{ skill: 'goto', at: [60, 64, 60] }]);
      await waitUntil(() => reports.length === 1, 40_000);
      const took = Date.now() - t0;
      expect(reports[0].kind).toBe('blocked');
      expect(reports[0].text).toContain('没能离这一段的落点 (60, 64, 60)更近一步');
      // 挖/搭那一档不判「钉在原地」:人本来就该站着不动,解卡无从谈起
      expect(reports[0].text).not.toContain('钉在原地');
      expect(took).toBeGreaterThan(20_000); // 干活豁免仍然给了慢档,不是 10 秒就掐
      expect(took).toBeLessThan(35_000);    // 但绝不允许拖到 120 秒 deadline
    } finally {
      clearInterval(wiggle);
    }
  }, 50_000);

  it('空桶舀水走「使用物品」:液体没有可点的面,activateBlock 的那条路服务端不理', async () => {
    const bag = new Map([['bucket', 1]]);
    let blockClicked = false;
    const bot = {
      entity: { id: 9, position: new V(0.5, 63, 0.5) },
      entities: {},
      game: { dimension: 'overworld' },
      health: 20,
      players: {},
      registry: { blocksByName: { water: { id: 10 } }, itemsByName: {} },
      heldItem: null as { name: string } | null,
      inventory: {
        items: () => [...bag].filter(([, n]) => n > 0).map(([name, n]) => ({ name, count: n, type: 1, metadata: 0 })),
      },
      equip: async (it: { name: string }) => { bot.heldItem = it; },
      lookAt: async () => {},
      activateBlock: async () => { blockClicked = true; },
      waitForTicks: async () => {},
      activateItem: () => {
        // 服务端按视线找到了水源:空桶换水桶
        bag.set('bucket', 0);
        bag.set('water_bucket', 1);
      },
      blockAt: (p: V) => {
        const f = p.floored();
        return f.x === 2 && f.y === 62 && f.z === 0
          ? { name: 'water', position: p, boundingBox: 'empty', stateId: 1, getProperties: () => ({ level: '0' }) }
          : { name: f.y < 63 ? 'stone' : 'air', position: p, boundingBox: f.y < 63 ? 'block' : 'empty', stateId: 0 };
      },
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'use', item: 'bucket', at: [2, 62, 0] }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('水');
    expect(blockClicked).toBe(false); // 没走 use_item_on 那条死路
    expect(bag.get('water_bucket')).toBe(1);
  });

  it('放船走「使用物品」:BoatItem 没有对方块使用这条实现,回执报船落在哪一格', async () => {
    const bag = new Map([['oak_boat', 1]]);
    let blockClicked = false;
    const bot = {
      entity: { id: 9, position: new V(0.5, 64, 0.5) },
      entities: {} as Record<string, { name: string; position: V }>,
      game: { dimension: 'overworld' },
      health: 20,
      players: {},
      registry: { blocksByName: {}, itemsByName: {} },
      heldItem: null as { name: string } | null,
      inventory: {
        items: () => [...bag].filter(([, n]) => n > 0).map(([name, n]) => ({ name, count: n, type: 1, metadata: 0 })),
      },
      equip: async (it: { name: string }) => { bot.heldItem = it; },
      lookAt: async () => {},
      activateBlock: async () => { blockClicked = true; },
      waitForTicks: async () => {},
      activateItem: () => {
        // 服务端按视线射线打在草方块顶面上,船就生成在那儿,包里少一条
        bag.set('oak_boat', 0);
        bot.entities['77'] = { name: 'boat', position: new V(1.5, 64, 0.5) };
      },
      deactivateItem: () => {},
      blockAt: (p: V) => {
        const f = p.floored();
        return f.y < 64
          ? { name: 'grass_block', position: p, boundingBox: 'block', stateId: 0 }
          : { name: 'air', position: p, boundingBox: 'empty', stateId: 1 };
      },
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'use', item: 'oak_boat', at: [1, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('(1, 64, 0)');
    expect(blockClicked).toBe(false); // 打在方块上服务端不理,这条路不能走
    expect(bag.get('oak_boat')).toBe(0);
  });

  /** 造一只与上面放船用例同款的假 bot;withCursor 控制有没有 blockAtCursor 可用 */
  function boatBot(opts: { withCursor?: boolean; spawnEntity?: boolean } = {}) {
    const bag = new Map([['jungle_boat', 1]]);
    const bot = {
      bag,
      entity: { id: 9, position: new V(0.5, 64, 0.5) },
      entities: {} as Record<string, { name: string; position: V }>,
      game: { dimension: 'overworld' },
      health: 20,
      players: {},
      registry: { blocksByName: {}, itemsByName: {} },
      heldItem: null as { name: string } | null,
      inventory: {
        items: () => [...bag].filter(([, n]) => n > 0).map(([name, n]) => ({ name, count: n, type: 1, metadata: 0 })),
      },
      equip: async (it: { name: string }) => { bot.heldItem = it; },
      lookAt: async () => {},
      activateBlock: async () => {},
      waitForTicks: async () => {},
      activateItem: () => {
        bag.set('jungle_boat', 0);
        if (opts.spawnEntity !== false) bot.entities['77'] = { name: 'boat', position: new V(1.5, 64, 0.5) };
      },
      deactivateItem: () => {},
      blockAt: (p: V) => {
        const f = p.floored();
        return f.y < 64
          ? { name: 'grass_block', position: new V(f.x, f.y, f.z), boundingBox: 'block', stateId: 0 }
          : { name: 'air', position: new V(f.x, f.y, f.z), boundingBox: 'empty', stateId: 1 };
      },
      ...(opts.withCursor
        ? { blockAtCursor: () => ({ name: 'grass_block', position: new V(1, 63, 0), boundingBox: 'block', stateId: 0 }) }
        : {}),
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    return bot;
  }

  it('放船不写 at:按视线射线找落点,不再落进「不抛错就算成功」的通用兜底', async () => {

    const bot = boatBot({ withCursor: true });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'use', item: 'jungle_boat' }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('(1, 64, 0)');
    expect(bot.bag.get('jungle_boat')).toBe(0);
  });

  it('放船不写 at 且视线里没有方块:受阻说清怎么给落点,不假装用过', async () => {
    const bot = boatBot({ withCursor: false });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'use', item: 'jungle_boat' }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('放船要么看着水面/地面,要么给 at 指一格落点');
    expect(bot.bag.get('jungle_boat')).toBe(1); // 一下都没按
  });

  it('放船包里少了一条但附近没扫到船:两个读数分开说,不做「少了=放成了」的软假设', async () => {
    const bot = boatBot({ withCursor: true, spawnEntity: false });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'use', item: 'jungle_boat', at: [1, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 5000);
    expect(reports[0].text).toContain('没扫到船的实体');
    expect(reports[0].text).toContain('船落在哪儿没读到');
    expect(reports[0].text).not.toContain('算放成了');
  });

});



describe('补齐终态:被叫停/顶替/停机的那些也有结局', () => {
  /** 一步走得通、但永远等不到 gate 的慢任务 */
  const stuckBot = () => combatBot({ goto: async () => new Promise<void>(() => {}) });

  it('mc_stop:手上这件与撤掉的那几件各一条 cancelled', async () => {
    const { exec, reports } = makeExecutorOn(stuckBot());
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
    exec.submit([{ skill: 'chat', text: '排着的' }], 'append');
    await waitUntil(() => exec.status().running !== null);
    exec.clear();
    expect(reports.map((r) => [r.kind, r.taskId])).toEqual([['cancelled', 1], ['cancelled', 2]]);
    expect(reports[0].text).toContain('没做完:做到第 1/1 步,被mc_stop 叫停');
    expect(reports[1].text).toContain('没做完:一步都没开始,被mc_stop 撤单');
    exec.shutdown();
  });

  it('cancelled 是第五档,不冒充成 done/blocked', async () => {
    const { exec, reports } = makeExecutorOn(stuckBot());
    exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
    await waitUntil(() => exec.status().running !== null);
    exec.clear();
    expect(reports[0].kind).toBe('cancelled');
    expect(reports[0].text).not.toContain('完成');
    expect(reports[0].text).not.toContain('没做成');
    exec.shutdown();
  });
});

describe('until 早停(行军型 find 与 tunnel)', () => {
  /**
   * findBlocks 认 `matching` 的假 bot:早停名单与 find 自己的目标各查各的。
   * 铁矿摆在 (12,64,0);金合欢原木永远找不到,所以走满 200 格是它的默认结局。
   */
  function untilBot() {
    const me = new V(0.5, 64, 0.5);
    const bot = {
      entity: { id: 9, position: me },
      entities: {},
      health: 20,
      players: {},
      time: { timeOfDay: 1000 },
      registry: {
        blocks: { 17: { name: 'acacia_log' }, 15: { name: 'iron_ore' }, 16: { name: 'coal_ore' } },
        blocksByName: {
          acacia_log: { id: 17, name: 'acacia_log' },
          iron_ore: { id: 15, name: 'iron_ore' },
          coal_ore: { id: 16, name: 'coal_ore' },
        },
        items: {},
        itemsByName: {},
      },
      inventory: { items: () => [] as never[] },
      equip: async () => {},
      lookAt: async () => {},
      setControlState: () => {},
      findBlocks: ({ matching }: { matching: number[] }) =>
        (matching.includes(15) ? [new V(12, 64, 0)] : []),
      blockAt: (v: V) => ({ name: v.x === 12 ? 'iron_ore' : 'stone' }),
      canSeeBlock: () => true,
      world: { raycast: () => null },
      pathfinder: {
        stop() {}, setGoal() {},
        goto: async (goal: FakeGoal) => {
          bot.entity.position = new V(goal.x ?? bot.entity.position.x, 64, goal.z ?? 0.5);
        },
      },
    };
    return bot;
  }

  it('名单写法:路上碰到点名的方块就停,算做完', async () => {
    const bot = untilBot();
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{
      skill: 'find', target: 'acacia_log', direction: 'east', distance: 200, until: ['iron_ore'],
    }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('在 (12, 64, 0) 碰到了铁矿石,停在这');
    expect(Math.abs(bot.entity.position.x)).toBeLessThan(80); // 没走满 200
  });

  it('类别写法 #ores:registry 没有 tag 数据面时走内置类别,一样命中', async () => {
    const bot = untilBot();
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{
      skill: 'find', target: 'acacia_log', direction: 'east', distance: 200, until: ['#ores'],
    }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('碰到了铁矿石,停在这');
  });

  it('认不出的名字点破,不静默吃掉', async () => {
    const bot = untilBot();
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{
      skill: 'find', target: 'acacia_log', direction: 'east', distance: 200, until: ['#兰花', 'iron_ore'],
    }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('until 里的 #兰花 认不出来,这几样没算进去');
  });

  it('until 在场时 tunnel 不再拿终点做判据(早停不算落空)', () => {
    const bot = untilBot();
    expect(deriveExpect(bot as never, { skill: 'tunnel', at: [30, 64, 0] })).toEqual({ near: [30, 64, 0] });
    expect(deriveExpect(bot as never, { skill: 'tunnel', at: [30, 64, 0], until: ['#ores'] })).toBeNull();
  });

  it('入参校验:until 收数组、认类别,写错整批退回', () => {
    const ok = parseSteps([{ skill: 'tunnel', at: [1, 2, 3], until: ['#ores', 'water'] }]);
    expect('error' in ok).toBe(false);
    expect((ok as { steps: SkillCall[] }).steps[0]).toEqual(
      { skill: 'tunnel', at: [1, 2, 3], until: ['#ores', 'water'] },
    );
    const bad = parseSteps([{ skill: 'find', target: 'cow', direction: 'east', until: 'iron_ore' }]);
    expect('error' in bad && bad.error).toContain('until');
  });

  it('站着扫写了 until:照实说这一格用不上,不静默吃掉', async () => {
    const bot = untilBot();
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'find', target: 'acacia_log', distance: 16, until: ['#ores'] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('写了 until,但这一趟是站着看一眼、人不动,碰不到东西也就没得停');
    exec.shutdown();
  });
});

describe('stow 双记账的措辞', () => {
  it('同一样东西拆两笔点走:两条回执不再各自认领一次整窗的差额', async () => {
    const { bot, inv, box } = chestBot({ inv: { cobblestone: 70 } });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([
      { skill: 'stow', item: 'cobblestone', count: 64 },
      { skill: 'stow', item: 'cobblestone', count: 6 },
    ]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(box.get('cobblestone')).toBe(70);
    expect(inv.get('cobblestone')).toBe(0);
    // 点击侧合计 = 库存侧差额,两笔都对得上,一句多余的话都不说
    expect(reports[0].text).not.toContain('包里实际少了');
    expect(reports[0].text).not.toContain('本次开窗合计');
  });

  it('点击侧与库存侧真对不上时:合成一句「本次开窗合计」,不读成搬了两次', async () => {
    // 关窗回灌多吃掉 6 个:点走 64,包里少了 70 —— 双记账要暴露的正是这个差
    const { bot } = chestBot({ inv: { cobblestone: 70 }, drift: 6 });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'stow', item: 'cobblestone', count: 64 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('本次开窗合计:点走 64,关窗后包里少了 70');
    expect(reports[0].text).not.toContain('包里实际少了 70 个');
  });
});



/**
 * 「包快满了」的主动提醒。
 *
 * 补的是 precheck 那条格位警告够不着的一段:precheck 只在**这一步要往包里装东西**时
 * 才算格位,于是挖了一路矿、包早就快满了,只要下一单不是装东西的,她一个字都读不到。
 */
describe('包快满了的提醒', () => {
  /** items 数量决定占了几格;chat 一步跑得最快,拿来当"任意一单" */
  function bagBot(used: number) {
    const said: string[] = [];
    return {
      said,
      chat(text: string) { said.push(text); },
      entity: { id: 1, position: new V(0.5, 64, 0.5) },
      entities: {},
      game: { dimension: 'overworld' },
      inventory: {
        items: () => Array.from({ length: used }, (_, i) => ({ name: `item_${i}`, type: 1, count: 1 })),
      },
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
  }

  it('空位跌破 5 格才提醒,宽裕时一个字都不占', async () => {
    const { exec, reports } = makeExecutorOn(bagBot(20));
    exec.submit([{ skill: 'chat', text: 'hi' }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].text).not.toContain('快满了');
  });

  it('跌破就报一次:剩几格、账上最近的箱子在哪', async () => {
    const chests = new ChestBook(null);
    chests.remember('overworld', { x: 10, y: 64, z: 0 }, [], 0, 27);
    const reports: TaskReport[] = [];
    const bot = bagBot(33);
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
      chests,
    });
    exec.submit([{ skill: 'chat', text: 'a' }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].text).toContain('只剩 3 格空位');
    expect(reports[0].text).toContain('(10, 64, 0)');
  });

  /**
   * 防刷屏是**状态机**不是节流:一次「跌破」只说一次,回到 5 格以上再跌破才说第二次。
   * 每条回执都念一遍等于这条提醒立刻变成噪音,她会连着一起略过。
   */
  it('同一次跌破只说一次;回到宽裕再跌破才说第二次', async () => {
    let used = 33;
    const reports: TaskReport[] = [];
    const bot = bagBot(0);
    bot.inventory.items = () => Array.from({ length: used }, (_, i) => ({ name: `item_${i}`, type: 1, count: 1 }));
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: nextTaskId(),
    });
    exec.submit([{ skill: 'chat', text: 'a' }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].text).toContain('快满了');

    exec.submit([{ skill: 'chat', text: 'b' }]);
    await waitUntil(() => reports.length === 2);
    expect(reports[1].text).not.toContain('快满了');

    used = 10; // 清了一批
    exec.submit([{ skill: 'chat', text: 'c' }]);
    await waitUntil(() => reports.length === 3);
    expect(reports[2].text).not.toContain('快满了');

    used = 34; // 又装满了:重新上膛之后才再报
    exec.submit([{ skill: 'chat', text: 'd' }]);
    await waitUntil(() => reports.length === 4);
    expect(reports[3].text).toContain('只剩 2 格空位');
  });
});

/**
 * bot.toss 不接收方向参数；掉落物初速度取决于玩家当刻的 yaw/pitch，因此须先 bot.look 再抛出。
 */
describe('toss 的落点', () => {
  function tossBot(solid: (x: number, y: number, z: number) => boolean) {
    const looked: Array<{ yaw: number; pitch: number }> = [];
    const counts = new Map<string, number>([['cobblestone', 20]]);
    return {
      looked,
      counts,
      entity: { id: 1, position: new V(0.5, 64, 0.5) },
      entities: {},
      game: { dimension: 'overworld' },
      registry: { itemsByName: {}, blocksByName: {} },
      inventory: {
        items: () => [...counts].filter(([, n]) => n > 0)
          .map(([name, count]) => ({ type: 1, metadata: 0, name, count })),
      },
      blockAt: (p: V) => ({
        name: solid(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) ? 'stone' : 'air',
        boundingBox: solid(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) ? 'block' : 'empty',
      }),
      look: async (yaw: number, pitch: number) => { looked.push({ yaw, pitch }); },
      toss: async (_type: number, _meta: number | null, n: number) => {
        counts.set('cobblestone', (counts.get('cobblestone') ?? 0) - n);
      },
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
  }

  it('四周开阔:先抬头转向再扔,回执报方向与距离', async () => {
    const bot = tossBot(() => false);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'toss', item: 'cobblestone', count: 4 }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(bot.looked).toHaveLength(1);
    // pitch 负值朝上:抬头 30–45° 之间
    expect(bot.looked[0].pitch).toBeLessThan(-(29 * Math.PI) / 180);
    expect(bot.looked[0].pitch).toBeGreaterThan(-(46 * Math.PI) / 180);
    expect(reports[0].text).toMatch(/朝[东南西北]+抬头抛出去/);
    expect(reports[0].text).toContain('8 格内是空的');
  });

  it('四面被围死:不转头,照旧就地扔,回执照实说是在脚边扔的', async () => {
    const bot = tossBot(() => true);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'toss', item: 'cobblestone', count: 4 }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(bot.looked).toHaveLength(0);
    expect(reports[0].text).toContain('就在脚边扔的');
    expect(bot.counts.get('cobblestone')).toBe(16);
  });

  it('只有一条走廊通:挑得出那个方向,不因为别的方向被挡就整个放弃', async () => {
    // 只有 +X 那一条是空的(y=65/66 两层),其余全是石头
    const bot = tossBot((x, y, z) => !(x >= 1 && z === 0 && (y === 65 || y === 66)));
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'toss', item: 'cobblestone', count: 1 }]);
    await waitUntil(() => reports.length === 1);
    expect(bot.looked).toHaveLength(1);
    expect(reports[0].text).toContain('朝东抬头抛出去');
  });
});



/**
 * anvil/grindstone 使用 1.20.6 通用窗口协议验证开窗、产出、shift-click 取货和经验变化；组件物品不依赖 prismarine-item 的本地合成计算。
 */
describe('anvil/grindstone:铁砧与砂轮', () => {
  interface FakeItem {
    name: string; count: number; type: number; slot?: number;
    componentMap?: Map<string, { data?: unknown }>;
  }

  function stationBot(opts: {
    station: 'anvil' | 'grindstone';
    bag: FakeItem[];
    /** 料就位后产出槽出什么;null = 这一对做不出结果 */
    out: FakeItem | null;
    outNeedsBoth?: boolean;
    level?: number;
    xpCost?: number;
    xpRefund?: number;
  }) {
    const bag = [...opts.bag];
    const win = {
      id: 5, type: `minecraft:${opts.station}`,
      slots: new Array<FakeItem | null>(39).fill(null),
      inventoryStart: 3, inventoryEnd: 39,
      // 开窗期间玩家那半边的实时账在窗口上,槽位号也只在这扇窗里成立
      items: () => bag.map((it, i) => ({ ...it, slot: 3 + i })),
    };
    const refreshOut = () => {
      const ready = opts.outNeedsBoth === false ? win.slots[0] !== null : win.slots[0] !== null && win.slots[1] !== null;
      win.slots[2] = ready ? opts.out : null;
    };
    const bot = {
      bag,
      win,
      entity: { id: 9, position: new V(0.5, 64, 0.5), onGround: true },
      entities: {},
      game: { dimension: 'overworld' },
      health: 20,
      players: {},
      experience: { level: opts.level ?? 30, points: 0, progress: 0 },
      registry: {
        blocksByName: { anvil: { id: 41 }, chipped_anvil: { id: 42 }, damaged_anvil: { id: 43 }, grindstone: { id: 55 } },
        itemsByName: {},
        entitiesByName: {},
        enchantments: {
          13: { name: 'sharpness' }, 30: { name: 'infinity' },
          31: { name: 'silk_touch' }, 32: { name: 'piercing' },
        },
      },
      heldItem: null,
      inventory: { items: () => bag },
      findBlocks: () => [new V(2, 64, 0)],
      blockAt: (p: V) => {
        const f = p.floored();
        if (f.x === 2 && f.y === 64 && f.z === 0) {
          return { name: opts.station, position: f, boundingBox: 'block', stateId: 7 };
        }
        return f.y < 64
          ? { name: 'stone', position: f, boundingBox: 'block', stateId: 0 }
          : { name: 'air', position: f, boundingBox: 'empty', stateId: 1 };
      },
      openBlock: async () => win,
      transfer: async (o: { itemType: number; destStart: number }) => {
        const idx = bag.findIndex((i) => i.type === o.itemType);
        if (idx < 0) throw new Error('transfer 找不到料');
        win.slots[o.destStart] = bag[idx];
        bag.splice(idx, 1);
        refreshOut();
      },
      /** 照 mineflayer:点起源格那一件,放进目标格 */
      moveSlotItem: async (from: number, to: number) => {
        const it = bag[from - win.inventoryStart];
        if (!it) throw new Error('moveSlotItem 起源格是空的');
        bag.splice(from - win.inventoryStart, 1);
        win.slots[to] = it;
        refreshOut();
      },
      clickWindow: async (slot: number) => {
        if (slot !== 2 || !win.slots[2]) return;
        if (opts.station === 'anvil') {
          const cost = opts.xpCost ?? 2;
          if (bot.experience.level < cost) return; // 等级不够原版不给取
          bot.experience.level -= cost;
        } else {
          bot.experience.points += opts.xpRefund ?? 0;
        }
        bag.push(win.slots[2]!);
        win.slots[0] = null;
        if (opts.station === 'anvil') win.slots[1] = null;
        win.slots[2] = null;
      },
      closeWindow: () => {
        for (const s of [0, 1]) {
          if (win.slots[s]) { bag.push(win.slots[s]!); win.slots[s] = null; }
        }
        win.slots[2] = null;
      },
      _client: { write: () => {}, on: () => {}, removeListener: () => {} },
      lookAt: async () => {},
      pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    };
    return bot;
  }

  const dmg = (n: number) => new Map([['damage', { data: n }]]);
  const sharp3 = () => new Map<string, { data?: unknown }>([
    ['damage', { data: 50 }],
    ['enchantments', { data: { enchantments: [{ id: 13, level: 3 }] } }],
  ]);

  it('铁砧合修:回执报产物耐久、实扣几级经验、铁砧磨没磨损', async () => {
    const bot = stationBot({
      station: 'anvil',
      bag: [
        { name: 'iron_pickaxe', count: 1, type: 10, componentMap: dmg(100) },
        { name: 'iron_pickaxe', count: 1, type: 10, componentMap: dmg(120) },
      ],
      out: { name: 'iron_pickaxe', count: 1, type: 10 },
      xpCost: 2,
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'anvil', op: 'combine', item: 'iron_pickaxe', with: 'iron_pickaxe' }]);
    await waitUntil(() => reports.length === 1, 10_000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('把铁镐和铁镐合了');
    expect(reports[0].text).toContain('耐久 250/250');
    expect(reports[0].text).toContain('花了 2 级经验(30 → 28)');
    expect(reports[0].text).not.toContain('磨损');
    expect(bot.bag.length).toBe(1);
  });

  /**
   * withPick 指定右槽物品时，必须取到对应附魔书，其他同 id 书保留在背包。
   */
  it('铁砧:withPick 点名右格那一本,别的书原样留在包里', async () => {
    const book = (id: number) => new Map<string, { data?: unknown }>([
      ['stored_enchantments', { data: { enchantments: [{ id, level: 1 }] } }],
    ]);
    const bot = stationBot({
      station: 'anvil',
      bag: [
        { name: 'bow', count: 1, type: 12 },
        { name: 'enchanted_book', count: 1, type: 13, componentMap: book(31) },
        { name: 'enchanted_book', count: 1, type: 13, componentMap: book(30) },
        { name: 'enchanted_book', count: 1, type: 13, componentMap: book(32) },
      ],
      out: {
        name: 'bow',
        count: 1,
        type: 12,
        componentMap: new Map([['enchantments', { data: { enchantments: [{ id: 30, level: 1 }] } }]]),
      },
      xpCost: 2,
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{
      skill: 'anvil', op: 'combine', item: 'bow', with: 'enchanted_book', withPick: '无限',
    }]);
    await waitUntil(() => reports.length === 1, 10_000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('把弓和附魔书（无限I）合了');
    // 吃掉的是无限那本;剩在包里的两本一本没少
    const left = bot.bag
      .filter((i) => i.name === 'enchanted_book')
      .map((i) => (i.componentMap?.get('stored_enchantments')?.data as
        { enchantments: Array<{ id: number }> }).enchantments[0].id);
    expect(left.sort()).toEqual([31, 32]);
  });

  it('铁砧不认这一对:产出槽没出东西按受阻收场,料退回包里', async () => {
    const bot = stationBot({
      station: 'anvil',
      bag: [
        { name: 'iron_pickaxe', count: 1, type: 10, componentMap: dmg(100) },
        { name: 'oak_planks', count: 1, type: 11 },
      ],
      out: null,
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'anvil', op: 'combine', item: 'iron_pickaxe', with: 'oak_planks' }]);
    await waitUntil(() => reports.length === 1, 10_000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('产出槽没出东西');
    expect(bot.bag.length).toBe(2); // 关窗把料退了回来
  });

  it('砂轮除魔:回执报磨前磨后读数与返还的经验点', async () => {
    const bot = stationBot({
      station: 'grindstone',
      bag: [{ name: 'iron_sword', count: 1, type: 20, componentMap: sharp3() }],
      out: { name: 'iron_sword', count: 1, type: 20, componentMap: dmg(50) },
      outNeedsBoth: false,
      xpRefund: 15,
    });
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'grindstone', item: 'iron_sword' }]);
    await waitUntil(() => reports.length === 1, 10_000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('磨之前(耐久 200/250,附魔 sharpness3)');
    expect(reports[0].text).toContain('磨完(耐久 200/250,没有附魔)');
    expect(reports[0].text).toContain('返还了 15 点经验');
  });
});
