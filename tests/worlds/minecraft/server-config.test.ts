import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  accessFrom, applyAccess, applySettings, ensureOps, flatPresets, grantOp, isOp, listWorlds,
  parseProperties, readOps, readProperty, resolveUuid, revokeOp, settingsFrom,
  stringifyProperties, validGeneratorSettings, validWorldName, writeOps, writeProperty,
} from '../../../src/worlds/minecraft/server-config.ts';
import { offlineUuid } from '../../../src/worlds/minecraft/client-launch.ts';

const SAMPLE = [
  '#Minecraft server properties',
  '#Mon Aug 04 00:00:00 CST 2026',
  'gamemode=survival',
  'difficulty=easy',
  'level-name=world',
  'pvp=true',
  'spawn-monsters=true',
  'motd=A Minecraft Server',
].join('\n');

describe('server.properties 读写', () => {
  it('注释、顺序、不认识的键原样留着', () => {
    const lines = parseProperties(SAMPLE);
    const out = stringifyProperties(writeProperty(lines, 'difficulty', 'hard'));
    expect(out.split('\n')[0]).toBe('#Minecraft server properties');
    expect(out).toContain('motd=A Minecraft Server');
    expect(out).toContain('difficulty=hard');
    expect(out).not.toContain('difficulty=easy');
    expect(out.split('\n')).toHaveLength(SAMPLE.split('\n').length);
  });

  it('没有的键追加到末尾', () => {
    const out = stringifyProperties(writeProperty(parseProperties(SAMPLE), 'level-seed', '12345'));
    expect(out.trimEnd().endsWith('level-seed=12345')).toBe(true);
  });

  it('反斜杠转义、换行压平:值是人填进来的', () => {
    const lines = writeProperty(parseProperties(SAMPLE), 'level-seed', 'a\\b\nc');
    expect(readProperty(lines, 'level-seed')).toBe('a\\\\b c');
  });

  it('缺键与写坏的值都退回默认,不把界面搞成空的', () => {
    const s = settingsFrom(parseProperties('gamemode=乱写\ndifficulty=\n'));
    expect(s).toMatchObject({
      gamemode: 'survival', difficulty: 'easy', hardcore: false, pvp: true,
      spawnMonsters: true, levelSeed: '', levelName: 'world',
    });
  });

  it('applySettings 只动给了的那几项', () => {
    const before = parseProperties(SAMPLE);
    const after = applySettings(before, { difficulty: 'peaceful', hardcore: true });
    expect(readProperty(after, 'difficulty')).toBe('peaceful');
    expect(readProperty(after, 'hardcore')).toBe('true');
    expect(readProperty(after, 'gamemode')).toBe('survival'); // 没给就不动
  });
});

describe('存档名校验', () => {
  it('路径分隔符与相对路径挡掉', () => {
    expect(validWorldName('world')).toBeNull();
    expect(validWorldName('我的世界 2')).toBeNull();
    expect(validWorldName('')).toContain('不能为空');
    expect(validWorldName('a/b')).toContain('不能有');
    expect(validWorldName('..')).toContain('不能用');
    expect(validWorldName('x'.repeat(65))).toContain('太长');
  });
});

