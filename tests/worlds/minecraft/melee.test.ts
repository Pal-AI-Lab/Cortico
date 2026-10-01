import { EventEmitter } from 'node:events';
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

describe('skillAttack 打末影水晶', () => {
  /** 一箭放出后水晶被移除;blast 给出时,爆炸包在移除之后的下一次读里才到 */
  function crystalRig(blast: { x: number; y: number; z: number } | null) {
    const client = new EventEmitter();
    const crystal = { id: 7, name: 'end_crystal', type: 'object', position: new V(20, 80, 0), isValid: true };
    const bot = {
      _client: client,
      entity: { id: 1, position: new V(0, 64, 0) },
      entities: { 7: crystal },
      players: {},
      health: 20,
      registry: { entitiesByName: { end_crystal: {} } },
      inventory: { items: () => [] as never[] },
      setControlState: () => undefined,
      lookAt: async () => undefined,
      blockAt: () => null,
    };
    const lease = { token: {}, targetId: 7, swings: 0, meleeHits: 0, arrows: 0, rangedHits: 0, hurts: 0, dead: false, disconnected: false };
    const ctx = {
      aborted: () => false,
      fleeHealth: () => 0,
      escape: { active: false },
      attack: {
        acquire: () => lease,
        release: () => undefined,
        ranged: {
          ready: () => true,
          abort: () => undefined,
          shoot: async () => {
            crystal.isValid = false;
            if (blast) setTimeout(() => client.emit('explosion', blast), 10);
            return { kind: 'released' };
          },
        },
      },
    } as unknown as SkillContext;
    return { bot, ctx, crystal, client };
  }

  it('水晶被移除后在原位收到爆炸包,算打掉了', async () => {
    const { bot, ctx, client } = crystalRig({ x: 20, y: 80, z: 0 });
    await expect(skillAttack(bot as never, 'end_crystal', 'auto', ctx)).resolves.toContain('在原位炸了(放箭 1 支');
    expect(client.listenerCount('explosion')).toBe(0);
  });

  it('水晶被移除而原位没有爆炸,照实报没确认', async () => {
    const { bot, ctx } = crystalRig(null);
    const err = await skillAttack(bot as never, 'end_crystal', 'auto', ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SkillBlocked);
    expect((err as Error).message).toContain('没收到它原位的爆炸');
  });
});
