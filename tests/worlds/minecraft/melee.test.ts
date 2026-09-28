import { describe, expect, it } from 'vitest';
import { skillAttack } from '../../../src/worlds/minecraft/melee.ts';
import { SkillBlocked, type SkillContext } from '../../../src/worlds/minecraft/skill-context.ts';
import { V } from './executor-harness.ts';

describe('skillAttack 找目标的半径', () => {
  it('末影水晶在 104 格外也找得到(主岛对面柱顶),不报附近没有', async () => {
    const crystal = { id: 7, name: 'end_crystal', type: 'object', position: new V(84, 124, 0), isValid: true };
    const bot = {
      entity: { id: 1, position: new V(0, 64, 0) },
      entities: { 7: crystal },
      players: {},
      registry: { entitiesByName: { end_crystal: {} } },
      inventory: { items: () => [] as never[] },
    };
    const ctx = { attack: { ranged: null, acquire: () => ({}) } } as unknown as SkillContext;
    // 远程控制器不可用时强制远程在找到目标之后才受阻:能走到这一句,说明目标找到了
    const err = await skillAttack(bot as never, 'end_crystal', 'ranged', ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SkillBlocked);
    expect((err as Error).message).toContain('不会改用近战');
  });
});
