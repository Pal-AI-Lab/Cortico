import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  alreadyNear, escapeCandidates, formatCandidates, formatEscapeReceipt, normalizeDimension,
  parsePlayerDat, pickEscapeTarget, playerDatPath, readPlayerDatFile, resolveEscapeTarget,
  runEscape, spawnAt, tpLine,
} from '../../../src/worlds/minecraft/escape.ts';

/** NBT 标签字节,只用得到这四个:根化合物、int、string、结束 */
const TAG_END = 0;
const TAG_INT = 3;
const TAG_STRING = 8;
const TAG_COMPOUND = 10;

/** NBT 的字符串:两字节大端长度 + utf8 字节 */
function u16str(s: string): Buffer {
  const body = Buffer.from(s, 'utf8');
  const head = Buffer.alloc(2);
  head.writeUInt16BE(body.length);
  return Buffer.concat([head, body]);
}

/**
 * 只写 Spawn* 的最小 player.dat。
 *
 * 生产侧只读不写 player.dat(`parsePlayerDat` / `readPlayerDatFile`),写这一半
 * 唯一的用处是给读那一半造样本,所以编码器住在测试里。
 */
function encodePlayerDat(fields: {
  SpawnX: number;
  SpawnY: number;
  SpawnZ: number;
  SpawnDimension?: string;
}): Buffer {
  const tags: Record<string, number | string> = {
    SpawnX: fields.SpawnX,
    SpawnY: fields.SpawnY,
    SpawnZ: fields.SpawnZ,
  };
  if (fields.SpawnDimension) tags.SpawnDimension = fields.SpawnDimension;
  const chunks: Buffer[] = [Buffer.from([TAG_COMPOUND]), u16str('')];
  for (const [name, value] of Object.entries(tags)) {
    if (typeof value === 'number') {
      const body = Buffer.alloc(4);
      body.writeInt32BE(value | 0);
      chunks.push(Buffer.from([TAG_INT]), u16str(name), body);
    } else {
      chunks.push(Buffer.from([TAG_STRING]), u16str(name), u16str(value));
    }
  }
  chunks.push(Buffer.from([TAG_END]));
  return gzipSync(Buffer.concat(chunks));
}

