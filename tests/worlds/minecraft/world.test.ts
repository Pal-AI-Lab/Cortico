import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderWorldEnvPrompt } from '../../../src/core/prefix.ts';
import { MinecraftWorld, MINECRAFT_TOOL_DECLS, PwsrTables, GOAL_TABLE_DECL, goalAge, applyGoal, goalSnapshotLine, staleGoalNotice, GOAL_NOTICE_HOURLY_CAP, GOAL_STALE_COOLDOWN_MS, GOAL_STALE_MS, GOAL_STALE_TASKS, MAP_KINDS, MAP_SLOTS, MAP_SLOTS_TIGHT, MAP_TABLE_DECL, MARK_NEAR_MAX, mapSnapshotLine, checkMark, dangerZonesAt, markBearing, nearMarkText, nearestMark, parseMap, renderDifficultyFact, type MinecraftGoal, type MinecraftMark } from '../../../src/worlds/minecraft/world.ts';
import { MINECRAFT_DEFAULTS, type MinecraftConfigSection } from '../../../src/worlds/minecraft/config.ts';
import { acceptBlueprint } from '../../../src/worlds/minecraft/blueprint-plan.ts';
import { parseGoalPlan, recordGoalJudgment } from '../../../src/worlds/minecraft/goal-plan.ts';
import { SET_SPAWN_TRANSLATE } from '../../../src/worlds/minecraft/escape.ts';
import { renderQueue } from '../../../src/worlds/minecraft/executor.ts';
import { Bridge } from '../../../src/worlds/minecraft/bridge.ts';
import { MinecraftServerManager, type MinecraftServerState } from '../../../src/worlds/minecraft/server.ts';
import { FakeHost } from '../../helpers/fake-host.ts';

function cfg(over: Partial<MinecraftConfigSection> = {}): MinecraftConfigSection {
  return structuredClone({ ...MINECRAFT_DEFAULTS, enabled: true, ...over }) as MinecraftConfigSection;
}

type Pos = { x: number; y: number; z: number; offset(dx: number, dy: number, dz: number): Pos; distanceTo(o: Pos): number; floored(): Pos };
function pos(x: number, y: number, z: number): Pos {
  return {
    x, y, z,
    offset: (dx, dy, dz) => pos(x + dx, y + dy, z + dz),
    distanceTo: (o) => Math.hypot(x - o.x, y - o.y, z - o.z),
    floored: () => pos(Math.floor(x), Math.floor(y), Math.floor(z)),
  };
}

/** 站着不动、身体健康、两手空空:只按住状态行读得到的那几处 */
function idleBot(): unknown {
  const inventory = Object.assign(new EventEmitter(), {
    slots: Array.from({ length: 46 }, () => null),
    items: () => [],
  });
  return {
    entity: { id: 17, position: pos(0.5, 64, 0.5) },
    _client: new EventEmitter(),
    entities: {},
    registry: { biomes: {}, blocksByName: {} },
    findBlocks: () => [],
    blockAt: () => null,
    game: { dimension: 'overworld', gameMode: 'survival' },
    health: 20, food: 20, oxygenLevel: 20,
    time: { timeOfDay: 1000 }, rainState: 0,
    heldItem: null,
    inventory,
    players: {},
  };
}

/** 替换 World 内部依赖,使视觉催促测试不启动引擎。 */
function stub(m: MinecraftWorld, parts: Record<string, unknown>): void {
  Object.assign(m, parts);
}


describe('实体接近滞回(常规 16/24，持弓可见敌对 32/40)', () => {
  function proxRig(raycast: () => unknown = () => null) {
    const zombie = { id: 7, name: 'zombie', type: 'mob', position: pos(30, 64, 0.5) };
    const bag: Array<{ name: string; type: number; count: number }> = [];
    const bot = {
      entity: { id: 17, position: pos(0.5, 64, 0.5) },
      entities: { '7': zombie } as Record<string, unknown>,
      world: { raycast },
      inventory: { items: () => bag },
    };
    const m = new MinecraftWorld({ cfg: cfg() });
    const host = new FakeHost();
    stub(m, { host });
    const tick = () => (m as any).proximityTick(bot);
    return { bot, zombie, bag, host, tick };
  }

  it('进 16 报一次,16-24 之间抖动不重复,出 24 报走远', () => {
    const { zombie, host, tick } = proxRig();
    tick();
    expect(host.events).toHaveLength(0); // 30 格:圈外
    zombie.position = pos(14, 64, 0.5);
    tick();
    expect(host.events).toHaveLength(1);
    expect(host.events[0].text).toContain('僵尸在东边 14 格');
    zombie.position = pos(20, 64, 0.5);
    tick(); // 滞回区:保持在态
    zombie.position = pos(14, 64, 0.5);
    tick(); // 回到圈内:仍是同一只,不重复
    expect(host.events).toHaveLength(1);
    zombie.position = pos(25, 64, 0.5);
    tick();
    expect(host.events).toHaveLength(2);
    expect(host.events[1].text).toContain('僵尸走远了');
  });

  it('隔墙的怪只报动静不给坐标,露头后补一条看清了', () => {
    let blocked = true;
    const { zombie, host, tick } = proxRig(() => (blocked ? { name: 'stone' } : null));
    zombie.position = pos(10, 64, 0.5);
    tick();
    expect(host.events).toHaveLength(1);
    expect(host.events[0].text).toContain('东边有僵尸的动静');
    expect(host.events[0].text).not.toContain('10 格');
    tick(); // 还隔着墙:不重复
    expect(host.events).toHaveLength(1);
    blocked = false;
    tick();
    expect(host.events).toHaveLength(2);
    expect(host.events[1].text).toContain('看清了,是僵尸(东边 10 格)');
  });

  it('牲畜按种类合并捎带,离圈后回来才再报', () => {
    const { bot, host, tick } = proxRig();
    bot.entities = {
      '1': { id: 1, name: 'cow', type: 'animal', position: pos(6, 64, 0.5) },
      '2': { id: 2, name: 'cow', type: 'animal', position: pos(8, 64, 2) },
    };
    tick();
    expect(host.events).toHaveLength(1);
    expect(host.events[0].text).toContain('附近有牛×2');
    tick(); // 还在圈内:不重复
    expect(host.events).toHaveLength(1);
    bot.entities = {};
    tick(); // 离开感知圈:静默清态
    bot.entities = { '1': { id: 1, name: 'cow', type: 'animal', position: pos(6, 64, 0.5) } };
    tick();
    expect(host.events).toHaveLength(2);
    expect(host.events[1].text).toContain('附近有牛×1');
  });

  it('有弓和普通箭时，32 格内可见敌对才扩大感知，40 格退出', () => {
    const { zombie, bag, host, tick } = proxRig();
    bag.push(
      { name: 'bow', type: 261, count: 1 },
      { name: 'arrow', type: 262, count: 16 },
    );
    tick();
    expect(host.events).toHaveLength(1);
    expect(host.events[0].text).toContain('僵尸在东边 30 格');

    zombie.position = pos(36, 64, 0.5);
    tick();
    expect(host.events).toHaveLength(1);
    zombie.position = pos(41, 64, 0.5);
    tick();
    expect(host.events.at(-1)?.text).toContain('僵尸走远了');
  });

  /**
   * 远处敌对目标失去可见性后从跟踪表移除，不能将未观察到的移动报告为走远。
   */
  it('远处敌对看不见了就不再跟:表里摘掉但不谎报走远,再露头当作新接触', () => {
    let blocked = false;
    const { zombie, bag, host, tick } = proxRig(() => (blocked ? { name: 'stone' } : null));
    bag.push(
      { name: 'bow', type: 261, count: 1 },
      { name: 'arrow', type: 262, count: 16 },
    );
    zombie.position = pos(30, 64, 0.5);
    tick();
    expect(host.events).toHaveLength(1);
    expect(host.events[0].text).toContain('僵尸在东边 30 格');

    // 30 格外躲进墙后:弓够不着了,不再跟。没看见它走,所以一个字都不说
    blocked = true;
    tick();
    expect(host.events).toHaveLength(1);
    expect(host.events.some((e) => e.text.includes('走远了'))).toBe(false);

    // 再露头:表里已经没有它了,当作一次新接触照报
    blocked = false;
    tick();
    expect(host.events).toHaveLength(2);
    expect(host.events[1].text).toContain('僵尸在东边 30 格');
  });

  it('弓箭不会把不可见远敌渲染成听见，友军也不扩大到 32 格', () => {
    const { bot, bag, host, tick } = proxRig(() => ({ name: 'stone' }));
    bag.push(
      { name: 'bow', type: 261, count: 1 },
      { name: 'arrow', type: 262, count: 16 },
    );
    tick();
    expect(host.events).toHaveLength(0);

    bot.entities = {
      '9': { id: 9, name: 'villager', type: 'mob', position: pos(30, 64, 0.5) },
    };
    tick();
    expect(host.events).toHaveLength(0);
  });

  it('普通猪灵会随金甲穿脱在敌对与中立接近事实之间切换', () => {
    const { bot, host, tick } = proxRig();
    const slots = Array.from({ length: 9 }, () => null as { name: string } | null);
    Object.assign(bot, {
      inventory: { slots },
      registry: { entitiesByName: { piglin: { metadataKeys: ['flags', 'baby'] } } },
      entities: {
        '7': { id: 7, name: 'piglin', type: 'mob', metadata: [0, false], position: pos(8, 64, 0.5) },
      },
    });

    tick();
    expect(host.events.at(-1)?.text).toContain('猪灵在东边 8 格');
    expect(host.pushOpts.at(-1)?.trigger).toBe('flush');

    slots[5] = { name: 'golden_helmet' };
    tick();
    expect(host.events.at(-1)?.text).toContain('看见猪灵在东边 8 格');
    expect(host.pushOpts.at(-1)?.trigger).not.toBe('flush');

    slots[5] = null;
    tick();
    expect(host.events.at(-1)?.text).toContain('猪灵在东边 8 格');
    expect(host.pushOpts.at(-1)?.trigger).toBe('flush');
  });
});

describe('远程实体事件边界', () => {
  it('位置事件喂测速器，实体消失清样本，且只有本 bot 的伤害才尝试归箭', () => {
    const bot = Object.assign(new EventEmitter(), idleBot()) as EventEmitter & {
      entity: { id: number; position: Pos };
    };
    const observed: number[] = [];
    const forgotten: number[] = [];
    const hits: number[] = [];
    const m = new MinecraftWorld({ cfg: cfg() });
    stub(m, {
      rangedBot: bot,
      rangedMotion: {
        observe: (id: number) => observed.push(id),
        forget: (id: number) => forgotten.push(id),
      },
      ranged: { noteHit: (id: number) => { hits.push(id); } },
      combat: { acceptsRangedHit: () => true },
    });
    (m as unknown as { hookBotEvents(bot: unknown): void }).hookBotEvents(bot);

    bot.emit('entityMoved', { id: 7, position: pos(4, 64, 0) });
    bot.emit('entityHurt', { id: 7 }, { id: 99 });
    bot.emit('entityHurt', { id: 7 }, { id: bot.entity.id });
    bot.emit('entityGone', { id: 7 });
    bot.emit('entityDead', { id: 8 });

    expect(observed).toEqual([7]);
    expect(hits).toEqual([7]);
    expect(forgotten).toEqual([7, 8]);
  });

  it('主动 attack 的目标伤害归任务,不送进被动战斗会话', () => {
    const bot = Object.assign(new EventEmitter(), idleBot()) as EventEmitter & {
      entity: { id: number; position: Pos };
    };
    const meleeHits: number[] = [];
    const rangedAttempts: number[] = [];
    const m = new MinecraftWorld({ cfg: cfg() });
    stub(m, {
      rangedBot: bot,
      rangedMotion: { observe: () => {}, forget: () => {} },
      ranged: {
        noteHit: (id: number) => { rangedAttempts.push(id); return null; },
      },
      executor: {
        claimsCombat: () => true,
        acceptsRangedHit: () => true,
        noteCombatTargetHurt: (id: number) => meleeHits.push(id),
      },
      combat: { acceptsRangedHit: () => false },
    });
    (m as unknown as { hookBotEvents(bot: unknown): void }).hookBotEvents(bot);

    bot.emit('entityHurt', { id: 7 }, { id: bot.entity.id });

    expect(rangedAttempts).toEqual([7]);
    expect(meleeHits).toEqual([7]);
  });
});

describe('MinecraftWorld World 面(未连接状态)', () => {
  it('工具面与 tag 分类', () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const tools = m.tools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort())
      .toEqual([
        'mc_bag', 'mc_blocked', 'mc_blueprint', 'mc_check', 'mc_do', 'mc_escape',
        'mc_goal', 'mc_map', 'mc_policy', 'mc_queue', 'mc_scout', 'mc_stop',
      ]);
    // 三个只读原语与 mc_check 同一档:纯读、不进队列、不该进只读 fork 的禁区;
    // 回执是此刻读数,另打 snapshot(交接笔记同名只留最后一次)
    for (const name of ['mc_bag', 'mc_queue', 'mc_blocked']) {
      expect(byName[name].tags).toEqual(['read', 'snapshot']);
      expect(byName[name].barrierAfter).toBeUndefined();
    }
    // 对账只读世界:不进队列也不该进只读 fork 的禁区
    expect(byName.mc_check.tags).toEqual(['read']);
    expect(byName.mc_check.barrierAfter).toBeUndefined();
    expect(byName.mc_scout.tags).toContain('read');
    expect(byName.mc_scout.barrierAfter).toBeUndefined();
    // 这三个改的是世界,不是她的嘴:标成 speak 会让"禁言"连挖矿一起禁掉
    expect(byName.mc_do.tags).toContain('act');
    expect(byName.mc_stop.tags).toContain('act');
    expect(byName.mc_escape.tags).toContain('act');
    // 规矩改的是常驻内部状态,不是外部世界也不是记忆:write 是唯一说得通的那一档,
    // 同时保证它不进只读 fork 的装配。没有要复核的东西,所以没有 barrierAfter
    expect(byName.mc_policy.tags).toEqual(['write']);
    expect(byName.mc_policy.barrierAfter).toBeUndefined();
  });

  it('未启动时工具返回可读失败文本,不抛错', async () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const tools = Object.fromEntries(m.tools().map((t) => [t.name, t]));
    const ctx = { role: 'test', log: console as never };
    const steps = [{ skill: 'collect', block: 'stone', count: 1 }];
    expect(await tools.mc_do.handler({ steps }, ctx as never)).toContain('未启动');
    expect(await tools.mc_scout.handler({ steps: [{ skill: 'probe', shape: 'line', anchors: [[0, 64, 0], [0, 66, 0]] }] }, ctx as never)).toContain('未启动');
    expect(await tools.mc_stop.handler({}, ctx as never)).toContain('未启动');
    expect(await tools.mc_escape.handler({}, ctx as never)).toContain('未启动');
  });

  /**
   * 无效 mc_do 入参回念原始错误段，不附整张技能表。
   */
  it('mc_do 的入参不合法就当场退回:回念她写的那一段,不再 dump 技能表', async () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const tools = Object.fromEntries(m.tools().map((t) => [t.name, t]));
    const ctx = { role: 'test', log: console as never };
    const bad = await tools.mc_do.handler({ steps: [{ skill: '往下挖' }] }, ctx as never) as string;
    expect(bad).toContain('第 1 步');
    expect(bad).toContain('你写的是 [{"skill":"往下挖"}]');
    // 技能表的任何一段都不该出现在失败回执里
    expect(bad).not.toContain('"skill":"collect"');
    expect(bad.length).toBeLessThan(200);
  });

  it('mc_scout 拒会动世界的步,同样只回念她写的那一段', async () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const tools = Object.fromEntries(m.tools().map((t) => [t.name, t]));
    const ctx = { role: 'test', log: console as never };
    const bad = await tools.mc_scout.handler({ steps: [{ skill: 'collect', block: 'stone' }] }, ctx as never) as string;
    expect(bad).toContain('会动世界');
    expect(bad).toContain('你写的是 [{"skill":"collect","block":"stone"}]');
    expect(bad).not.toContain('"skill":"probe"');
    expect(bad.length).toBeLessThan(200);
  });

  it('console 自报:未连接 off 徽标 + 配置组归属正确', () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const decl = m.console();
    expect(decl.badges?.[0]).toMatchObject({ label: '服务器', tone: 'off' });
    expect(decl.config?.[0].id).toBe('world:minecraft');
    // 分成几组是给人看的分节
    const ids = decl.config!.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const group of decl.config!) expect(group.owner).toBe('world:minecraft');
    // 声明的每个配置键都能在默认值里找到落点
    for (const group of decl.config!) {
      for (const key of Object.keys(group.schema.properties)) {
        const path = key.split('.').slice(1); // 去掉 worlds. 前缀 → minecraft.xxx
        let node: unknown = { minecraft: cfg() };
        for (const seg of path) node = (node as Record<string, unknown>)[seg];
        expect(node, key).not.toBeUndefined();
      }
    }
  });

  it('画面徽标:两条路都没有时是 off', () => {
    const m = new MinecraftWorld({ cfg: cfg({ viewerPort: 0 }) });
    expect(m.console().badges?.[2]).toMatchObject({ label: '画面', value: '无', tone: 'off' });
  });

  it('摄像机段只认开关:关=空串(不留 {{}}),开=「摄像机说明」文件原文', async () => {
    const off = (await renderWorldEnvPrompt(new MinecraftWorld({ cfg: cfg() }))).text;
    expect(off).not.toContain('{{');
    expect((new MinecraftWorld({ cfg: cfg() }).envPromptVars() as Record<string, string>)['minecraft.camera']).toBe('');
    // 开了客户端时那一段读「摄像机说明」文件——说什么归模板管,这里只对账来源
    const m = new MinecraftWorld({
      cfg: cfg({ client: { ...MINECRAFT_DEFAULTS.client, enabled: true } }),
    });
    const noteDoc = m.console().promptDocs?.find((d) => d.key === 'worlds.minecraft.cameraNote');
    expect(noteDoc).toBeDefined();
    expect((m.envPromptVars() as Record<string, string>)['minecraft.camera'])
      .toBe(readFileSync(noteDoc!.path, 'utf8').trim());
  });

  it('客户端挂载面板:没有游戏目录时报未配置,并给出原因', async () => {
    const m = new MinecraftWorld({ cfg: cfg({ client: { ...MINECRAFT_DEFAULTS.client, gameDir: 'C:\\nope\\.minecraft' } }) });
    const st = await m.clientConsole().state();
    expect(st.configured).toBe(false);
    expect(st.detail).toContain('不存在');
    expect(st.phase).toBe('stopped');
  });

  it('玩家客户端:自己没配目录时用摄像机那份,名字是自己的', async () => {
    const m = new MinecraftWorld({
      cfg: cfg({
        client: { ...MINECRAFT_DEFAULTS.client, gameDir: 'C:\\nope\\.minecraft' },
        player: { ...MINECRAFT_DEFAULTS.player, username: '老王' },
      }),
    });
    const st = await m.playerConsole().state();
    expect(st.username).toBe('老王');
    expect(st.gameDir).toBe('C:\\nope\\.minecraft');
    expect(st.enabled).toBe(false); // 配置没开,但面板仍可手动启停
    expect(st.phase).toBe('stopped');
  });

  it('传送:没有托管服务器也没有 bot 时说清是谁下不了这条指令', async () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const st = await m.playerConsole().teleport();
    expect(st.detail).toContain('传送没人下得了');
  });

  it('传送:玩家名与 bot 同名时当场拒绝,不去下指令', async () => {
    const m = new MinecraftWorld({
      cfg: cfg({ username: '同名', player: { ...MINECRAFT_DEFAULTS.player, username: '同名' } }),
    });
    expect((await m.playerConsole().teleport()).detail).toContain('传送不了');
  });

  it('mc_do 收 steps 与 queue 两个字段;mc_scout 同一条队列同一套三态', async () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const tools = Object.fromEntries(m.tools().map((t) => [t.name, t]));
    const ctx = { role: 'test', log: console as never };
    for (const name of ['mc_do', 'mc_scout']) {
      const props = tools[name].parameters.properties as Record<string, Record<string, unknown>>;
      expect(Object.keys(props).sort()).toEqual(['queue', 'steps']);
      expect(props.queue.enum).toEqual(['replace', 'append', 'now']);
      expect(tools[name].parameters.required).toEqual(['steps']); // queue 不写 = replace
    }
    // schema 外的字段照旧忽略,随后因 World 未启动而停止
    expect(await tools.mc_do.handler({ steps: [{ skill: 'eat', item: 'bread' }], mode: 'append' }, ctx as never))
      .toContain('未启动');
  });

  it('queue 写了个不认识的值:当场退回,不猜她想说哪一个', async () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const tools = Object.fromEntries(m.tools().map((t) => [t.name, t]));
    const ctx = { role: 'test', log: console as never };
    const bad = await tools.mc_do.handler(
      { steps: [{ skill: 'eat', item: 'bread' }], queue: 'next' }, ctx as never,
    ) as string;
    expect(bad).toContain('queue 只认 replace/append/now');
    expect(bad).not.toContain('未启动'); // 参数错误优先于「World 未启动」
  });

  it('世界快照是投递成文挂单:连着才挂 piggyback,在途不重复,发车刻现拿', () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const deferred: Array<{ type: string; trigger?: string; render: () => string | null | Promise<string | null> }> = [];
    const arm = () => (m as any).armSnapshot(Date.now());
    stub(m, {
      host: {
        pushDeferred: (
          e: { type: string; render: () => string | null | Promise<string | null> },
          opts?: { trigger?: string },
        ) => deferred.push({ type: e.type, trigger: opts?.trigger, render: e.render }),
        log: console,
      },
    });
    arm();
    expect(deferred).toHaveLength(0); // 没连上:不挂,渲染侧也就永远不会说"还没连上"
    stub(m, { bridge: { connected: true, bot: idleBot(), invSynced: true } });
    arm();
    expect(deferred).toHaveLength(1);
    expect(deferred[0].type).toBe('minecraft.world.snapshot');
    expect(deferred[0].trigger).toBe('piggyback');
    arm();
    expect(deferred).toHaveLength(1); // 在途挂单不重复挂
    const text = deferred[0].render() as string;
    expect(text).toContain('[Minecraft]');
    expect(text).toContain('生命'); // narrateWorld 的身体状况行进了快照
  });

  it('快照按段去重:全段没变整条蒸发,变了只发脏段并以尾缀指代其余', () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const deferred: Array<{ render: () => string | null | Promise<string | null> }> = [];
    const bot = idleBot() as { entity: { position: { x: number } } };
    stub(m, {
      host: {
        pushDeferred: (e: { render: () => string | null | Promise<string | null> }) => deferred.push(e),
        log: console,
      },
      bridge: { connected: true, bot, invSynced: true },
    });
    const rewind = () => { (m as any).lastSnapshotRenderAt = Date.now() - 60_000; };
    const arm = () => { rewind(); (m as any).armSnapshot(Date.now()); };
    arm();
    const first = deferred[0].render() as string;
    expect(first).toContain('[Minecraft]');
    expect(first).toContain('生命'); // 首份没有基线,发全量
    // 世界没变:第二份蒸发,不占一条事件(它搭的那班车就是这一批的正文)
    rewind();
    arm();
    expect(deferred[1].render()).toBeNull();
    // 蒸发的那份不消耗基线:下一份仍按首份的基线比对
    // 挪了位置:只发方位段,身体段没变不重发,其余以尾缀指代
    bot.entity.position.x = 40.5;
    rewind();
    arm();
    const third = deferred[2].render() as string;
    // 报的是脚下那一格的整数格坐标:她写 at/anchors 用的就是这个口径,不该再让她自己取整
    expect(third).toContain('站在格 (40,');
    // 未重发段保持不变的规则不在每份快照尾部重复。
    expect(third).not.toContain('其余跟上一份快照一样');
    expect(third).not.toContain('生命');
    expect(third).not.toContain('没有变化');
  });

  it('envPromptVars 被重调(截断刷新环境提示词)后,下一份快照强制全量', () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const deferred: Array<{ render: () => string | null | Promise<string | null> }> = [];
    stub(m, {
      host: {
        pushDeferred: (e: { render: () => string | null | Promise<string | null> }) => deferred.push(e),
        log: console,
      },
      bridge: { connected: true, bot: idleBot(), invSynced: true },
    });
    const arm = () => { (m as any).lastSnapshotRenderAt = Date.now() - 60_000; (m as any).armSnapshot(Date.now()); };
    arm();
    deferred[0].render();
    m.envPromptVars(); // 截断点 core 会重调:新窗口失去基线
    arm();
    const next = deferred[1].render() as string;
    expect(next).toContain('生命'); // 世界没变也发全量(蒸发只发生在没有全量锚的时候)
  });

  it('距上一份全量超过 snapshotAnchorSec 时强制全量兜底', () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const deferred: Array<{ render: () => string | null | Promise<string | null> }> = [];
    stub(m, {
      host: {
        pushDeferred: (e: { render: () => string | null | Promise<string | null> }) => deferred.push(e),
        log: console,
      },
      bridge: { connected: true, bot: idleBot(), invSynced: true },
    });
    const arm = () => { (m as any).lastSnapshotRenderAt = Date.now() - 60_000; (m as any).armSnapshot(Date.now()); };
    arm();
    deferred[0].render();
    (m as any).lastSnapshotFullAt = Date.now() - 601_000; // 默认锚 600s
    arm();
    const next = deferred[1].render() as string;
    expect(next).toContain('生命');
  });

  it('挂单后断线,发车刻渲染返回 null 整条蒸发', () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const deferred: Array<{ render: () => string | null | Promise<string | null> }> = [];
    stub(m, {
      host: {
        pushDeferred: (e: { render: () => string | null | Promise<string | null> }) =>
          deferred.push({ render: e.render }),
        log: console,
      },
      bridge: { connected: true, bot: idleBot(), invSynced: true },
    });
    (m as any).armSnapshot(Date.now());
    expect(deferred).toHaveLength(1);
    stub(m, { bridge: { connected: false } });
    expect(deferred[0].render()).toBeNull();
  });

  it('技能表里有 find,mc_do 的 enum 跟着走', () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const mcDo = m.tools().find((t) => t.name === 'mc_do')!;
    const props = mcDo.parameters.properties as Record<string, { items?: { properties?: Record<string, { enum?: string[] }> } }>;
    const names = props.steps.items!.properties!.skill.enum!;
    expect(names).toContain('find');
    expect(names).toContain('toss');
    expect(names).toContain('stow');
    expect(names).toContain('take');
  });

  it('mc_scout 的 enum 是同一张表的只读切片', () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const scout = m.tools().find((t) => t.name === 'mc_scout')!;
    const props = scout.parameters.properties as Record<string, { items?: { properties?: Record<string, { enum?: string[] }> } }>;
    const names = props.steps.items!.properties!.skill.enum!;
    expect(names).toEqual(['goto', 'tunnel', 'build', 'excavate', 'probe']);
    expect(names).not.toContain('collect');
    expect(names).not.toContain('chat');
  });

  it('默认 enabled=false:World 不自报被需要;观察者客户端也默认不开', () => {
    expect(MINECRAFT_DEFAULTS.enabled).toBe(false);
    expect(MINECRAFT_DEFAULTS.local.serverEnabled).toBe(false);
    expect(MINECRAFT_DEFAULTS.client.enabled).toBe(false);
  });
});

