import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createBot, type Bot } from '../../src/bot.ts';
import { loadDeployment } from '../../src/deploy.ts';
import { withWorlds } from '../../src/world.ts';
import { loadBuiltinWorlds } from '../../src/worlds/index.ts';
import cortiv, { type CortiVConfig } from '../../bots/cortiv/index.ts';

const builtinWorlds = await loadBuiltinWorlds();

/** 与启动器同一条线:仓内全部实现并进定义,扩展不装。 */
const definition = withWorlds(cortiv, builtinWorlds);

let dir: string;
let bot: Bot<CortiVConfig> | null = null;

/**
 * 装配但不启动:激活/停用只改槽位表与 config.json,core 没起时不 start World,
 * 所以这里不会真去拉 MC 服务端。外部扩展不装,所以 `vtuber`、`asr`、`pvz`、`canvas`
 * 只剩 missing 卡。
 */
function assemble(worlds: Record<string, Record<string, unknown>>) {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ worlds }), 'utf8');
  const loaded = loadDeployment(definition, dir, resolve(import.meta.dirname, '../..'));
  loaded.config.web.port = 0;
  bot = createBot(loaded, definition);
  return {
    assembly: bot.assembly,
    config: () => JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as CortiVConfig,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cortiv-activation-'));
});
afterEach(async () => {
  await bot?.stop();
  bot = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('CortiV 的 World 激活开关(热生效)', () => {
  it('激活直播间:写回 config.json 并挂进挂载表,不重启进程', async () => {
    const a = assemble({
      terminal: { enabled: true },
      minecraft: { enabled: false }, bilibili: { enabled: false },
    });
    expect(a.assembly.mounted.map((m) => m.id)).not.toContain('bilibili');
    expect(await a.assembly.activate('bilibili')).toContain('已启用');
    expect(a.config().worlds.bilibili.enabled).toBe(true);
    expect(a.assembly.mounted.map((m) => m.id)).toContain('bilibili');
    expect(a.assembly.slot('bilibili').mounted).toBe(true);
  });

  it('房间号与凭证已经填过时,开关只动 enabled', async () => {
    const a = assemble({
      terminal: { enabled: true },
      bilibili: { enabled: false, roomId: 7734200, sessdata: 'abc' },
    });
    await a.assembly.activate('bilibili');
    expect(a.config().worlds.bilibili).toMatchObject({ enabled: true, roomId: 7734200, sessdata: 'abc' });
  });

  it('停用写回 enabled=false 并撤出挂载表;停最后一个也允许', async () => {
    const a = assemble({
      terminal: { enabled: true },
      minecraft: { enabled: false }, bilibili: { enabled: false },
    });
    for (const id of a.assembly.mounted.map((m) => m.id).filter((id) => id !== 'terminal')) {
      await a.assembly.deactivate(id);
    }
    expect(a.assembly.mounted.map((m) => m.id)).toEqual(['terminal']);
    expect(await a.assembly.deactivate('terminal')).toContain('已停用');
    expect(a.config().worlds.terminal.enabled).toBe(false);
    expect(a.assembly.mounted).toEqual([]);
    // 停用后槽位上是一个全新实例,再激活按当前配置重建
    await a.assembly.activate('terminal');
    expect(a.assembly.mounted.map((m) => m.id)).toEqual(['terminal']);
  });

  it('声明过但没装实现的 World 进 missing,不是激活开关的作用域', async () => {
    const a = assemble({ terminal: { enabled: true }, bilibili: { enabled: false } });
    // vtuber、asr、pvz、canvas 的实现都是扩展包,这里没装。
    await expect(a.assembly.activate('vtuber')).rejects.toThrow('未知 World');
    expect(a.assembly.missing.map((m) => m.id)).toEqual(['vtuber', 'asr', 'pvz', 'canvas']);
  });

  it('仓内有实现但 Persona 没声明的 World 是部署侧选配:有槽位、默认不挂', () => {
    const a = assemble({ terminal: { enabled: true } });
    expect(a.assembly.slot('qq')).toMatchObject({ mounted: false, declared: false });
    expect(a.assembly.mounted.map((m) => m.id)).not.toContain('qq');
  });
});
