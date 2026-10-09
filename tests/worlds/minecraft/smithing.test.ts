/**
 * 下界合金装备走锻造台:合成配方表里没有它们,1.20 起锻造台多一个模板槽。
 *
 * 窗口布局在 prismarine-windows 里,只能改包:src/worlds/minecraft/dependency-patches.ts。
 */
import '../../../src/worlds/minecraft/dependency-patches.ts';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { skillCraft } from '../../../src/worlds/minecraft/skills-craft.ts';
import { SkillBlocked, type SkillContext } from '../../../src/worlds/minecraft/skill-context.ts';

const require_ = createRequire(import.meta.url);
// prismarine-windows 不是本仓库的直接依赖,顺着 mineflayer 的解析根找
const mfRequire = createRequire(require_.resolve('mineflayer'));

describe('锻造台窗口', () => {
  it('1.20.6 的锻造台:模板/底料/添料占 0–2,产出在 3,玩家背包从 4 开始', () => {
    const windows = mfRequire('prismarine-windows')('1.20.6') as {
      createWindow(id: number, type: string, title: string): { inventoryStart: number; craftingResultSlot: number };
    };
    const win = windows.createWindow(1, 'minecraft:smithing', 'smithing');
    expect(win.craftingResultSlot).toBe(3);
    expect(win.inventoryStart).toBe(4);
  });
});

describe('craft 下界合金装备', () => {
  it('合成配方表里没有下界合金剑:按锻造台三样材料报缺,不报没有做法', async () => {
    const bot = {
      registry: {
        blocksByName: { crafting_table: { id: 1 } },
        itemsByName: { netherite_sword: { id: 900, name: 'netherite_sword' } },
      },
      findBlocks: () => [],
      recipesAll: () => [],
      inventory: { items: () => [{ name: 'diamond_sword', count: 1, type: 800 }, { name: 'netherite_ingot', count: 1, type: 801 }] },
    };
    const call = { skill: 'craft', item: 'netherite_sword', count: 1 } as never;
    const err = await skillCraft(bot as never, call, {} as SkillContext).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SkillBlocked);
    expect((err as Error).message).toContain('锻造台');
    expect((err as Error).message).toContain('下界合金升级锻造模板 0 个');
  });
});
