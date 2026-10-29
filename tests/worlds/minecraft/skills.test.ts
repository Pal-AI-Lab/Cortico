import { describe, expect, it } from 'vitest';
import { parseSteps, SKILL_STEP_SCHEMA } from '../../../src/worlds/minecraft/skills.ts';

describe('物品英文 id', () => {
  it('take 的 item 写成中文名时整批退回,报错要英文 id', () => {
    const parsed = parseSteps([{ skill: 'take', item: '石按钮', count: 4 }]);
    expect(parsed).toEqual({ error: expect.stringMatching(/item .*英文 id/) });
  });

  it('steps schema 里 item 的说明带上各技能的 hint', () => {
    const props = SKILL_STEP_SCHEMA.properties as Record<string, { description: string }>;
    expect(props.item.description).toMatch(/take\([^)]*英文 id/);
  });
});
