/**
 * 客户端命令行的拼装:版本继承、规则过滤、占位符替换、直连服务器。
 * 全部用临时目录里的合成安装,不依赖本机真的装了 Minecraft。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  buildClientLaunch, mavenPath, offlineUuid, rulesAllow, soleVersionId,
} from '../../../src/worlds/minecraft/client-launch.ts';

let dir: string;

/** 合成一份最小可用的 .minecraft:一个原版版本 + 一个继承它的"World 版" */
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mc-launch-'));
  const vanilla = {
    id: '1.20.1',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assetIndex: { id: '5' },
    libraries: [
      { name: 'org.example:core:1.0', downloads: { artifact: { path: 'org/example/core/1.0/core-1.0.jar' } } },
      {
        name: 'org.lwjgl:lwjgl:3.3.1:natives-windows',
        downloads: { artifact: { path: 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar' } },
        rules: [{ action: 'allow', os: { name: 'windows' } }],
      },
      {
        name: 'org.example:maconly:1.0',
        downloads: { artifact: { path: 'org/example/maconly/1.0/maconly-1.0.jar' } },
        rules: [{ action: 'allow', os: { name: 'osx' } }],
      },
    ],
    arguments: {
      jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'],
      game: [
        '--username', '${auth_player_name}',
        '--uuid', '${auth_uuid}',
        '--assetIndex', '${assets_index_name}',
        { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '${resolution_width}', '--height', '${resolution_height}'] },
        { rules: [{ action: 'allow', features: { is_quick_play_multiplayer: true } }], value: ['--quickPlayMultiplayer', '${quickPlayMultiplayer}'] },
        { rules: [{ action: 'allow', features: { is_demo_user: true } }], value: '--demo' },
      ],
    },
  };
  const modded = {
    id: 'fabric-1.20.1',
    inheritsFrom: '1.20.1',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.0' }],
    arguments: { game: ['--fabric'] },
  };
  /** 加载器版本:自己没有主 jar,靠 ignoreList 把借来的那个挡在模块路径外,并点名一个没装上的库 */
  const bootstrapped = {
    id: 'bootstrap-1.20.1',
    inheritsFrom: '1.20.1',
    mainClass: 'org.example.bootstrap.Main',
    libraries: [{ name: 'org.example:absent:2.0' }],
    arguments: { jvm: ['-DignoreList=client-extra,${version_name}.jar'] },
  };
  for (const v of [vanilla, modded, bootstrapped]) {
    mkdirSync(join(dir, 'versions', v.id), { recursive: true });
    writeFileSync(join(dir, 'versions', v.id, `${v.id}.json`), JSON.stringify(v));
  }
  // 只有原版有主 jar:继承版本共用它
  writeFileSync(join(dir, 'versions', '1.20.1', '1.20.1.jar'), 'jar');
  for (const rel of [
    'org/example/core/1.0/core-1.0.jar',
    'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar',
    'org/example/maconly/1.0/maconly-1.0.jar',
    'net/fabricmc/fabric-loader/0.15.0/fabric-loader-0.15.0.jar',
  ]) {
    const abs = join(dir, 'libraries', ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, 'jar');
  }
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const base = {
  javaPath: 'java.exe',
  username: 'CortiCam',
  width: 1280,
  height: 720,
  os: 'win32' as NodeJS.Platform,
  arch: 'x64',
};

describe('离线身份', () => {
  it('UUID 是 md5 版本 3,同名同 UUID', () => {
    const a = offlineUuid('CortiCam');
    expect(a).toBe(offlineUuid('CortiCam'));
    expect(a).not.toBe(offlineUuid('corti'));
    expect(a[14]).toBe('3'); // 版本位
    expect('89ab').toContain(a[19]); // variant 位
  });
});

describe('maven 坐标 → 路径', () => {
  it('带分类器与扩展名', () => {
    expect(mavenPath('net.fabricmc:fabric-loader:0.15.0')).toBe('net/fabricmc/fabric-loader/0.15.0/fabric-loader-0.15.0.jar');
    expect(mavenPath('a.b:c:1:natives-windows')).toBe('a/b/c/1/c-1-natives-windows.jar');
    expect(mavenPath('a.b:c:1@zip')).toBe('a/b/c/1/c-1.zip');
  });
});

describe('规则', () => {
  const ctx = { os: 'windows', arch: 'x64', features: { is_quick_play_multiplayer: true } };
  it('无规则=允许;os 不匹配=不允许;disallow 覆盖前面的 allow', () => {
    expect(rulesAllow(undefined, ctx)).toBe(true);
    expect(rulesAllow([{ action: 'allow', os: { name: 'osx' } }], ctx)).toBe(false);
    expect(rulesAllow([{ action: 'allow' }, { action: 'disallow', os: { name: 'windows' } }], ctx)).toBe(false);
  });
  it('feature 开关按当前上下文判定', () => {
    expect(rulesAllow([{ action: 'allow', features: { is_quick_play_multiplayer: true } }], ctx)).toBe(true);
    expect(rulesAllow([{ action: 'allow', features: { is_demo_user: true } }], ctx)).toBe(false);
  });
});

describe('buildClientLaunch', () => {
  it('原版:占位符替换 + 平台库过滤 + natives 挑出来', () => {
    const out = buildClientLaunch({ ...base, gameDir: dir, versionId: '1.20.1' });
    if ('error' in out) throw new Error(out.error);
    expect(out.mainClass).toBe('net.minecraft.client.main.Main');
    const cp = out.args[out.args.indexOf('-cp') + 1];
    expect(cp).toContain('core-1.0.jar');
    expect(cp).toContain('1.20.1.jar');
    expect(cp).not.toContain('maconly'); // 只给 osx 的库被规则挡掉
    expect(out.nativeJars).toHaveLength(1);
    expect(out.args).toContain('CortiCam');
    expect(out.args).toContain(offlineUuid('CortiCam'));
    expect(out.args.join(' ')).not.toContain('${');
    expect(out.args).toContain('--width');
    expect(out.args).toContain('1280');
    expect(out.args).not.toContain('--demo');
  });

  it('直连服务器走 quickPlay;不直连就没有这一段', () => {
    const joined = buildClientLaunch({ ...base, gameDir: dir, versionId: '1.20.1', joinServer: { host: '127.0.0.1', port: 25565 } });
    if ('error' in joined) throw new Error(joined.error);
    expect(joined.args).toContain('--quickPlayMultiplayer');
    expect(joined.args).toContain('127.0.0.1:25565');
    const alone = buildClientLaunch({ ...base, gameDir: dir, versionId: '1.20.1' });
    if ('error' in alone) throw new Error(alone.error);
    expect(alone.args).not.toContain('--quickPlayMultiplayer');
  });

  it('继承版本:mainClass 换成 loader,库合并,主 jar 仍是父版本的', () => {
    const out = buildClientLaunch({ ...base, gameDir: dir, versionId: 'fabric-1.20.1' });
    if ('error' in out) throw new Error(out.error);
    expect(out.mainClass).toContain('KnotClient');
    expect(out.versionChain).toEqual(['fabric-1.20.1', '1.20.1']);
    const cp = out.args[out.args.indexOf('-cp') + 1];
    expect(cp.indexOf('fabric-loader')).toBeLessThan(cp.indexOf('core-1.0.jar')); // loader 排在前面
    expect(cp).toContain(join('versions', '1.20.1', '1.20.1.jar'));
    expect(out.args).toContain('--fabric');
  });

  it('ignoreList 指向实际加载的那个主 jar', () => {
    const out = buildClientLaunch({ ...base, gameDir: dir, versionId: 'bootstrap-1.20.1' });
    if ('error' in out) throw new Error(out.error);
    const cp = out.args[out.args.indexOf('-cp') + 1];
    const mainJar = basename(cp.split(';').at(-1)!);
    expect(mainJar).toBe('1.20.1.jar');
    expect(out.args.find((a) => a.startsWith('-DignoreList='))).toBe(`-DignoreList=client-extra,${mainJar}`);
  });

  it('装不全的库进 missingLibraries', () => {
    const out = buildClientLaunch({ ...base, gameDir: dir, versionId: 'bootstrap-1.20.1' });
    if ('error' in out) throw new Error(out.error);
    expect(out.missingLibraries).toEqual(['org/example/absent/2.0/absent-2.0.jar']);
    const complete = buildClientLaunch({ ...base, gameDir: dir, versionId: '1.20.1' });
    if ('error' in complete) throw new Error(complete.error);
    expect(complete.missingLibraries).toEqual([]);
  });

  it('自定义 JVM 参数落在 mainClass 之前', () => {
    const out = buildClientLaunch({ ...base, gameDir: dir, versionId: '1.20.1', jvmArgs: ['-Xmx4G'] });
    if ('error' in out) throw new Error(out.error);
    expect(out.args.indexOf('-Xmx4G')).toBeLessThan(out.args.indexOf(out.mainClass));
  });

  it('目录/版本不对:回错误文本,不抛', () => {
    expect(buildClientLaunch({ ...base, gameDir: join(dir, 'nope'), versionId: '1.20.1' })).toEqual({ error: expect.stringContaining('不存在') });
    expect(buildClientLaunch({ ...base, gameDir: dir, versionId: '9.9' })).toEqual({ error: expect.stringContaining('找不到版本文件') });
    expect(buildClientLaunch({ ...base, gameDir: '', versionId: '' })).toEqual({ error: expect.stringContaining('未配置') });
  });

  it('装了不止一个版本时不猜,要求显式指定', () => {
    expect(soleVersionId(dir)).toBeNull();
    expect(buildClientLaunch({ ...base, gameDir: dir, versionId: '' })).toEqual({ error: expect.stringContaining('恰好一个版本') });
  });
});
