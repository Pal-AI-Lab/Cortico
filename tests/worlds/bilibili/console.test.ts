/**
 * 直播间 World 的控制台表面:只保留日志。
 *
 * 咬住的是**两侧对齐**:服务端声明的局部 panel id 与扩展导出的键一一对应。
 * 对不上时控制台渲染的是"扩展缺这个面板"的错误卡,而那张卡在真直播时才会
 * 被人看见。
 */
import { describe, it, expect } from 'vitest';
import { BilibiliWorld } from '../../../src/worlds/bilibili/world.ts';
import { ioPageContribution } from '../../../src/bot.ts';
import type { WorldPanelDecl } from '../../../src/core/types.ts';

/**
 * 扩展是浏览器端代码(DOM 类型,由 tsconfig.web.json 单独 check)。
 * specifier 存进变量,免得根 tsconfig 把它拉进 Node 那份检查。
 */
const BUNDLE_ENTRY = '../../../src/worlds/bilibili/console/client.ts';

/** 不 start:面板声明不需要真连直播间。 */
const mod = (): BilibiliWorld => new BilibiliWorld({ roomId: 0 });

describe('bilibili 的面板声明', () => {
  it('适配成 provider 贡献后:局部 id 原样,配置组与环境提示词照带', () => {
    const c = ioPageContribution('bilibili', 'B 站直播间', undefined, mod());
    expect(c.id).toBe('world:bilibili');
    expect(c.panels?.map((p) => p.id)).toEqual(['log']);
    expect(c.config?.map((g) => g.id)).toEqual(['world:bilibili']);
    expect(c.promptDocs?.map((d) => d.key)).toEqual(['worlds.bilibili.envPrompt']);
    const properties = c.config?.[0].schema.properties ?? {};
    expect(properties).toHaveProperty('worlds.bilibili.coalesceWindowMs');
    expect(properties).toHaveProperty('worlds.bilibili.coalesceMaxItems');
    expect(properties).toHaveProperty('worlds.bilibili.audienceOnlineRankOn');
    expect(properties).toHaveProperty('worlds.bilibili.audienceEventLineBudget');
  });

  it('invoke 按局部 id 分派,未知面板/方法都报错而不是静默返回空', async () => {
    const c = ioPageContribution('bilibili', 'B 站直播间', undefined, mod());
    const st = (await c.invoke!('log', 'state', [])) as { total: number; recent: string[] };
    expect(st.total).toBe(0);
    expect(st.recent).toEqual([]);
    await expect(c.invoke!('nope', 'state', [])).rejects.toThrow('未知面板');
    await expect(c.invoke!('styles', 'state', [])).rejects.toThrow('未知面板');
    await expect(c.invoke!('log', 'nope', [])).rejects.toThrow('未知方法');
  });

  it('英文界面的声明(灯、徽标、面板、配置组、模板说明)不含中文', () => {
    const shown = JSON.stringify(mod().console('en'), (k, v) => (k === 'path' ? undefined : v));
    expect(shown).not.toMatch(/[一-鿿]/u);
  });
});

describe('bilibili 的浏览器扩展', () => {
  it('default export 的面板键与服务端声明的局部 id 一一对应,且都能 mount', async () => {
    const bundle = ((await import(BUNDLE_ENTRY)) as any).default;
    const declared = (mod().console().panels ?? []) as WorldPanelDecl[];
    expect(Object.keys(bundle.panels).sort()).toEqual(declared.map((p) => p.id).sort());
    for (const id of declared.map((p) => p.id)) {
      expect(typeof bundle.panels[id].mount).toBe('function');
    }
  });

  it('扩展里一次 fetch 都没有,数据面只走 ctx.invoke、定时器只走 ctx.interval', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(import.meta.dirname, '../../../src/worlds/bilibili/console');
    const offenders: string[] = [];
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      readFileSync(join(dir, name), 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (/^\s*[/*]/.test(line)) return; // 注释里提到 fetch 是在解释为什么不用它
        if (/\bfetch\s*\(|document\.body|window\.__|setInterval|setTimeout/.test(line)) {
          offenders.push(`${name}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