describe('MinecraftWorld 受管服务器开关', () => {
  const serverState = (enabled: boolean, phase: MinecraftServerState['phase'] = 'stopped'): MinecraftServerState => ({
    enabled,
    phase,
    address: '127.0.0.1:1',
    detail: null,
    pid: null,
    reachable: phase === 'running',
    serverDir: 'C:\\managed',
    configured: true,
  });

  it('关态长期不连接；开后启动并连接，再关会断线并保存式停服', async () => {
    vi.useFakeTimers();
    const runtimeCfg = cfg({
      port: 1,
      local: {
        ...MINECRAFT_DEFAULTS.local,
        serverDir: 'C:\\managed',
        serverEnabled: false,
        cheats: false,
      },
    });
    const bridgeStart = vi.spyOn(Bridge.prototype, 'start').mockImplementation(() => undefined);
    const bridgeStop = vi.spyOn(Bridge.prototype, 'stop').mockResolvedValue(undefined);
    const serverStart = vi.spyOn(MinecraftServerManager.prototype, 'start')
      .mockImplementation(async () => serverState(runtimeCfg.local.serverEnabled, 'starting'));
    const serverStop = vi.spyOn(MinecraftServerManager.prototype, 'stop')
      .mockImplementation(async () => serverState(runtimeCfg.local.serverEnabled));
    vi.spyOn(MinecraftServerManager.prototype, 'state')
      .mockImplementation(async () => serverState(runtimeCfg.local.serverEnabled));
    const m = new MinecraftWorld({ cfg: runtimeCfg });
    try {
      await m.start(new FakeHost() as never);
      await vi.advanceTimersByTimeAsync(0);
      expect(bridgeStart).not.toHaveBeenCalled();
      expect(serverStart).not.toHaveBeenCalled();
      expect(bridgeStop).toHaveBeenCalledTimes(1);
      expect(serverStop).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(600_000);
      expect(bridgeStart).not.toHaveBeenCalled();
      expect(serverStart).not.toHaveBeenCalled();
      expect((await m.serverConsole().start()).detail).toContain('开关已关闭');

      runtimeCfg.local.serverEnabled = true;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(serverStart).toHaveBeenCalledTimes(1);
      expect(bridgeStart).toHaveBeenCalledTimes(1);
      const stopsBeforeRejectedConsoleStop = serverStop.mock.calls.length;
      expect((await m.serverConsole().stop()).detail).toContain('开关仍开启');
      expect(serverStop).toHaveBeenCalledTimes(stopsBeforeRejectedConsoleStop);

      // 运行期间把配置路径清空也不得孤儿化已受管的进程。
      const executor = (m as unknown as { executor: { onConnectionLost(reason?: string): void } }).executor;
      const combat = (m as unknown as { combat: { onConnectionLost(): void } }).combat;
      const executorLost = vi.spyOn(executor, 'onConnectionLost');
      const combatLost = vi.spyOn(combat, 'onConnectionLost');
      (m as unknown as { mcServer: { activeServerDir: string | null } }).mcServer.activeServerDir = 'C:\\managed';
      runtimeCfg.local.serverDir = '';
      runtimeCfg.local.serverEnabled = false;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(bridgeStop).toHaveBeenCalledTimes(2);
      expect(serverStop).toHaveBeenCalledTimes(stopsBeforeRejectedConsoleStop + 1);
      expect(executorLost).toHaveBeenCalledWith('受管服务器开关关闭');
      expect(combatLost).toHaveBeenCalledOnce();
      expect(m.console().badges?.[0]).toMatchObject({ value: '受管服务已关闭', tone: 'off' });
    } finally {
      await m.stop();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('关闭的一个外部边界失败时仍尝试另一个，下一心跳会重试未落地状态', async () => {
    vi.useFakeTimers();
    const runtimeCfg = cfg({
      port: 1,
      local: {
        ...MINECRAFT_DEFAULTS.local,
        serverDir: 'C:\\managed',
        serverEnabled: false,
        cheats: false,
      },
    });
    vi.spyOn(Bridge.prototype, 'start').mockImplementation(() => undefined);
    const bridgeStop = vi.spyOn(Bridge.prototype, 'stop')
      .mockRejectedValueOnce(new Error('quit failed'))
      .mockResolvedValue(undefined);
    vi.spyOn(MinecraftServerManager.prototype, 'start').mockResolvedValue(serverState(false));
    const serverStop = vi.spyOn(MinecraftServerManager.prototype, 'stop').mockResolvedValue(serverState(false));
    vi.spyOn(MinecraftServerManager.prototype, 'state').mockResolvedValue(serverState(false));
    const m = new MinecraftWorld({ cfg: runtimeCfg });
    try {
      await m.start(new FakeHost() as never);
      await vi.advanceTimersByTimeAsync(0);
      expect(bridgeStop).toHaveBeenCalledTimes(1);
      expect(serverStop).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(bridgeStop).toHaveBeenCalledTimes(2);
      expect(serverStop).toHaveBeenCalledTimes(2);
    } finally {
      await m.stop();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('模块重启按持久化的开启值恢复受管服务器与连接', async () => {
    vi.useFakeTimers();
    const runtimeCfg = cfg({
      port: 1,
      local: {
        ...MINECRAFT_DEFAULTS.local,
        serverDir: 'C:\\managed',
        serverEnabled: true,
        cheats: false,
      },
    });
    const bridgeStart = vi.spyOn(Bridge.prototype, 'start').mockImplementation(() => undefined);
    vi.spyOn(Bridge.prototype, 'stop').mockResolvedValue(undefined);
    const serverStart = vi.spyOn(MinecraftServerManager.prototype, 'start')
      .mockResolvedValue(serverState(true, 'starting'));
    vi.spyOn(MinecraftServerManager.prototype, 'stop').mockResolvedValue(serverState(true));
    vi.spyOn(MinecraftServerManager.prototype, 'state').mockResolvedValue(serverState(true));
    const m = new MinecraftWorld({ cfg: runtimeCfg });
    try {
      await m.start(new FakeHost() as never);
      await vi.advanceTimersByTimeAsync(0);
      expect(serverStart).toHaveBeenCalledTimes(1);
      expect(bridgeStart).toHaveBeenCalledTimes(1);
    } finally {
      await m.stop();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('模块 stop 不等待在途启动探针，立即撤销 Bridge 与服务器生命周期', async () => {
    vi.useFakeTimers();
    const runtimeCfg = cfg({
      port: 1,
      local: {
        ...MINECRAFT_DEFAULTS.local,
        serverDir: 'C:\\managed',
        serverEnabled: true,
        cheats: false,
      },
    });
    const pending: { resolve: ((state: MinecraftServerState) => void) | null } = { resolve: null };
    const bridgeStart = vi.spyOn(Bridge.prototype, 'start').mockImplementation(() => undefined);
    const bridgeStop = vi.spyOn(Bridge.prototype, 'stop').mockResolvedValue(undefined);
    vi.spyOn(MinecraftServerManager.prototype, 'start').mockImplementation(() => (
      new Promise<MinecraftServerState>((resolve) => { pending.resolve = resolve; })
    ));
    const serverStop = vi.spyOn(MinecraftServerManager.prototype, 'stop')
      .mockResolvedValue(serverState(true));
    vi.spyOn(MinecraftServerManager.prototype, 'state').mockResolvedValue(serverState(true));
    const m = new MinecraftWorld({ cfg: runtimeCfg });
    try {
      await m.start(new FakeHost() as never);
      await vi.advanceTimersByTimeAsync(0);
      expect(pending.resolve).not.toBeNull();

      const stopping = m.stop();
      await Promise.resolve();
      // 先停 bridge，再停服务器，避免连接方在服务器退出后继续安排重连。
      expect(bridgeStop).toHaveBeenCalledOnce();
      expect(bridgeStart).not.toHaveBeenCalled();

      pending.resolve?.(serverState(true, 'starting'));
      await stopping;
      // 在途启动探针没把收摊挡住:服务器照样停下了,而且 bridge 没被重新拉起来
      expect(serverStop).toHaveBeenCalledOnce();
      expect(bridgeStart).not.toHaveBeenCalled();
    } finally {
      pending.resolve?.(serverState(true));
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('未配置本地服务时不受本地开关约束，仍按远程连接启动', async () => {
    vi.useFakeTimers();
    const bridgeStart = vi.spyOn(Bridge.prototype, 'start').mockImplementation(() => undefined);
    vi.spyOn(Bridge.prototype, 'stop').mockResolvedValue(undefined);
    const serverStart = vi.spyOn(MinecraftServerManager.prototype, 'start').mockResolvedValue(serverState(true));
    const serverStop = vi.spyOn(MinecraftServerManager.prototype, 'stop').mockResolvedValue(serverState(true));
    vi.spyOn(MinecraftServerManager.prototype, 'state').mockResolvedValue(serverState(true));
    const m = new MinecraftWorld({ cfg: cfg({
      local: { ...MINECRAFT_DEFAULTS.local, serverDir: '', serverEnabled: false },
    }) });
    try {
      await m.start(new FakeHost() as never);
      await vi.advanceTimersByTimeAsync(0);
      expect(bridgeStart).toHaveBeenCalledTimes(1);
      expect(serverStart).not.toHaveBeenCalled();
      expect(serverStop).not.toHaveBeenCalled();
    } finally {
      await m.stop();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});

describe('掉血播报:快到来不及的伤害必须当场唤醒', () => {
  function damageRig() {
    const m = new MinecraftWorld({ cfg: cfg() });
    const host = new FakeHost();
    stub(m, { host });
    return {
      host,
      health: (h: number) => (m as any).noticeDamage(h),
      reflexSaid: (text: string, hurt: boolean) => (m as any).onTaskReport({ kind: 'reflex', hurt, text }),
    };
  }

  /** 事件的唤醒口径:flush = 当场投递,debounce = 攒批 */
  const triggers = (host: FakeHost): Array<string | undefined> =>
    host.pushOpts.map((o) => (o as { trigger?: string } | undefined)?.trigger);

  it('一跳掉 4 点立刻唤醒:岩浆每半秒 4 点,等血线跌破 10 就来不及了', () => {
    const { host, health } = damageRig();
    health(20);
    health(16); // 血还剩 16,老口径按"不急"攒批,人已经在岩浆里了
    expect(host.events).toHaveLength(1);
    expect(triggers(host)).toEqual(['flush']);
  });

  it('零敲碎打的掉血照旧攒批,6 秒内不重复', () => {
    const { host, health } = damageRig();
    health(20);
    health(17); // 掉 3 点:不到唤醒线
    health(15);
    expect(host.events).toHaveLength(1);
    expect(triggers(host)).toEqual(['debounce']);
  });

  it('节流窗里再挨一记重的照样穿过去:连着掉不能只播报第一下', () => {
    const { host, health } = damageRig();
    health(20);
    health(17);
    health(9); // 同一个 6 秒窗内,但一跳 8 点
    expect(host.events).toHaveLength(2);
    expect(triggers(host)).toEqual(['debounce', 'flush']);
    expect(host.events[1].text).toContain('少了 8 点');
  });

  it('反射已经讲过掉血来由的,5 秒内不再复述一遍', () => {
    const { host, health, reflexSaid } = damageRig();
    health(20);
    reflexSaid('[反射] 碰到岩浆了!正在逃离。', true);
    health(12);
    expect(host.events.filter((e) => e.text.includes('我在掉血'))).toHaveLength(0);
  });

  it('反射说的不是掉血的事(比如吃了个东西),掉血照播', () => {
    const { host, health, reflexSaid } = damageRig();
    health(20);
    reflexSaid('[反射] 饥饿到 13/20,自动吃了一个 bread。', false);
    health(12);
    expect(host.events.filter((e) => e.text.includes('我在掉血'))).toHaveLength(1);
  });

  it('血量播报向上取整:0.4 血活着报 1/20,不报 0/20', () => {
    const { host, health } = damageRig();
    health(20);
    health(0.4);
    const said = host.events.find((e) => e.text.includes('我在掉血'))?.text ?? '';
    expect(said).toContain('现在 1/20');
    expect(said).not.toContain('0/20');
  });

  it('濒死播报同口径:0.086 血写 1/20', () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const host = new FakeHost();
    stub(m, { host });
    const bot = Object.assign(new EventEmitter(), idleBot() as Record<string, unknown>, { health: 0.086 });
    (m as unknown as { hookBotEvents(bot: unknown): void }).hookBotEvents(bot);
    bot.emit('health');
    const said = host.events.find((e) => e.text.includes('濒死'))?.text ?? '';
    expect(said).toContain('生命只剩 1/20');
  });
});

describe('状态效果与爆炸的事件成文', () => {
  function effectRig() {
    const m = new MinecraftWorld({ cfg: cfg() });
    const host = new FakeHost();
    stub(m, { host });
    const bot = Object.assign(new EventEmitter(), idleBot() as Record<string, unknown>, {
      registry: { biomes: {}, blocksByName: {}, effects: { 31: { name: 'BadOmen' } } },
    }) as unknown as EventEmitter & { entity: unknown; _client: EventEmitter };
    (m as unknown as { hookBotEvents(bot: unknown): void }).hookBotEvents(bot);
    const texts = () => host.events.map((e) => e.text).filter((t) => t.includes('不祥之兆'));
    return { m, host, bot, texts };
  }

  /**
 * 服务端会重复发送持续中的 entity_effect，重复包不代表新效果出现。
 */
  it('同一效果持续中的重推不成文:出现一条、结束一条、再中一条', () => {
    const { bot, texts } = effectRig();
    bot.emit('entityEffect', bot.entity, { id: 31, duration: 6000 * 20 });
    bot.emit('entityEffect', bot.entity, { id: 31, duration: 5970 * 20 });
    bot.emit('entityEffect', bot.entity, { id: 31, duration: 5940 * 20 });
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('中了「不祥之兆」效果');
    bot.emit('entityEffectEnd', bot.entity, { id: 31 });
    expect(texts()).toHaveLength(2);
    expect(texts()[1]).toContain('效果结束了');
    bot.emit('entityEffect', bot.entity, { id: 31, duration: 6000 * 20 });
    expect(texts()).toHaveLength(3);
  });

  it('死亡清掉效果表:复活后再中同一效果照常成文', () => {
    const { bot, texts } = effectRig();
    bot.emit('entityEffect', bot.entity, { id: 31, duration: 6000 * 20 });
    bot.emit('death');
    bot.emit('entityEffect', bot.entity, { id: 31, duration: 6000 * 20 });
    expect(texts()).toHaveLength(2);
  });


  it('explosion 包记进 world 泳道:坐标、半径、炸掉几格、离我多远;不投递给她', () => {
    const { m, host, bot } = effectRig();
    const before = host.events.length;
    bot._client.emit('explosion', {
      x: 3.5, y: 64, z: 4.5, radius: 3,
      affectedBlockOffsets: [{ x: 0, y: -1, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }],
    });
    const rows = m.logConsole().entries().filter((e) => e.event === 'explosion');
    expect(rows).toHaveLength(1);
    expect(rows[0].lane).toBe('world');
    expect(rows[0].msg).toContain('爆炸:(4, 64, 5) 半径 3.0,炸掉 3 格,离我 5.0 格');
    expect(rows[0].data).toMatchObject({ x: 3.5, y: 64, z: 4.5, radius: 3, affected: 3, distance: 5 });
    expect(host.events).toHaveLength(before);
  });
});

/** 使用拒绝连接的端口隔离队列与任务号测试，避免执行已入队技能。 */
async function started(over: Partial<MinecraftConfigSection> = {}) {
  const m = new MinecraftWorld({ cfg: cfg({ port: 1, ...over }) });
  const host = new FakeHost();
  await m.start(host as never);
  const tools = Object.fromEntries(m.tools().map((t) => [t.name, t]));
  const ctx = { role: 'test', log: console as never } as never;
  return {
    m, host, tools,
    call: (name: string, args: Record<string, unknown> = {}) =>
      tools[name].handler(args, ctx) as Promise<string>,
    callInRound: (round: number, name: string, args: Record<string, unknown> = {}) =>
      tools[name].handler(args, {
        role: 'test', log: console as never, round,
      } as never) as Promise<string>,
    // 队列现状没有工具入口了,测试直接读执行器(她那边走快照的 queue 段与任务推送)
    queueText: () => renderQueue((m as any).executor.status()),
  };
}

describe('MinecraftWorld 物品损坏事件', () => {
  interface BreakItem {
    name: string;
    count: number;
    componentMap: Map<string, { data: number }>;
  }

  function breakItem(name: string, damage: number): BreakItem {
    return { name, count: 1, componentMap: new Map([['damage', { data: damage }]]) };
  }

  function breakBot(main: BreakItem | null, head: BreakItem | null = null) {
    const client = new EventEmitter();
    const inventory = new EventEmitter() as EventEmitter & {
      slots: Array<BreakItem | null>;
      items(): BreakItem[];
    };
    inventory.slots = Array.from({ length: 46 }, () => null);
    inventory.slots[5] = head;
    inventory.items = () => inventory.slots.filter((entry): entry is BreakItem => entry !== null);
    const bot = Object.assign(new EventEmitter(), idleBot() as Record<string, unknown>, {
      entity: { id: 17, position: pos(0.5, 64, 0.5) },
      heldItem: main,
      inventory,
      _client: client,
    });
    return { bot, client, inventory };
  }

  function breakRig(initial: ReturnType<typeof breakBot>) {
    const m = new MinecraftWorld({ cfg: cfg({ port: 1 }) });
    const host = new FakeHost();
    const bridge = { connected: true, invSynced: true, bot: initial.bot, stop: async () => {} };
    stub(m, { host, bridge });
    return {
      m, host, bridge,
      spawn: () => (m as any).onSpawn(),
      breaks: () => m.logConsole().entries().filter((entry) => entry.event === 'item-broke'),
    };
  }

  it('本玩家的主手损坏只投递一次，并记物品泳道结构化事实', () => {
    const current = breakBot(breakItem('diamond_pickaxe', 1560));
    const { host, spawn, breaks } = breakRig(current);
    spawn();
    expect(current.client.listenerCount('entity_status')).toBe(1);

    current.client.emit('entity_status', { entityId: 17, entityStatus: 47 });
    current.client.emit('entity_status', { entityId: 17, entityStatus: 47 });

    const events = host.events.filter((entry) => entry.text.includes('已损坏'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'minecraft.event' });
    expect(events[0].text).toContain('主手的钻石镐已损坏');
    expect(events[0].text).toContain('下一步动作前要重新选择工具');
    expect(host.pushOpts.at(-1)?.trigger).toBe('flush');
    expect(breaks()).toEqual([
      expect.objectContaining({
        lane: 'inventory',
        event: 'item-broke',
        data: {
          slot: 'mainhand',
          item: 'diamond_pickaxe',
          durability: { left: 1, max: 1561 },
        },
      }),
    ]);
  });

  it('他人的 status 和普通换栏、卸甲都不生成损坏回执', () => {
    const current = breakBot(breakItem('iron_pickaxe', 10), breakItem('iron_helmet', 5));
    const { host, spawn, breaks } = breakRig(current);
    spawn();

    current.bot.heldItem = null;
    current.bot.emit('heldItemChanged', null);
    const helmet = current.inventory.slots[5];
    current.inventory.slots[5] = null;
    current.inventory.emit('updateSlot', 5, helmet, null);
    current.client.emit('entity_status', { entityId: 99, entityStatus: 47 });
    expect(host.events.filter((entry) => entry.text.includes('已损坏'))).toHaveLength(0);
    expect(breaks()).toHaveLength(0);
  });

  it('副手与护甲回执点名具体装备', () => {
    const current = breakBot(null, breakItem('iron_helmet', 164));
    current.inventory.slots[45] = breakItem('shield', 335);
    const { host, spawn, breaks } = breakRig(current);
    spawn();

    current.client.emit('entity_status', { entityId: 17, entityStatus: 48 });
    current.client.emit('entity_status', { entityId: 17, entityStatus: 49 });
    const events = host.events.filter((entry) => entry.text.includes('已损坏'));
    expect(events.map((entry) => entry.text)).toEqual([
      '[Minecraft] 副手的盾牌已损坏。',
      '[Minecraft] 头部装备的铁头盔已损坏。',
    ]);
    expect(breaks().map((entry) => entry.data?.item)).toEqual(['shield', 'iron_helmet']);
  });

  it('换 bot 和 stop 都移除旧 client 的 raw listener，旧事件不泄漏', async () => {
    const old = breakBot(breakItem('stone_pickaxe', 130));
    const next = breakBot(breakItem('iron_pickaxe', 249));
    const { m, host, bridge, spawn, breaks } = breakRig(old);
    spawn();
    expect(old.client.listenerCount('entity_status')).toBe(1);

    bridge.bot = next.bot;
    spawn();
    expect(old.client.listenerCount('entity_status')).toBe(0);
    expect(next.client.listenerCount('entity_status')).toBe(1);
    old.client.emit('entity_status', { entityId: 17, entityStatus: 47 });
    expect(breaks()).toHaveLength(0);

    next.client.emit('entity_status', { entityId: 17, entityStatus: 47 });
    expect(breaks()).toHaveLength(1);
    expect(host.events.filter((entry) => entry.text.includes('已损坏'))).toHaveLength(1);

    await m.stop();
    expect(next.client.listenerCount('entity_status')).toBe(0);
    next.client.emit('entity_status', { entityId: 17, entityStatus: 47 });
    expect(breaks()).toHaveLength(1);
  });
});

describe('队列的全部入口:排进去、试算、清空', () => {
  /*
   * 查队列是纯读入口；同轮且读数指纹相同的重复查询返回短回执，状态变化后仍正常输出。
   */
  it('查队列有了只读入口:纯读、不动队列', async () => {
    const { m, tools, call, queueText } = await started();
    try {
      expect(Object.keys(tools).sort()).toContain('mc_queue');
      const before = queueText();
      const readout = await call('mc_queue');
      expect(readout).toContain('[队列]');
      expect(readout).toContain('[最近一单]');
      // 读一遍不该改变任何东西
      expect(queueText()).toBe(before);
      // 包与受阻两条同样是纯读
      expect(await call('mc_bag')).toContain('还没连上服务器');
      expect(await call('mc_blocked')).toContain('[上次没成]');
      expect(queueText()).toBe(before);
    } finally {
      await m.stop();
    }
  });

  it('一轮一答:同一轮里再问同一个只读原语,只拿回指回上一条的短回执', async () => {
    const { m, callInRound } = await started();
    try {
      const first = await callInRound(1, 'mc_queue');
      expect(first).toContain('[队列]');
      // 同一轮第二次:不复述内容
      const again = await callInRound(1, 'mc_queue');
      expect(again).toBe('这轮已经答过了,答案不会变,先看上一条。');
      expect(again).not.toContain('[队列]');
      // 换一轮就照常答
      expect(await callInRound(2, 'mc_queue')).toContain('[队列]');
      // 闸是按工具分格的:同一轮里另一个只读原语照常答
      expect(await callInRound(2, 'mc_blocked')).toContain('[上次没成]');
    } finally {
      await m.stop();
    }
  });

  it('没有显式轮号就不设闸,连问两次都照答', async () => {
    const { m, call } = await started();
    try {
      expect(await call('mc_blocked')).toContain('[上次没成]');
      expect(await call('mc_blocked')).toContain('[上次没成]');
    } finally {
      await m.stop();
    }
  });

  it('mc_scout 与 mc_do 走同一条队列、同一段任务号', async () => {
    const { m, call } = await started();
    try {
      const scout = await call('mc_scout', { steps: [{ skill: 'goto', at: [10, 64, 10] }] });
      expect(scout).toContain('任务#1');
      const next = await call('mc_do', { steps: [{ skill: 'eat', item: 'bread' }] });
      expect(next).toContain('任务#2');
    } finally {
      await m.stop();
    }
  });

  it.each(['upkeep', 'unknown_skill'])('mc_do 遇到未知技能 %s 整批拒绝,前面的有效步骤也不入队', async (skill) => {
    const { m, call, queueText } = await started();
    try {
      const before = queueText();
      const rejected = await call('mc_do', { steps: [{ skill: 'eat', item: 'bread' }, { skill }] });
      expect(rejected).toContain('第 2 步');
      expect(rejected).toContain(skill);
      expect(queueText()).toBe(before);
      expect(await call('mc_do', { steps: [{ skill: 'eat', item: 'bread' }] })).toContain('任务#1');
    } finally {
      await m.stop();
    }
  });

  it('mc_do 排队不顶替:第二条排在后面等,号段是同一条', async () => {
    const { m, call } = await started();
    try {
      const first = await call('mc_do', { steps: [{ skill: 'eat', item: 'bread' }] });
      expect(first).toContain('任务#1');
      const second = await call('mc_do', { steps: [{ skill: 'goto', at: [10, 64, 10] }] });
      expect(second).toContain('任务#2');
      expect(second).not.toContain('顶');
    } finally {
      await m.stop();
    }
  });

  it('队列空闲时那一段说得清空,不含糊(它现在只经快照与推送出场)', async () => {
    const { m, queueText } = await started();
    try {
      const q = queueText();
      expect(q).toContain('手上没有在做的事');
      expect(q).toContain('后面没有排着的了');
    } finally {
      await m.stop();
    }
  });

  /**
   * 受理回执只回念引擎对输入作出的语义改写，一致字段不重复。
   */
  it('受理回执带时刻;她写的与实际要跑的全一致就一个字都不回念', async () => {
    const { m, call } = await started();
    try {
      // 键序不同但语义与规范形一致。
      const receipt = await call('mc_do', {
        steps: [{ count: 3, skill: 'collect', block: 'stone' }], queue: 'append',
      });
      expect(receipt).toMatch(/^\[\d{2}:\d{2}:\d{2}\] /);
      expect(receipt).toContain('任务#1');
      expect(receipt).not.toContain('跟你写的不一样');
      expect(receipt).not.toContain('{"skill":"collect"');
    } finally {
      await m.stop();
    }
  });

  it('引擎补了默认值就回念,点名是这一步的这个字段', async () => {
    const { m, call } = await started();
    try {
      const receipt = await call('mc_do', { steps: [{ skill: 'collect', block: 'stone' }] });
      expect(receipt).toContain('跟你写的不一样:count 你没写,我按 1 理解');
    } finally {
      await m.stop();
    }
  });

  it('一单里混着一致与不一致:只回念不一致的那几步', async () => {
    const { m, call } = await started();
    try {
      const receipt = await call('mc_do', {
        steps: [{ skill: 'collect', block: 'stone', count: 3 }, { skill: 'toss', item: 'dirt' }],
      });
      expect(receipt).toContain('跟你写的不一样:第 2 步的 count 你没写,我按 1 理解');
      expect(receipt).not.toContain('第 1 步的');
    } finally {
      await m.stop();
    }
  });

  /**
   * 受理回执带当前任务步骤进度；耗时有实际读数后才报告，刚开跑的零值不重复显示。
   */
  it('受理回执尾巴上带队列现状:在做的那件第几步', async () => {
    const { m, call } = await started();
    try {
      await call('mc_do', { steps: [{ skill: 'eat', item: 'bread' }] });
      const second = await call('mc_do', { steps: [{ skill: 'eat', item: 'bread' }], queue: 'append' });
      expect(second).toContain('[队列] 正在做任务#1');
      expect(second).toMatch(/第 1\/1 步:[^,)]+\)/);
      expect(second).not.toContain('已跑 0s');
      expect(second).not.toContain('整单已跑 0.0s');
      expect(second).toContain('后面排着 任务#2');
    } finally {
      await m.stop();
    }
  });

  it('解析把她写的东西丢掉了就明说:静默吃掉参数是这条链上最贵的一类失败', async () => {
    const { m, call } = await started();
    try {
      const receipt = await call('mc_do', { steps: [{ skill: 'eat', item: 'bread', count: 3 }] });
      expect(receipt).toContain('第 1 步写的 count:3');
      expect(receipt).toContain('忽略了');
      // 被丢掉的字段由这条注说,回念行不再重复说一遍同一件事
      expect(receipt).not.toContain('跟你写的不一样');
    } finally {
      await m.stop();
    }
  });

  it('mc_stop 空队列时明说本来就是空的', async () => {
    const { m, call } = await started();
    try {
      expect(await call('mc_stop')).toContain('本来就没有');
    } finally {
      await m.stop();
    }
  });

  it('mc_escape 未连接时失败,不假装传走了', async () => {
    const { m, call } = await started();
    try {
      expect(await call('mc_escape')).toContain('未连接');
    } finally {
      await m.stop();
    }
  });
});

describe('mc_escape 接线', () => {
  function liveBot(at: Pos, spawn: Pos) {
    const bot = Object.assign(new EventEmitter(), idleBot()) as EventEmitter & {
      entity: { position: Pos };
      game: { dimension: string };
      spawnPoint: Pos;
      chat: (s: string) => void;
      _client: EventEmitter;
    };
    const chats: string[] = [];
    bot.entity = { position: at };
    bot.game = { dimension: 'overworld' };
    bot.spawnPoint = spawn;
    bot.chat = (s) => { chats.push(s); };
    bot._client = new EventEmitter();
    return { bot, chats };
  }

  it.each(['floor', 'wall', 'unknown'] as const)('世界读数为 %s:传送和回执使用读出的落脚格', async (terrain) => {
    const { m, call } = await started();
    const { bot, chats } = liveBot(pos(20.5, 70, 4.5), pos(20, 70, 4));
    const landing = terrain === 'floor' ? pos(20.5, 71, 4.5)
      : terrain === 'wall' ? pos(21.5, 70, 4.5) : pos(20.5, 70, 4.5);
    if (terrain === 'unknown') bot.entity.position = pos(100, 12, -30);
    Object.assign(bot, { blockAt: (p: Pos) => {
      if (terrain === 'unknown') return null;
      const solid = terrain === 'floor' ? p.y <= 70 : p.y < 70 || (p.x === 20 && p.z === 4);
      return { name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty' };
    } });
    try {
      const orig = (m as any).bridge;
      stub(m, { bridge: { bot, connected: true, stop: () => orig?.stop() } });
      const pending = call('mc_escape');
      queueMicrotask(() => { bot.entity.position = landing; bot.emit('forcedMove'); });
      const out = await pending;
      expect(chats[0]).toBe(`/execute in minecraft:overworld run tp corti ${landing.x} ${landing.y} ${landing.z}`);
      expect(out).toContain('已回到世界出生点');
      expect(out).toContain(`(${Math.floor(landing.x)}, ${landing.y}, ${Math.floor(landing.z)})`);
    } finally {
      await m.stop();
    }
  });

  it('设重生点之后 escape 走床,清掉排队,自己的位移不急报', async () => {
    const { m, call, host, queueText } = await started();
    const { bot, chats } = liveBot(pos(100, 12, -30), pos(8, 64, 8));
    try {
      const orig = (m as any).bridge;
      stub(m, { bridge: { bot, connected: true, stop: () => orig?.stop() } });
      (m as any).hookBotEvents(bot);
      bot.entity.position = pos(20, 70, 4);
      bot.emit('message', { translate: SET_SPAWN_TRANSLATE, toString: () => 'Respawn point set' }, 'game_info');
      bot.entity.position = pos(100, 12, -30);
      (m as any).lastPosForTeleport = { x: 100, y: 12, z: -30 };

      await call('mc_do', { steps: [{ skill: 'eat', item: 'bread' }] });
      const pending = call('mc_escape');
      queueMicrotask(() => {
        bot.entity.position = pos(20.5, 70, 4.5);
        bot.emit('forcedMove');
      });
      const out = await pending;
      expect(chats[0]).toContain('/execute in minecraft:overworld run tp corti 20.5 70 4.5');
      expect(out).toContain('已回到床重生点 [主世界]');
      expect(out).toContain('任务#1');
      expect(queueText()).toContain('手上没有在做的事');
      expect(host.events.some((e) => e.text.includes('位置突然变了'))).toBe(false);
    } finally {
      await m.stop();
    }
  });
});

/**
 * world 日志记录官方死因，以及重生点变化的时刻和新旧值。
 */
describe('world 泳道:官方死因与重生点变更', () => {
  function liveBot(at: Pos) {
    const bot = Object.assign(new EventEmitter(), idleBot()) as EventEmitter & {
      entity: { position: Pos };
      game: { dimension: string };
      health: number;
      _client: EventEmitter;
    };
    bot.entity = { position: at };
    bot.game = { dimension: 'overworld' };
    bot.health = 0;
    bot._client = new EventEmitter();
    return bot;
  }

  async function hooked() {
    const rig = await started();
    const bot = liveBot(pos(10, 64, -3));
    const bridge = (rig.m as any).bridge;
    stub(rig.m, { bridge: { bot, connected: true, stop: () => bridge.stop() } });
    (rig.m as any).hookBotEvents(bot);
    return {
      ...rig, bot,
      lane: (event: string) => rig.m.logConsole().entries().filter((e) => e.event === event),
    };
  }

  it('自己的死因照旧不投递,但落进日志:归因不再只能靠死前的交火记录推', async () => {
    const { m, host, bot, lane } = await hooked();
    try {
      bot.emit(
        'message',
        { translate: 'death.attack.mob', toString: () => 'corti was slain by Zombie' },
        'system',
      );
      const [entry] = lane('death-cause');
      expect(entry.lane).toBe('world');
      expect(entry.msg).toBe('官方死因:corti was slain by Zombie');
      expect(entry.data).toMatchObject({ translate: 'death.attack.mob', health: 0 });
      // 只做日志:她那边的可观测面一个字都没变
      expect(host.events.some((e) => e.text.includes('slain'))).toBe(false);
    } finally {
      await m.stop();
    }
  });

  it('别人的死亡广播照旧投递,不进 world 泳道', async () => {
    const { m, host, bot, lane } = await hooked();
    try {
      bot.emit(
        'message',
        { translate: 'death.attack.mob', toString: () => 'Phant was slain by Skeleton' },
        'system',
      );
      expect(lane('death-cause')).toHaveLength(0);
      expect(host.events.some((e) => e.text.includes('Phant was slain by Skeleton'))).toBe(true);
    } finally {
      await m.stop();
    }
  });

  it('重生点变更记时刻与新旧值:躺床设点,床没了再清掉', async () => {
    const { m, bot, lane } = await hooked();
    try {
      bot.emit('message', { translate: SET_SPAWN_TRANSLATE, toString: () => 'set' }, 'game_info');
      bot.emit('spawnReset');
      const changes = lane('spawn-point');
      expect(changes).toHaveLength(2);
      expect(changes[0].msg).toContain('重生点 无 → (10, 64, -3) minecraft:overworld [bed]');
      expect(changes[0].data).toMatchObject({ from: `${SET_SPAWN_TRANSLATE} 系统消息` });
      expect(changes[1].msg).toContain('→ 无(来源:spawnReset 事件)');
    } finally {
      await m.stop();
    }
  });

  it('值没变就不记:同一张床上再睡一次不刷日志', async () => {
    const { m, bot, lane } = await hooked();
    try {
      bot.emit('sleep');
      bot.emit('sleep');
      expect(lane('spawn-point')).toHaveLength(1);
      expect(lane('spawn-point')[0].data).toMatchObject({ from: 'sleep 事件' });
    } finally {
      await m.stop();
    }
  });

  it('死亡那一刻把当前重生点一起记下:重生落在哪儿事后查得到', async () => {
    const { m, bot, lane } = await hooked();
    try {
      const cancel = vi.spyOn((m as any).executor, 'cancelForDeath');
      const record = vi.spyOn((m as any).deaths, 'record');
      bot.emit('sleep');
      bot.emit('death');
      expect(cancel).toHaveBeenCalledOnce();
      expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(record.mock.invocationCallOrder[0]);
      const [entry] = lane('death');
      expect(entry.msg).toContain('死亡点 [主世界] (10, 64, -3)');
      expect(entry.msg).toContain('当前重生点 [主世界] (10, 64, -3) [bed]');
      expect(entry.data).toMatchObject({
        position: { x: 10, y: 64, z: -3, dimension: 'minecraft:overworld' },
      });
    } finally {
      await m.stop();
    }
  });
});

/**
 * 死亡与重生点事件报告预计落点、距离和掉落保留时限；白天点床也可能更新重生点。
 */
describe('重生点与死亡:说清会落在哪儿、离多远、还剩多久', () => {
  function liveBot(at: Pos, worldSpawn: Pos | null) {
    const bot = new EventEmitter() as EventEmitter & {
      // id 是必需的:自己的死亡走专报,entityDead 要认得出「这是我」才不双记
      entity: { id: number; position: Pos };
      game: { dimension: string };
      spawnPoint: Pos | null;
      health: number;
      _client: EventEmitter;
    };
    bot.entity = { id: 17, position: at };
    bot.game = { dimension: 'overworld' };
    bot.spawnPoint = worldSpawn;
    bot.health = 0;
    bot._client = new EventEmitter();
    return bot;
  }

  async function hooked(at: Pos = pos(10, 64, -3), worldSpawn: Pos | null = pos(-1, 64, -7)) {
    const m = new MinecraftWorld({ cfg: cfg() });
    const host = new FakeHost();
    const bot = liveBot(at, worldSpawn);
    stub(m, { host, bridge: { bot, connected: true, stop: () => {} } });
    (m as any).hookBotEvents(bot);
    const idx = (frag: string) => host.events.findIndex((e) => e.text.includes(frag));
    return {
      m, host, bot,
      find: (frag: string) => host.events.find((e) => e.text.includes(frag))?.text ?? null,
      /** 那一条是唤醒的还是搭车的 */
      trigger: (frag: string) => host.pushOpts[idx(frag)]?.trigger ?? null,
      lane: (event: string) => m.logConsole().entries().filter((e) => e.event === event),
    };
  }

  it('重生点搬远了当场唤醒,并说清离原来那个多远', async () => {
    const { m, bot, find, trigger } = await hooked();
    try {
      bot.emit('message', { translate: SET_SPAWN_TRANSLATE, toString: () => 'set' }, 'game_info');
      expect(find('重生点设在 [主世界] (10, 64, -3) 了')).toContain('以前没有');
      // 2300 格外的那一张床:这一条不叫醒她,她就还按「家在原处」行事
      bot.entity.position = pos(2310, 64, -3);
      bot.emit('message', { translate: SET_SPAWN_TRANSLATE, toString: () => 'set' }, 'game_info');
      expect(find('重生点搬到 [主世界] (2310, 64, -3) 了')).toContain('离原来那个 2300 格');
      expect(trigger('重生点搬到')).toBe('flush');
    } finally {
      await m.stop();
    }
  });

  it('挪几格的重生点照报不打断:按紧急度分流,不是一律唤醒', async () => {
    const { m, bot, find, trigger } = await hooked();
    try {
      bot.emit('message', { translate: SET_SPAWN_TRANSLATE, toString: () => 'set' }, 'game_info');
      bot.entity.position = pos(14, 64, -3);
      bot.emit('message', { translate: SET_SPAWN_TRANSLATE, toString: () => 'set' }, 'game_info');
      expect(find('重生点搬到 [主世界] (14, 64, -3) 了')).toContain('离原来那个 4 格');
      expect(trigger('重生点搬到')).not.toBe('flush');
    } finally {
      await m.stop();
    }
  });

  it('重生点失效:带上世界出生点的坐标与距离,并且当场唤醒', async () => {
    const { m, bot, host, find, trigger } = await hooked(pos(2000, 64, 0));
    try {
      bot.emit('message', { translate: SET_SPAWN_TRANSLATE, toString: () => 'set' }, 'game_info');
      const before = host.events.length;
      bot.emit('spawnReset');
      const line = find('重生点失效了');
      expect(line).toContain('(-1, 64, -7)');
      expect(line).toContain('离你现在的位置 2001 格');
      expect(trigger('重生点失效了')).toBe('flush');
      // 失效只说一句:清重生点那一步不再自己也报一条
      expect(host.events.length - before).toBe(1);
    } finally {
      await m.stop();
    }
  });

  it('死亡回执三段:回哪儿、离死亡点多远、掉的东西还剩多久', async () => {
    const { m, bot, find } = await hooked();
    try {
      bot.emit('message', { translate: SET_SPAWN_TRANSLATE, toString: () => 'set' }, 'game_info');
      bot.entity.position = pos(110, 64, -3);
      bot.emit('death');
      const line = find('你死了');
      expect(line).toContain('死亡点在 [主世界] (110, 64, -3)');
      expect(line).toContain('会回重生点 [主世界] (10, 64, -3) 重生');
      expect(line).toContain('离死亡点 100 格');
      expect(line).toContain('5 分钟后消失');
      // 掉落保留期限到达后，不能继续断言物品还在原地。
      expect(line).not.toContain('还在原地');
    } finally {
      await m.stop();
    }
  });

  /**
   * 自身死亡已有专报，entityDead 不再为自身重复投递玩家死亡事件。
   */
  it('自己死亡只记一条:entityDead 不给自己再补一句「玩家死了」', async () => {
    const { m, bot, host } = await hooked();
    try {
      const before = host.events.length;
      bot.emit('entityDead', { id: bot.entity.id, name: 'player', position: bot.entity.position });
      const added = host.events.slice(before).map((e) => e.text);
      expect(added.some((t) => t.includes('死了('))).toBe(false);
      // 别人死了照旧报
      bot.emit('entityDead', { id: 999, name: 'zombie', position: pos(12, 64, -3) });
      expect(host.events.at(-1)?.text).toContain('僵尸死了');
    } finally {
      await m.stop();
    }
  });

  it('没有重生点时点名世界出生点,不再含糊地说「在出生点重生」', async () => {
    const { m, bot, find } = await hooked(pos(2000, 64, 0));
    try {
      bot.emit('death');
      const line = find('你死了');
      expect(line).toContain('没有重生点了,会回世界出生点 [主世界] (-1, 64, -7) 重生');
      expect(line).toContain('离死亡点 2001 格');
    } finally {
      await m.stop();
    }
  });

  it('掉落到期由系统自己收回那句承诺,不用她去猜', async () => {
    const { m, bot, find } = await hooked();
    vi.useFakeTimers();
    try {
      bot.entity.position = pos(110, 64, -3);
      bot.emit('death');
      expect(find('那堆掉落物')).toBeNull();
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 10);
      const line = find('那堆掉落物');
      expect(line).toContain('死亡点 [主世界] (110, 64, -3)');
      expect(line).toContain('到 5 分钟了,没捡的已经消失');
    } finally {
      await m.stop();
      vi.useRealTimers();
    }
  });

  it('预告落空时才再说一句,而且瞬移不再被渲染成走路', async () => {
    const { m, bot, find } = await hooked();
    vi.useFakeTimers();
    try {
      // 床已毁但 spawnReset 尚未到达，死亡预告可能仍用旧重生点；重生后三秒实测复核实际落点。
      bot.entity.position = pos(-425, 77, -2892);   // 家里那张床
      bot.emit('message', { translate: SET_SPAWN_TRANSLATE, toString: () => 'set' }, 'game_info');
      bot.entity.position = pos(1094, 62, -2693);   // 18:32 那次死在这儿
      bot.emit('death');
      expect(find('会回重生点 [主世界] (-425, 77, -2892) 重生')).not.toBeNull();
      // 重生前的位置基线停在死亡点:不重设的话世界摘要会报「往西走了 2900 多格」
      (m as any).lastReported = {
        position: { x: 1094, y: 62, z: -2693 }, dimension: 'overworld',
        biome: 'plains', inventory: [], invSynced: true, food: 20,
      };
      bot.entity.position = pos(-1, 64, -7);
      await vi.advanceTimersByTimeAsync(3_100);
      const line = find('重生了');
      expect(line).toContain('实际落在 [主世界] (-1, 64, -7)');
      expect(line).toContain('跟刚才说的那个重生点差 2916 格');
      expect(line).toContain('离死亡点 2901 格');
      expect((m as any).lastReported.position).toMatchObject({ x: -1, y: 64, z: -7 });
      // 只动 position 那一段:掉了什么、走进了什么群系照旧照实报
      expect((m as any).lastReported.biome).toBe('plains');
    } finally {
      await m.stop();
      vi.useRealTimers();
    }
  });

  it('预告准了就不再重复一遍:53 次死不能变成 53 条冗余', async () => {
    const { m, bot, find } = await hooked();
    vi.useFakeTimers();
    try {
      bot.entity.position = pos(2900, 64, -3);
      bot.emit('death');
      bot.entity.position = pos(-1, 64, -7);   // 正好落在预告的世界出生点
      await vi.advanceTimersByTimeAsync(3_100);
      expect(find('重生了')).toBeNull();
      // 不出声不等于不做事:位置基线照样重设
      expect((m as any).lastReported).toBeNull();
    } finally {
      await m.stop();
      vi.useRealTimers();
    }
  });

  it('死亡点与重生点不在同一维度时分别点名维度,不报坐标直线距离', async () => {
    const { m, bot, find } = await hooked(pos(8, 70, 4));
    try {
      bot.game.dimension = 'the_nether';
      (bot as any).findBlock = () => ({ name: 'respawn_anchor', position: pos(8, 70, 4) });
      bot.emit('message', { translate: SET_SPAWN_TRANSLATE, toString: () => 'set' }, 'game_info');

      bot.game.dimension = 'overworld';
      bot.entity.position = pos(8, 70, 4);
      bot.emit('death');
      const line = find('你死了');
      expect(line).toContain('死亡点在 [主世界] (8, 70, 4)');
      expect(line).toContain('会回重生点 [下界] (8, 70, 4) 重生');
      expect(line).toContain('与死亡点不在同一个维度,不计算直线距离');
      expect(line).not.toContain('离死亡点 0 格');
    } finally {
      await m.stop();
    }
  });

  it('人在下界时世界出生点仍标为主世界,不计算两边坐标距离', async () => {
    const { m, bot, find } = await hooked(pos(-1, 64, -7));
    try {
      bot.game.dimension = 'the_nether';
      bot.emit('death');
      const line = find('你死了');
      expect(line).toContain('死亡点在 [下界] (-1, 64, -7)');
      expect(line).toContain('世界出生点 [主世界] (-1, 64, -7)');
      expect(line).toContain('与死亡点不在同一个维度,不计算直线距离');
      expect(line).not.toContain('离死亡点 0 格');
    } finally {
      await m.stop();
    }
  });

  it('重生点记的是床的位置,不是她站在床边的位置', async () => {
    const { m, bot, lane } = await hooked();
    try {
      // 玩家在 (10,64,-3)，床在 (12,64,-3)；重生点须记录床坐标。
      (bot as any).findBlock = () => ({ position: pos(12, 64, -3) });
      bot.emit('message', { translate: SET_SPAWN_TRANSLATE, toString: () => 'set' }, 'game_info');
      expect(lane('spawn-point')[0].msg).toContain('→ (12, 64, -3)');
    } finally {
      await m.stop();
    }
  });
});

describe('世界摘要的唤醒口径', () => {
  /** worldDelta 只读这几处;reportWorldDelta 除了把快照转手给它,就只存一份基线 */
  function partial(over: Record<string, unknown>): unknown {
    return {
      position: { x: 0, y: 64, z: 0 },
      dimension: 'overworld',
      biome: 'plains',
      raining: false,
      invSynced: true,
      inventory: [],
      food: 20,
      ...over,
    };
  }

  function report(first: unknown, second: unknown): FakeHost {
    const m = new MinecraftWorld({ cfg: cfg() });
    const host = new FakeHost();
    let cur = first;
    stub(m, { host, snapshot: () => cur });
    const tick = (): void => (m as any).reportWorldDelta();
    tick(); // 第一次只立基线
    cur = second;
    tick();
    return host;
  }

  it('只有包里增减的摘要搭车走:采集途中每个窗口都在多几格土,叫醒她换不来一句话', () => {
    const host = report(
      partial({ inventory: [{ name: 'dirt', count: 3 }] }),
      partial({ inventory: [{ name: 'dirt', count: 9 }] }),
    );
    expect(host.events).toHaveLength(1);
    expect(host.events[0].text).toContain('包里多了 泥土×6');
    expect(host.pushOpts[0]?.trigger).toBe('piggyback');
  });

  it('同一条摘要里还有位移就照常攒批唤醒', () => {
    const host = report(
      partial({ inventory: [{ name: 'dirt', count: 3 }] }),
      partial({ position: { x: 200, y: 64, z: 0 }, inventory: [{ name: 'dirt', count: 9 }] }),
    );
    expect(host.events[0].text).toContain('走了');
    expect(host.pushOpts[0]?.trigger).toBe('debounce');
  });
});

describe('炉子到期与作物成熟:推事件,不给轮询入口', () => {
  it('expectedDoneAt 到点推一条 piggyback 估计事件,带取货 JSON;报过不再报', () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const host = new FakeHost();
    stub(m, { host });
    (m as any).chests.rememberFurnace('overworld', { x: 5, y: 64, z: 5 }, 'furnace',
      { input: { name: 'raw_iron', count: 8 }, fuel: { name: 'coal', count: 1 }, output: null },
      Date.now() - 90_000, Date.now() - 1_000);
    (m as any).furnaceTick();
    expect(host.events).toHaveLength(1);
    // 措辞是估计:服务端不同步没开窗的炉子槽位,读得到真值的只有取货那一刻
    expect(host.events[0].text).toContain('按每件烧炼耗时估算');
    expect(host.events[0].text).toContain('(5, 64, 5) 的熔炉');
    expect(host.events[0].text).toContain('粗铁×8');
    expect(host.events[0].text).toContain('以取出来的为准');
    expect(host.events[0].text).toContain('取货:{"skill":"take","at":[5,64,5],"all":true}');
    // 成文不唤醒:搭下一班车
    expect(host.pushOpts[0]?.trigger).toBe('piggyback');
    (m as any).furnaceTick();
    expect(host.events).toHaveLength(1);
  });

  it('作物只报观察到 age 到顶的;持续在视里不重复,离开视野再看到才再报', () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const host = new FakeHost();
    stub(m, { host });
    let ages: Record<string, number> = { '1,64,0': 7, '2,64,0': 5 };
    const bot = {
      registry: { blocksByName: { wheat: { id: 7 } } },
      findBlocks: ({ matching }: { matching: number[] }) =>
        (matching.includes(7)
          ? Object.keys(ages).map((k) => { const [x, y, z] = k.split(',').map(Number); return pos(x, y, z); })
          : []),
      // mineflayer.blockAt 要求 pos.floored()，夹具也保留此要求。
      blockAt: (p: Pos) => {
        const f = p.floored();
        return { name: 'wheat', getProperties: () => ({ age: ages[`${f.x},${f.y},${f.z}`] }) };
      },
    };
    (m as any).cropTick(bot);
    expect(host.events).toHaveLength(1);
    expect(host.events[0].text).toContain('小麦熟了(age 7/7)');
    expect(host.events[0].text).toContain('(1,64,0)');
    expect(host.events[0].text).not.toContain('(2,64,0)'); // age 5 的不报
    (m as any).cropTick(bot); // 还在视里且还熟着:不重复
    expect(host.events).toHaveLength(1);
    ages = { '2,64,0': 5 };
    (m as any).cropTick(bot); // 那格被收割了:什么都不报
    expect(host.events).toHaveLength(1);
    ages = { '1,64,0': 7, '2,64,0': 5 };
    (m as any).cropTick(bot); // 重新观察到:再报一次(新观察,不是倒计时)
    expect(host.events).toHaveLength(2);
  });
});

describe('World 自报的可清除存储', () => {
  it('箱子账本、死亡账本、探索账本、成果登记、常驻规矩、暂态表各一条,归在自己那一节(World 日志进运行日志,不再是存储项)', () => {
    const parts = new MinecraftWorld({ cfg: cfg() }).console().storage ?? [];
    expect(parts.map((p) => p.key))
      .toEqual([
        'minecraft-chests', 'minecraft-deaths', 'minecraft-explored', 'minecraft-works',
        'minecraft-policy', 'minecraft-blueprints',
        'minecraft-pwsr',
      ]);
    // 暂态本来就不落盘:它是内存的,清了只等于提前进下一场
    expect(parts.find((p) => p.key === 'minecraft-pwsr')?.kind).toBe('memory');
    for (const p of parts) {
      expect(p.stat()).toBeTruthy();
      expect(p.danger).toBeUndefined();
    }
  });

  it('探索账本落盘进环境提示词;清库连带抹掉摘要', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-explored-mod-'));
    try {
      mkdirSync(join(dir, 'diag'), { recursive: true });
      writeFileSync(
        join(dir, 'minecraft-explored.json'),
        JSON.stringify({
          version: 2,
          currentRealm: '',
          realms: {
            '': {
              'minecraft:overworld': { north: { distance: 460, biome: 'plains', at: 1 } },
              'minecraft:the_nether': { north: { distance: 45, biome: 'nether_wastes', at: 2 } },
            },
          },
        }),
        'utf8',
      );
      const m = new MinecraftWorld({ cfg: cfg(), dataDir: dir });
      expect((m.envPromptVars() as Record<string, string>)['minecraft.explored'])
        .toBe('探过:北460(平原);东北、东、东南、南、西南、西、西北没去过');
      const part = (m.console().storage ?? []).find((p) => p.key === 'minecraft-explored')!;
      expect(await part.clear()).toContain('已清空');
      expect((m.envPromptVars() as Record<string, string>)['minecraft.explored']).toBe('');
      expect(JSON.parse(readFileSync(join(dir, 'minecraft-explored.json'), 'utf8')))
        .toEqual({ version: 2, currentRealm: '', realms: {} });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * policy 持久化跨重启保留；环境提示词提供跨上下文窗口的设置状态，全默认时不添加内容。
   */
  it('mc_policy 落盘进环境提示词;全默认时那一格是空串,清库回默认', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-policy-mod-'));
    try {
      mkdirSync(join(dir, 'diag'), { recursive: true });
      const m = new MinecraftWorld({ cfg: cfg(), dataDir: dir });
      const vars = (): Record<string, string> => m.envPromptVars() as Record<string, string>;
      expect(vars()['minecraft.policy']).toBe('');
      const tools = Object.fromEntries(m.tools().map((t) => [t.name, t]));
      const ctx = { role: 'test', log: console as never };
      await tools.mc_policy.handler({ fight: 'off', reserve: ['iron_pickaxe'] }, ctx as never);
      expect(vars()['minecraft.policy'])
        .toBe('常驻规矩(与默认不同的几条):铁镐收着不主动拿;不主动动手,挨打照旧还手。');
      // 新实例读回五格:一次崩溃重启不会把她的干活规矩静默清回默认。fight 是例外——
      // 那一格重启回 auto(设 off 是当下那一刻的处置,过期要拿命赔)
      const again = new MinecraftWorld({ cfg: cfg(), dataDir: dir });
      expect((again.envPromptVars() as Record<string, string>)['minecraft.policy'])
        .toBe('常驻规矩(与默认不同的几条):铁镐收着不主动拿。');
      const part = (m.console().storage ?? []).find((p) => p.key === 'minecraft-policy')!;
      expect(await part.clear()).toContain('已清回默认');
      expect(vars()['minecraft.policy']).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mc_policy:规矩是设置,不是任务', () => {
  it('空调用只回读六格;念的是默认值,不出现第二人称', async () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const tools = Object.fromEntries(m.tools().map((t) => [t.name, t]));
    const ctx = { role: 'test', log: console as never };
    const text = await tools.mc_policy.handler({}, ctx as never) as string;
    // 查询与修改使用不同回执开头。
    expect(text).toBe(
      '念一遍(这次一格都没给,什么都没改)。'
      + '现在生效的规矩:垫一格用默认名单(泥土、圆石);插一根用默认名单(火把),'
      + '只在挖通道和挖空间的时候插;赶路遇坎按代价自选挖还是垫;没有收着不用的家伙什;'
      + '手上有趁手的家伙才主动动手,挨打照旧还手。',
    );
    for (const banned of ['你', '您']) expect(text).not.toContain(banned);
  });

  it('回执来自 set 之后的回读,不复述入参;没收下的那一格点破', async () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const tools = Object.fromEntries(m.tools().map((t) => [t.name, t]));
    const ctx = { role: 'test', log: console as never };
    const text = await tools.mc_policy.handler({ scaffold: ['dirt'], travel: 'mine' }, ctx as never) as string;
    expect(text).toContain('travel 写的 "mine",只认 auto/dig/place,没收下');
    expect(text).toContain('垫一格只用泥土');
    expect(text).toContain('赶路遇坎按代价自选挖还是垫');
  });

  it('默认名单跟着 worlds.minecraft.scaffoldBlocks 走,不是写死的字面量', async () => {
    const m = new MinecraftWorld({ cfg: cfg({ scaffoldBlocks: ['oak_planks'] }) });
    const tools = Object.fromEntries(m.tools().map((t) => [t.name, t]));
    const text = await tools.mc_policy.handler({}, { role: 'test', log: console as never } as never) as string;
    expect(text).toContain('垫一格用默认名单(橡木木板)');
    expect(text).not.toContain('圆石');
  });

  it('总开关关着时回执照实说 fight 这一格不起作用', async () => {
    const m = new MinecraftWorld({ cfg: cfg({ combat: { ...MINECRAFT_DEFAULTS.combat, enabled: false } }) });
    const tools = Object.fromEntries(m.tools().map((t) => [t.name, t]));
    const text = await tools.mc_policy.handler({ fight: 'off' }, { role: 'test', log: console as never } as never) as string;
    expect(text).toContain('战斗总开关在控制台关着,主动动手这一格现在不起作用');
  });

  /**
   * policy 修改立即影响当前任务，不进入 mc_do 队列，也不撤销排队任务。
   */
  it('调用不进队列:submit 一次都不走,所以撤不掉任何排着的活', async () => {
    const { m, call } = await started();
    try {
      const exec = (m as any).executor;
      let submits = 0;
      const real = exec.submit.bind(exec);
      exec.submit = (...a: unknown[]) => { submits++; return real(...a); };
      const text = await call('mc_policy', { travel: 'dig' });
      expect(text).toContain('赶路遇坎能挖就不垫');
      // 撤队列只发生在 submit 里(replace/now),不走 submit 就撤不着
      expect(submits).toBe(0);
      expect(text).not.toContain('任务#');
      await call('mc_do', { steps: [{ skill: 'eat', item: 'bread' }] });
      expect(submits).toBe(1);
    } finally {
      await m.stop();
    }
  });

  // 队列没起来也答得上:规矩不住在执行器里,这是"不排队"的另一面
  it('World 未启动时 mc_do 说未启动,mc_policy 照旧回读六格', async () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const tools = Object.fromEntries(m.tools().map((t) => [t.name, t]));
    const ctx = { role: 'test', log: console as never };
    expect(await tools.mc_do.handler({ steps: [{ skill: 'eat', item: 'bread' }] }, ctx as never)).toContain('未启动');
    expect(await tools.mc_policy.handler({ fight: 'off' }, ctx as never))
      .toContain('不主动动手,挨打照旧还手');
  });
});

describe('存档与玩法面板(服务器停着)', () => {
  /** 一份带 server.properties 与两个存档的服务器目录 */
  function serverDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mcworld-'));
    writeFileSync(join(dir, 'server.properties'), [
      '#Minecraft server properties',
      'gamemode=survival',
      'difficulty=easy',
      'level-name=world',
      'motd=A Minecraft Server',
    ].join('\n'), 'utf8');
    for (const name of ['world', 'old-world']) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, 'level.dat'), 'x');
    }
    return dir;
  }

  // 端口指向一个必定拒连的地方:面板的"跑着没"判据里有一次真实 TCP 探测,
  // 本机恰好开着 25565 的话这些用例会变成在测"服务器跑着"那一支
  const panelOn = (dir: string) => new MinecraftWorld({
    cfg: cfg({ port: 1, local: { ...MINECRAFT_DEFAULTS.local, serverDir: dir } }),
  }).worldConsole();

  const props = (dir: string): string => readFileSync(join(dir, 'server.properties'), 'utf8');

  it('没配目录时说清楚,不给一份假的存档表', async () => {
    const st = await new MinecraftWorld({ cfg: cfg({ port: 1 }) }).worldConsole().state();
    expect(st.configured).toBe(false);
    expect(st.detail).toContain('worlds.minecraft.local.serverDir');
    expect(st.worlds).toEqual([]);
  });

  it('读出当前设置与存档表', async () => {
    const dir = serverDir();
    const st = await panelOn(dir).state();
    expect(st.configured).toBe(true);
    expect(st.settings).toMatchObject({ gamemode: 'survival', difficulty: 'easy', levelName: 'world' });
    expect(st.worlds.map((w) => w.name)).toEqual(['old-world', 'world']);
  });

  it('换存档改的是 level-name,别的键一个不动', async () => {
    const dir = serverDir();
    const st = await panelOn(dir).select('old-world');
    expect(st.settings.levelName).toBe('old-world');
    expect(st.detail).toContain('下次启动');
    expect(props(dir)).toContain('level-name=old-world');
    expect(props(dir)).toContain('motd=A Minecraft Server');
  });

  it('存档名不合法当场退回,不写文件', async () => {
    const dir = serverDir();
    const st = await panelOn(dir).select('a/b');
    expect(st.detail).toContain('不能有');
    expect(props(dir)).toContain('level-name=world');
  });

  it('开新存档写 level-name 与种子;目录不在这一步生成', async () => {
    const dir = serverDir();
    const st = await panelOn(dir).create('新世界', { seed: '12345' });
    expect(st.settings.levelName).toBe('新世界');
    expect(st.settings.levelSeed).toBe('12345');
    expect(props(dir)).toContain('level-seed=12345');
    expect(existsSync(join(dir, '新世界'))).toBe(false); // 服务器启动时才生成
    expect(st.worlds.find((w) => w.name === '新世界')).toMatchObject({ generated: false });
  });

  it('开新存档把世界生成那几项一并写进去', async () => {
    const dir = serverDir();
    const flat = '{"layers":[{"block":"minecraft:bedrock","height":1}],"biome":"minecraft:plains"}';
    const st = await panelOn(dir).create('平坦世界', {
      levelType: 'minecraft:flat',
      generatorSettings: flat,
      generateStructures: false,
    });
    expect(st.settings).toMatchObject({
      levelType: 'minecraft:flat', generatorSettings: flat, generateStructures: false,
    });
    expect(props(dir)).toContain('level-type=minecraft:flat');
    expect(props(dir)).toContain('generate-structures=false');
    expect(st.detail).toContain('超平坦');
  });

  it('生成器细则不是合法 JSON 对象就退回,一个字都不写', async () => {
    const dir = serverDir();
    const st = await panelOn(dir).create('坏世界', {
      levelType: 'minecraft:flat', generatorSettings: '{层不对',
    });
    expect(st.detail).toContain('不是合法 JSON');
    expect(st.settings.levelName).toBe('world');
    expect(props(dir)).not.toContain('level-name=坏世界');
  });

  it('新存档名撞上已有目录时拦下来,提示直接选那个', async () => {
    const dir = serverDir();
    const st = await panelOn(dir).create('old-world', {});
    expect(st.detail).toContain('已经存在');
    expect(st.settings.levelName).toBe('world');
  });

  it('停机时玩法项全都写进文件', async () => {
    const dir = serverDir();
    const st = await panelOn(dir).apply({ difficulty: 'hard', gamemode: 'creative', hardcore: true });
    expect(st.settings).toMatchObject({ difficulty: 'hard', gamemode: 'creative', hardcore: true });
    expect(st.detail).toContain('下次启动生效');
    expect(props(dir)).toContain('difficulty=hard');
    expect(props(dir)).toContain('hardcore=true');
  });
});

describe('权限与作弊面板(服务器停着)', () => {
  function serverDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mcaccess-'));
    writeFileSync(join(dir, 'server.properties'), [
      '#Minecraft server properties',
      'online-mode=false',
      'motd=A Minecraft Server',
    ].join('\n'), 'utf8');
    return dir;
  }

  // 与存档面板同一个理由:port=1 让"跑着没"那次真实探测必定拒连
  const rig = (dir: string) => new MinecraftWorld({
    cfg: cfg({
      port: 1,
      username: 'CortiV',
      local: { ...MINECRAFT_DEFAULTS.local, serverDir: dir, serverEnabled: true },
      client: { ...MINECRAFT_DEFAULTS.client, username: 'CortiCam' },
      player: { ...MINECRAFT_DEFAULTS.player, username: 'Phant' },
    }),
  });

  const ops = (dir: string): Array<{ name: string; level: number }> =>
    JSON.parse(readFileSync(join(dir, 'ops.json'), 'utf8'));

  it('三个身份都摆出来;一个都没授权时如实说没有', async () => {
    const st = await rig(serverDir()).accessConsole().state();
    expect(st.members.map((m) => [m.name, m.role, m.op]))
      .toEqual([['CortiV', 'bot', false], ['CortiCam', 'camera', false], ['Phant', 'player', false]]);
    expect(st.autoOp).toBe(true);
    expect(st.settings.onlineMode).toBe(false);
  });

  it('授权写进 ops.json,再读回来就是"有 4 级"', async () => {
    const dir = serverDir();
    const panel = rig(dir).accessConsole();
    const st = await panel.setOp('CortiV', true);
    expect(st.detail).toContain('下次启动生效');
    expect(st.members[0]).toMatchObject({ name: 'CortiV', op: true, level: 4 });
    expect(ops(dir)).toEqual([expect.objectContaining({ name: 'CortiV', level: 4 })]);
    // 收回就把那条删掉,别人不受影响
    await panel.setOp('朋友', true);
    const back = await panel.setOp('CortiV', false);
    expect(back.members.find((m) => m.name === 'CortiV')!.op).toBe(false);
    expect(ops(dir).map((e) => e.name)).toEqual(['朋友']);
  });

  it('名单里别人的名字也摆出来,否则收回权限得去翻文件', async () => {
    const dir = serverDir();
    const panel = rig(dir).accessConsole();
    await panel.setOp('朋友', true);
    const st = await panel.state();
    expect(st.members.map((m) => m.role)).toEqual(['bot', 'camera', 'player', 'other']);
    expect(st.members[3]).toMatchObject({ name: '朋友', op: true });
  });

  it('空名字与带空格的名字退回,不写文件', async () => {
    const dir = serverDir();
    const panel = rig(dir).accessConsole();
    expect((await panel.setOp('   ', true)).detail).toContain('名字');
    expect((await panel.setOp('两 个词', true)).detail).toContain('空格');
    expect(existsSync(join(dir, 'ops.json'))).toBe(false);
  });

  it('权限项写进 server.properties,别的键一个不动', async () => {
    const dir = serverDir();
    const st = await rig(dir).accessConsole().apply({
      opPermissionLevel: 4, enableCommandBlock: true, allowFlight: true,
      onlineMode: false, whiteList: false,
    });
    expect(st.settings).toMatchObject({ opPermissionLevel: 4, enableCommandBlock: true });
    const text = readFileSync(join(dir, 'server.properties'), 'utf8');
    expect(text).toContain('enable-command-block=true');
    expect(text).toContain('motd=A Minecraft Server');
  });

  it('启动服务器前把三个名字补进名单;关掉自动授权就一个字都不写', async () => {
    const dir = serverDir();
    await rig(dir).serverConsole().start();
    expect(ops(dir).map((e) => e.name)).toEqual(['CortiV', 'CortiCam', 'Phant']);

    const off = mkdtempSync(join(tmpdir(), 'mcaccess-'));
    const m = new MinecraftWorld({
      cfg: cfg({
        port: 1,
        local: {
          ...MINECRAFT_DEFAULTS.local,
          serverDir: off,
          serverEnabled: true,
          cheats: false,
        },
      }),
    });
    await m.serverConsole().start();
    expect(existsSync(join(off, 'ops.json'))).toBe(false);
  });

  it('没配服务器目录时说清楚,不假装写成功了', async () => {
    const panel = new MinecraftWorld({ cfg: cfg({ port: 1 }) }).accessConsole();
    expect((await panel.state()).detail).toContain('worlds.minecraft.local.serverDir');
    expect((await panel.setOp('CortiV', true)).detail).toContain('改不了');
    expect((await panel.apply({ whiteList: true })).detail).toContain('改不了');
  });
});

describe('世界身份对账(noteWorldSwitch)', () => {
  function rig() {
    const dir = mkdtempSync(join(tmpdir(), 'mc-world-'));
    const m = new MinecraftWorld({ cfg: cfg(), dataDir: dir });
    const host = new FakeHost();
    stub(m, { host });
    const note = () => (m as any).noteWorldSwitch();
    return { dir, host, note, file: join(dir, 'minecraft-world.json') };
  }

  it('首次进服只落盘不出声;世界没变不重复', () => {
    const { dir, host, note, file } = rig();
    try {
      note();
      expect(host.events).toHaveLength(0);
      const c = cfg();
      // 没配 serverDir:世界身份退回服务器地址
      expect((JSON.parse(readFileSync(file, 'utf8')) as { world: string }).world).toBe(`${c.host}:${c.port}`);
      note();
      expect(host.events).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('世界换了:投一条事件点明新旧,并更新落盘', () => {
    const { dir, host, note, file } = rig();
    try {
      writeFileSync(file, `${JSON.stringify({ world: '旧大陆' })}\n`, 'utf8');
      note();
      expect(host.events).toHaveLength(1);
      expect(host.events[0].text).toContain('世界换了');
      expect(host.events[0].text).toContain('旧大陆');
      expect((JSON.parse(readFileSync(file, 'utf8')) as { world: string }).world).not.toBe('旧大陆');
      note();
      expect(host.events).toHaveLength(1); // 对上了就不再吵
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * 死亡次数由系统计数并在回执中报告。
 */
describe('死亡计数:系统自己数,并且让她看见', () => {
  function liveBot(): EventEmitter & { entity: { position: Pos }; game: { dimension: string }; spawnPoint: Pos | null; health: number } {
    const bot = new EventEmitter() as EventEmitter & {
      entity: { position: Pos };
      game: { dimension: string };
      spawnPoint: Pos | null;
      health: number;
      _client: EventEmitter;
    };
    bot.entity = { position: pos(10, 64, -3) };
    bot.game = { dimension: 'overworld' };
    bot.spawnPoint = pos(-1, 64, -7);
    bot.health = 0;
    bot._client = new EventEmitter();
    return bot;
  }

  async function hooked() {
    const m = new MinecraftWorld({ cfg: cfg() });
    const host = new FakeHost();
    const bot = liveBot();
    stub(m, { host, bridge: { bot, connected: true, stop: () => {} } });
    (m as any).hookBotEvents(bot);
    return {
      m, host, bot,
      deathLines: () => host.events.filter((e) => e.text.includes('你死了')).map((e) => e.text),
    };
  }

  it('死亡回执报今天第几次,逐次递增', async () => {
    const { m, bot, deathLines } = await hooked();
    try {
      bot.emit('death');
      bot.emit('death');
      bot.emit('death');
      expect(deathLines().map((l) => /今天第 (\d+) 次/.exec(l)?.[1])).toEqual(['1', '2', '3']);
    } finally {
      await m.stop();
    }
  });
});



describe('摄像机:崩溃告警与跨维度跟机位', () => {
  function camBot() {
    const bot = new EventEmitter() as EventEmitter & { game: { dimension: string }; _client: EventEmitter };
    bot.game = { dimension: 'overworld' };
    bot._client = new EventEmitter();
    return bot;
  }

  it('她换维度就立刻重下附身,且带上传送——不等 30 秒周期', async () => {
    const { m } = await started();
    const bot = camBot();
    try {
      const calls: Array<{ reason: string; opts: unknown }> = [];
      stub(m, { syncSpectator: (reason: string, opts: unknown) => calls.push({ reason, opts }) });
      (m as any).hookBotEvents(bot);

      bot.emit('game'); // 维度没变:不该动机位
      expect(calls).toHaveLength(0);

      bot.game.dimension = 'the_nether';
      bot.emit('game');
      expect(calls).toHaveLength(1);
      expect(calls[0].reason).toContain('维度变了');
      expect(calls[0].opts).toEqual({ teleportFirst: true });
    } finally {
      await m.stop();
    }
  });

  it('穿门那一刻服务端还在搬运,3 秒后补一次;期间又换了维度就交给新的那次', () => {
    vi.useFakeTimers();
    try {
      const m = new MinecraftWorld({ cfg: cfg() });
      const calls: string[] = [];
      stub(m, { syncSpectator: (reason: string) => calls.push(reason) });
      const mm = m as any;

      mm.lastDimension = 'the_nether';
      mm.resyncSpectatorForDimension('the_nether');
      expect(calls).toHaveLength(1);
      vi.advanceTimersByTime(3_000);
      expect(calls).toHaveLength(2);

      calls.length = 0;
      mm.resyncSpectatorForDimension('the_nether');
      mm.lastDimension = 'overworld'; // 又穿回主世界了
      vi.advanceTimersByTime(3_000);
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('附身指令里传送夹在脱离与附身之间:顺序错了 SpectatorPlus 的全量快照就没了', () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const sent: string[] = [];
    stub(m, {
      client: { running: true },
      mcServer: { command: (c: string) => { sent.push(c); return true; } },
    });
    (m as any).syncSpectator('维度变了(下界)', { teleportFirst: true });
    expect(sent).toEqual([
      'op CortiCam',
      'gamemode spectator CortiCam',
      'execute as CortiCam run spectate',
      'tp CortiCam corti',
      'spectate corti CortiCam',
    ]);

    sent.length = 0;
    (m as any).syncSpectator('周期重下');
    expect(sent).not.toContain('tp CortiCam corti'); // 平时那一路一个字都不变
  });

  it('摄像机崩了要投进她的上下文:第几次、多久重启,超上限就直说没人管画面就黑着', async () => {
    const { m, host } = await started();
    try {
      const mm = m as any;
      mm.onCameraCrash({ detail: '客户端退出 code=3221225477(0xC0000005)', attempt: 1, max: 3, delayMs: 30_000 });
      expect(host.events.at(-1)?.text).toContain('观察者摄像机崩了(第 1 次)');
      expect(host.events.at(-1)?.text).toContain('30 秒后自动重启');

      mm.onCameraCrash({ detail: '客户端退出 code=3221225477(0xC0000005)', attempt: 0, max: 3, delayMs: 0 });
      expect(host.events.at(-1)?.text).toContain('重启 3 次都没活');
      expect(host.events.at(-1)?.text).toContain('需要人来看');
    } finally {
      await m.stop();
    }
  });

  it('解除只在崩过之后、且附身核过一次才投,同一次故障只投一条', () => {
    vi.useFakeTimers();
    try {
      const m = new MinecraftWorld({ cfg: cfg() });
      const host = new FakeHost();
      stub(m, {
        host,
        client: { running: true },
        bridge: { bot: { players: { CortiCam: { gamemode: 3 } } } },
      });
      const mm = m as any;
      const recovered = () => host.events.filter((e) => e.text.includes('画面恢复')).length;

      mm.scheduleSpectateCheck(); // 没崩过:核过也不吭声
      vi.advanceTimersByTime(5_000);
      expect(recovered()).toBe(0);

      mm.cameraDown = true;
      mm.scheduleSpectateCheck();
      vi.advanceTimersByTime(5_000);
      expect(recovered()).toBe(1);

      mm.scheduleSpectateCheck();
      vi.advanceTimersByTime(5_000);
      expect(recovered()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('worlds-minecraft 工具 tag', () => {
  const tagOf = (name: string) => MINECRAFT_TOOL_DECLS.find((t) => t.name === name)!.tags;

  it('改世界的动作是 act,不是 speak——否则"禁言"会连挖矿一起禁掉', () => {
    expect(tagOf('mc_do')).toEqual(['act']);
    expect(tagOf('mc_stop')).toEqual(['act']);
    expect(tagOf('mc_escape')).toEqual(['act']);
  });

  it('只读查询仍是 read,常设策略仍是 write', () => {
    expect(tagOf('mc_scout')).toEqual(['read']);
    expect(tagOf('mc_policy')).toEqual(['write']);
  });

  it('mc World 不产出她的话:没有一个工具带 speak', () => {
    expect(MINECRAFT_TOOL_DECLS.filter((t) => t.tags.includes('speak'))).toEqual([]);
  });
});

/**
 * 世界快照按变化量发送。
 */
describe('世界快照跳拍闸', () => {
  function snapRig() {
    const m = new MinecraftWorld({ cfg: cfg() });
    const deferred: Array<{ render: () => string | null | Promise<string | null> }> = [];
    const bot = idleBot() as {
      entity: { position: { x: number; y: number; z: number } };
      health: number;
    };
    stub(m, {
      host: {
        pushDeferred: (e: { render: () => string | null | Promise<string | null> }) => deferred.push(e),
        log: console,
      },
      bridge: { connected: true, bot, invSynced: true },
    });
    const arm = (): void => {
      (m as any).lastSnapshotRenderAt = Date.now() - 60_000;
      (m as any).armSnapshot(Date.now());
    };
    const agePastAnchor = (): void => {
      (m as any).lastSnapshotFullAt = Date.now() - (cfg().world.snapshotAnchorSec + 60) * 1000;
    };
    const tick = (): string | null => {
      arm();
      return deferred[deferred.length - 1].render() as string | null;
    };
    return { m, bot, tick, agePastAnchor };
  }

  it('原地不动、读数没变:这一拍整条不发', () => {
    const { bot, tick } = snapRig();
    expect(tick()).toContain('[Minecraft]'); // 首份是全量锚
    // 挪不到阈值那么远(采矿、合成、钓鱼都在这条线内):不值得单独占一条事件
    bot.entity.position.x = 2.5;
    expect(tick()).toBeNull();
    bot.entity.position.x = 3.4;
    expect(tick()).toBeNull();
  });

  it('真挪窝就发', () => {
    const { bot, tick } = snapRig();
    tick();
    bot.entity.position.x = 20.5;
    const moved = tick();
    expect(moved).toContain('站在格 (20,');
  });

  it('血掉了就发,哪怕一步没挪', () => {
    const { bot, tick } = snapRig();
    tick();
    bot.entity.position.x = 1.5;
    expect(tick()).toBeNull();
    bot.health = 11;
    const hurt = tick();
    expect(hurt).toContain('生命 11/20');
  });

  it('全量锚那一拍不受这道闸管:漂移由它兜住', () => {
    const { tick, agePastAnchor } = snapRig();
    tick();
    expect(tick()).toBeNull();
    agePastAnchor();
    const anchor = tick();
    expect(anchor).toContain('生命');
  });
});

describe('mc_policy 回执带 diff 与持久性', () => {
  const tools = (m: MinecraftWorld) => Object.fromEntries(m.tools().map((t) => [t.name, t]));
  const ctx = { role: 'test', log: console as never };

  it('修改:点名改了哪一格、其余几条没动,并说明 fight 不跨重启', async () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const text = await tools(m).mc_policy.handler({ fight: 'off' }, ctx as never) as string;
    expect(text).toContain('这次改了 fight:armed→off;其余 5 条没动。');
    expect(text).toContain('fight 这一格不跨重启,重启会弹回 armed');
  });

  it('重复设同一档:说清一格都没变,不再与生效那一次逐字相同', async () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const t = tools(m);
    const first = await t.mc_policy.handler({ fight: 'off' }, ctx as never) as string;
    const again = await t.mc_policy.handler({ fight: 'off' }, ctx as never) as string;
    expect(again).not.toBe(first);
    expect(again).toContain('一格都没变:fight 给的值与现在生效的一模一样(fight:off)');
  });

  it('名单那一格的 diff 报得出「默认 → 她指定的那几样」', async () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const text = await tools(m).mc_policy.handler({ scaffold: ['dirt'] }, ctx as never) as string;
    expect(text).toContain('这次改了 scaffold:默认→[dirt]');
    expect(text).not.toContain('不跨重启'); // 这一格是落盘的,不该借 fight 的话来说
  });
});

describe('cancelled 终态进事件流但不唤醒', () => {
  it('三条路都刚给过同步回执,再唤醒一次就是多买一个 LLM 往返', async () => {
    const { m, host } = await started();
    try {
      const report = (r: unknown): void => (m as any).onTaskReport(r);
      report({ kind: 'cancelled', text: '任务#1没做完:做到第 1/2 步,被mc_stop 叫停。', taskId: 1 });
      const cancelled = host.events.at(-1)!;
      expect(cancelled.text).toContain('任务#1没做完');
      expect(host.pushOpts.at(-1)?.trigger).toBe('debounce');
      report({ kind: 'blocked', text: '任务#2:没做成。', taskId: 2 });
      expect(host.pushOpts.at(-1)?.trigger).toBe('flush');
    } finally {
      await m.stop();
    }
  });
});

describe('睡床等醒的进度文案', () => {
  it('等醒期间说的是「正在床上睡觉」,不是「挪了 0 格」', async () => {
    const { m, host } = await started();
    try {
      const opts = (m as any).executor.opts as {
        onProgress: (p: Record<string, unknown>) => void;
      };
      const base = {
        taskId: 7, label: '空手右键 (1,64,1)', stepIndex: 0, stepCount: 1,
        step: '空手右键 (1,64,1)', elapsedS: 30, pos: { x: 1, y: 64, z: 1 },
        movedBlocks: 0, count: null, half: false,
      };
      opts.onProgress({ ...base, sleeping: true });
      const sleeping = host.events.at(-1)!.text;
      expect(sleeping).toContain('正在床上睡觉,等天亮醒过来');
      expect(sleeping).not.toContain('挪了 0 格');
      opts.onProgress({ ...base });
      expect(host.events.at(-1)!.text).toContain('挪了 0 格');
    } finally {
      await m.stop();
    }
  });
});

// 暂态状态与 mc_goal

function fakeGoal(slot: number, text: string, over: Partial<MinecraftGoal> = {}): MinecraftGoal {
  const plan = parseGoalPlan([{ do: '验收', judgment: '现场确认目标完成' }]);
  if ('error' in plan) throw new Error(plan.error);
  return {
    slot, text, plan, blueprint: null, day: 6,
    realTime: '2026-08-24T20:14:00+08:00', at: Date.now(), ...over,
  };
}

describe('PWSR 骨架:realm 命名空间', () => {
  it('换命名空间:旧数据留在旧空间不删,切回去原样还在', () => {
    const t = new PwsrTables();
    const goals = t.register(GOAL_TABLE_DECL);
    t.switchTo('世界甲');
    goals().list.push(fakeGoal(1, '盖新家'));
    // 换世界:公告拿到「下桌」清单,新空间是干净的
    expect(t.switchTo('世界乙')).toEqual(['1 条目标']);
    expect(goals().list).toEqual([]);
    goals().list.push(fakeGoal(1, '挖铁'));
    // 切回旧存档:那一条原样还在(命名空间保留式失效,不是删)
    expect(t.switchTo('世界甲')).toEqual(['1 条目标']);
    expect(goals().list.map((g) => g.text)).toEqual(['盖新家']);
    // 而新世界那条永远漏不进这边
    expect(goals().list.map((g) => g.text)).not.toContain('挖铁');
  });

  it('同一个键再切:什么都没发生,不产生假公告;空表也不进公告', () => {
    const t = new PwsrTables();
    const goals = t.register(GOAL_TABLE_DECL);
    t.switchTo('世界甲');
    expect(t.switchTo('世界甲')).toEqual([]);
    expect(t.switchTo('世界乙')).toEqual([]); // 旧空间本来就空
    goals().list.push(fakeGoal(1, '盖新家'));
    expect(t.switchTo('世界丙')).toEqual(['1 条目标']);
  });

  it('现状一行:全空才附那句指路;有东西时只列清单,不催她做什么', () => {
    const t = new PwsrTables();
    const goals = t.register(GOAL_TABLE_DECL);
    const empty = t.statusLine()!;
    expect(empty).toContain('暂态:目标 0 条');
    expect(empty).toContain('从你的笔记里读回来重新登记');
    expect(empty).toContain('mc_goal');
    goals().list.push(fakeGoal(1, '盖新家'));
    const filled = t.statusLine()!;
    expect(filled).toContain('暂态:目标 1 条');
    expect(filled).toContain('#1 盖新家');
    expect(filled).not.toContain('从你的笔记里读回来'); // 有东西时不指路
  });

  it('控制台存储项:规模一行点出旧命名空间还留着几个;清空是全清', () => {
    const t = new PwsrTables();
    const goals = t.register(GOAL_TABLE_DECL);
    t.switchTo('世界甲');
    goals().list.push(fakeGoal(1, '盖新家'));
    t.switchTo('世界乙');
    expect(t.stat()).toContain('目标 0 条');
    expect(t.stat()).toContain('另有 1 个旧世界的命名空间留着');
    expect(t.clear()).toContain('2 个世界命名空间');
    t.switchTo('世界甲');
    expect(goals().list).toEqual([]); // 一键清空连旧世界那份一起没
  });
});

describe('realm 键的构成(强身份 / 弱身份)', () => {
  /** 一份带 server.properties 与一个存档目录的服务器目录 */
  function serverDirWith(level: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'mc-realm-'));
    writeFileSync(join(dir, 'server.properties'), `level-name=${level}\n`, 'utf8');
    mkdirSync(join(dir, level), { recursive: true });
    writeFileSync(join(dir, level, 'level.dat'), 'x');
    return dir;
  }

  it('没有受管世界:弱身份 = host:port + 存档名(这里没有存档名,那一半是空的)', () => {
    const c = cfg({ port: 1 });
    const m = new MinecraftWorld({ cfg: c });
    expect((m as any).realmKey()).toBe(`weak:${c.host}:1|`);
  });

  it('受管世界:强身份走 marker 的 uuid;同名新档是新身份', () => {
    const dir = serverDirWith('world');
    try {
      const c = cfg({ port: 1, local: { ...MINECRAFT_DEFAULTS.local, serverDir: dir } });
      const m = new MinecraftWorld({ cfg: c });
      const key = () => (m as any).realmKey() as string;
      const first = key();
      expect(first.startsWith('uuid:')).toBe(true);
      expect(existsSync(join(dir, 'world', 'cortico-realm.json'))).toBe(true);
      expect(key()).toBe(first); // 幂等:再查一次还是同一个世界
      // 存档删掉重开(同名新世界):marker 没了,发新 uuid,于是命名空间也换了
      rmSync(join(dir, 'world'), { recursive: true, force: true });
      expect(key()).not.toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('配的目录根本不在(盘没挂上/配错了):退回弱身份,不拿一个假 uuid 把世界并成一个', () => {
    const c = cfg({
      port: 1,
      local: { ...MINECRAFT_DEFAULTS.local, serverDir: join(tmpdir(), '这个目录不存在-mc-realm') },
    });
    const m = new MinecraftWorld({ cfg: c });
    expect((m as any).realmKey()).toBe(`weak:${c.host}:1|`);
  });
});

describe('世界切换公告带暂态清单', () => {
  function rig() {
    const dir = mkdtempSync(join(tmpdir(), 'mc-pwsr-switch-'));
    const m = new MinecraftWorld({ cfg: cfg({ port: 1 }), dataDir: dir });
    const host = new FakeHost();
    stub(m, { host });
    return {
      dir, host, m,
      goal: (args: Record<string, unknown>) => (m as any).setGoal(args) as string,
      sync: () => (m as any).syncRealm(),
      note: () => (m as any).noteWorldSwitch(),
      file: join(dir, 'minecraft-world.json'),
    };
  }

  it('换世界:公告如实说清了什么;旧世界那几条留在旧命名空间,切回去还在', () => {
    const { dir, host, m, goal, sync, note, file } = rig();
    try {
      writeFileSync(file, `${JSON.stringify({ world: '旧大陆' })}\n`, 'utf8');
      goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: '盖新家' } });
      goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: '攒一组铁' } });
      (m as any).cfg.port = 25566; // 换了台服务器 = 换了 realm
      sync();
      note();
      expect(host.events).toHaveLength(1);
      expect(host.events[0].text).toContain('世界换了');
      expect(host.events[0].text).toContain('暂态已清:2 条目标随旧世界下桌');
      // 新世界这边是干净的
      expect(goal({})).toContain('一条目标都没有');
      // 切回旧世界:那两条原样还在(保留而非删)
      (m as any).cfg.port = 1;
      expect(goal({})).toContain('盖新家');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('存档名没变而世界是新的(同名新档):清单照样单独说一句,不静默清', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-pwsr-same-name-'));
    const data = mkdtempSync(join(tmpdir(), 'mc-pwsr-data-'));
    try {
      writeFileSync(join(dir, 'server.properties'), 'level-name=world\n', 'utf8');
      mkdirSync(join(dir, 'world'), { recursive: true });
      writeFileSync(join(dir, 'world', 'level.dat'), 'x');
      const m = new MinecraftWorld({
        cfg: cfg({ port: 1, local: { ...MINECRAFT_DEFAULTS.local, serverDir: dir } }),
        dataDir: data,
      });
      const host = new FakeHost();
      stub(m, { host });
      const goal = (args: Record<string, unknown>) => (m as any).setGoal(args) as string;
      const sync = () => (m as any).syncRealm();
      const note = () => (m as any).noteWorldSwitch();
      sync();
      note(); // 首次进服:只落盘不出声
      expect(host.events).toHaveLength(0);
      goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: '盖新家' } });
      // 存档删掉重开:存档名还叫 world,worldFile 对得上,但它已经是另一个世界
      rmSync(join(dir, 'world'), { recursive: true, force: true });
      sync();
      note();
      expect(host.events).toHaveLength(1);
      expect(host.events[0].text).not.toContain('世界换了'); // 名字确实没变,不编一句
      expect(host.events[0].text).toContain('暂态已清:1 条目标随旧世界下桌');
      expect(goal({})).toContain('一条目标都没有');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    }
  });
});

describe('mc_goal:目标操作与 diff 回执', () => {
  /** World 不必启动:目标是她投影进来的语义,连不连得上服务器都成立 */
  function rig(day: number | null = 6) {
    const m = new MinecraftWorld({ cfg: cfg({ port: 1 }) });
    if (day !== null) stub(m, { bridge: { bot: { time: { day } } } });
    const tools = Object.fromEntries(m.tools().map((t) => [t.name, t]));
    const ctx = { role: 'test', log: console as never } as never;
    return {
      m,
      goal: (args: Record<string, unknown> = {}) => tools.mc_goal.handler(args, ctx) as Promise<string>,
    };
  }

  it('add:落在最小的空格上,回执只说这一次发生了什么', async () => {
    const { goal } = rig();
    const first = await goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: '盖新家' } });
    expect(first).toContain('这次挂上 #1 盖新家');
    expect(first).toContain('别的没有了');
    const second = await goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: '攒一组铁' } });
    expect(second).toContain('这次挂上 #2 攒一组铁');
    expect(second).toContain('其余 1 条没动'); // diff 式:不全量复述
    expect(second).not.toContain('盖新家');
  });

  it('查询列全,每条带登记时长;蓝图字段现在只存字符串', async () => {
    const { goal } = rig();
    await goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: '盖新家', blueprint: 'home-v2' } });
    await goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: '攒一组铁' } });
    const all = await goal();
    expect(all).toContain('挂着 2 条(共 5 格)');
    expect(all).toContain('#1 盖新家[里程碑:0/1;下一步:验收](蓝图 home-v2:待装载)');
    expect(all).toContain('#2 攒一组铁');
    expect(all).toContain('从现实 '); // 登记时刻的主口径;游戏内天数只是括注
    expect(all).toContain('挂上那会儿游戏里是第 6 天');
    expect(all).toContain('挂到现在');
  });

  it('done 与 drop 分开说:干完了和不干了不是一件事', async () => {
    const { goal } = rig();
    await goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: '盖新家' } });
    await goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: '攒一组铁' } });
    await goal({ milestone: { slot: 1, step: 1, judgment: '现场确认目标完成' } });
    const done = await goal({ done: 1 });
    expect(done).toContain('#1 盖新家[里程碑:1/1] 完成了');
    expect(done).toContain('从现实 ');
    expect(done).toContain('其余 1 条没动');
    const drop = await goal({ drop: 2 });
    expect(drop).toContain('#2 攒一组铁[里程碑:0/1;下一步:验收] 撤了(不是干完,是不干了)');
    expect(drop).toContain('别的没有了');
  });

  it('腾出来的号会被下一次 add 补上', async () => {
    const { goal } = rig();
    await goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: 'A' } });
    await goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: 'B' } });
    await goal({ milestone: { slot: 1, step: 1, judgment: '现场确认目标完成' } });
    await goal({ done: 1 });
    expect(await goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: 'C' } })).toContain('这次挂上 #1 C');
  });

  it('judgment 完成计划后可 reopen,重开期间 done 不移除目标', async () => {
    const { goal } = rig();
    await goal({ add: { text: '盖新家', plan: [{ do: '验收', judgment: '现场确认目标完成' }] } });
    await goal({ done: 1 });
    expect(await goal()).toContain('#1 盖新家[里程碑:0/1;下一步:验收]');
    await goal({ milestone: { slot: 1, step: 1, judgment: '现场确认目标完成' } });
    expect(await goal()).toContain('#1 盖新家[里程碑:1/1]');
    await goal({ reopen: { slot: 1, step: 1, reason: '现场改动后重新验收' } });
    await goal({ done: 1 });
    expect(await goal()).toContain('#1 盖新家[里程碑:0/1;下一步:验收]');
    await goal({ milestone: { slot: 1, step: 1, judgment: '改动后现场再次验收完成' } });
    expect(await goal({ done: 1 })).toContain('#1 盖新家[里程碑:1/1] 完成了');
    expect(await goal()).not.toContain('盖新家');
  });

  it('五格满了:这一条没挂上,如实说,并把现在挂着的列给她', async () => {
    const { goal } = rig();
    for (const n of [1, 2, 3, 4, 5]) await goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: `目标${n}` } });
    const full = await goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: '第六条' } });
    expect(full).toContain('5 格全占着,这条没挂上');
    expect(full).toContain('挂着 5 条');
    expect(await goal()).not.toContain('第六条');
  });

  it('空格上 done/drop:什么都没动,不假装受理', async () => {
    const { goal } = rig();
    await goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: '盖新家' } });
    const miss = await goal({ done: 4 });
    expect(miss).toContain('#4 那一格本来就空着,什么都没动');
    expect(await goal()).toContain('#1 盖新家');
  });

  it('参数错当场退回:槽位越界、一次给了两件事、add 没有 text', async () => {
    const { goal } = rig();
    expect(await goal({ done: 9 })).toContain('要一个 1..5 的槽位号');
    expect(await goal({ done: 1, drop: 2 })).toContain('一次只受理一件事');
    expect(await goal({ add: {} })).toContain('add.text 要一句话');
  });

  it('连不上服务器也能登记:只是登记时刻少一个游戏内天数,如实留空', async () => {
    const { goal } = rig(null);
    expect(await goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: '盖新家' } })).toContain('这次挂上 #1 盖新家');
    const all = await goal();
    expect(all).not.toContain('DAY');
    expect(all).toContain('从现实 ');
  });

  it('通用追踪:击杀、捕获与探索都能登记初始计数', async () => {
    const { goal } = rig();
    const kill = await goal({
      add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: '清理刷怪区', kind: '击杀', target: '僵尸', current: 2, total: 10, unit: '只' },
    });
    expect(kill).toContain('#1 清理刷怪区[类型:击杀;对象:僵尸;进度:2/10 只;里程碑:0/1;下一步:验收]');
    await goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: '把村民困进交易所', kind: '捕获', target: '村民', total: 2, unit: '个' } });
    await goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: '向北探路', kind: '探索', target: '北方路线', total: 600, unit: '格' } });
    expect(await goal()).toContain('#2 把村民困进交易所[类型:捕获;对象:村民;进度:0/2 个;里程碑:0/1;下一步:验收]');
    expect(await goal()).toContain('#3 向北探路[类型:探索;对象:北方路线;进度:0/600 格;里程碑:0/1;下一步:验收]');
  });
});

