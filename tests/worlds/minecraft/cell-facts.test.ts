import { describe, expect, it } from 'vitest';
import { surfaceFeetAt } from '../../../src/worlds/minecraft/cell-facts.ts';
import { SkillBlocked } from '../../../src/worlds/minecraft/skill-context.ts';
import { V } from './executor-harness.ts';

/** 一柱方块:y → 名字;列出的以外是空气。boundingBox 按名字给 */
function columnBot(column: Record<number, string>) {
  return {
    game: { minY: -64, height: 384 },
    entity: { position: new V(0.5, 70, 0.5) },
    blockAt(p: V) {
      const name = column[Math.floor(p.y)] ?? 'air';
      return { name, boundingBox: name === 'stone' ? 'block' : 'empty', position: p };
    },
  };
}

describe('surfaceFeetAt', () => {
  it('往下先碰到水就受阻,报水面高度与水深,不把落脚格定在海底', () => {
    const bot = columnBot({ 62: 'water', 61: 'water', 60: 'water', 59: 'stone' });
    let err: unknown = null;
    try {
      surfaceFeetAt(bot as never, [5, '~', 5]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SkillBlocked);
    expect((err as SkillBlocked).message).toContain('水面那格 y=62,水深 3 格');
  });
});
