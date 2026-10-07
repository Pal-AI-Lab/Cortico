/** 端点策略文件：交接后前 calls 次请求用策略端点，之后与未交接时用活跃端点；文件现读，形状不对时抛错。 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CortiV } from '../../bots/cortiv/persona/persona.ts';
import { makeFakeHarnessApi } from '../core/helpers.ts';

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function rig(policy: unknown): CortiV {
  dir = mkdtempSync(join(tmpdir(), 'cortiv-policy-'));
  const file = join(dir, 'provider-policy.json');
  writeFileSync(file, JSON.stringify(policy));
  const persona = new CortiV({ memoryDir: join(dir, 'workspace'), providerPolicyFile: () => file });
  persona.attach(makeFakeHarnessApi());
  persona.declareSessions();
  return persona;
}

describe('CortiV 端点策略', () => {
  it('交接后前 calls 次请求用策略端点,之后回到活跃端点;下一次交接重新计数', async () => {
    const persona = rig({ afterHandoff: { provider: 'alt', calls: 2 } });
    expect(persona.mainEndpoint()).toBeNull();
    for (let handoff = 0; handoff < 2; handoff++) {
      await persona.onHandoff([], { hardTokens: null });
      expect([persona.mainEndpoint(), persona.mainEndpoint(), persona.mainEndpoint()]).toEqual(['alt', 'alt', null]);
    }
  });

  it('afterHandoff 形状不对时抛错,本次交接余下的请求用活跃端点', async () => {
    const persona = rig({ afterHandoff: { provider: 'alt', calls: 0 } });
    await persona.onHandoff([], { hardTokens: null });
    expect(() => persona.mainEndpoint()).toThrow(/afterHandoff/);
    expect(persona.mainEndpoint()).toBeNull();
  });
});