/**
 * 绑定蓝图的目标仅使用蓝图游标，避免与按 unit 计数的进度混用。
 */
describe('绑蓝图的目标只认蓝图游标', () => {
  const at = Date.parse('2026-08-24T20:14:00+08:00');
  const stamp = { day: 6, realTime: '2026-08-24T20:14:00+08:00', at };
  const note = (k: string): string | null =>
    (k === 'melon' ? '已施工 21%(截至上次施工),还缺石头 50' : null);

  it('add 带蓝图:计数当场丢掉,回执说明为什么', () => {
    const table = { list: [] as MinecraftGoal[] };
    const said = applyGoal(
      table,
      {
        plan: fakeGoal(1, '验收').plan,
        kind: 'add', text: '西瓜田', blueprint: 'melon',
        trackingKind: '建造', target: '西瓜田', progress: { current: 22, total: 1, unit: '座' },
      },
      stamp,
      note,
    );
    expect(said).toContain('计数没收');
    expect(said).not.toContain('22/1');
    expect(table.list[0].progress).toBeNull();
    expect(said).toContain('蓝图 melon:已施工 21%');
  });

  it('计划完成后 done 的游标事实摆在最前面,且不重复念一遍', () => {
    const table = { list: [fakeGoal(1, '西瓜田', { blueprint: 'melon', at })] };
    recordGoalJudgment(table.list[0].plan, 1, '现场确认目标完成', stamp.at);
    const said = applyGoal(table, { kind: 'done', slot: 1 }, stamp, note);
    expect(said.indexOf('蓝图「melon」现在已施工 21%')).toBe(0);
    expect(said).toContain('#1 西瓜田[里程碑:1/1] 完成了');
    expect(said.match(/已施工 21%/g)).toHaveLength(1);
  });
});

