import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CORE_DEFAULTS } from '../src/core/config.ts';
import type { CoreConfig } from '../src/core/types.ts';
import { AVATAR_FILE, createDeployment, loadDeployment } from '../src/deploy.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadDeployment text decoding', () => {
  for (const encoding of ['utf8', 'utf16le'] as const) {
    for (const layer of ['deployment', 'provider', 'world'] as const) {
      it(`loads ${encoding} BOM in the ${layer} configuration`, () => {
        const dir = mkdtempSync(join(tmpdir(), 'deployment-encoding-'));
        dirs.push(dir);
        const configDir = layer === 'provider' ? join(dir, 'providers', 'endpoint')
          : layer === 'world' ? join(dir, 'worlds', 'example') : dir;
        mkdirSync(configDir, { recursive: true });
        const content = layer === 'deployment' ? { displayName: '测试名称' }
          : layer === 'provider' ? { kind: 'test', baseUrl: 'https://example.invalid', spec: { model: '测试模型' } }
          : { enabled: true, label: '测试环境' };
        const bom = encoding === 'utf8' ? [0xef, 0xbb, 0xbf] : [0xff, 0xfe];
        writeFileSync(join(configDir, 'config.json'), Buffer.concat([
          Buffer.from(bom), Buffer.from(JSON.stringify(content), encoding),
        ]));

        const { config } = loadDeployment<CoreConfig>({ defaults: () => structuredClone(CORE_DEFAULTS) }, dir);
        if (layer === 'deployment') expect(config.displayName).toBe(content.displayName);
        else if (layer === 'provider') expect(config.providers.endpoint).toEqual(content);
        else expect((config as unknown as { worlds: Record<string, unknown> }).worlds.example).toEqual(content);
      });
    }
  }
});

describe('createDeployment', () => {
  it('avatarFrom 复制成部署的头像;不给就没有头像', () => {
    const root = mkdtempSync(join(tmpdir(), 'deployment-avatar-'));
    dirs.push(root);
    const icon = join(root, 'package-icon.png');
    writeFileSync(icon, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    createDeployment({ name: 'pictured', bot: 'example-bot', root, avatarFrom: icon });
    createDeployment({ name: 'plain', bot: 'example-bot', root });
    expect(readFileSync(join(root, 'pictured', AVATAR_FILE))).toEqual(readFileSync(icon));
    expect(existsSync(join(root, 'plain', AVATAR_FILE))).toBe(false);
  });
});
