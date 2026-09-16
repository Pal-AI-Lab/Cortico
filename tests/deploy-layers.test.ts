/** 配置逐层深合并:代码默认、bot 包的 World 配置、共享端点表、部署配置。
 * 端点表不接受部署 config.json 的 providers 覆盖;提示词另按整份文件覆盖。
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_DEPLOYMENT, ONBOARDING_FLAG_FILE, ensureDeployment, listBots, loadDeployment } from '../src/deploy.ts';
import type { CoreConfig } from '../src/core/types.ts';

interface TestConfig extends CoreConfig {
  worlds: Record<string, { enabled: boolean; username?: string; port?: number; nested?: { a?: number; b?: number } }>;
}


function defaults(): TestConfig {
  return {
    paths: { memory: 'memory', data: 'data' },
    worlds: {
      minecraft: { enabled: true, username: 'World 默认名', port: 25565, nested: { a: 1, b: 2 } },
      terminal: { enabled: true },
    },
  } as unknown as TestConfig;
}

function makeDirs(): { pkgDir: string; deployDir: string } {
  return {
    pkgDir: mkdtempSync(join(tmpdir(), 'deploy-pkg-')),
    deployDir: mkdtempSync(join(tmpdir(), 'deploy-dep-')),
  };
}

function writePackageIo(pkgDir: string, worldId: string, json: unknown): void {
  const dir = join(pkgDir, 'worlds', worldId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(json), 'utf8');
}

describe('worlds 配置的三层', () => {
  it('包里的 worlds/<id>/config.json 压过 World 默认', () => {
    const { pkgDir, deployDir } = makeDirs();
    writePackageIo(pkgDir, 'minecraft', { username: 'CortiV' });

    const cfg = loadDeployment<TestConfig>({ defaults }, deployDir, deployDir, pkgDir).config;
    expect(cfg.worlds.minecraft.username).toBe('CortiV');

    expect(cfg.worlds.minecraft.port).toBe(25565);
    expect(cfg.worlds.minecraft.nested).toEqual({ a: 1, b: 2 });
  });

  it('部署的 config.json 压过包里那层', () => {
    const { pkgDir, deployDir } = makeDirs();
    writePackageIo(pkgDir, 'minecraft', { username: 'CortiV', port: 25565 });
    writeFileSync(join(deployDir, 'config.json'), JSON.stringify({ worlds: { minecraft: { port: 30000 } } }), 'utf8');

    const cfg = loadDeployment<TestConfig>({ defaults }, deployDir, deployDir, pkgDir).config;
    expect(cfg.worlds.minecraft.port).toBe(30000);
    expect(cfg.worlds.minecraft.username).toBe('CortiV');
  });

  it('深合并到嵌套键;没有 worlds/ 目录时什么都不发生', () => {
    const { pkgDir, deployDir } = makeDirs();
    writePackageIo(pkgDir, 'minecraft', { nested: { b: 99 } });
    const merged = loadDeployment<TestConfig>({ defaults }, deployDir, deployDir, pkgDir).config;
    expect(merged.worlds.minecraft.nested).toEqual({ a: 1, b: 99 });

    const bare = makeDirs();
    const plain = loadDeployment<TestConfig>({ defaults }, bare.deployDir, bare.deployDir, bare.pkgDir).config;
    expect(plain.worlds.minecraft.username).toBe('World 默认名');
  });

  it('包里的 worlds 配置坏了要报出是哪份文件,不能静默忽略', () => {
    const { pkgDir, deployDir } = makeDirs();
    const dir = join(pkgDir, 'worlds', 'minecraft');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), '{ 这不是 json', 'utf8');

    expect(() => loadDeployment<TestConfig>({ defaults }, deployDir, deployDir, pkgDir))
      .toThrow(/minecraft[\\/]config\.json/);
  });

  it('packageDir 缺省等于部署目录(测试与 assemble 入口:包与部署同一个目录)', () => {
    const { deployDir } = makeDirs();
    const loaded = loadDeployment<TestConfig>({ defaults }, deployDir);
    expect(loaded.packageDir).toBe(loaded.rootDir);
  });
});


function providerDefaults(): TestConfig {
  return {
    paths: { memory: 'memory', data: 'data' },
    worlds: {},
    providers: { cloud: { kind: 'deepseek', baseUrl: 'https://code.test', secret: 'K' } },
    activeProvider: 'cloud',
  } as unknown as TestConfig;
}

function writeGlobalProvider(providersDir: string, name: string, json: unknown): void {
  mkdirSync(join(providersDir, name), { recursive: true });
  writeFileSync(join(providersDir, name, 'config.json'), JSON.stringify(json), 'utf8');
}

describe('共享端点表', () => {
  it('共享端点覆盖代码默认值,忽略部署 config.json 的 providers 段', () => {
    const { deployDir } = makeDirs();
    const providersDir = mkdtempSync(join(tmpdir(), 'deploy-prov-'));
    writeGlobalProvider(providersDir, 'cloud', { kind: 'deepseek', baseUrl: 'https://global.test' });
    writeGlobalProvider(providersDir, 'local', { kind: 'openai-responses-compat', baseUrl: 'http://127.0.0.1:8090/v1' });
    writeFileSync(
      join(deployDir, 'config.json'),
      JSON.stringify({ providers: { cloud: { serviceTier: 'priority' }, ghost: { kind: 'deepseek' } } }),
      'utf8',
    );

    const cfg = loadDeployment<TestConfig>({ defaults: providerDefaults }, deployDir, deployDir, deployDir, providersDir).config;
    expect(cfg.providers.cloud.baseUrl).toBe('https://global.test');
    expect(cfg.providers.cloud.secret).toBe('K');
    expect(cfg.providers.cloud.serviceTier).toBeUndefined();
    expect(cfg.providers.ghost).toBeUndefined();
    expect(cfg.providers.local.kind).toBe('openai-responses-compat');
  });
});

describe('第一次上手:部署根空着时自建一份', () => {
  const homes: string[] = [];
  const home = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-home-'));
    homes.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('按 DEFAULT_DEPLOYMENT 建,只写 deployment.json 与开场引导的标记', () => {
    const root = home();
    expect(ensureDeployment(root)).toBe(DEFAULT_DEPLOYMENT.name);
    const dir = join(root, DEFAULT_DEPLOYMENT.name);
    expect(readdirSync(dir).sort()).toEqual([ONBOARDING_FLAG_FILE, 'deployment.json'].sort());
    expect(JSON.parse(readFileSync(join(dir, 'deployment.json'), 'utf8'))).toEqual({
      bot: DEFAULT_DEPLOYMENT.bot,
    });
    expect(listBots(root)).toEqual([DEFAULT_DEPLOYMENT.name]);
  });

  it('已经有部署就返回现有那份,不再建', () => {
    const root = home();
    mkdirSync(join(root, 'aaa'), { recursive: true });
    writeFileSync(join(root, 'aaa', 'deployment.json'), '{"bot":"cormini"}', 'utf8');

    expect(ensureDeployment(root)).toBe('aaa');
    expect(readdirSync(root)).toEqual(['aaa']);
  });
});