/**
 * 断言器本身的正反例在 tests/worlds/minecraft/check.test.ts;这里只验 World 这一侧的接线:
 * 工具收得到世界(方块/背包/路标)、没连上时整单不受理、回执只报差异。
 */
describe('H1 · mc_check 的 World 接线', () => {
  function checkBot(blocks: Record<string, string> = {}, items: Array<{ name: string; count: number }> = []) {
    return {
      entity: { position: pos(0.5, 64, 0.5) },
      game: { dimension: 'overworld' },
      registry: { blocksByName: { chest: {}, stone: {}, torch: {}, furnace: {} } },
      inventory: { items: () => items },
      blockAt: (p: { x: number; y: number; z: number }) => {
        const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
        if (!(key in blocks)) return null;
        return { name: blocks[key], boundingBox: blocks[key] === 'air' ? 'empty' : 'block' };
      },
    };
  }

  function rig(bot: unknown = null) {
    const m = new MinecraftWorld({ cfg: cfg({ port: 1 }) });
    if (bot) stub(m, { bridge: { bot } });
    const tools = Object.fromEntries(m.tools().map((t) => [t.name, t]));
    const ctx = { role: 'test', log: console as never } as never;
    return {
      m,
      check: (args: Record<string, unknown>) => tools.mc_check.handler(args, ctx) as Promise<string>,
      map: (args: Record<string, unknown>) => tools.mc_map.handler(args, ctx) as Promise<string>,
    };
  }

  it('方块、背包、路标三路都接上了;符合的不逐条复述', async () => {
    const { check, map } = rig(checkBot(
      { '3,63,3': 'chest', '5,64,5': 'air' },
      [{ name: 'torch', count: 5 }],
    ));
    await map({ set: [{ name: '主箱', dimension: 'overworld', pos: [3, 63, 3], kind: '箱' }] });
    const said = await check({
      checks: [
        { at: [3, 63, 3], is: 'chest' },
        { at: [5, 64, 5], is: 'furnace' },
        { inv: { torch: '>=8' } },
        { mark: '主箱' },
      ],
    });
    expect(said).toContain('对账 4 条:2 条符合、2 条不符');
    expect(said).toContain('#2 (5, 64, 5) 该是熔炉,现在是空气');
    expect(said).toContain('#3 包里现有:火把 5(要 ≥8)');
    expect(said).not.toContain('#1');
    expect(said).not.toContain('#4');
  });

  it('区块没加载不当结论:自成一档', async () => {
    const { check } = rig(checkBot({}));
    expect(await check({ checks: [{ at: [0, 64, 0], is: 'chest' }] }))
      .toContain('1 条没对上(区块没加载)');
  });

  it('registry 接上时认不出的方块名当场退回,不废整单', async () => {
    const { check } = rig(checkBot({ '0,64,0': 'chest' }));
    const said = await check({ checks: [{ at: [0, 64, 0], is: 'chset' }, { at: [0, 64, 0], is: 'chest' }] });
    expect(said).toContain('1 条符合、1 条没受理');
    expect(said).toContain('这一版里没有叫「chset」的方块');
  });

  it('没连上服务器就整单不受理:给一份"全没加载"的空账反而像结论', async () => {
    const { check } = rig();
    expect(await check({ checks: [{ at: [0, 64, 0], is: 'chest' }] })).toContain('还没连上服务器');
  });

  it('checks 不成形是整单的错', async () => {
    const { check } = rig(checkBot());
    expect(await check({})).toContain('[mc_check 失败] checks 要一个断言数组');
  });
});

