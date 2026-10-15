/** 验证未启动 World 的状态灯声明:非空、名称唯一、状态合法且数量不超限。 */
import { describe, expect, it } from 'vitest';
import { MODULE_LAMP_MAX, type World, type WorldLamp } from '../src/core/types.ts';
import { BilibiliWorld } from '../src/worlds/bilibili/world.ts';
import { WebUiFixtureWorld } from '../src/worlds/webui-fixture/world.ts';
import { MinecraftWorld } from '../src/worlds/minecraft/world.ts';
import { MINECRAFT_DEFAULTS, type MinecraftConfigSection } from '../src/worlds/minecraft/config.ts';
import { QQWorld } from '../src/worlds/qq/world.ts';
import { ConsoleWorld } from '../src/worlds/console/world.ts';
import { WebSearchWorld } from '../src/worlds/websearch/world.ts';

const mcCfg = structuredClone({ ...MINECRAFT_DEFAULTS, enabled: true }) as MinecraftConfigSection;

const MODULES: Array<() => World> = [
  () => new BilibiliWorld({ roomId: 0 }),
  () => new WebUiFixtureWorld(),
  () => new MinecraftWorld({ cfg: mcCfg }),
  () => new QQWorld({ wsUrl: 'ws://127.0.0.1:1', groups: [], privates: [], token: '' }),
  () => new ConsoleWorld(),
  () => new WebSearchWorld({ apiKey: 'k' }),
];

const STATES: ReadonlyArray<WorldLamp['state']> = ['online', 'loading', 'error', 'offline'];

describe('状态灯契约', () => {
  it.each(MODULES.map((make) => [make().id, make] as const))(
    '%s:状态灯名称唯一、状态合法且数量不超限',
    (_id, make) => {
      const lamps = make().webUi?.()?.lamps ?? [];
      expect(lamps.length, 'World 必须声明状态灯')
        .toBeGreaterThan(0);
      expect(lamps.length).toBeLessThanOrEqual(MODULE_LAMP_MAX);
      for (const lamp of lamps) {
        expect(STATES).toContain(lamp.state);
        expect(lamp.label, '状态灯必须有名称').toBeTruthy();
        if (lamp.hint !== undefined) expect(typeof lamp.hint).toBe('string');
      }

      expect(new Set(lamps.map((l) => l.label)).size).toBe(lamps.length);
    },
  );
});

describe('几个具体判据', () => {
  const lampsOf = (mod: World): WorldLamp[] => mod.webUi?.()?.lamps ?? [];
  const find = (mod: World, label: string): WorldLamp | undefined =>
    lampsOf(mod).find((l) => l.label === label);

  it('World 内部那几条链路各占一颗，不合成一颗聚合灯', () => {
    expect(lampsOf(new MinecraftWorld({ cfg: mcCfg })).map((l) => l.label))
      .toEqual(['服务器', '任务', '画面']);
  });

  it('没配密钥是灰：部署没填不算运行出错', () => {
    expect(find(new WebSearchWorld({ apiKey: '' }), '密钥')?.state).toBe('offline');
    expect(find(new WebSearchWorld({ apiKey: 'k' }), '密钥')?.state).toBe('online');
  });

  it('QQ 连不上协议端是红，名单空着只是灰：一个是失联，一个是没设监听', () => {
    const mod = new QQWorld({ wsUrl: 'ws://127.0.0.1:1', groups: [], privates: [], token: '' });
    expect(find(mod, '协议端')).toEqual({ label: '协议端', state: 'error', hint: '未连接' });
    expect(find(mod, '监听')?.state).toBe('offline');
  });

  it('控制台对话没人在线仍是绿：没人说话不是故障', () => {
    expect(lampsOf(new ConsoleWorld())).toEqual([
      { label: '对话通道', state: 'online', hint: '无人在线' },
    ]);
  });

  it('未启动的引擎显示 offline', () => {
    expect(find(new MinecraftWorld({ cfg: mcCfg }), '服务器')).toEqual({
      label: '服务器', state: 'offline', hint: '未启动',
    });
  });
});
