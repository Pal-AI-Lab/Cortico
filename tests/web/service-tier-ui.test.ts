import { afterEach, describe, expect, it } from 'vitest';
import { mountSettings, change, flush } from './provider-settings-fixture.ts';
type Any = any;
let cleanup: () => void = () => {};
afterEach(() => cleanup());
const tierField = (root: Any) =>
  [...root.querySelectorAll('.fieldrow')].find(
    (row: Any) => row.querySelector('.fieldlabel')?.textContent === '服务档',
  );
describe('Provider 服务档', () => {
  it('展示模块支持的档位与当前选择', async () => {
    const view = await mountSettings(undefined, { serviceTier: 'priority' });
    cleanup = view.cleanup;
    const select = tierField(view.root).querySelector('select');
    expect(select.value).toBe('priority');
    expect([...select.options].map((o: Any) => o.value)).toEqual(['', 'default', 'priority']);
  });
  it('清空服务档恢复服务端默认', async () => {
    const view = await mountSettings(undefined, { serviceTier: 'priority' });
    cleanup = view.cleanup;
    change(tierField(view.root).querySelector('select'), '');
    await flush();
    expect(view.read().providers.primary.serviceTier).toBe('');
  });
  it('未声明服务档的模块不显示下拉', async () => {
    const view = await mountSettings('openai-responses-compat');
    cleanup = view.cleanup;
    expect(tierField(view.root)).toBeUndefined();
  });
});