/**
 * 计划完成后,结案回执附上蓝图现场旁证;未绑定蓝图时提示 mc_check 入口。
 */
describe('H2 · done 接线:结案回执带上世界的账', () => {
  const at = Date.parse('2026-08-24T20:14:00+08:00');
  const stamp = { day: 6, realTime: '2026-08-24T20:14:00+08:00', at };
  const note = () => '已施工 100%(截至上次施工)';
  const survey = (key: string) => `蓝图「${key}」对上 40/44 格;缺 4 格(箱子 在 (1, 2, 3))`;

  it('绑蓝图且计划已完成:结案回执附上现场 diff', () => {
    const table = { list: [fakeGoal(1, '盖新家', { blueprint: 'home-v2', at })] };
    recordGoalJudgment(table.list[0].plan, 1, '现场确认目标完成', stamp.at);
    const said = applyGoal(table, { kind: 'done', slot: 1 }, stamp, note, survey);
    expect(table.list).toEqual([]);
    expect(said).toContain('#1 盖新家[里程碑:1/1] 完成了');
    expect(said).toContain('对上 40/44 格;缺 4 格(箱子 在 (1, 2, 3))');
  });

  it('没绑蓝图的条目:只附那一句对账的路,不做别的动作', () => {
    const table = { list: [fakeGoal(1, '攒铁', { at })] };
    recordGoalJudgment(table.list[0].plan, 1, '现场确认目标完成', stamp.at);
    const said = applyGoal(table, { kind: 'done', slot: 1 }, stamp, note, survey);
    expect(said).toContain('结案前想对一眼世界的话,mc_check 能按断言对账。');
    expect(said).not.toContain('对上');
  });

  it('add / drop 不附结案旁证', () => {
    const table = { list: [] as MinecraftGoal[] };
    const added = applyGoal(
      table,
      { plan: fakeGoal(1, '验收').plan, kind: 'add', text: '攒铁', blueprint: null, trackingKind: null, target: null, progress: null },
      stamp, note, survey,
    );
    expect(added).not.toContain('mc_check');
    const dropped = applyGoal(table, { kind: 'drop', slot: 1 }, stamp, note, survey);
    expect(dropped).not.toContain('mc_check');
    expect(dropped).not.toContain('对上');
  });

  it('拿不到世界(没连上)时不硬凑一份账', () => {
    const table = { list: [fakeGoal(1, '盖新家', { blueprint: 'home-v2', at })] };
    recordGoalJudgment(table.list[0].plan, 1, '现场确认目标完成', stamp.at);
    const said = applyGoal(table, { kind: 'done', slot: 1 }, stamp, note, () => null);
    expect(said).toContain('#1 盖新家[里程碑:1/1] 完成了');
    expect(said.endsWith('自己记进笔记。)')).toBe(true);
  });
});