describe('存档枚举', () => {
  function serverDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mcsrv-'));
    for (const name of ['world', 'world_nether', 'world_the_end', 'creative-test', 'plugins']) {
      mkdirSync(join(dir, name), { recursive: true });
    }
    for (const name of ['world', 'world_nether', 'world_the_end', 'creative-test']) {
      writeFileSync(join(dir, name, 'level.dat'), 'x');
    }
    return dir;
  }

  it('只列存档本体:下界与末地是同一个世界的另外两维', () => {
    const worlds = listWorlds(serverDir(), 'world');
    expect(worlds.map((w) => w.name).sort()).toEqual(['creative-test', 'world']);
    // 另外两维不是存档,但算进那个世界的占盘,并作为它已生成的维度露出来
    expect(worlds.find((w) => w.name === 'world')?.dimensions).toEqual(['nether', 'the_end']);
    expect(worlds.find((w) => w.name === 'creative-test')?.dimensions).toEqual([]);
  });

  it('最近活跃的排前面', () => {
    const dir = serverDir();
    const old = new Date('2026-01-01T00:00:00Z');
    utimesSync(join(dir, 'world', 'level.dat'), old, old);
    expect(listWorlds(dir, 'world').map((w) => w.name)).toEqual(['creative-test', 'world']);
  });

  it('占盘算上下界与末地', () => {
    const dir = serverDir();
    writeFileSync(join(dir, 'world', 'region.mca'), Buffer.alloc(4096));
    writeFileSync(join(dir, 'world_nether', 'region.mca'), Buffer.alloc(2048));
    const world = listWorlds(dir, 'world').find((w) => w.name === 'world');
    expect(world!.sizeBytes).toBeGreaterThanOrEqual(4096 + 2048);
  });

  it('没有 level.dat 的目录不是存档', () => {
    expect(listWorlds(serverDir(), 'world').map((w) => w.name)).not.toContain('plugins');
  });

  it('配着但还没生成的那个也在列表里,标成未生成', () => {
    const worlds = listWorlds(serverDir(), '还没开的世界');
    const pending = worlds.find((w) => w.name === '还没开的世界');
    expect(pending).toMatchObject({ generated: false, modified: null });
  });

  it('目录不存在时给空表而不是抛', () => {
    expect(listWorlds('', 'world')).toEqual([
      { name: 'world', generated: false, modified: null, sizeBytes: 0, dimensions: [], info: null },
    ]);
    expect(listWorlds(join(tmpdir(), 'nope-' + Date.now()), '')).toEqual([]);
  });
});

describe('世界生成项', () => {
  it('level-type 认新旧两种写法,认不出的退回默认', () => {
    const t = (raw: string): string => settingsFrom(parseProperties(`level-type=${raw}`)).levelType;
    expect(t('minecraft:flat')).toBe('minecraft:flat');
    expect(t('flat')).toBe('minecraft:flat');
    expect(t('largeBiomes')).toBe('minecraft:large_biomes');
    expect(t('default')).toBe('minecraft:normal');
    expect(t('乱写')).toBe('minecraft:normal');
  });

  it('数值项越界钳回范围,写坏了退回默认', () => {
    const s = settingsFrom(parseProperties([
      'spawn-protection=9999', 'view-distance=1', 'simulation-distance=abc',
    ].join('\n')));
    expect(s).toMatchObject({ spawnProtection: 512, viewDistance: 2, simulationDistance: 10 });
  });

  it('applySettings 写生成项;没给的键一个不动', () => {
    const after = applySettings(parseProperties(SAMPLE), {
      levelType: 'minecraft:flat',
      generatorSettings: flatPresets('zh')[0].json,
      generateStructures: false,
      maxWorldSize: 5000,
    });
    expect(readProperty(after, 'level-type')).toBe('minecraft:flat');
    expect(readProperty(after, 'generate-structures')).toBe('false');
    expect(readProperty(after, 'max-world-size')).toBe('5000');
    expect(readProperty(after, 'allow-nether')).toBeNull();
  });

  it('自带的超平坦预设都是合法 JSON 对象', () => {
    for (const preset of flatPresets('zh')) {
      expect(validGeneratorSettings(preset.json), preset.id).toBeNull();
      expect(JSON.parse(preset.json)).toHaveProperty('biome');
    }
  });

  it('生成器细则:空放行,坏 JSON 与数组都拦下', () => {
    expect(validGeneratorSettings('')).toBeNull();
    expect(validGeneratorSettings('  ')).toBeNull();
    expect(validGeneratorSettings('{坏')).toContain('不是合法 JSON');
    expect(validGeneratorSettings('[1,2]')).toContain('JSON 对象');
  });
});

