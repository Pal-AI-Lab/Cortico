/**
 * 早停名单:find 与 tunnel 声明的 `until`,把类别名摊成方块 id,一路上撞见就收工。
 *
 * 只认名单与判定,收不收工由技能自己决定。
 */
import type { Bot } from 'mineflayer';
import { UNTIL_CATEGORIES } from './skills.ts';
import { matchBlockIds } from './travel.ts';
import { canSeeBlockAt } from './terrain.ts';
import { zhName } from './names.ts';

/**
 * `until` 的早停名单 → 方块 id 集合。
 *
 * `#类别` 先探一次 registry 的 tag 数据面(本仓库钉住的版本没有这一面,留着是为了
 * 将来有了就自动走过去),取不到落到 `UNTIL_CATEGORIES` 那几个内置类别。
 * 认不出的名字不抛错 —— 早停是这一单的副条件,它认不出来不该把整步判死;
 * 认不出哪几个由回执点名(静默吃掉参数是这条链上最贵的一类失败)。
 */
export function untilBlockIds(bot: Bot, until: readonly string[]): { ids: number[]; unknown: string[] } {
  const byName = bot.registry.blocksByName as Record<string, { id: number; name: string }>;
  const tags = (bot.registry as unknown as { blockTags?: Record<string, string[]> }).blockTags;
  const ids = new Set<number>();
  const unknown: string[] = [];
  for (const raw of until) {
    const name = raw.replace(/^minecraft:/, '');
    if (name.startsWith('#')) {
      const bare = name.slice(1);
      const tagged = tags?.[bare] ?? tags?.[`minecraft:${bare}`] ?? null;
      if (tagged) {
        for (const n of tagged) {
          const b = byName[n.replace(/^minecraft:/, '')];
          if (b) ids.add(b.id);
        }
        continue;
      }
      const pred = UNTIL_CATEGORIES[bare];
      if (!pred) { unknown.push(name); continue; }
      for (const b of Object.values(byName)) if (pred(b.name)) ids.add(b.id);
      continue;
    }
    const matched = matchBlockIds(bot, name);
    if (matched.length === 0) { unknown.push(name); continue; }
    for (const id of matched) ids.add(id);
  }
  return { ids: [...ids], unknown };
}

/** `until` 命中的那一格 */
export interface UntilHit { x: number; y: number; z: number; what: string }

/**
 * 周身有没有碰到早停名单里的东西。
 *
 * `visible` = 只认看得见的:行军途中用这一档(与 find 自己的感知规则同源)。
 * 挖通道那一档不设视线闸 —— 铲子下去露出来的那一面本来就贴着脸,视线判据在坑里没意义。
 */
export function untilHit(bot: Bot, ids: readonly number[], radius: number, visible: boolean): UntilHit | null {
  if (ids.length === 0) return null;
  const found = bot.findBlocks({ matching: [...ids], maxDistance: radius, count: 16 });
  const p = found.find((q) => !visible || canSeeBlockAt(bot, q));
  if (!p) return null;
  return { x: p.x, y: p.y, z: p.z, what: zhName(bot.blockAt(p)?.name ?? 'unknown') };
}

/** 行军途中每走完一段扫一次早停的半径(格) */
export const UNTIL_TRAVEL_RADIUS = 16;
/** 挖通道每挖完一格扫一次早停的半径(格):坑壁上露出来的那一圈 */
export const UNTIL_DIG_RADIUS = 4;

/** 认不出的早停名字那一句;全认得出返回空串 */
export function untilUnknownNote(unknown: readonly string[]): string {
  return unknown.length > 0 ? `(until 里的 ${unknown.join('、')} 认不出来,这几样没算进去)` : '';
}