/**
 * 目标表陈旧:她在干活却没记账时提一句,搭下一次本来就会发生的唤醒。
 * 三条判定线缺一不可,而且提醒本身有冷却与每小时预算。
 */
describe('H4 · 目标表陈旧自察(搭车、冷却、预算)', () => {
  function rig() {
    const m = new MinecraftWorld({ cfg: cfg({ port: 1 }) });
    const host = new FakeHost();
    stub(m, { host });
    const goals = (m as any).goals().list as MinecraftGoal[];
    const tick = (now: number) => (m as any).staleGoalTick(now);
    const setTasks = (n: number) => { (m as any).tasksSinceGoalWrite = n; };
    const doneTask = () => (m as any).onTaskReport({ kind: 'done', text: '干完了一件' });
    return { m, host, goals, tick, setTasks, doneTask };
  }

  const T0 = Date.parse('2026-08-24T20:00:00+08:00');
  const stale = T0 + GOAL_STALE_MS + 1_000;

  it('三条线都过才响,而且是搭车不唤醒', () => {
    const { host, goals, tick, setTasks } = rig();
    goals.push(fakeGoal(1, '盖新家'));
    tick(T0); // 头一回看见非空表:从这一刻起算
    setTasks(GOAL_STALE_TASKS);
    tick(stale);
    expect(host.events).toHaveLength(1);
    expect(host.events[0].text).toContain('目标表 45 分钟没动了');
    expect(host.events[0].text).toContain('这中间做完了 3 件活');
    expect(host.events[0].text).toContain('#1 盖新家[里程碑:0/1;下一步:验收] 还挂着');
    expect(host.pushOpts[0]).toMatchObject({ trigger: 'piggyback' });
  });

  it('表空着不响;时间没到不响;在干活这一条不成立也不响', () => {
    const empty = rig();
    empty.tick(stale);
    expect(empty.host.events).toHaveLength(0);

    const early = rig();
    early.goals.push(fakeGoal(1, '盖新家'));
    early.tick(T0);
    early.setTasks(GOAL_STALE_TASKS);
    early.tick(T0 + GOAL_STALE_MS - 1_000);
    expect(early.host.events).toHaveLength(0);

    const idle = rig();
    idle.goals.push(fakeGoal(1, '盖新家'));
    idle.tick(T0);
    idle.setTasks(GOAL_STALE_TASKS - 1);
    idle.tick(stale);
    expect(idle.host.events).toHaveLength(0);
  });

  it('响过一次进冷却,冷却内每秒心跳都不再响', () => {
    const { host, goals, tick, setTasks } = rig();
    goals.push(fakeGoal(1, '盖新家'));
    tick(T0);
    setTasks(GOAL_STALE_TASKS);
    tick(stale);
    tick(stale + 1_000);
    tick(stale + GOAL_STALE_COOLDOWN_MS - 1_000);
    expect(host.events).toHaveLength(1);
    tick(stale + GOAL_STALE_COOLDOWN_MS + 1_000);
    expect(host.events).toHaveLength(2);
  });

  /**
   * 冷却与预算是两道独立的闸:冷却管"同一件事别连着说",预算管"这一类提醒一小时
   * 里最多占她几次注意力"。冷却 45 分钟时预算恰好卡在边界上,所以这里直接把窗口
   * 里的额度用满来验它 —— 越了界是静默跳过,不补一句"我本来还想提醒"。
   */
  it('每小时预算用满就静默跳过;滑出一小时之后重新可发', () => {
    const { m, host, goals, tick, setTasks } = rig();
    goals.push(fakeGoal(1, '盖新家'));
    tick(T0);
    setTasks(GOAL_STALE_TASKS);
    const spent = (m as any).noticeTimes as number[];
    spent.push(stale - 10 * 60_000, stale - 5 * 60_000);
    expect(spent).toHaveLength(GOAL_NOTICE_HOURLY_CAP);
    tick(stale);
    expect(host.events).toHaveLength(0);
    // 两条都滑出一小时窗口之后,额度回来
    tick(stale + 60 * 60_000);
    expect(host.events).toHaveLength(1);
  });

  it('记一次账就清零:时钟与"干了几件活"一起重来', () => {
    const { m, host, goals, tick, doneTask } = rig();
    goals.push(fakeGoal(1, '盖新家'));
    tick(T0);
    doneTask(); doneTask(); doneTask();
    (m as any).markGoalWrite();
    tick(stale);
    expect(host.events.filter((e) => e.text.includes('目标表'))).toHaveLength(0);
  });

  it('受阻/撤单不算"在干活"', () => {
    const { m, host, goals, tick } = rig();
    goals.push(fakeGoal(1, '盖新家'));
    tick(T0);
    for (const kind of ['blocked', 'superseded', 'cancelled']) (m as any).onTaskReport({ kind, text: '没成' });
    tick(stale);
    expect(host.events.filter((e) => e.text.includes('目标表'))).toHaveLength(0);
  });

  it('措辞只陈述事实:多久、干了几件、最上面那条是什么', () => {
    const list = [fakeGoal(1, '盖新家'), fakeGoal(2, '攒铁')];
    expect(staleGoalNotice(list, 47 * 60_000, 5))
      .toBe('目标表 47 分钟没动了,这中间做完了 5 件活;#1 盖新家[里程碑:0/1;下一步:验收] 还挂着(另有 1 条)。');
    expect(staleGoalNotice([fakeGoal(1, '盖新家')], 45 * 60_000, 3))
      .toBe('目标表 45 分钟没动了,这中间做完了 3 件活;#1 盖新家[里程碑:0/1;下一步:验收] 还挂着。');
  });
});

describe('mc_goal 过夜提醒只跟语义写', () => {
  function rig() {
    const m = new MinecraftWorld({ cfg: cfg({ port: 1 }) });
    const tools = Object.fromEntries(m.tools().map((t) => [t.name, t]));
    const ctx = { role: 'test', log: console as never } as never;
    return (args: Record<string, unknown> = {}) => tools.mc_goal.handler(args, ctx) as Promise<string>;
  }
  const NOTE = '要过夜自己记进笔记';

  it('add/done/drop 带提醒;查询不带', async () => {
    const goal = rig();
    expect(await goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: '盖新家' } })).toContain(NOTE);
    expect(await goal()).not.toContain(NOTE); // 看一眼不是写
    expect(await goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: '攒一组铁' } })).toContain(NOTE);
    await goal({ milestone: { slot: 1, step: 1, judgment: '现场确认目标完成' } });
    expect(await goal({ done: 1 })).toContain(NOTE);
    expect(await goal({ drop: 2 })).toContain(NOTE);
  });

  it('没写成的那两条(满格、空格)不提醒:什么都没进去,没有可对齐的东西', async () => {
    const goal = rig();
    for (const n of [1, 2, 3, 4, 5]) await goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: `目标${n}` } });
    expect(await goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: '第六条' } })).not.toContain(NOTE);
    await goal({ milestone: { slot: 3, step: 1, judgment: '现场确认目标完成' } });
    await goal({ done: 3 });
    expect(await goal({ drop: 3 })).not.toContain(NOTE);
    expect(await goal({ done: 9 })).not.toContain(NOTE); // 参数错更不是写
  });
});

