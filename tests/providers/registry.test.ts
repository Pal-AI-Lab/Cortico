/**
 * 实例缓存键要感知端点 `.env` 的内容:密钥在实例创建时定格,文件变更后
 * 下一次解析必须重建实例,否则手工改写或另一进程的控制台写入永不生效。
 */
import { afterEach, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeCfg, makeTmpDir } from '../core/helpers.ts';
import { nullLogger } from '../../src/core/util.ts';
import { ProviderRegistry } from '../../src/providers/registry.ts';
import { BaseProvider, type ProviderModule } from '../../src/providers/base.ts';

class StubClient extends BaseProvider {
  async respond(): Promise<never> { throw new Error('unused'); }
}

/** 每次实例创建时按端点 `.env` 读到的密钥值。 */
const seenKeys: string[] = [];
const stub: ProviderModule = {
  id: 'stub', title: 'Stub', reasoningTiers: [], serviceTiers: [],
  create: (_name, entry, host) => {
    seenKeys.push(entry.secret ? host.secret(entry.secret) : '');
    return { client: new StubClient() };
  },
};

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); seenKeys.splice(0); });
function fixture() {
  const temp = makeTmpDir(); cleanups.push(temp.cleanup);
  const root = join(temp.dir, 'providers'); mkdirSync(root);
  const dir = join(root, 'Alpha'); mkdirSync(dir);
  writeFileSync(join(dir, '.env'), 'CORTICO_KEY_ALPHA=first\n');
  const cfg = makeCfg({ providers: { Alpha: { kind: 'stub', baseUrl: 'https://model.test', secret: 'CORTICO_KEY_ALPHA' } }, activeProvider: 'Alpha' });
  const registry = new ProviderRegistry(() => cfg.providers, { stateRoot: root, readBlob: () => null, keepThinking: () => true, log: nullLogger() }, [stub]);
  return { registry, dir };
}

it('rebuilds the instance with the new key after the endpoint .env changes', () => {
  const { registry, dir } = fixture();
  const first = registry.resolve('Alpha');
  expect(seenKeys.at(-1)).toBe('first');
  writeFileSync(join(dir, '.env'), 'CORTICO_KEY_ALPHA=second\n');
  expect(registry.resolve('Alpha')).not.toBe(first);
  expect(seenKeys.at(-1)).toBe('second');
});

it('keeps the cached instance while the .env content is unchanged', () => {
  const { registry } = fixture();
  const first = registry.resolve('Alpha');
  expect(registry.resolve('Alpha')).toBe(first);
  expect(seenKeys).toHaveLength(1);
});
