/**
 * 上下文交接阈值的部署覆盖、控制台声明与读取路径。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { loadDeployment } from '../../src/deploy.ts';
import { readGroupValues } from '../../src/core/config-schema.ts';
import definition, { CORTIV_CONTEXT_CONFIG_GROUP, type CortiVConfig } from '../../bots/cortiv/index.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

function loadFrom(raw: Record<string, unknown>): CortiVConfig {
  const dir = mkdtempSync(join(tmpdir(), 'cortiv-ctx-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify(raw), 'utf8');
    return loadDeployment(definition, dir, REPO_ROOT).config;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('上下文交接阈值', () => {
  it('config.json 的 context.maxTokens 压过代码默认(层 3 > 层 2)', () => {
    const fallback = definition.defaults().context.maxTokens;
    const cfg = loadFrom({ context: { maxTokens: 96000 } });
    expect(cfg.context.maxTokens).toBe(96000);
    expect(cfg.context.maxTokens).not.toBe(fallback);
    // 同段的其余键不该被这次覆盖抹掉(深合并,不是整段替换)
    expect(cfg.context.keepRatio).toBe(definition.defaults().context.keepRatio);
    expect(cfg.context.firstTurn).toBe(definition.defaults().context.firstTurn);
  });

  it('控制台有位置改它:CortiV 声明了这一组,且 96000 落在声明的取值区间里', () => {
    const prop = CORTIV_CONTEXT_CONFIG_GROUP.schema.properties['context.maxTokens'];
    expect(prop).toBeTruthy();
    expect(prop.type).toBe('integer');
    expect(prop.minimum!).toBeLessThanOrEqual(96000);
    expect(prop.maximum!).toBeGreaterThanOrEqual(96000);
    // 归Persona(容量归它);core 那组只管历史思维链与首轮对话两条策略
    expect(CORTIV_CONTEXT_CONFIG_GROUP.owner).toBe('persona');

    const dir = mkdtempSync(join(tmpdir(), 'cortiv-ctx-'));
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ context: { maxTokens: 96000 } }), 'utf8');
      const built = definition.build(loadDeployment(definition, dir, REPO_ROOT), []);
      const ids = (built.console?.configGroups ?? []).map((g) => g.id);
      expect(ids).toContain(CORTIV_CONTEXT_CONFIG_GROUP.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('声明的读取路径指向真配置:readGroupValues 报的就是生效值', () => {
    const cfg = loadFrom({ context: { maxTokens: 96000 } });
    const values = readGroupValues(cfg, CORTIV_CONTEXT_CONFIG_GROUP);
    expect(values['context.maxTokens']).toBe(96000);
    expect(values['context.softRatio']).toBe(cfg.context.softRatio);
  });
});