describe('暂态现状一行(告知 + 指路,不是开机仪式)', () => {
  function rig() {
    const m = new MinecraftWorld({ cfg: cfg({ port: 1 }) });
    const host = new FakeHost();
    const bot = Object.assign(new EventEmitter(), idleBot() as Record<string, unknown>);
    stub(m, { host, bridge: { connected: true, bot, invSynced: true, stop: () => {} } });
    return {
      m, host, bot,
      spawn: () => (m as any).onSpawn(),
      goal: (args: Record<string, unknown> = {}) => (m as any).setGoal(args) as string,
      render: () => {
        (m as any).lastSnapshotRenderAt = 0;
        return (m as any).renderSnapshotEvent() as string | null;
      },
    };
  }

  it('搭连接回执走:一次连接只说一次,不阻塞任何东西', () => {
    const { m, host, spawn } = rig();
    spawn();
    const said = host.events.filter((e) => e.text.includes('暂态:'));
    expect(said).toHaveLength(1);
    expect(said[0].text).toContain('已连入服务器'); // 就在连接回执里,不另起一条
    expect(said[0].text).toContain('暂态:目标 0 条');
    expect(said[0].text).toContain('从你的笔记里读回来重新登记');
    expect(m.logConsole().entries().find((entry) => entry.event === 'spawn')?.data)
      .toMatchObject({ connectionGeneration: 1 });
  });

  it('每次 spawn 递增连接代次，后续工具记录沿用当年代次', () => {
    const { m, spawn } = rig();
    const tool = () => (m as any).toolLog('mc_check', {}, '[mc_check] ok');
    spawn();
    tool();
    spawn();
    tool();
    const entries = m.logConsole().entries();
    expect(entries.filter((entry) => entry.event === 'spawn').map((entry) => entry.data?.connectionGeneration))
      .toEqual([1, 2]);
    expect(entries.filter((entry) => entry.event === 'mc_check').map((entry) => entry.data?.connectionGeneration))
      .toEqual([1, 2]);
  });

  it('非空时只列一行清单,不再指路;后续快照不重复这一行', () => {
    const { host, spawn, goal, render } = rig();
    goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: '盖新家' } });
    spawn();
    const said = host.events.filter((e) => e.text.includes('暂态:'));
    expect(said).toHaveLength(1);
    expect(said[0].text).toContain('暂态:目标 1 条(#1 盖新家[里程碑:0/1;下一步:验收])');
    expect(said[0].text).not.toContain('从你的笔记里读回来');
    expect(render() ?? '').not.toContain('暂态:');
  });
});

describe('快照目标尾行与指纹', () => {
  function rig() {
    const m = new MinecraftWorld({ cfg: cfg({ port: 1 }) });
    stub(m, {
      host: { pushDeferred: () => {}, log: console },
      bridge: { connected: true, bot: idleBot(), invSynced: true },
    });
    return {
      goal: (args: Record<string, unknown> = {}) => (m as any).setGoal(args) as string,
      render: () => {
        (m as any).lastSnapshotRenderAt = 0;
        return (m as any).renderSnapshotEvent() as string | null;
      },
    };
  }

  /**
   * 空目标表仍渲染一行事实，明确当前没有登记目标。
   */
  it('空表也渲染一行事实,不静默', () => {
    const { goal, render } = rig();
    const empty = render()!;
    expect(empty).toContain('目标:0 条(5 格全空,用 mc_goal 挂)');
    expect(empty).toContain('路标:0 处(24 格全空,用 mc_map 记)');
    goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: '盖新家', blueprint: 'home-v2' } });
    expect(render()).toContain('目标:#1 盖新家[里程碑:0/1;下一步:验收](蓝图 home-v2:待装载)');
  });

  it('目标变了算实质变化:世界没动那一拍照样发,且只发这一段', () => {
    const { goal, render } = rig();
    expect(render()).toContain('[Minecraft]'); // 首份全量,立基线
    expect(render()).toBeNull(); // 什么都没变:跳拍闸吃掉
    goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: '攒一组铁' } });
    const changed = render()!;
    expect(changed).toContain('目标:#1 攒一组铁');
    expect(changed).not.toContain('生命'); // 身体那段没变,不重发
    expect(render()).toBeNull(); // 目标没再变:又静下来
  });

  it('最后一条被划掉:那一拍报「0 条」,再往后静下来', () => {
    const { goal, render } = rig();
    goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: '盖新家' } });
    expect(render()).toContain('目标:#1 盖新家');
    goal({ milestone: { slot: 1, step: 1, judgment: '现场确认目标完成' } });
    goal({ done: 1 });
    expect(render()).toContain('目标:0 条');
    expect(render()).toBeNull();
  });
});

describe('快照里两张表各占一行', () => {
  it('目标行:空表也报一行事实,有目标时逐条念', () => {
    expect(goalSnapshotLine([])).toBe('目标:0 条(5 格全空,用 mc_goal 挂)');
    expect(goalSnapshotLine([fakeGoal(1, '盖新家')])).toBe('目标:#1 盖新家[里程碑:0/1;下一步:验收]');
  });

  it('路标行:只报数与前几个名字,不念坐标;已用几格写在字面上', () => {
    expect(mapSnapshotLine([])).toBe(`路标:0 处(${MAP_SLOTS} 格全空,用 mc_map 记)`);
    expect(mapSnapshotLine([fakeMark('家'), fakeMark('矿洞口')]))
      .toBe(`路标:2/${MAP_SLOTS} 处(「家」「矿洞口」)`);
    const many = Array.from({ length: 8 }, (_, i) => fakeMark(`P${i}`));
    expect(mapSnapshotLine(many)).toBe(`路标:8/${MAP_SLOTS} 处(「P0」「P1」「P2」「P3」「P4」「P5」等)`);
  });
});

describe('goalAge(纯函数:登记时长的两个口径)', () => {
  it('不到一小时报分钟,超过报小时+分;拿不到游戏内天数时只报现实时刻', () => {
    const at = Date.parse('2026-08-24T20:14:00+08:00');
    const g = fakeGoal(1, '盖新家', { at, day: 6 });
    expect(goalAge(g, at + 12 * 60_000))
      .toBe('从现实 8-24 20:14 挂到现在,挂了 12 分钟(挂上那会儿游戏里是第 6 天)');
    expect(goalAge(g, at + 192 * 60_000))
      .toBe('从现实 8-24 20:14 挂到现在,挂了 3 小时 12 分(挂上那会儿游戏里是第 6 天)');
    expect(goalAge({ ...g, day: null }, at)).toBe('从现实 8-24 20:14 挂到现在,挂了 0 分钟');
  });


});

// mc_map 路标表

function fakeMark(name: string, over: Partial<MinecraftMark> = {}): MinecraftMark {
  return {
    name, dimension: 'minecraft:overworld', pos: [0, 64, 0],
    kind: '地标', note: null, radius: null, at: Date.now(), ...over,
  };
}

/**
 * 会读方块的假 bot:`blocks` 里有的按 id 报,没有的按「区块没加载」报 null
 * —— 那正是 mineflayer 的口径,也是回执里要分开说的两件事。
 */
function markBot(blocks: Record<string, string> = {}, at = pos(0.5, 64, 0.5)) {
  return {
    entity: { position: at },
    game: { dimension: 'overworld' },
    blockAt: (p: { x: number; y: number; z: number }) => {
      const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
      return key in blocks ? { name: blocks[key] } : null;
    },
  };
}

describe('mc_map:四个操作与批量装载', () => {
  function rig(bot: unknown = null) {
    const m = new MinecraftWorld({ cfg: cfg({ port: 1 }) });
    if (bot) stub(m, { bridge: { bot } });
    const tools = Object.fromEntries(m.tools().map((t) => [t.name, t]));
    const ctx = { role: 'test', log: console as never } as never;
    return {
      m,
      map: (args: Record<string, unknown> = {}) => tools.mc_map.handler(args, ctx) as Promise<string>,
    };
  }

  it('set 单条:回执只说这一次记下了什么', async () => {
    const { map } = rig();
    const r = await map({ set: {
      name: '新家', dimension: 'overworld', pos: [10, 64, -3], kind: '家', note: '橡木小屋',
    } });
    expect(r).toContain('这次记下 「新家」家 [主世界] (10, 64, -3),橡木小屋');
    expect(r).toContain('别的没有了');
  });

  it('set 数组 = 一次批量装载,回执报新记/改了各几处', async () => {
    const { map } = rig();
    await map({ set: { name: '新家', dimension: 'overworld', pos: [10, 64, -3], kind: '家' } });
    const r = await map({
      set: [
        { name: '铁矿点', dimension: 'overworld', pos: [80, 12, 40], kind: '资源点' },
        { name: '新家', dimension: 'overworld', pos: [11, 64, -3], kind: '家' },
      ],
    });
    expect(r).toContain('这次装载 2 处');
    expect(r).toContain('新记 1 处');
    expect(r).toContain('改了 1 处');
    expect(await map({})).toContain('「新家」家 [主世界] (11, 64, -3)');
  });

  /**
   * 路标 note 是登记时的观察，查询须附登记时刻，不能将其当作当前世界状态。
   */
  it('查询时给 note 附登记时刻:这句话有多旧要看得见', async () => {
    const { map } = rig();
    await map({ set: {
      name: '废门1号', dimension: 'overworld', pos: [80, 40, -20], kind: '资源点', note: '约10块黑曜石',
    } });
    const all = await map({});
    expect(all).toMatch(/约10块黑曜石 · 记于 \d\d:\d\d:\d\d/);
  });

  it('没写 note 的路标不凭空多出一个时刻', async () => {
    const { map } = rig();
    await map({ set: { name: '家', dimension: 'overworld', pos: [0, 64, 0], kind: '家' } });
    expect(await map({})).not.toContain('记于');
  });

  it('同名 set = 改那一处,回执给出改前改后', async () => {
    const { map } = rig();
    await map({ set: { name: '家', dimension: 'overworld', pos: [0, 64, 0], kind: '家' } });
    const r = await map({ set: { name: '家', dimension: 'overworld', pos: [40, 70, 40], kind: '家' } });
    expect(r).toContain('「家」改了:');
    expect(r).toContain('(0, 64, 0)');
    expect(r).toContain('→ 「家」家 [主世界] (40, 70, 40)');
  });

  it('查询:列全,每条附离她当前位置的距离与方向', async () => {
    const { map } = rig(markBot());
    await map({ set: { name: '新家', dimension: 'overworld', pos: [10, 64, -3], kind: '家' } });
    const all = await map({});
    expect(all).toContain(`记着 1 处(共 ${MAP_SLOTS} 格)`);
    expect(all).toContain('「新家」家 [主世界] (10, 64, -3) —— 在你东边 10 格');
  });

  it('没连上服务器:照样能登记,只是方向距离算不出来,如实说', async () => {
    const { map } = rig();
    await map({ set: { name: '新家', dimension: 'overworld', pos: [10, 64, -3], kind: '家' } });
    const all = await map({});
    expect(all).toContain('这会儿没连上服务器,方向和距离算不出来');
    expect(all).not.toContain('在你');
  });

  it('drop / rename:按名字寻址,名字不在就什么都不动', async () => {
    const { map } = rig();
    await map({ set: { name: '旧箱', dimension: 'overworld', pos: [3, 63, 3], kind: '箱' } });
    expect(await map({ rename: { from: '旧箱', to: '仓库' } })).toContain('「旧箱」改名叫「仓库」了');
    expect(await map({ drop: '旧箱' })).toContain('没有叫「旧箱」的路标,什么都没动');
    expect(await map({ drop: '仓库' })).toContain('「仓库」箱 [主世界] (3, 63, 3) 撤了');
    expect(await map({})).toContain('一处路标都没有');
  });

  it('改名撞上已有的名字:不改,如实说(一个名字只能有一处)', async () => {
    const { map } = rig();
    await map({ set: [
      { name: 'A', dimension: 'overworld', pos: [0, 64, 0], kind: '地标' },
      { name: 'B', dimension: 'overworld', pos: [1, 64, 1], kind: '地标' },
    ] });
    const r = await map({ rename: { from: 'A', to: 'B' } });
    expect(r).toContain('已经有一处叫「B」了,没改名');
    expect(await map({})).toContain('「A」');
  });

  it('参数错当场退回:词表外的 kind、pos 不是三个数、一次给了两件事', async () => {
    const { map } = rig();
    expect(await map({ set: { name: 'X', dimension: 'overworld', pos: [1, 2, 3], kind: '秘密基地' } }))
      .toContain(`kind 只收这几个词:${MAP_KINDS.join('/')}`);
    expect(await map({ set: { name: 'X', dimension: 'overworld', pos: [1, 2], kind: '家' } }))
      .toContain('pos 要 [x, y, z] 三个数');
    expect(await map({ set: { name: '', dimension: 'overworld', pos: [1, 2, 3], kind: '家' } }))
      .toContain('name 要一个名字');
    expect(await map({ drop: 'A', rename: { from: 'A', to: 'B' } })).toContain('一次只受理一件事');
    expect(await map({ set: [
      { name: 'A', dimension: 'overworld', pos: [0, 0, 0], kind: '家' },
      { name: 'A', dimension: 'overworld', pos: [1, 1, 1], kind: '家' },
    ] }))
      .toContain('这一批里「A」出现了两次');
  });

  it('没写维度不再整条驳回:按主世界记下,回执点名是哪几条', async () => {
    const { map } = rig();
    const one = await map({ set: { name: '旧写法', pos: [1, 2, 3], kind: '地标' } });
    expect(one).toContain('1 条没写 dimension(旧写法)');
    expect(one).toContain('按主世界记的');
    expect(one).toContain('这次记下 「旧写法」地标 [主世界] (1, 2, 3)');

    // 批量装载旧笔记:提醒一句话说完,不是每条刷一行
    const batch = await map({ set: [
      { name: '旧A', pos: [0, 64, 0], kind: '地标' },
      { name: '旧B', pos: [1, 64, 1], kind: '地标' },
      { name: '写了的', dimension: 'the_nether', pos: [2, 64, 2], kind: '地标' },
    ] });
    expect(batch).toContain('2 条没写 dimension(旧A、旧B)');
    expect(batch.match(/没写 dimension/g)).toHaveLength(1);
    expect(await map({})).toContain('[下界]');

    // 写成非字符串仍然驳回:那不是「没写」,是写错了
    expect(await map({ set: { name: 'X', dimension: 3, pos: [1, 2, 3], kind: '地标' } }))
      .toContain('dimension 要写维度名');
  });

  it('批量里第几条错就说第几条:整批一条都不落进去', async () => {
    const { map } = rig();
    const r = await map({
      set: [
        { name: 'A', dimension: 'overworld', pos: [0, 64, 0], kind: '家' },
        { name: 'B', dimension: 'overworld', pos: [1, 64, 1], kind: '澡堂' },
      ],
    });
    expect(r).toContain('第 2 条的 kind');
    expect(await map({})).toContain('一处路标都没有');
  });

  it(`${MAP_SLOTS} 格是上限:超了整批不收,并把现在记着的列给她`, async () => {
    const { map } = rig();
    const full = Array.from({ length: MAP_SLOTS }, (_, i) => ({
      name: `P${i}`, dimension: 'overworld', pos: [i, 64, 0], kind: '地标',
    }));
    expect(await map({ set: full })).toContain(`这次装载 ${MAP_SLOTS} 处`);
    const over = await map({ set: { name: '第 25 处', dimension: 'overworld', pos: [0, 64, 9], kind: '地标' } });
    expect(over).toContain(`${MAP_SLOTS} 格里只剩 0 格`);
    expect(over).toContain(`记着 ${MAP_SLOTS} 处`);
    expect(await map({})).not.toContain('第 25 处');
    // 满格时改现有那几处照样收:它不占新格
    expect(await map({ set: { name: 'P0', dimension: 'overworld', pos: [9, 9, 9], kind: '家' } }))
      .toContain('「P0」改了');
  });


  it('一格只归一个名字:坐标已被别人登记就退这一条,同批别的照收', async () => {
    const { map } = rig();
    await map({ set: { name: '家-白床', dimension: 'overworld', pos: [-234, 72, 48], kind: '床' } });
    const r = await map({
      set: [
        { name: '白床', dimension: 'overworld', pos: [-234, 72, 48], kind: '床' },
        { name: '矿洞口', dimension: 'overworld', pos: [12, 40, 8], kind: '地标' },
      ],
    });
    expect(r).toContain('「白床」没登记:(-234, 72, 48) 已登记为「家-白床」(床)');
    expect(r).toContain('想换名先 drop 或 rename');
    expect(r).toContain('这次记下 「矿洞口」地标 [主世界]');
    const all = await map({});
    expect(all).toContain('记着 2 处');
    expect(all).not.toContain('「白床」');
  });

  it('相同坐标在不同维度不冲突;查询只给当前维度路标计算方位距离', async () => {
    const { map } = rig(markBot());
    const r = await map({
      set: [
        { name: '主世界门', dimension: 'overworld', pos: [10, 64, -3], kind: '门户' },
        { name: '下界门', dimension: 'the_nether', pos: [10, 64, -3], kind: '门户' },
      ],
    });
    expect(r).toContain('这次装载 2 处');
    expect(r).not.toContain('已登记为');

    const lines = (await map({})).split('\n');
    const overworld = lines.find((line) => line.includes('「主世界门」'))!;
    const nether = lines.find((line) => line.includes('「下界门」'))!;
    expect(overworld).toContain('[主世界] (10, 64, -3) —— 在你东边 10 格');
    expect(nether).toContain('[下界] (10, 64, -3)');
    expect(nether).not.toContain(' —— ');
  });

  it('同名同坐标照旧是「改」,不受这道闸影响', async () => {
    const { map } = rig();
    await map({ set: { name: '家', dimension: 'overworld', pos: [0, 64, 0], kind: '家' } });
    const r = await map({ set: {
      name: '家', dimension: 'overworld', pos: [0, 64, 0], kind: '家', note: '橡木小屋',
    } });
    expect(r).toContain('「家」改了:');
    expect(r).toContain('橡木小屋');
  });

  it('撞坐标的那一条是整批唯一一条时:什么都没登记,把现在记着的列给她', async () => {
    const { map } = rig();
    await map({ set: { name: '家-白床', dimension: 'overworld', pos: [-234, 72, 48], kind: '床' } });
    const r = await map({ set: { name: '白床', dimension: 'overworld', pos: [-234, 72, 48], kind: '床' } });
    expect(r).toContain('已登记为「家-白床」');
    expect(r).toContain('记着 1 处');
    expect(r).not.toContain('这次记下');
  });

  it(`已用 ${MAP_SLOTS_TIGHT} 格起,登记回执附一句用掉了几格`, async () => {
    const { map } = rig();
    const batch = Array.from({ length: MAP_SLOTS_TIGHT - 1 }, (_, i) => ({
      name: `P${i}`, dimension: 'overworld', pos: [i, 64, 0], kind: '地标',
    }));
    expect(await map({ set: batch })).not.toContain('格已用');
    const tight = await map({ set: { name: '再一处', dimension: 'overworld', pos: [0, 64, 9], kind: '地标' } });
    expect(tight).toContain(`(${MAP_SLOTS} 格已用 ${MAP_SLOTS_TIGHT})`);
  });

  it('半径只在危险区上留着:别的 kind 给了也不记(记了不知道拿它做什么)', () => {
    const zone = parseMap({ set: {
      name: '刷怪窝', dimension: 'overworld', pos: [0, 64, 0], kind: '危险区', radius: 30,
    } });
    expect(zone).toMatchObject({ kind: 'set', marks: [{ radius: 30 }] });
    const home = parseMap({ set: {
      name: '家', dimension: 'overworld', pos: [0, 64, 0], kind: '家', radius: 30,
    } });
    expect(home).toMatchObject({ kind: 'set', marks: [{ radius: null }] });
  });
});

describe('装载回执的世界核验(能查证的逐条对账)', () => {
  function rig(blocks: Record<string, string> = {}, connected = true) {
    const m = new MinecraftWorld({ cfg: cfg({ port: 1 }) });
    if (connected) stub(m, { bridge: { bot: markBot(blocks) } });
    const tools = Object.fromEntries(m.tools().map((t) => [t.name, t]));
    const ctx = { role: 'test', log: console as never } as never;
    return (args: Record<string, unknown> = {}) => tools.mc_map.handler(args, ctx) as Promise<string>;
  }

  it('对上了只报个数;对不上的逐条点名说那一格现在是什么', async () => {
    const map = rig({ '3,63,3': 'chest', '5,64,5': 'air', '7,64,7': 'crafting_table' });
    const r = await map({
      set: [
        { name: '主箱', dimension: 'overworld', pos: [3, 63, 3], kind: '箱' },
        { name: '旧箱', dimension: 'overworld', pos: [5, 64, 5], kind: '箱' },
        { name: '台子', dimension: 'overworld', pos: [7, 64, 7], kind: '工作站' },
      ],
    });
    expect(r).toContain('核对了一遍:2 处对上了');
    expect(r).toContain('「旧箱」登记的是箱,那一格现在是空气');
    expect(r).not.toContain('「主箱」登记的是');
    // 核验自成一行:它接在逐条列表后面,不粘在最后一条路标的尾巴上
    expect(r).toContain('\n核对了一遍:');
  });

  it('区块没加载:说没加载没法核,不含糊成「没找到」', async () => {
    const map = rig({});
    const r = await map({ set: {
      name: '床', dimension: 'overworld', pos: [100, 64, 100], kind: '床',
    } });
    expect(r).toContain('「床」那一格区块没加载,没法核');
  });

  it('危险区/资源点这类查不了:一个字都不说,不硬凑结论', async () => {
    const map = rig({});
    const r = await map({ set: {
      name: '刷怪窝', dimension: 'overworld', pos: [0, 64, 0], kind: '危险区', radius: 30,
    } });
    expect(r).not.toContain('核对了一遍');
  });

  it('还没连上服务器:核不了就当没加载说,不假装核过', async () => {
    const map = rig({}, false);
    expect(await map({ set: { name: '床', dimension: 'overworld', pos: [1, 2, 3], kind: '床' } }))
      .toContain('没加载,没法核');
  });

  it('床/箱/工作站认的是一族方块,不是一个 id', () => {
    const bed = fakeMark('床', { pos: [0, 0, 0], kind: '床' });
    expect(checkMark(bed, () => 'red_bed').verdict).toBe('ok');
    expect(checkMark(bed, () => 'white_bed').verdict).toBe('ok');
    expect(checkMark(fakeMark('箱', { kind: '箱' }), () => 'barrel').verdict).toBe('ok');
    expect(checkMark(fakeMark('站', { kind: '工作站' }), () => 'smoker').verdict).toBe('ok');

    expect(checkMark(fakeMark('火', { kind: '工作站' }), () => 'campfire').verdict).toBe('ok');
    expect(checkMark(fakeMark('火', { kind: '工作站' }), () => 'soul_campfire').verdict).toBe('ok');
    expect(checkMark(fakeMark('站', { kind: '工作站' }), () => 'dirt')).toMatchObject(
      { verdict: 'mismatch', found: '泥土' },
    );
    expect(checkMark(fakeMark('家', { kind: '家' }), () => 'dirt').verdict).toBe('unchecked');
  });

  it('可核验路标属于另一维度时不读取当前维度的同坐标方块', () => {
    let peeks = 0;
    const mark = fakeMark('下界箱', { dimension: 'minecraft:the_nether', kind: '箱' });
    const result = checkMark(mark, () => { peeks++; return 'chest'; }, 'overworld');
    expect(result).toMatchObject({ verdict: 'other-dimension', found: null });
    expect(peeks).toBe(0);
  });
});

