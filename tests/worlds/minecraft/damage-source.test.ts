import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  selfDamageText, takeSelfDamage, trackDamageSources,
} from '../../../src/worlds/minecraft/damage-source.ts';

/** 末地平台:自己 id 1,末影龙 7,龙息云 9,十来格外站着一只末影人 12 */
function endBot() {
  const client = new EventEmitter();
  const bot = {
    _client: client,
    entity: { id: 1 },
    entities: {
      7: { id: 7, name: 'ender_dragon' },
      9: { id: 9, name: 'area_effect_cloud' },
      12: { id: 12, name: 'enderman' },
    } as Record<number, { id: number; name: string }>,
  };
  trackDamageSources(bot as never);
  client.emit('registry_data', {
    id: 'minecraft:damage_type',
    entries: ['minecraft:arrow', 'minecraft:indirect_magic', 'minecraft:mob_attack'].map((key) => ({ key })),
  });
  return { bot, client };
}

describe('自己挨打的来由按 damage_event 报', () => {
  it('龙息:起因是末影龙、直接是区域效果云,附近的末影人不进来由', () => {
    const { bot, client } = endBot();
    client.emit('damage_event', { entityId: 1, sourceTypeId: 1, sourceCauseId: 8, sourceDirectId: 10 });
    const text = selfDamageText(takeSelfDamage(bot as never));
    expect(text).toContain('末影龙');
    expect(text).toContain('区域效果云');
    expect(text).toContain('indirect_magic');
    expect(text).not.toContain('末影人');
  });

  it('包里没有来源实体时只报伤害类型;别人挨打的包不算', () => {
    const { bot, client } = endBot();
    client.emit('damage_event', { entityId: 12, sourceTypeId: 2, sourceCauseId: 2, sourceDirectId: 2 });
    client.emit('damage_event', { entityId: 1, sourceTypeId: 0, sourceCauseId: 0, sourceDirectId: 0 });
    expect(selfDamageText(takeSelfDamage(bot as never))).toBe('伤害类型 arrow');
  });

  it('取走之后清空:下一次掉血没收到包就没有来由可说', () => {
    const { bot, client } = endBot();
    client.emit('damage_event', { entityId: 1, sourceTypeId: 2, sourceCauseId: 13, sourceDirectId: 13 });
    expect(selfDamageText(takeSelfDamage(bot as never))).toBe('来自末影人,伤害类型 mob_attack');
    expect(selfDamageText(takeSelfDamage(bot as never))).toBeNull();
  });
});
