import { describe, it, expect } from 'vitest';
import { contextStageConfigGroup } from '../../bots/cormini/persona/config.ts';
import { LANGUAGES } from '../../src/core/language.ts';
import type { ConfigGroup } from '../../src/core/types.ts';

/** 组的标题、说明与每个配置项的标题、说明。 */
function texts(group: ConfigGroup): string[] {
  const props = Object.values(group.schema.properties) as Array<{ title?: string; description?: string }>;
  return [group.schema.title, group.schema.description, ...props.flatMap((p) => [p.title, p.description])].map(String);
}

/** 去掉文案后的结构:id、owner、配置键与取值范围。 */
function shape(group: ConfigGroup): unknown {
  const props = Object.fromEntries(Object.entries(group.schema.properties).map(([key, p]) => {
    const { title: _t, description: _d, ...rest } = p;
    return [key, rest];
  }));
  return { id: group.id, owner: group.owner, props };
}

describe('contextStageConfigGroup', () => {
  it('每种语言有自己的一份文案，没有语言借用另一种语言的整组文案', () => {
    const seen = new Map<string, string>();
    for (const language of LANGUAGES) {
      const joined = texts(contextStageConfigGroup('cormini', language)).join('\n');
      expect(seen.get(joined), `${language} 与 ${seen.get(joined)} 文案相同`).toBeUndefined();
      seen.set(joined, language);
    }
  });

  it('各语言的组 id、owner、配置键与取值范围一致', () => {
    const base = shape(contextStageConfigGroup('cormini', 'zh'));
    for (const language of LANGUAGES) {
      expect(shape(contextStageConfigGroup('cormini', language))).toEqual(base);
    }
  });
});