describe('重生点解析', () => {
  it('维度收成 execute in 要的全名', () => {
    expect(normalizeDimension('overworld')).toBe('minecraft:overworld');
    expect(normalizeDimension('minecraft:the_nether')).toBe('minecraft:the_nether');
    expect(normalizeDimension('')).toBe('minecraft:overworld');
  });

  it('有床用床,没有才走世界出生点', () => {
    const bed = spawnAt({ x: 10, y: 70, z: -4 }, 'overworld', 'bed');
    const world = { x: 0, y: 64, z: 0 };
    expect(resolveEscapeTarget(bed, world)).toEqual(bed);
    expect(resolveEscapeTarget(null, world)?.source).toBe('world');
    expect(resolveEscapeTarget(null, null)).toBeNull();
  });

  it('同维度 4 格内算已经在', () => {
    const target = spawnAt({ x: 8, y: 64, z: 8 }, 'overworld', 'world');
    expect(alreadyNear({ x: 9, y: 64, z: 8 }, 'overworld', target)).toBe(true);
    expect(alreadyNear({ x: 20, y: 64, z: 8 }, 'overworld', target)).toBe(false);
    expect(alreadyNear({ x: 8, y: 64, z: 8 }, 'the_nether', target)).toBe(false);
  });

  /**
   * 安全锚候选包含床/重生锚、世界出生点及标为家或床的路标；按距离排序，不按来源加权。
   */
  it('候选按距离排,选最近的那个;不给任何一类加权', () => {
    const bed = spawnAt({ x: 5360, y: 76, z: 60 }, 'overworld', 'bed');
    const home = spawnAt({ x: 5200, y: 80, z: 50 }, 'overworld', 'mark', '家');
    const here = { x: 5210, y: 72, z: 53 };
    const list = escapeCandidates(bed, { x: 8, y: 64, z: 8 }, [home], here, 'overworld');
    expect(list.map((c) => c.target.source)).toEqual(['mark', 'bed', 'world']);
    expect(pickEscapeTarget(list, bed, { x: 8, y: 64, z: 8 })).toEqual(home);
    // 床更"权威"也不加分:它只是排在第二近
    expect(Math.round(list[0].distance!)).toBe(10);
  });

  it('同一格的重生点与路标算一个候选,不重复列', () => {
    const bed = spawnAt({ x: 20, y: 70, z: 4 }, 'overworld', 'bed');
    const sameBed = spawnAt({ x: 20.4, y: 70, z: 4.2 }, 'overworld', 'mark', '海边床');
    const list = escapeCandidates(bed, null, [sameBed], { x: 0, y: 64, z: 0 }, 'overworld');
    expect(list).toHaveLength(1);
    expect(list[0].target.source).toBe('bed');
  });

  it('同维度一个候选都没有时退回旧口径(个人重生点优先)', () => {
    const anchor = spawnAt({ x: 8, y: 70, z: 4 }, 'the_nether', 'anchor');
    const list = escapeCandidates(anchor, null, [], { x: 0, y: 64, z: 0 }, 'overworld');
    expect(list[0].distance).toBeNull();
    expect(pickEscapeTarget(list, anchor, null)).toEqual(anchor);
    expect(pickEscapeTarget([], null, { x: 1, y: 2, z: 3 })?.source).toBe('world');
    expect(pickEscapeTarget([], null, null)).toBeNull();
  });

  it('落点在她自己圈的危险区里:只报这个事实,不改变选点', () => {
    const bed = spawnAt({ x: 5360, y: 76, z: 60 }, 'overworld', 'bed');
    const far = spawnAt({ x: 4000, y: 64, z: 60 }, 'overworld', 'mark', '家');
    const list = escapeCandidates(
      bed, null, [far], { x: 5350, y: 72, z: 53 }, 'overworld',
      (t) => (t.source === 'bed' ? ['沙漠死亡区'] : []),
    );
    // 危险区不参与排序:床还是最近的那个
    expect(pickEscapeTarget(list, bed, null)).toEqual(bed);
    const text = formatCandidates(list, bed);
    expect(text).toContain('在你圈的危险区「沙漠死亡区」里');
    expect(text).toContain('←去的是这个');
    // 只有一个候选时不出这一段
    expect(formatCandidates([list[0]], bed)).toBe('');
  });

  it('传送指令落在目标格中心', () => {
    const t = spawnAt({ x: 10.2, y: 64, z: -3.8 }, 'overworld', 'bed');
    expect(tpLine('corti', t)).toBe('execute in minecraft:overworld run tp corti 10.5 64 -3.5');
  });

  /**
   * 已知不能站立的落点降级排序，仍保留为候选。
   */
  it('读出「站不住」的落点降级:近的实心格让位给远一点但能站的', () => {
    const home = spawnAt({ x: 5200, y: 70, z: 50 }, 'overworld', 'mark', '家');
    const bed = spawnAt({ x: 5360, y: 76, z: 60 }, 'overworld', 'bed');
    const here = { x: 5210, y: 72, z: 53 };
    const list = escapeCandidates(
      bed, null, [home], here, 'overworld', undefined,
      (t) => t.source !== 'mark' ? t : false, // 「家」那格实心
    );
    expect(list.map((c) => c.target.source)).toEqual(['bed', 'mark']);
    expect(pickEscapeTarget(list, bed, null)).toEqual(bed);
    expect(formatCandidates(list, bed)).toContain('落点按读数站不住人');
  });

  it('全不可站时不硬过滤:仍给最近的那个', () => {
    const home = spawnAt({ x: 5200, y: 70, z: 50 }, 'overworld', 'mark', '家');
    const bed = spawnAt({ x: 5360, y: 76, z: 60 }, 'overworld', 'bed');
    const list = escapeCandidates(
      bed, null, [home], { x: 5210, y: 72, z: 53 }, 'overworld', undefined,
      () => false,
    );
    // 都被降级 = 谁也不比谁高,还是按距离:家最近
    expect(pickEscapeTarget(list, bed, null)).toEqual(home);
    expect(list.every((c) => c.standable === false)).toBe(true);
  });

  it('没给可站性判据时不下结论:standable 为 null,排序与旧口径一致', () => {
    const home = spawnAt({ x: 5200, y: 70, z: 50 }, 'overworld', 'mark', '家');
    const bed = spawnAt({ x: 5360, y: 76, z: 60 }, 'overworld', 'bed');
    const list = escapeCandidates(bed, null, [home], { x: 5210, y: 72, z: 53 }, 'overworld');
    expect(list.map((c) => c.target.source)).toEqual(['mark', 'bed']);
    expect(list.every((c) => c.standable === null)).toBe(true);
    expect(formatCandidates(list, home)).not.toContain('站不住');
  });
});