describe('权限项(server.properties 里与"谁能下命令"有关的那几个)', () => {
  it('缺键按 Minecraft 自己的默认来:op 4 级、命令方块关、正版验证开', () => {
    expect(accessFrom(parseProperties(''))).toEqual({
      opPermissionLevel: 4,
      enableCommandBlock: false,
      allowFlight: false,
      onlineMode: true,
      whiteList: false,
    });
  });

  it('等级越界钳回 1-4', () => {
    expect(accessFrom(parseProperties('op-permission-level=9')).opPermissionLevel).toBe(4);
    expect(accessFrom(parseProperties('op-permission-level=0')).opPermissionLevel).toBe(1);
  });

  it('applyAccess 只动给了的那几项', () => {
    const after = applyAccess(parseProperties(['online-mode=true', 'pvp=true'].join('\n')), {
      onlineMode: false,
    });
    expect(readProperty(after, 'online-mode')).toBe('false');
    expect(readProperty(after, 'pvp')).toBe('true');
    expect(readProperty(after, 'white-list')).toBeNull();
  });
});

describe('管理员名单(ops.json)', () => {
  const dir = (): string => mkdtempSync(join(tmpdir(), 'mcops-'));

  it('没有文件时是空名单,不抛', () => {
    expect(readOps(dir())).toEqual([]);
    expect(readOps('')).toEqual([]);
  });

  it('写坏的 JSON 当作没有名单:面板照样能开', () => {
    const d = dir();
    writeFileSync(join(d, 'ops.json'), '{坏');
    expect(readOps(d)).toEqual([]);
  });

  it('名字→UUID:先问 usercache,没见过的按离线账号算', () => {
    const d = dir();
    writeFileSync(join(d, 'usercache.json'), JSON.stringify([
      { name: 'CortiV', uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    ]));
    expect(resolveUuid(d, 'CortiV')).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(resolveUuid(d, 'Phant')).toBe(offlineUuid('Phant'));
  });

  it('授权写进名单;已经有了就不重复加', () => {
    const d = dir();
    const first = grantOp([], d, 'CortiV');
    expect(first.changed).toBe(true);
    expect(first.ops).toEqual([
      { uuid: offlineUuid('CortiV'), name: 'CortiV', level: 4, bypassesPlayerLimit: false },
    ]);
    expect(grantOp(first.ops, d, 'CortiV').changed).toBe(false);
    // 等级只抬不降:名单里是 2 级时要 4 级算改动
    const low = [{ uuid: offlineUuid('X'), name: 'X', level: 2, bypassesPlayerLimit: false }];
    expect(grantOp(low, d, 'X').ops[0].level).toBe(4);
  });

  it('收回按 UUID 或名字认人,没这条就不算改动', () => {
    const d = dir();
    const ops = grantOp([], d, 'CortiV').ops;
    expect(revokeOp(ops, d, 'CortiV')).toEqual({ ops: [], changed: true });
    expect(revokeOp(ops, d, '别人').changed).toBe(false);
  });

  it('isOp 认的是这个名字的那条', () => {
    const d = dir();
    const ops = grantOp([], d, 'CortiV').ops;
    expect(isOp(ops, d, 'CortiV')?.level).toBe(4);
    expect(isOp(ops, d, 'Phant')).toBeUndefined();
  });

  it('ensureOps 只补不删,并把名单落盘', () => {
    const d = dir();
    writeOps(d, grantOp([], d, 'CortiCam').ops);
    expect(ensureOps(d, ['CortiV', 'CortiCam', 'Phant'])).toEqual(['CortiV', 'Phant']);
    const after = readOps(d);
    expect(after.map((e) => e.name)).toEqual(['CortiCam', 'CortiV', 'Phant']);
    expect(after.every((e) => e.level === 4)).toBe(true);
    // 已经齐了就不再动文件内容
    expect(ensureOps(d, ['CortiV'])).toEqual([]);
    expect(JSON.parse(readFileSync(join(d, 'ops.json'), 'utf8'))).toHaveLength(3);
  });

  it('空名字与不存在的目录都不写文件', () => {
    const d = dir();
    expect(ensureOps(d, ['  '])).toEqual([]);
    expect(readOps(d)).toEqual([]);
    expect(ensureOps(join(tmpdir(), 'nope-mcops'), ['CortiV'])).toEqual([]);
  });
});
