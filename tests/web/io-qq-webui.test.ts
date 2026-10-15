/**
 * QQ 面板声明使用局部 id 与标题，适配器原样传递声明。
 * 浏览器扩展的面板键须与服务端声明一致。
 */
import { describe, it, expect } from 'vitest';
import { QQWorld } from '../../src/worlds/qq/world.ts';
import { ioPageContribution } from '../../src/bot.ts';
import type {
  World,
  WorldWebUiDecl,
  WorldPanelDecl,
  ToolDef,
} from '../../src/core/types.ts';

/**
 * 扩展是浏览器端代码(DOM 类型,由 tsconfig.web.json 单独 check)。
 * specifier 存进变量,免得根 tsconfig 把它拉进 Node 那份检查——
 * 与 client-ui.test.ts 同一个理由。
 */
const QQ_BUNDLE_ENTRY = '../../src/worlds/qq/webui/client.ts';

/** 只声明 webUi() 的假 World,用来验适配器对两种声明形态一视同仁。 */
class FakeWorld implements World {
  constructor(
    readonly id: string,
    private readonly decl: WorldWebUiDecl,
  ) {}

  envPromptVars(): Record<string, string> { return {}; }
  tools(): ToolDef[] { return []; }
  webUi(): WorldWebUiDecl { return this.decl; }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

const qq = (): QQWorld =>
  new QQWorld({ wsUrl: 'ws://127.0.0.1:3001', groups: [111], privates: [222], token: '' });

// ---------------------------------------------------------------------------

describe('QQ 的面板声明', () => {
  it('三个面板都是局部 id + 真标题,不带 World 名前缀', () => {
    const panels = qq().webUi().panels ?? [];
    expect(panels.every((p) => typeof p === 'object')).toBe(true);
    expect((panels as WorldPanelDecl[]).map((p) => p.id)).toEqual(['gate', 'roster', 'events']);
    expect((panels as WorldPanelDecl[]).map((p) => p.title)).toEqual(['接入门', '监听名单', '事件']);
    for (const p of panels as WorldPanelDecl[]) expect(p.description).toBeTruthy();
  });

  it('适配成 provider 贡献后:id 原样、标题与说明照带', () => {
    const c = ioPageContribution('qq', 'QQ', undefined, qq());
    expect(c.id).toBe('world:qq');
    expect(c.panels?.map((p) => p.id)).toEqual(['gate', 'roster', 'events']);
    expect(c.panels?.map((p) => p.title)).toEqual(['接入门', '监听名单', '事件']);
    expect(c.panels?.[0].description).toContain('接入开关');
  });

});

/**
 * 面板声明只有 { id, title, description? } 对象形态，id 为局部标识；适配器原样传递。
 */
describe('适配器不改写 panel id', () => {
  it('id / 标题 / 说明一律原样进 manifest', () => {
    const mod = new FakeWorld('demo', {
      panels: [{ id: 'gate', title: '接入门' }, { id: 'log', title: '日志', description: '说明' }],
    });
    const c = ioPageContribution('demo', 'Demo', undefined, mod);
    expect(c.panels).toEqual([
      { id: 'gate', title: '接入门' },
      { id: 'log', title: '日志', description: '说明' },
    ]);
  });

  it('panel id 原样传给处理函数', () => {
    const mod = new FakeWorld('demo', { panels: [{ id: 'demo-gate', title: 'X' }] });
    const c = ioPageContribution('demo', 'Demo', undefined, mod);
    expect(c.panels?.[0].id).toBe('demo-gate');
  });

  it('invoke 收到的就是声明里那个 id,不做任何反向改写', async () => {
    const seen: string[] = [];
    const mod = new FakeWorld('demo', {
      panels: [{ id: 'demo-old', title: 'A' }, { id: 'new', title: 'B' }],
      invoke: async (panel) => { seen.push(panel); return null; },
    });
    const c = ioPageContribution('demo', 'Demo', undefined, mod);
    for (const p of ['demo-old', 'new', 'ghost']) await c.invoke!(p, 'ping', []);
    expect(seen).toEqual(['demo-old', 'new', 'ghost']);
  });
});

describe('QQ 的 invoke 按局部 id 分派', () => {
  it('provider 通道上的 gate/roster/events 直达 World,不再拼前缀', async () => {
    const c = ioPageContribution('qq', 'QQ', undefined, qq());
    // gate/roster 没接装配层数据面 → 报"不可用"(而不是"未知面板"),说明分派到位了
    await expect(c.invoke!('gate', 'state', [])).rejects.toThrow('不可用');
    await expect(c.invoke!('roster', 'get', [])).rejects.toThrow('不可用');
    // events 不依赖 gate,未启动时报的是 World 自己的措辞
    await expect(c.invoke!('events', 'list', [{}])).rejects.toThrow('未启动');
    await expect(c.invoke!('nope', 'x', [])).rejects.toThrow('未知面板');
  });

  it('roster/events 各有 names:两个面板都要名字,而 ctx.invoke 只能打到本面板', async () => {
    const c = ioPageContribution('qq', 'QQ', undefined, qq());
    const expected = {
      groups: [{ id: 111, name: '111', card: '' }],
      privates: [{ id: 222, name: '' }],
    };
    // names 不经装配层的 gate 数据面:名单读不出来时至少名字还在
    expect(await c.invoke!('roster', 'names', [])).toEqual(expected);
    expect(await c.invoke!('events', 'names', [])).toEqual(expected);
  });
});

describe('浏览器扩展', () => {
  it('default export 的面板键与服务端声明的局部 id 一一对应,且都能 mount', async () => {
    const bundle = ((await import(QQ_BUNDLE_ENTRY)) as any).default;
    const declared = (qq().webUi().panels ?? []) as WorldPanelDecl[];
    expect(Object.keys(bundle.panels).sort()).toEqual(declared.map((p) => p.id).sort());
    for (const id of declared.map((p) => p.id)) {
      expect(typeof bundle.panels[id].mount).toBe('function');
    }
  });
});