describe('player.dat Spawn*', () => {
  it('写出再读回床坐标与维度', () => {
    const buf = encodePlayerDat({
      SpawnX: 12, SpawnY: 68, SpawnZ: -9,
      SpawnDimension: 'minecraft:the_nether',
    });
    expect(parsePlayerDat(buf)).toEqual(spawnAt({ x: 12, y: 68, z: -9 }, 'minecraft:the_nether', 'anchor'));
  });

  it('没睡过床(根化合物没有 SpawnX)就是没有个人重生点', () => {
    expect(parsePlayerDat(Buffer.from([0x0a, 0x00, 0x00, 0x00]))).toBeNull();
  });

  it('从文件路径读,文件不存在则空', () => {
    const dir = join(tmpdir(), `mc-escape-${Date.now()}`);
    const uuid = '11111111-1111-1111-1111-111111111111';
    const file = playerDatPath(dir, 'world', uuid);
    expect(readPlayerDatFile(file)).toBeNull();
    mkdirSync(join(dir, 'world', 'playerdata'), { recursive: true });
    writeFileSync(file, encodePlayerDat({ SpawnX: 3, SpawnY: 64, SpawnZ: 5 }));
    expect(readPlayerDatFile(file)).toEqual(spawnAt({ x: 3, y: 64, z: 5 }, 'overworld', 'bed'));
  });
});

describe('回执', () => {
  const bed = spawnAt({ x: 1, y: 64, z: 2 }, 'overworld', 'bed');
  it('按实际走到哪说,队列清没清写在同一句', () => {
    expect(formatEscapeReceipt('arrived', bed, '已叫停任务#1「吃东西」'))
      .toBe('已回到床重生点 [主世界] (1, 64, 2)。已叫停任务#1「吃东西」');
    expect(formatEscapeReceipt('already', spawnAt({ x: 0, y: 64, z: 0 }, 'overworld', 'world'), null))
      .toBe('已经在世界出生点附近 [主世界] (0, 64, 0)。队列本来就是空的');
    expect(formatEscapeReceipt('rejected', bed, null, { x: 100, y: 12, z: -30 }))
      .toContain('没能传送');
  });

  it('起点和重生点不在同一维度时不计算坐标直线距离', () => {
    const anchor = spawnAt({ x: 8, y: 70, z: 4 }, 'the_nether', 'anchor');
    const out = formatEscapeReceipt(
      'arrived', anchor, null, undefined,
      { x: 8, y: 70, z: 4, dimension: 'overworld' },
    );
    expect(out).toContain('已回到重生锚 [下界] (8, 70, 4)');
    expect(out).not.toContain('离你出发那儿');
  });
});