describe('mc_map 过夜提醒只跟语义写', () => {
  function rig() {
    const m = new MinecraftWorld({ cfg: cfg({ port: 1 }) });
    const tools = Object.fromEntries(m.tools().map((t) => [t.name, t]));
    const ctx = { role: 'test', log: console as never } as never;
    return (args: Record<string, unknown> = {}) => tools.mc_map.handler(args, ctx) as Promise<string>;
  }
  const NOTE = '要过夜自己记进笔记';

  it('set/drop/rename 带提醒;查询不带', async () => {
    const map = rig();
    expect(await map({ set: { name: '家', dimension: 'overworld', pos: [0, 64, 0], kind: '家' } }))
      .toContain(NOTE);
    expect(await map({})).not.toContain(NOTE); // 看一眼不是写
    expect(await map({ rename: { from: '家', to: '老家' } })).toContain(NOTE);
    expect(await map({ drop: '老家' })).toContain(NOTE);
  });

  it('没写成的那几条不提醒:什么都没进去,没有可对齐的东西', async () => {
    const map = rig();
    expect(await map({ drop: '不存在' })).not.toContain(NOTE);
    expect(await map({ rename: { from: '不存在', to: '别的' } })).not.toContain(NOTE);
    const full = Array.from({ length: MAP_SLOTS }, (_, i) => ({
      name: `P${i}`, dimension: 'overworld', pos: [i, 64, 0], kind: '地标',
    }));
    await map({ set: full });
    expect(await map({ set: {
      name: '第 25 处', dimension: 'overworld', pos: [0, 64, 9], kind: '地标',
    } })).not.toContain(NOTE);
    expect(await map({ set: { name: 'X', dimension: 'overworld', pos: [1, 2], kind: '家' } }))
      .not.toContain(NOTE);
  });
});

describe('路标:换世界下桌、公告、现状一行', () => {
  it('换命名空间:路标那一句进「下桌」清单,旧世界那份原样留着', () => {
    const t = new PwsrTables();
    const marks = t.register(MAP_TABLE_DECL);
    t.switchTo('世界甲');
    marks().list.push(fakeMark('家'), fakeMark('矿洞口'));
    expect(t.switchTo('世界乙')).toEqual(['2 处地点']);
    expect(marks().list).toEqual([]);
    t.switchTo('世界甲');
    expect(marks().list.map((m) => m.name)).toEqual(['家', '矿洞口']);
  });

  it('现状一行同时报目标与路标;全空才附那句指路,并点名 mc_map', () => {
    const t = new PwsrTables();
    t.register(GOAL_TABLE_DECL);
    const marks = t.register(MAP_TABLE_DECL);
    const empty = t.statusLine()!;
    expect(empty).toContain('路标 0 处');
    expect(empty).toContain('mc_map');
    marks().list.push(fakeMark('家'));
    const filled = t.statusLine()!;
    expect(filled).toContain('路标 1 处(「家」)');
    expect(filled).not.toContain('从你的笔记里读回来');
  });

  it('世界切换公告一句话说清两张表各下桌了什么', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-map-switch-'));
    const m = new MinecraftWorld({ cfg: cfg({ port: 1 }), dataDir: dir });
    const host = new FakeHost();
    stub(m, { host });
    try {
      writeFileSync(join(dir, 'minecraft-world.json'), `${JSON.stringify({ world: '旧大陆' })}\n`, 'utf8');
      (m as any).setGoal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: '盖新家' } });
      (m as any).setMap({ set: [
        { name: '家', dimension: 'overworld', pos: [0, 64, 0], kind: '家' },
        { name: '矿洞口', dimension: 'overworld', pos: [30, 40, 30], kind: '地标' },
      ] });
      (m as any).cfg.port = 25566;
      (m as any).syncRealm();
      (m as any).noteWorldSwitch();
      expect(host.events[0].text).toContain('暂态已清:1 条目标、2 处地点随旧世界下桌');
      expect((m as any).setMap({})).toContain('一处路标都没有');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('地点相对化(回执侧、事实措辞)', () => {
  it('nearestMark:只取最近的一处;超过 256 格一个字都不说', () => {
    const list = [fakeMark('新家', { pos: [0, 64, 0] }), fakeMark('矿洞口', { pos: [40, 64, 0] })];
    expect(nearestMark(list, { x: 30, y: 64, z: 0 })!.mark.name).toBe('矿洞口');
    expect(nearMarkText(list, { x: 82, y: 64, z: 0 })).toBe('离「矿洞口」42 格');
    expect(nearMarkText(list, { x: MARK_NEAR_MAX + 41, y: 64, z: 0 })).toBeNull();
    expect(nearMarkText([], { x: 0, y: 64, z: 0 })).toBeNull();
    // 上界估算把「约」写在字面上
    expect(nearMarkText(list, { x: 170, y: 64, z: 0 }, true)).toBe('离「矿洞口」约 130 格');
  });

  it('nearestMark 与 nearMarkText 不拿另一维度的同坐标地点作参照', () => {
    const list = [
      fakeMark('主世界家', { pos: [20, 64, 0] }),
      fakeMark('下界门', { dimension: 'minecraft:the_nether', pos: [0, 64, 0] }),
    ];
    expect(nearestMark(list, { x: 0, y: 64, z: 0 }, 'overworld')?.mark.name).toBe('主世界家');
    expect(nearMarkText(list, { x: 0, y: 64, z: 0 }, false, 'overworld'))
      .toBe('离「主世界家」20 格');
    expect(nearMarkText(list, { x: 0, y: 64, z: 0 }, false, 'the_end')).toBeNull();
  });

  it('死亡回执:死亡点坐标后面附最近的命名地点;太远就不附', () => {
    const m = new MinecraftWorld({ cfg: cfg({ port: 1 }) });
    (m as any).setMap({ set: {
      name: '新家', dimension: 'overworld', pos: [0, 64, 0], kind: '家',
    } });
    const note = (at: { x: number; y: number; z: number; dimension: string }) =>
      (m as any).deathNote({ spawnPoint: null }, at) as string;
    expect(note({ x: 82, y: 64, z: 0, dimension: 'overworld' }))
      .toContain('死亡点在 [主世界] (82, 64, 0),离「新家」82 格。');
    expect(note({ x: 900, y: 64, z: 0, dimension: 'overworld' }))
      .toContain('死亡点在 [主世界] (900, 64, 0)。');
    expect(note({ x: 900, y: 64, z: 0, dimension: 'overworld' })).not.toContain('离「新家」');
  });

  it('快照位置行:坐标后面接同一句;没有近处路标时那一段不占字', () => {
    const m = new MinecraftWorld({ cfg: cfg({ port: 1 }) });
    stub(m, {
      host: { pushDeferred: () => {}, log: console },
      bridge: { connected: true, bot: idleBot(), invSynced: true },
    });
    const render = () => {
      (m as any).lastSnapshotRenderAt = 0;
      (m as any).snapshotAnchorPending = true;
      return (m as any).renderSnapshotEvent() as string | null;
    };
    expect(render()).not.toContain('离「');
    (m as any).setMap({ set: {
      name: '家', dimension: 'overworld', pos: [0, 70, 0], kind: '家',
    } });
    expect(render()).toContain('站在格 (0, 64, 0)，离「家」6 格，主世界。');
  });

  /**
   * 背包快照首份和全量锚发送全量，其余只发变化；mc_check 提供按需核对入口。
   */
  it('快照背包:首份整份印、之后只印变的、全量锚那一拍再整份印', () => {
    const m = new MinecraftWorld({ cfg: cfg({ port: 1 }) });
    const bag: { name: string; count: number }[] = [{ name: 'oak_log', count: 3 }];
    const bot = Object.assign(idleBot() as Record<string, unknown>, { inventory: { items: () => bag } });
    stub(m, {
      host: { pushDeferred: () => {}, log: console },
      bridge: { connected: true, bot, invSynced: true },
    });
    const render = () => {
      (m as any).lastSnapshotRenderAt = 0;
      return (m as any).renderSnapshotEvent() as string | null;
    };
    // 首份没有基线 = 全量锚
    expect(render()).toContain('包里有：橡木原木×3。');
    bag.push({ name: 'bread', count: 2 });
    const inc = render()!;
    expect(inc).toContain('包里变的：面包×2。');
    expect(inc).not.toContain('橡木原木');
    // 一条都没变:整条快照都不必存在(跳拍闸)
    expect(render()).toBeNull();
    // 全量锚那一拍:整份再摆一次
    (m as any).lastSnapshotFullAt = 0;
    expect(render()).toContain('包里有：橡木原木×3、面包×2。');
  });
});

describe('危险区:只陈述她标的事实,不做系统判断', () => {
  it('dangerZonesAt:只认带半径的危险区,别的 kind 与没标半径的都不成圈', () => {
    const zone = fakeMark('出生点刷怪窝', { pos: [0, 64, 0], kind: '危险区', radius: 30 });
    const point = fakeMark('那口岩浆', { pos: [0, 64, 0], kind: '危险区' });
    const home = fakeMark('家', { pos: [0, 64, 0], kind: '家', radius: 30 });
    expect(dangerZonesAt([zone, point, home], { x: 20, y: 64, z: 0 }).map((m) => m.name))
      .toEqual(['出生点刷怪窝']);
    expect(dangerZonesAt([zone], { x: 31, y: 64, z: 0 })).toEqual([]);
  });

  it('危险区只作用于登记的维度', () => {
    const overworld = fakeMark('主世界刷怪窝', { kind: '危险区', radius: 30 });
    const nether = fakeMark('下界岩浆海', {
      dimension: 'minecraft:the_nether', kind: '危险区', radius: 30,
    });
    expect(dangerZonesAt([overworld, nether], { x: 0, y: 64, z: 0 }, 'overworld')
      .map((mark) => mark.name)).toEqual(['主世界刷怪窝']);
    expect(dangerZonesAt([overworld, nether], { x: 0, y: 64, z: 0 }, 'the_nether')
      .map((mark) => mark.name)).toEqual(['下界岩浆海']);
  });

  it('markBearing:同一格说「就在你脚下」,拿不到她的位置就不说方向', () => {
    expect(markBearing({ x: 10, y: 64, z: -3 }, [10, 64, -3])).toBe('就在你脚下');
    expect(markBearing(null, [10, 64, -3])).toBeNull();
    expect(markBearing({ x: 0, y: 64, z: 0 }, [0, 64, -20])).toBe('在你北边 20 格');
    // 高低差 ±3 格才点出上下:与世界快照的 whereIs 同一套口径
    expect(markBearing({ x: 0, y: 64, z: 0 }, [0, 20, -20])).toBe('在你北边下方 48 格');
    expect(markBearing({ x: 0, y: 64, z: 0 }, [0, 20, 0])).toBe('在你正下方 44 格');
  });
});

describe('mc_map 工具面:只有查询与写入', () => {
  const decl = MINECRAFT_TOOL_DECLS.find((t) => t.name === 'mc_map')!;

  it('常驻内部状态一档:write,不带 speak', () => {
    expect(decl.tags).toEqual(['write']);
  });

  it('字段就那三个,一个 goto/寻路类的都没有', () => {
    const props = Object.keys((decl.parameters as { properties: Record<string, unknown> }).properties).sort();
    expect(props).toEqual(['drop', 'rename', 'set']);
    // 参数面上一个能"去某处"的字段都没有:那会悄悄变成第二套动作入口
    const surface = JSON.stringify(decl.parameters).toLowerCase();
    for (const banned of ['goto', 'walk', 'travel', 'navigate', 'path', '走过去', '寻路']) {
      expect(surface).not.toContain(banned);
    }
    // 「说明里反过来点破一句」那条已撤:参数面上没有寻路字段,这件事就已经说完了,
    // 再写一句「it never moves you」是替一个提不出来的调用预先辩护。
  });

  it('set 在工具面上只有数组一种形状', () => {
    expect(JSON.stringify(decl.parameters)).not.toContain('oneOf');
    const set = (decl.parameters as { properties: { set: { type: string; items: unknown } } }).properties.set;
    expect(set.type).toBe('array');
    // dimension 为可选字段，兼容未记录维度的已有地图笔记。
    expect(set.items).toMatchObject({ required: ['name', 'pos', 'kind'] });
    expect((set.items as { properties: Record<string, unknown> }).properties.dimension).toBeDefined();
  });
});




describe('MinecraftWorld mc_escape 打转计数', () => {
  it('同一个落点短时间反复逃回:第二次起报这是第几次;换了落点重新数', () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const priv = m as any;
    const bed = { x: 5360, y: 76, z: 60, dimension: 'overworld', source: 'bed' };
    const base = Date.now();
    expect(priv.noteEscapeRepeat(bed, base)).toBe('');
    expect(priv.noteEscapeRepeat(bed, base + 60_000)).toContain('第 2 次回到同一张床');
    const third = priv.noteEscapeRepeat(bed, base + 11 * 60_000) as string;
    expect(third).toContain('11 分钟内第 3 次回到同一张床');
    // 换一张床就是另一处,从头数
    const other = { x: 100, y: 64, z: 100, dimension: 'overworld', source: 'bed' };
    expect(priv.noteEscapeRepeat(other, base + 11 * 60_000)).toBe('');
  });
});

describe('MinecraftWorld 关机顺序', () => {
  it('先停 bridge 与两份客户端,再停 MC 服务器;收摊闸当场合上', async () => {
    const order: string[] = [];
    const rig = await started();
    const m = rig.m;
    const priv = m as any;
    stub(m, { bridge: { bot: null, connected: false, stop: async () => { order.push('bridge'); } } });
    vi.spyOn(priv.mcServer, 'stop').mockImplementation(async () => { order.push('server'); });
    vi.spyOn(priv.client, 'stop').mockImplementation(async () => { order.push('camera'); });
    vi.spyOn(priv.playerClient, 'stop').mockImplementation(async () => { order.push('player'); });
    try {
      await m.stop();
      expect(order.indexOf('bridge')).toBeLessThan(order.indexOf('server'));
      expect(order.indexOf('camera')).toBeLessThan(order.indexOf('server'));
      expect(order.indexOf('player')).toBeLessThan(order.indexOf('server'));
      expect(priv.shuttingDown).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('MinecraftWorld 全身影子观测不再每秒写盘', () => {
  it('稳定态跑 60 拍只落一条;owner 换人那一拍照落,并说清压了几拍', () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    let step = '第 1 步:去坐标';
    stub(m, {
      executor: {
        status: () => ({
          running: { id: 7, label: '去坐标', step, stepIndex: 0, stepCount: 1, elapsedMs: 0, taskElapsedMs: 0, count: null, pos: null },
          waiting: [],
        }),
      },
    });
    const priv = m as any;
    const base = Date.now();
    for (let i = 0; i < 60; i++) priv.observeBodyControl(base + i * 1000);

    const body = () => priv.diag.after(0).filter((e: { lane: string }) => e.lane === 'body');
    // 60 拍只有两条:第一拍取到租约、第二拍起是稳定的续租,其余 58 拍全压掉
    expect(body()).toHaveLength(2);
    expect(body().every((e: { event: string }) => e.event === 'heartbeat')).toBe(true);
    // 压掉的不是丢掉的:整拍的每条事件都在 data 里留着
    expect(body()[0].data.events.length).toBeGreaterThan(1);

    // 步骤换了 = 这一拍与上一拍不同,照落一条,并说清刚才压了几拍
    step = '第 2 步:挖石头';
    priv.observeBodyControl(base + 60_000 - 1);
    const after = body();
    expect(after).toHaveLength(3);
    expect(after[2].data).toMatchObject({ foldedTicks: 58 });
    expect(after[2].msg).toContain('58 拍');
  });
});

describe('MinecraftWorld 死亡重生恢复全身租约', () => {
  interface Priv {
    bridge: { opts: { onRespawn?: () => void } } | null;
    bodyLease: {
      update(input: unknown, now: number): unknown;
      invalidate(reason: string, now: number): void;
      connectionGeneration: number;
    };
    diag: { after(seq: number): Array<{ lane: string; event: string; data?: unknown }> };
  }

  const intent = (owner: object, now: number) => ({
    owner, ownerKind: 'task' as const, intent: 'task#1:goto', validUntil: now + 5_000,
    utility: {
      survival: 20, urgency: 30, feasibility: 80, progress: 65,
      continuity: 80, executionRisk: 20, disruption: 0,
    },
  });

  it('bridge 的重生通知接回 revive,作废期的重复拒绝折叠成一条汇总', async () => {
    vi.useFakeTimers();
    vi.spyOn(Bridge.prototype, 'start').mockImplementation(() => undefined);
    vi.spyOn(Bridge.prototype, 'stop').mockResolvedValue(undefined);
    const m = new MinecraftWorld({ cfg: cfg() });
    try {
      await m.start(new FakeHost() as never);
      await vi.advanceTimersByTimeAsync(0);
      const priv = m as unknown as Priv;
      const onRespawn = priv.bridge?.opts.onRespawn;
      expect(typeof onRespawn).toBe('function');

      const lease = priv.bodyLease;
      const gen = lease.connectionGeneration;
      const owner = {};
      const now = Date.now();
      lease.invalidate('death', now);
      for (let i = 0; i < 60; i++) lease.update(intent(owner, now), now + i);
      const duringDeath = priv.diag.after(0).filter((e) => e.lane === 'body');
      // 首条照记,其余 59 条压成计数
      expect(duringDeath.filter((e) => e.event === 'proposal-rejected')).toHaveLength(1);

      onRespawn!();
      const afterRevive = priv.diag.after(0).filter((e) => e.lane === 'body');
      expect(afterRevive.filter((e) => e.event === 'revived')).toHaveLength(1);
      const folded = afterRevive.filter((e) => e.event === 'rejects-folded');
      expect(folded).toHaveLength(1);
      expect(folded[0].data).toMatchObject({ total: 59 });
      // 重生不换连接:代次不动
      expect(lease.connectionGeneration).toBe(gen);

      // 恢复之后同一条 proposal 重新被收下
      lease.update(intent(owner, now), now + 100);
      const tail = priv.diag.after(0).filter((e) => e.lane === 'body');
      expect(tail[tail.length - 1].event).toBe('proposal-updated');
    } finally {
      await m.stop();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});

/**
 * 槽位事务的中间态用 500ms 防抖合并,免得游标暂存被误判成借料。防抖窗口里
 * `placementDecision` 读的是上一次核对之后的账:刚掉进 reserve 的那几块还没扣
 * 临时覆盖的预算,于是覆盖预算见底之后还能再放一块。判据入口必须先把待结算的
 * 核对补跑一次。
 */
describe('MinecraftWorld 蓝图放置判据的防抖逃生口', () => {
  interface Priv {
    bridge: unknown;
    blueprintResources: {
      sync(projects: unknown[]): boolean;
      openOverride(spec: { reason: string; ttlMs: number; maxBlocks: number }, now?: number): unknown;
    };
    blueprintInventoryTimer: unknown;
    observeBlueprintResources(): void;
    scheduleBlueprintResourceObservation(bot: unknown): void;
    permitBlueprintResourcePlacement(item: string): { ok: boolean; reason?: string };
  }

  function glassPlan() {
    const accepted = acceptBlueprint({
      key: 'home', site_mode: 'new', size_xyz: [2, 1, 2], axis_order: 'YZX',
      palette: ['minecraft:glass'], layers: [[[0, 0], [0, 0]]],
    });
    if (!accepted.ok || !accepted.plan) throw new Error('测试蓝图没通过');
    return accepted.plan;
  }

  it('槽位变动后立刻取 permit:用的是补跑核对之后的库存', () => {
    const m = new MinecraftWorld({ cfg: cfg() });
    const priv = m as unknown as Priv;
    let glass = 5;
    const bot = {
      inventory: { items: () => [{ name: 'glass', count: glass }] },
      game: { dimension: 'overworld' },
    };
    priv.bridge = { bot, retune: () => {} };
    priv.blueprintResources.sync([{ key: 'home', versionId: 'bpv_test', remaining: glassPlan().steps }]);
    priv.observeBlueprintResources(); // 基线:随身 5 块,reserve 4
    priv.blueprintResources.openOverride({ reason: '测试', ttlMs: 30_000, maxBlocks: 1 });

    glass = 3; // 掉进 reserve 一块,覆盖预算刚好够这一块
    priv.scheduleBlueprintResourceObservation(bot);
    expect(priv.blueprintInventoryTimer).not.toBeNull();

    const permit = priv.permitBlueprintResourcePlacement('glass');
    expect(priv.blueprintInventoryTimer).toBeNull();
    // 补跑的核对把这一块记进覆盖预算,预算见底 —— 不补跑就会再放出去一块
    expect(permit.ok).toBe(false);
    expect(permit.reason).toContain('蓝图 reserve 是 4');
  });
});

/**
 * 服务端就绪后回读实际难度，并投递可观测事件。
 */
describe('服务端难度回读的措辞与投递', () => {
  it('难度与 server.properties 对得上:点明是 properties 定的,并说清刷不刷怪', () => {
    const text = renderDifficultyFact({ difficulty: 'easy', raw: 'The difficulty is Easy', properties: 'easy' });
    expect(text).toContain('难度 easy');
    expect(text).toContain('server.properties 所定');
    expect(text).toContain('刷怪开');
  });

  it('和平模式:刷怪那一句反过来说', () => {
    const text = renderDifficultyFact({ difficulty: 'peaceful', raw: null, properties: 'peaceful' });
    expect(text).toContain('刷怪关');
  });

  it('回读值与 properties 对不上:两个数都念,点明现在生效的是哪一个', () => {
    const text = renderDifficultyFact({ difficulty: 'hard', raw: null, properties: 'easy' });
    expect(text).toContain('难度 hard');
    expect(text).toContain('server.properties 里写的是 easy');
    expect(text).toContain('现在生效的是这个');
  });

  it('问了没问出来:照实说没问出来,不拿 properties 冒充实际值', () => {
    const text = renderDifficultyFact({ difficulty: null, raw: null, properties: 'easy' });
    expect(text).toContain('没问出来');
    expect(text).toContain('server.properties 里写的是 easy');
    expect(text).not.toContain('刷怪');
  });

  it('bot 还没连上时先挂起,握手那一刻投一次;只投一次', async () => {
    const { m, host } = await started();
    try {
      const inner = m as any;
      const difficultyEvents = (): unknown[] => host.events.filter((e) => e.text.includes('难度 easy'));
      // 服务端就绪一定早于 bot 连上(bridge 正是在 running 那一拍才 start):这里把
      // bridge 摘掉冒充「还没连上」那一刻
      const bridge = inner.bridge;
      inner.bridge = null;
      inner.onServerDifficulty({ difficulty: 'easy', raw: 'The difficulty is Easy', properties: 'easy' });
      expect(difficultyEvents()).toHaveLength(0);
      inner.bridge = bridge;
      inner.flushDifficultyFact(); // onSpawn 里的那一脚
      expect(difficultyEvents()).toHaveLength(1);
      // 挂单已经清掉:再握手一次不重复说
      inner.flushDifficultyFact();
      expect(difficultyEvents()).toHaveLength(1);
    } finally {
      await m.stop();
    }
  });
});
