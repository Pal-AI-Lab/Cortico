/**
 * 浏览器端产物构建:自动发现入口 → esbuild 打包 → 写 asset-manifest.json。
 *
 * 入口与 asset key 按以下目录约定生成:
 *
 *   src/web/client/main.ts        → core
 *   src/worlds/<x>/console/client.ts → world:<x>
 *   src/providers/<x>/console/client.ts → llm:<x>
 *   bots/<y>/console/client.ts    → persona:<y>
 */
import * as esbuild from 'esbuild';
import { readdirSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hashSources } from '../bin/web-assets.mjs';
import {
  CONSOLE_PROTOCOL_VERSION,
  pageIdFor,
  type ConsoleAssetManifest,
} from '../src/web/shared/console-protocol.ts';

/** 一个浏览器端入口:asset key 与它的源文件绝对路径。 */
export interface WebEntry {
  /** core、world:<id>、llm:<id> 或 persona:<id>。 */
  key: string;
  /** 入口源文件的绝对路径。 */
  entry: string;
}

/** core 入口的 asset key。 */
const CORE_KEY = 'core';

const CONSOLE_ENTRY = join('console', 'client.ts');

/** 目录下所有子目录名,目录不存在时为空。 */
function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * 发现浏览器入口;core 在前,其余按 key 排序。
 */
export function discoverEntries(root: string): WebEntry[] {
  const found: WebEntry[] = [];

  const core = join(root, 'src', 'web', 'client', 'main.ts');
  if (existsSync(core)) found.push({ key: CORE_KEY, entry: core });

  const providers: WebEntry[] = [];

  const srcDir = join(root, 'src');
  const worldsDir = join(srcDir, 'worlds');
  for (const name of subdirs(worldsDir)) {
    const entry = join(worldsDir, name, CONSOLE_ENTRY);
    if (existsSync(entry)) providers.push({ key: pageIdFor('world', name), entry });
  }

  const llmDir = join(srcDir, 'providers');
  for (const name of subdirs(llmDir)) {
    const entry = join(llmDir,name,CONSOLE_ENTRY);
    if (existsSync(entry)) providers.push({key:pageIdFor('llm',name),entry});
  }

  const botsDir = join(root, 'bots');
  for (const name of subdirs(botsDir)) {
    const entry = join(botsDir, name, CONSOLE_ENTRY);
    if (existsSync(entry)) providers.push({ key: pageIdFor('persona', name), entry });
  }

  providers.sort((a, b) => (a.key < b.key ? -1 : 1));
  return [...found, ...providers];
}

/** asset key → outdir 下的产物路径前缀(不含 hash 与扩展名)。 */
function outPrefix(key: string): string {
  if (key === CORE_KEY) return 'main';
  return `providers/${key.replace(':', '-')}`;
}

/** 产物绝对路径 → 对外 URL。服务端把 /assets/ 静态映射到 dist/web/。 */
function assetUrl(outdir: string, absPath: string): string {
  return `/assets/${relative(outdir, absPath).split(sep).join('/')}`;
}

/** metafile 里的路径相对 process.cwd(),统一还原成绝对路径。 */
function absFromMeta(metaPath: string): string {
  return resolve(process.cwd(), metaPath);
}

export async function buildWeb(root: string): Promise<ConsoleAssetManifest> {
  const entries = discoverEntries(root);
  const resolvedRoot = resolve(root);
  const outdir = resolve(resolvedRoot,'dist','web');
  if (!outdir.startsWith(resolvedRoot + sep)) throw new Error('Build output must remain inside the supplied repository root');

  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });

  const manifest: ConsoleAssetManifest = { protocolVersion: CONSOLE_PROTOCOL_VERSION, core: null, providers: {}, sources: {} };

  if (entries.length === 0) {
    writeManifest(outdir, manifest);
    console.log('没有发现浏览器端入口(src/web/client/main.ts 与 */console/client.ts 均不存在),已写出空清单。');
    return manifest;
  }

  const result = await esbuild.build({
    entryPoints: entries.map((e) => ({ in: e.entry, out: outPrefix(e.key) })),
    outdir,
    bundle: true,
    splitting: true,
    format: 'esm',
    jsx: 'automatic',
    target: 'es2022',
    platform: 'browser',
    minify: true,
    entryNames: '[dir]/[name]-[hash]',
    chunkNames: 'chunks/[name]-[hash]',
    assetNames: 'media/[name]-[hash]',
    sourcemap: true,
    metafile: true,
  });

  // entryPoint(源文件绝对路径) → 产物,用来把 asset key 接回产物 URL。
  const byEntry = new Map<string, { js: string; css?: string }>();
  for (const [outPath, info] of Object.entries(result.metafile.outputs)) {
    if (!info.entryPoint) continue;
    byEntry.set(absFromMeta(info.entryPoint), {
      js: assetUrl(outdir, absFromMeta(outPath)),
      css: info.cssBundle ? assetUrl(outdir, absFromMeta(info.cssBundle)) : undefined,
    });
  }

  for (const { key, entry } of entries) {
    const out = byEntry.get(entry)!;
    if (key === CORE_KEY) {
      manifest.core = out.js;
      continue;
    }
    manifest.providers[key] = out.css ? { js: out.js, css: out.css } : { js: out.js };
  }

  manifest.sources = hashSources(resolvedRoot, repoInputs(resolvedRoot, result.metafile));
  writeManifest(outdir, manifest);
  reportSizes(outdir, result.metafile);
  return manifest;
}

/** esbuild 读到的仓库内源文件，仓库相对路径；依赖包不计入。 */
function repoInputs(root: string, metafile: esbuild.Metafile): string[] {
  return Object.keys(metafile.inputs)
    .map((p) => relative(root, absFromMeta(p)))
    .filter((rel) => !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('node_modules'))
    .map((rel) => rel.split(sep).join('/'));
}

function writeManifest(outdir: string, manifest: ConsoleAssetManifest): void {
  writeFileSync(join(outdir, 'asset-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/** 产物体积统计不包含 sourcemap。 */
function reportSizes(outdir: string, metafile: esbuild.Metafile): void {
  const rows = Object.entries(metafile.outputs)
    .filter(([p]) => !p.endsWith('.map'))
    .map(([p, info]) => ({ path: assetUrl(outdir, absFromMeta(p)), bytes: info.bytes }))
    .sort((a, b) => b.bytes - a.bytes);

  const total = rows.reduce((sum, r) => sum + r.bytes, 0);
  const width = Math.max(...rows.map((r) => r.path.length));
  for (const r of rows) {
    console.log(`${r.path.padEnd(width)}  ${(r.bytes / 1024).toFixed(1)} KiB`);
  }
  console.log(`${'合计'.padEnd(width)}  ${(total / 1024).toFixed(1)} KiB (${rows.length} 个产物)`);
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  await buildWeb(root);
}
