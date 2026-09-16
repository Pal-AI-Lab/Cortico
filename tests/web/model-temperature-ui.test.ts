import { afterEach, describe, expect, it } from 'vitest';
import { fixtureWorld, mountSettings, change, flush } from './provider-settings-fixture.ts';
let cleanup: () => void = () => {};
afterEach(() => cleanup());
describe('Provider 模型档编辑', () => {
  it('未指定温度显示空值，0 保留为显式温度', async () => {
    const view = await mountSettings();
    cleanup = view.cleanup;
    const temperature = view.root.querySelector('[aria-label="温度"]');
    expect(temperature.value).toBe('');
    change(temperature, '0');
    await flush();
    expect(view.read().providers.primary.spec.temperature).toBe(0);
  });
  it('清空温度移除字段；模型、推理档与输出上限各自落盘', async () => {
    const view = await mountSettings(
      undefined,
      {},
      { model: 'fixture-flash', thinking: false, temperature: 1.2 },
    );
    cleanup = view.cleanup;
    change(view.root.querySelector('[aria-label="温度"]'), '');
    change(view.root.querySelector('[aria-label="模型"]'), 'fixture-pro');
    change(view.root.querySelector('[aria-label="推理档位"]'), 'high');
    change(view.root.querySelector('[aria-label="最大输出 token"]'), '2048');
    await flush();
    expect(view.read().providers.primary.spec).toEqual({
      model: 'fixture-pro',
      thinking: true,
      reasoningEffort: 'high',
      maxTokens: 2048,
    });
  });
  it('无效温度拒绝这一档的写入，改回合法值时草稿整份落盘', async () => {
    const view = await mountSettings();
    cleanup = view.cleanup;
    change(view.root.querySelector('[aria-label="温度"]'), '3');
    change(view.root.querySelector('[aria-label="模型"]'), 'changed');
    await flush();
    expect(view.cfg.providers.primary.spec!.model).toBe('fixture-pro');
    expect(view.root.textContent).toContain('temperature 必须在');
    change(view.root.querySelector('[aria-label="温度"]'), '1');
    await flush();
    expect(view.read().providers.primary.spec).toMatchObject({ model: 'changed', temperature: 1 });
  });
  it('展示模块声明的温度限制', async () => {
    const view = await mountSettings();
    cleanup = view.cleanup;
    expect(view.root.textContent).toContain(fixtureWorld.temperatureNote);
  });
});
