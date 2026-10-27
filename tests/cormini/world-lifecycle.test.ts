/**
 * World 生命周期钩子:装配层的五种事件各注入一句内部通知。措辞是Persona的,
 * 这里钉的是"每种事件一句、经 injectInternal、kind 为 notice"。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cormini } from '../../bots/cormini/persona/persona.ts';
import type { CoreApi } from '../../src/core/types.ts';

const dir = mkdtempSync(join(tmpdir(), 'cormini-lifecycle-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('onWorldLifecycle', () => {
  it('激活 / 停用 / 重启 / 可见性 / 启动失败各一句,带 World 显示名,走 injectInternal notice', () => {
    const persona = new Cormini({
      memoryDir: dir,
      worlds: [],
    });
    const injected: Array<[string, string | undefined]> = [];
    persona.attach({ injectInternal: (text: string, kind?: string) => { injected.push([text, kind]); } } as unknown as CoreApi);

    persona.onWorldLifecycle({ kind: 'mounted', id: 'x', label: '甲渠道' });
    persona.onWorldLifecycle({ kind: 'unmounted', id: 'x', label: '甲渠道' });
    persona.onWorldLifecycle({ kind: 'restarted', id: 'x', label: '甲渠道' });
    persona.onWorldLifecycle({ kind: 'visibility', id: 'x', label: '甲渠道', visible: false });
    persona.onWorldLifecycle({ kind: 'visibility', id: 'x', label: '甲渠道', visible: true });
    persona.onWorldLifecycle({ kind: 'start-failed', id: 'x', label: '甲渠道', reason: 'listen EADDRINUSE: address already in use 127.0.0.1:7797' });

    expect(injected.map(([, kind]) => kind)).toEqual(['notice', 'notice', 'notice', 'notice', 'notice', 'notice']);
    const texts = injected.map(([text]) => text);
    expect(texts[0]).toBe('[system] World 「甲渠道」已激活。');
    expect(texts[1]).toBe('[system] World 「甲渠道」已停用。');
    expect(texts[2]).toBe('[system] World 「甲渠道」已重启。');
    expect(texts[3]).toContain('已对你隐藏');
    expect(texts[4]).toContain('重新对你可见');
    expect(texts[5]).toBe('[system] World 「甲渠道」启动失败,本次运行里没有它:listen EADDRINUSE: address already in use 127.0.0.1:7797');
  });

  it('没 attach 时什么也不做', () => {
    const persona = new Cormini({
      memoryDir: dir,
      worlds: [],
    });
    expect(() => persona.onWorldLifecycle({ kind: 'mounted', id: 'x', label: 'x' })).not.toThrow();
  });
});
