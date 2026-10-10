/**
 * Minecraft 面板声明使用局部 id 与标题，适配器保留 id、标题和说明。
 * mount 按方法名前缀分派到对应链路；浏览器插件的面板键须与 World 声明一致。
 */
import { describe, it, expect } from 'vitest';
import { MINECRAFT_DEFAULTS, type MinecraftConfigSection } from '../../src/worlds/minecraft/config.ts';
import { MinecraftWorld } from '../../src/worlds/minecraft/world.ts';
import { MinecraftWorldProxy } from '../../src/worlds/minecraft/proxy.ts';
import { ioPageContribution } from '../../src/bot.ts';
import type { WorldPanelDecl } from '../../src/core/types.ts';

/**
 * 插件是浏览器端代码(DOM 类型,由 tsconfig.web.json 单独 check)。
 * specifier 存进变量,免得根 tsconfig 把它拉进 Node 那份检查——
 * 与 worlds-qq-console.test.ts 同一个理由。
 */
const MC_BUNDLE_ENTRY = '../../src/worlds/minecraft/console/client.ts';

const mc = (): MinecraftWorld =>
  new MinecraftWorld({
    cfg: structuredClone(MINECRAFT_DEFAULTS) as unknown as MinecraftConfigSection,
  });

// ---------------------------------------------------------------------------

describe('Minecraft 的面板声明', () => {
  it('五个面板都是局部 id + 真标题,不带 World 名前缀', () => {
    const panels = mc().console().panels ?? [];
    expect(panels.every((p) => typeof p === 'object')).toBe(true);
    expect((panels as WorldPanelDecl[]).map((p) => p.id))
      .toEqual(['mount', 'skin', 'world', 'access', 'log']);
    expect((panels as WorldPanelDecl[]).map((p) => p.title))
      .toEqual(['挂载', '皮肤', '存档与玩法', '权限与作弊', 'World 日志']);
    for (const p of panels as WorldPanelDecl[]) expect(p.description).toBeTruthy();
  });

  it('适配成 provider 贡献后:id 原样、标题与说明照带', () => {
    const c = ioPageContribution('minecraft', 'Minecraft', undefined, mc());
    expect(c.id).toBe('world:minecraft');
    expect(c.panels?.map((p) => p.id)).toEqual(['mount', 'skin', 'world', 'access', 'log']);
    expect(c.panels?.map((p) => p.title))
      .toEqual(['挂载', '皮肤', '存档与玩法', '权限与作弊', 'World 日志']);
    expect(c.panels?.[0].description).toContain('观察者客户端');
  });

  it('子进程代理报的面板与真 World 逐字一致(真实部署走的是代理那条)', () => {
    const proxy = new MinecraftWorldProxy({
      cfg: structuredClone(MINECRAFT_DEFAULTS) as unknown as MinecraftConfigSection,
    });
    expect(proxy.console().panels).toEqual(mc().console().panels);
  });

  it('配置组也是代理与真 World 同一份:漏一组就是那些项在控制台里根本改不了', () => {
    const proxy = new MinecraftWorldProxy({
      cfg: structuredClone(MINECRAFT_DEFAULTS) as unknown as MinecraftConfigSection,
    });
    expect(proxy.console().config?.map((g) => g.id)).toEqual(mc().console().config?.map((g) => g.id));
  });
});

