import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { visibleBlocks } from '../../../src/worlds/minecraft/skills-gather.ts';

/**
 * 矿脉密集处:脚边一圈 20 块埋着的矿,10 格外洞壁上露着 1 块。
 * findBlocks 照 mineflayer 的口径按距离排序后截到 count 个,且不看遮挡。
 */
function denseOreBot() {
  const me = new Vec3(0.5, 64, 0.5);
  const buried: Vec3[] = [];
  for (let i = 0; i < 20; i++) buried.push(new Vec3((i % 5) - 2, 60, Math.floor(i / 5) - 2));
  const exposed = new Vec3(10, 64, 0);
  const cells = [...buried, exposed];
  return {
    exposed,
    bot: {
      entity: { position: me, eyeHeight: 1.62 },
      findBlocks: ({ maxDistance, count }: { maxDistance: number; count: number }) => cells
        .filter((v) => v.distanceTo(me) <= maxDistance)
        .sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
        .slice(0, count),
      blockAt: (v: Vec3) => ({ name: 'nether_quartz_ore', position: v, boundingBox: 'block' }),
      canSeeBlock: (b: { position: Vec3 }) => b.position.equals(exposed),
      world: { raycast: () => null },
    },
  };
}

describe('find 与 collect 共用的可见候选', () => {
  it('近旁埋着的矿多过 16 块时,远一点露着的那块照样在候选里', () => {
    const { bot, exposed } = denseOreBot();
    const seen = visibleBlocks(bot as never, [1], 48);
    expect(seen.map((v) => v.toString())).toEqual([exposed.toString()]);
  });
});
