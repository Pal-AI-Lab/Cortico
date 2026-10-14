/**
 * 仓内 World 目录。装配方用 `loadBuiltinWorlds(ids)` 取要带上的定义，与扩展装进来的 World 并成一张表，
 * 经 `withWorlds()` 交给 bot 定义;bot 只声明它为之设计的渠道，哪些真挂由部署的 `worlds.<id>.enabled` 决定。
 *
 * 本文件不静态 import 任何 World:定义按 id 从 `./<id>/definition.ts` 动态导入，导入路径是模板字符串，
 * TypeScript 不解析它。没选上的 World 不被加载，删掉它的目录不影响装配与类型检查。
 * `console-fixture` 是控制台边界的验收件，不在这里。
 */
import type { WorldDefinition, WorldSection } from '../world.ts';

/** id(即 `src/worlds/` 下的目录名)→ 该目录 `definition.ts` 导出定义的名字。 */
const EXPORTS = {
  terminal: 'TERMINAL',
  qq: 'QQ',
  bilibili: 'BILIBILI',
  minecraft: 'MINECRAFT',
  websearch: 'WEBSEARCH',
} as const;

export type BuiltinWorldId = keyof typeof EXPORTS;

/** 全部仓内 World 的 id;`loadBuiltinWorlds()` 不给参数时按此顺序全带。 */
export const BUILTIN_WORLD_IDS = Object.keys(EXPORTS) as readonly BuiltinWorldId[];

/**
 * 按 `ids` 的顺序导入仓内 World 定义。有不认识的 id 时在导入任何 World 之前抛错，错误里列出可选的 id。
 */
export async function loadBuiltinWorlds(
  ids: readonly string[] = BUILTIN_WORLD_IDS,
): Promise<WorldDefinition<WorldSection>[]> {
  const unknown = ids.filter((id) => !Object.hasOwn(EXPORTS, id));
  if (unknown.length > 0) {
    throw new Error(`没有这个仓内 World: ${unknown.join(', ')}。可选:${BUILTIN_WORLD_IDS.join(' / ')}`);
  }
  return Promise.all(ids.map(async (id) => {
    const mod = await import(`./${id}/definition.ts`) as Record<string, WorldDefinition<WorldSection>>;
    return mod[EXPORTS[id as BuiltinWorldId]];
  }));
}
