import { describe, expect, it } from 'vitest';
import { loadBuiltinWorlds } from '../../src/worlds/index.ts';

describe('loadBuiltinWorlds', () => {
  it('只带选中的 World,按给的顺序;有不认识的 id 时整次装配失败', async () => {
    expect((await loadBuiltinWorlds(['websearch', 'terminal'])).map((w) => w.id)).toEqual(['websearch', 'terminal']);
    await expect(loadBuiltinWorlds(['terminal', 'nope'])).rejects.toThrow(/nope/);
  });
});
