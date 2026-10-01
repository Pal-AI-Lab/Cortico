/**
 * bot 自己挨的每一下伤害的服务端事实,取自 damage_event 包:伤害类型(damage_type 动态
 * 注册表的序号,名字在配置阶段的 registry_data 里下发)、起因实体与直接实体(包里是实体 id + 1,
 * 0 = 没有)。服务端先发 damage_event 再在下一刻发血量更新,所以两次血量更新之间攒下的
 * 就是这次掉血的来由。
 */
import type { Bot } from 'mineflayer';
import { zhEntity } from './names.ts';

export interface SelfDamage {
  /** 伤害类型名(去掉 minecraft: 前缀);注册表没收到时为 null */
  type: string | null;
  /** 起因实体名(如放出龙息的末影龙);包里没有或实体不在视野里为 null */
  cause: string | null;
  /** 直接造成伤害的实体名(如龙息的区域效果云、箭);同上 */
  direct: string | null;
}

interface DamageEventPacket {
  entityId: number;
  sourceTypeId: number;
  sourceCauseId: number;
  sourceDirectId: number;
}

interface RegistryDataPacket {
  id?: string;
  entries?: Array<{ key: string }>;
}

const damageTypes = new WeakMap<Bot, string[]>();
const pending = new WeakMap<Bot, SelfDamage[]>();

/** createBot 之后立刻挂上:registry_data 在 login 之前的配置阶段就到了 */
export function trackDamageSources(bot: Bot): void {
  const client = (bot as unknown as { _client: { on(n: string, f: (p: never) => void): void } })._client;
  // 1.20.5 起一个注册表一个包,条目顺序即序号
  client.on('registry_data', (p: RegistryDataPacket) => {
    if (p.id !== 'minecraft:damage_type' || !p.entries) return;
    damageTypes.set(bot, p.entries.map((e) => e.key.replace(/^minecraft:/, '')));
  });
  client.on('damage_event', (p: DamageEventPacket) => {
    if (p.entityId !== bot.entity?.id) return;
    const nameOf = (idPlusOne: number): string | null =>
      idPlusOne > 0 ? (bot.entities[idPlusOne - 1]?.name ?? null) : null;
    const list = pending.get(bot) ?? [];
    list.push({
      type: damageTypes.get(bot)?.[p.sourceTypeId] ?? null,
      cause: nameOf(p.sourceCauseId),
      direct: nameOf(p.sourceDirectId),
    });
    pending.set(bot, list);
  });
}

/** 取走上次取之后攒下的伤害记录 */
export function takeSelfDamage(bot: Bot): SelfDamage[] {
  const list = pending.get(bot) ?? [];
  pending.delete(bot);
  return list;
}

/** 一组伤害记录的中文说法,相同的合并;没有可说的事实时为 null */
export function selfDamageText(hits: readonly SelfDamage[]): string | null {
  const parts = new Set<string>();
  for (const h of hits) {
    const who = h.cause !== null ? zhEntity(h.cause) : null;
    const via = h.direct !== null && h.direct !== h.cause ? zhEntity(h.direct) : null;
    const bits = [
      who !== null ? `来自${who}` : null,
      via !== null ? `经${via}` : null,
      h.type !== null ? `伤害类型 ${h.type}` : null,
    ].filter((b): b is string => b !== null);
    if (bits.length > 0) parts.add(bits.join(','));
  }
  return parts.size > 0 ? [...parts].join(';') : null;
}