describe('invoke 按局部 id 分派', () => {
  it('mount 按方法名前缀分派到对应链路', async () => {
    const c = ioPageContribution('minecraft', 'Minecraft', undefined, mc());
    // 客户端那条不碰网络:纯读配置与 versions/ 目录,拿它验分派到位
    const st = await c.invoke!('mount', 'client.state', []) as { username: string };
    expect(st.username).toBe(MINECRAFT_DEFAULTS.client.username);
  });

  it('玩家客户端是 mount 的第四条链路,它多一个 teleport', async () => {
    const c = ioPageContribution('minecraft', 'Minecraft', undefined, mc());
    const st = await c.invoke!('mount', 'player.state', []) as { username: string };
    expect(st.username).toBe(MINECRAFT_DEFAULTS.player.username);
    // 没有服务器也没有 bot:回执说清是谁下不了这条指令,而不是抛错
    const tp = await c.invoke!('mount', 'player.teleport', []) as { detail: string };
    expect(tp.detail).toContain('传送');
    await expect(c.invoke!('mount', 'client.teleport', [])).rejects.toThrow('未知面板方法');
  });

  it('mount 上不认识的链路、不认识的方法、以及漏了链路前缀都报"未知面板方法"', async () => {
    const c = ioPageContribution('minecraft', 'Minecraft', undefined, mc());
    await expect(c.invoke!('mount', 'nope.state', [])).rejects.toThrow('未知面板方法');
    await expect(c.invoke!('mount', 'client.nope', [])).rejects.toThrow('未知面板方法');
    await expect(c.invoke!('mount', 'state', [])).rejects.toThrow('未知面板方法');
  });

  it('log/world 直达 World;不认识的面板报"未知面板"', async () => {
    const c = ioPageContribution('minecraft', 'Minecraft', undefined, mc());
    expect(await c.invoke!('log', 'entries', [0])).toEqual({ entries: [] });
    await expect(c.invoke!('log', 'nope', [])).rejects.toThrow('未知面板方法');
    await expect(c.invoke!('nope', 'x', [])).rejects.toThrow('未知面板');
  });

  it('权限面板没配服务器目录时不抛错,回一句无法修改', async () => {
    const c = ioPageContribution('minecraft', 'Minecraft', undefined, mc());
    const st = await c.invoke!('access', 'state', []) as { configured: boolean; detail: string };
    expect(st.configured).toBe(false);
    expect(st.detail).toContain('serverDir');
    const after = await c.invoke!('access', 'setOp', ['CortiV', true]) as { detail: string };
    expect(after.detail).toContain('无法在这里修改');
    await expect(c.invoke!('access', 'nope', [])).rejects.toThrow('未知面板方法');
  });

  it('皮肤面板报的是两个角色各穿哪一张;不认识的角色与没选皮肤都不抛到裸错', async () => {
    const c = ioPageContribution('minecraft', 'Minecraft', undefined, mc());
    const st = await c.invoke!('skin', 'state', []) as {
      roles: Array<{ role: string; username: string }>;
      dirs: { camera: string };
    };
    expect(st.roles.map((r) => r.role)).toEqual(['bot', 'player']);
    expect(st.roles.map((r) => r.username))
      .toEqual([MINECRAFT_DEFAULTS.username, MINECRAFT_DEFAULTS.player.username]);
    // 客户端目录没有内置默认值:未配置就是空串,面板据此提示去填 worlds.minecraft.client.gameDir
    expect(st.dirs.camera).toBe('');
    await expect(c.invoke!('skin', 'set', ['camera', ''])).rejects.toThrow('没有这个角色');
    await expect(c.invoke!('skin', 'nope', [])).rejects.toThrow('未知面板方法');
  });

  it('server/client panel id 调用对应控制接口', async () => {
    const c = ioPageContribution('minecraft', 'Minecraft', undefined, mc());
    const viaLane = await c.invoke!('client', 'state', []) as { versionId: string };
    const viaMount = await c.invoke!('mount', 'client.state', []) as { versionId: string };
    expect(viaMount).toEqual(viaLane);
  });
});

describe('浏览器插件', () => {
  it('default export 的面板键与服务端声明的局部 id 一一对应,且都能 mount', async () => {
    const bundle = ((await import(MC_BUNDLE_ENTRY)) as any).default;
    const declared = (mc().console().panels ?? []) as WorldPanelDecl[];
    expect(Object.keys(bundle.panels).sort()).toEqual(declared.map((p) => p.id).sort());
    for (const id of declared.map((p) => p.id)) {
      expect(typeof bundle.panels[id].mount).toBe('function');
    }
  });
});