describe('runEscape', () => {
  function rig(over: {
    pos?: { x: number; y: number; z: number };
    /** `null` = 这个世界还没有出生点读数(候选里就只剩个人重生点) */
    spawn?: { x: number; y: number; z: number } | null;
    personal?: ReturnType<typeof spawnAt> | null;
    moveTo?: { x: number; y: number; z: number };
    dimension?: string;
    moveDimension?: string;
    consoleOk?: boolean;
  } = {}) {
    const pos = { ...(over.pos ?? { x: 100, y: 12, z: -30 }) };
    const bot = {
      entity: { position: pos },
      game: { dimension: over.dimension ?? 'overworld' },
      spawnPoint: over.spawn === null ? undefined : over.spawn ?? { x: 8, y: 64, z: 8 },
    };
    const chats: string[] = [];
    const consoles: string[] = [];
    let held = 0;
    let cleared = 0;
    const p = runEscape({
      getBot: () => bot,
      playerName: 'corti',
      personalSpawn: over.personal ?? null,
      clearQueue: () => {
        cleared++;
        return '已叫停任务#1「挖石头」';
      },
      sendConsole: (line) => {
        consoles.push(line);
        return over.consoleOk === true;
      },
      chat: (text) => { chats.push(text); },
      hold: (ms) => { held = ms; },
      waitMove: async () => {
        if (over.moveTo) Object.assign(pos, over.moveTo);
        if (over.moveDimension) bot.game.dimension = over.moveDimension;
        return Boolean(over.moveTo);
      },
      timeoutMs: 20,
    });
    return { p, chats, consoles, get held() { return held; }, get cleared() { return cleared; } };
  }

  /**
   * 短时间反复逃回同一处时报告次数，只陈述事实。
   */
  it('短时间反复逃回同一处:回执追一句「这是第 N 次」,只报事实', async () => {
    const bed = spawnAt({ x: 5360, y: 76, z: 60 }, 'overworld', 'bed');
    const out = formatEscapeReceipt(
      'arrived', bed, null, undefined,
      { x: 5340, y: 70, z: 45, dimension: 'overworld' },
      '这是 11 分钟内第 8 次回到同一张床。',
    );
    expect(out).toContain('已回到床重生点');
    expect(out).toContain('这是 11 分钟内第 8 次回到同一张床。');
    // 只陈述,不劝
    expect(out).not.toContain('建议');
    // 没有这句时一个字都不多
    expect(formatEscapeReceipt('arrived', bed, null)).not.toContain('第');
  });

  it('noteRepeat 接进 runEscape:三条路径的回执都带得上这句事实', async () => {
    const bed = spawnAt({ x: 8, y: 64, z: 8 }, 'overworld', 'bed');
    const seen: Array<{ x: number; y: number; z: number }> = [];
    const out = await runEscape({
      getBot: () => ({
        entity: { position: { x: 8.2, y: 64, z: 8.1 } },
        game: { dimension: 'overworld' },
        spawnPoint: { x: 8, y: 64, z: 8 },
      }),
      playerName: 'corti',
      personalSpawn: bed,
      clearQueue: () => null,
      sendConsole: () => true,
      chat: () => {},
      hold: () => {},
      waitMove: async () => true,
      timeoutMs: 20,
      noteRepeat: (target) => {
        seen.push({ x: target.x, y: target.y, z: target.z });
        return '这是 3 分钟内第 2 次回到同一张床。';
      },
    });
    expect(seen).toEqual([{ x: 8, y: 64, z: 8 }]);
    expect(out).toContain('这是 3 分钟内第 2 次回到同一张床。');
  });

  /** 反射的寻路目标按传送前的位置下的,不在发传送指令前撤掉,落地后会把人拽回原处。 */
  it('传送指令发出前撤掉反射的寻路目标,回执说撤了什么', async () => {
    const pos = { x: 100, y: 12, z: -30 };
    const consoles: string[] = [];
    let consolesAtDrop: number | null = null;
    const out = await runEscape({
      getBot: () => ({ entity: { position: pos }, game: { dimension: 'overworld' }, spawnPoint: { x: 8, y: 64, z: 8 } }),
      playerName: 'corti',
      personalSpawn: null,
      clearQueue: () => null,
      dropReflexGoal: () => {
        consolesAtDrop = consoles.length;
        return '撤掉了反射正在走的登岸寻路(目标 (-707, 63, 128))';
      },
      sendConsole: (line) => { consoles.push(line); return true; },
      chat: () => {},
      hold: () => {},
      waitMove: async () => { Object.assign(pos, { x: 8, y: 64, z: 8 }); return true; },
      timeoutMs: 20,
    });
    expect(consolesAtDrop).toBe(0);
    expect(consoles).toHaveLength(1);
    expect(out).toContain('撤掉了反射正在走的登岸寻路');
  });

  it('runEscape 走最近安全锚:去的是路标不是床,回执列全部候选与距离', async () => {
    const bed = spawnAt({ x: 5360, y: 76, z: 60 }, 'overworld', 'bed');
    const home = spawnAt({ x: 5200, y: 80, z: 50 }, 'overworld', 'mark', '家');
    const pos = { x: 5210, y: 72, z: 53 };
    const consoles: string[] = [];
    const out = await runEscape({
      getBot: () => ({
        entity: { position: pos },
        game: { dimension: 'overworld' },
        spawnPoint: { x: 8, y: 64, z: 8 },
      }),
      playerName: 'corti',
      personalSpawn: bed,
      safeMarks: [home],
      clearQueue: () => null,
      sendConsole: (line) => { consoles.push(line); return true; },
      chat: () => {},
      hold: () => {},
      waitMove: async () => { Object.assign(pos, { x: 5200.5, y: 80, z: 50.5 }); return true; },
      timeoutMs: 20,
    });
    expect(consoles[0]).toBe('execute in minecraft:overworld run tp corti 5200.5 80 50.5');
    expect(out).toContain('已回到你圈的「家」 [主世界] (5200, 80, 50)');
    expect(out).toContain('候选安全锚 3 个,按远近排');
    expect(out).toContain('床重生点 (5360, 76, 60)');
    expect(out).toContain('世界出生点 (8, 64, 8)');
    expect(out).toContain('←去的是这个');
    // 只报读数,不劝
    expect(out).not.toContain('建议');
  });

  it('传送被拒且仍在原锚的楼板格:离安全落脚格很近也不能报告到达', async () => {
    const anchor = spawnAt({ x: 20, y: 70, z: 4 }, 'overworld', 'mark', '家');
    const position = { x: 20.5, y: 70, z: 4.5 };
    const out = await runEscape({
      getBot: () => ({ entity: { position }, game: { dimension: 'overworld' } }),
      playerName: 'corti', personalSpawn: null, safeMarks: [anchor],
      landingAt: () => ({ x: 20, y: 71, z: 4 }),
      clearQueue: () => null, sendConsole: () => true, chat: () => {}, hold: () => {},
      waitMove: async () => false,
    });
    expect(out).toContain('没能传送');
    expect(out).toContain('本来会把你送到你圈的「家」 [主世界] (20, 71, 4)');
    expect(out).not.toContain('已回到');
    expect(out).not.toContain('已经在');
  });

  it('传送前先来了一个别的强制位置包:接着等,传送落地后报到达', async () => {
    const anchor = spawnAt({ x: -150, y: 70, z: 100 }, 'overworld', 'mark', '叹息之墙');
    const position = { x: -410.8, y: 63.1, z: 156.7 };
    let calls = 0;
    const out = await runEscape({
      getBot: () => ({ entity: { position }, game: { dimension: 'overworld' } }),
      playerName: 'corti', personalSpawn: null, safeMarks: [anchor],
      clearQueue: () => null, sendConsole: () => true, chat: () => {}, hold: () => {},
      waitMove: async () => {
        calls += 1;
        if (calls === 2) Object.assign(position, { x: -149.5, y: 70, z: 100.5 });
        return true;
      },
      timeoutMs: 1_000,
    });
    expect(calls).toBe(2);
    expect(out).toContain('已回到你圈的「叹息之墙」');
    expect(out).not.toContain('没能传送');
  });

  it('runEscape 全候选站不住:照去最近的,回执把这个事实说全', async () => {
    const home = spawnAt({ x: 5200, y: 70, z: 50 }, 'overworld', 'mark', '家');
    const pos = { x: 5210, y: 72, z: 53 };
    const out = await runEscape({
      getBot: () => ({
        entity: { position: pos },
        game: { dimension: 'overworld' },
        spawnPoint: undefined,
      }),
      playerName: 'corti',
      personalSpawn: null,
      safeMarks: [home],
      landingAt: () => false,
      clearQueue: () => null,
      sendConsole: () => true,
      chat: () => {},
      hold: () => {},
      waitMove: async () => { Object.assign(pos, { x: 5200.5, y: 70, z: 50.5 }); return true; },
      timeoutMs: 20,
    });
    expect(out).toContain('已回到你圈的「家」');
    expect(out).toContain('所有候选落点按世界读数都站不住人');
    // 只报事实,不劝
    expect(out).not.toContain('建议');
  });

  it('没有重生点也没有圈过地方:说清两样都没有', async () => {
    const out = await runEscape({
      getBot: () => ({
        entity: { position: { x: 0, y: 64, z: 0 } },
        game: { dimension: 'overworld' },
      }),
      playerName: 'corti',
      personalSpawn: null,
      clearQueue: () => null,
      sendConsole: () => true,
      chat: () => {},
      hold: () => {},
      waitMove: async () => true,
    });
    expect(out).toContain('还不知道出生点,也没有圈过可以去的地方');
  });

  it('已经在出生点附近只清队列,不发传送', async () => {
    const r = rig({ pos: { x: 8.2, y: 64, z: 8.1 } });
    const out = await r.p;
    expect(out).toContain('已经在世界出生点附近');
    expect(out).toContain('已叫停');
    expect(r.chats).toEqual([]);
    expect(r.consoles).toEqual([]);
    expect(r.cleared).toBe(1);
  });

  it('托管服走 stdin,到位后报重生点', async () => {
    const bed = spawnAt({ x: 20, y: 70, z: 4 }, 'overworld', 'bed');
    const r = rig({ personal: bed, consoleOk: true, moveTo: { x: 20.5, y: 70, z: 4.5 } });
    const out = await r.p;
    expect(out).toContain('已回到床重生点 [主世界]');
    expect(r.consoles[0]).toBe('execute in minecraft:overworld run tp corti 20.5 70 4.5');
    expect(r.chats).toEqual([]);
    expect(r.held).toBeGreaterThan(0);
  });

  /**
   * 世界出生点放在更远处，使床成为最近安全锚；用例检查远距离传送后的实际位移回执。
   */
  it('落点很远时回执照实说挪了多少格', async () => {
    const bed = spawnAt({ x: -900, y: 70, z: -30 }, 'overworld', 'bed');
    const r = rig({
      pos: { x: 100, y: 12, z: -30 },
      spawn: { x: 9000, y: 64, z: -30 },
      personal: bed,
      consoleOk: true,
      moveTo: { x: -899.5, y: 70, z: -29.5 },
    });
    const out = await r.p;
    expect(out).toContain('已回到床重生点 [主世界] (-900, 70, -30)');
    expect(out).toContain('离你出发那儿 1000 格');
  });

  it('传送被拒时也把本来的落点说出来', async () => {
    const bed = spawnAt({ x: -900, y: 70, z: -30 }, 'overworld', 'bed');
    const r = rig({ pos: { x: 100, y: 12, z: -30 }, spawn: { x: 9000, y: 64, z: -30 }, personal: bed });
    const out = await r.p;
    expect(out).toContain('本来会把你送到床重生点 [主世界] (-900, 70, -30)');
    expect(out).toContain('离你出发那儿 1000 格');
    expect(out).toContain('还在[主世界] (100, 12, -30)');
  });

  /**
   * 同维度的更近锚优先，不因来源是床或世界出生点改变排序。
   */
  it('世界出生点比床近时就去世界出生点(只按距离,不按来源)', async () => {
    const bed = spawnAt({ x: -900, y: 70, z: -30 }, 'overworld', 'bed');
    const r = rig({
      pos: { x: 100, y: 12, z: -30 },
      personal: bed,
      consoleOk: true,
      moveTo: { x: 8.5, y: 64, z: 8.5 },
    });
    const out = await r.p;
    expect(out).toContain('已回到世界出生点 [主世界] (8, 64, 8)');
    expect(out).toContain('床重生点 (-900, 70, -30) 1000 格');
  });

  it('没有 stdin 就走 bot 聊天,传不到位报拒了', async () => {
    const r = rig();
    const out = await r.p;
    expect(r.chats[0]).toMatch(/^\/execute in minecraft:overworld run tp corti /);
    expect(out).toContain('没能传送');
    expect(out).toContain('还在[主世界] (100, 12, -30)');
    expect(out).toContain('已叫停');
  });

  it('跨维度回重生锚按实际维度验收,回执不报伪造的直线距离', async () => {
    const anchor = spawnAt({ x: 8, y: 70, z: 4 }, 'the_nether', 'anchor');
    const r = rig({
      pos: { x: 8, y: 70, z: 4 },
      dimension: 'overworld',
      // 这个世界还没读到出生点:同维度一个候选都没有,退回"个人重生点优先"
      spawn: null,
      personal: anchor,
      consoleOk: true,
      moveTo: { x: 8.5, y: 70, z: 4.5 },
      moveDimension: 'the_nether',
    });
    const out = await r.p;
    expect(out).toContain('已回到重生锚 [下界] (8, 70, 4)');
    expect(out).not.toContain('离你出发那儿');
    expect(r.consoles[0]).toBe('execute in minecraft:the_nether run tp corti 8.5 70 4.5');
  });
});
