/** 扫描控制台代码的 import、领域词、目录发现与资源归属；例外必须使用带理由的 arch-allow。 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '../..');
const WEB_CORE_ROOTS = ['src/web/client', 'src/web/shared'];
const WEB_CORE_FILES = ['src/web/server.ts', 'src/web/strings.ts', 'src/web/console-pages.ts', 'src/web/files.ts'];

const toPosix = (p: string): string => p.replaceAll('\\', '/');

/** 递归列出目录下所有文件(仓库相对、posix 分隔);目录不存在视为空集合。 */
function walk(root: string, base = REPO): string[] {
  const abs = resolve(base, root);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const child = join(abs, entry.name);
    if (entry.isDirectory()) out.push(...walk(child, base));
    else if (entry.isFile()) out.push(toPosix(relative(base, child)));
  }
  return out.sort();
}

const SCRIPT_EXT = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];
const TEXT_EXT = [...SCRIPT_EXT, '.html', '.css'];
const hasExt = (file: string, exts: string[]): boolean => exts.some((e) => file.endsWith(e));

const readLines = (rel: string): string[] => readFileSync(resolve(REPO, rel), 'utf8').split(/\r?\n/);

// ── Guard A:import 边界 ────────────────────────────────────────────────

/** import / export-from / 动态 import / require / 副作用 import 的模块说明符。 */
const SPECIFIER_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
];

/** 说明符转为仓库相对路径；第三方裸包名返回 null。 */
function normalizeSpecifier(spec: string, fromFile: string): string | null {
  if (spec.startsWith('.')) return toPosix(relative(REPO, resolve(dirname(resolve(REPO, fromFile)), spec)));
  if (/^[@~]\//.test(spec)) return spec.slice(2); // 别名根写法 @/... ~/...
  if (/^\/?(src|bots)\//.test(spec)) return spec.replace(/^\//, '');
  return null;
}

const FORBIDDEN_TARGETS: Array<{ what: string; re: RegExp }> = [
  { what: 'World', re: /(^|\/)src\/worlds\/[^/]+(\/|$)/ },
  { what: '具体 bot', re: /(^|\/)bots(\/|$)/ },
  { what: 'LLM Provider 模块', re: /(^|\/)src\/providers\/[^/]+\// },
];

/** 返回可直接照着改的违规行:`文件:行  → 说明符`。 */
function findForbiddenImports(files: string[], read: (f: string) => string[] = readLines): string[] {
  const out: string[] = [];
  for (const file of files.filter((f) => hasExt(f, SCRIPT_EXT))) {
    read(file).forEach((line, i) => {
      for (const pattern of SPECIFIER_PATTERNS) {
        pattern.lastIndex = 0;
        for (const m of line.matchAll(pattern)) {
          const spec = m[1];
          const norm = normalizeSpecifier(spec, file);
          if (!norm) continue;
          const hit = FORBIDDEN_TARGETS.find((t) => t.re.test(norm));
          if (hit) out.push(`${file}:${i + 1}  Web Core 不得 import ${hit.what} → '${spec}'`);
        }
      }
    });
  }
  return out;
}

// ── Guard B:领域词 + 白名单机制 ────────────────────────────────────────

const DOMAIN_WORDS = ['qq', 'minecraft', 'vtuber', 'dream', 'checkpoint', 'persona-git', 'personaGit'];

/**
 * 文件级白名单:两条通用规则,不是 World 名单。
 * 新增例外只能靠"放进 fixtures 目录 / 起名 *.fixture.ts",不许往测试里写死文件名。
 */
const FILE_ALLOW_RULES: Array<{ why: string; match: (rel: string) => boolean }> = [
  { why: 'fixtures 目录', match: (rel) => rel.includes('/fixtures/') },
  { why: '*.fixture.ts', match: (rel) => rel.endsWith('.fixture.ts') },
];
/** 行级白名单:必须写明理由,`// arch-allow:` 后面留空不算豁免。 */
const LINE_ALLOW_RE = /\/\/\s*arch-allow:\s*\S/;

const fileAllowReason = (rel: string): string | null => FILE_ALLOW_RULES.find((r) => r.match(rel))?.why ?? null;
const lineAllowed = (line: string): boolean => LINE_ALLOW_RE.test(line);

const WORD_RES = DOMAIN_WORDS.map((w) => ({
  word: w,
  re: new RegExp(`\\b${w.replaceAll('-', '\\-')}\\b`, 'i'),
}));

/** 返回可直接照着改的违规行:`文件:行  命中词  |  原文`。 */
function findDomainWords(files: string[], read: (f: string) => string[] = readLines): string[] {
  const out: string[] = [];
  for (const file of files.filter((f) => hasExt(f, TEXT_EXT))) {
    if (fileAllowReason(file)) continue;
    read(file).forEach((line, i) => {
      if (lineAllowed(line)) return;
      const hits = WORD_RES.filter((w) => w.re.test(line)).map((w) => w.word);
      if (hits.length) out.push(`${file}:${i + 1}  出现领域词 [${hits.join(', ')}]  |  ${line.trim()}`);
    });
  }
  return out;
}

// ── Guard E:provider 目录约定发现 ──────────────────────────────────────

/**
 * 纯目录扫描找出所有 provider 控制台入口:src/worlds/<World>/console/client.ts
 * 与 bots/<人格>/console/client.ts。没有任何写死的 World/人格名单。
 */
export function findProviderConsoleClients(base = REPO): string[] {
  const groups: Array<{ parent: string; dirMatch: (name: string) => boolean }> = [
    { parent: 'src/worlds', dirMatch: () => true },
    { parent: 'bots', dirMatch: () => true },
  ];
  const found: string[] = [];
  for (const { parent, dirMatch } of groups) {
    const parentAbs = resolve(base, parent);
    if (!existsSync(parentAbs)) continue;
    for (const entry of readdirSync(parentAbs, { withFileTypes: true })) {
      if (!entry.isDirectory() || !dirMatch(entry.name)) continue;
      const rel = `${parent}/${entry.name}/console/client.ts`;
      if (existsSync(resolve(base, rel))) found.push(rel);
    }
  }
  return found.sort();
}

// ── 测试 ───────────────────────────────────────────────────────────────

const webCoreFiles = [
  ...WEB_CORE_ROOTS.flatMap((r) => walk(r)),
  ...WEB_CORE_FILES.filter((f) => existsSync(resolve(REPO, f))),
];

describe('Web Core 架构护栏', () => {
  it('Guard A:client/shared 不 import 任何具体 World 或 bot', () => {
    expect(findForbiddenImports(webCoreFiles)).toEqual([]);
  });

  it('Guard B:client/shared 正文里不出现领域词(fixtures 与 arch-allow 行除外)', () => {
    expect(findDomainWords(webCoreFiles)).toEqual([]);
  });

  it('管辖区包含 server.ts 与 providers.ts', () => {
    expect(webCoreFiles).toContain('src/web/server.ts');
    expect(webCoreFiles).toContain('src/web/console-pages.ts');
  });

});

describe('护栏自检(合成样本)', () => {
  const fake = (files: Record<string, string>) => ({
    names: Object.keys(files),
    read: (f: string) => files[f].split('\n'),
  });

  it('Guard A 抓相对/绝对/别名/动态 import,并放过框架内与第三方', () => {
    const f = fake({
      'src/web/client/bad.ts': [
        `import { x } from '../../worlds/qq/world.ts';`,
        `export * from 'src/worlds/minecraft/world.ts';`,
        `const m = await import('@/bots/corti-soulmate/index.ts');`,
        `import '~/bots/cormini/persona/persona.ts';`,
      ].join('\n'),
      'src/web/shared/ok.ts': [
        `import { WebApp } from '../../server.ts';`,
        `import type { Event } from '../../../core/types.ts';`,
        `import * as t from 'io-ts';`,
        `import express from 'express';`,
      ].join('\n'),
    });
    const hits = findForbiddenImports(f.names, f.read);
    expect(hits.map((h) => h.split('  ')[0])).toEqual([
      'src/web/client/bad.ts:1',
      'src/web/client/bad.ts:2',
      'src/web/client/bad.ts:3',
      'src/web/client/bad.ts:4',
    ]);
    // 失败信息要直接可行动:文件:行 + 命中的 import 原文
    expect(hits[0]).toBe(`src/web/client/bad.ts:1  Web Core 不得 import World → '../../worlds/qq/world.ts'`);
    expect(hits[2]).toContain(`具体 bot → '@/bots/corti-soulmate/index.ts'`);
  });

  it('Guard B 大小写不敏感、按单词边界,失败信息带文件:行与原文', () => {
    const f = fake({
      'src/web/client/panel.ts': [
        `const label = 'QQ 面板';`,
        `// 走 personaGit 读历史`,
        `const kind = 'checkpoint';`,
        `const ok = 'quantity';`, // 不含 \bqq\b
        `const also = 'daydreaming';`, // 不含 \bdream\b
      ].join('\n'),
    });
    const hits = findDomainWords(f.names, f.read);
    expect(hits).toEqual([
      `src/web/client/panel.ts:1  出现领域词 [qq]  |  const label = 'QQ 面板';`,
      `src/web/client/panel.ts:2  出现领域词 [personaGit]  |  // 走 personaGit 读历史`,
      `src/web/client/panel.ts:3  出现领域词 [checkpoint]  |  const kind = 'checkpoint';`,
    ]);
  });

  it('Guard B 白名单只有三条通用规则:fixtures 目录、*.fixture.ts、带理由的 arch-allow 行', () => {
    const f = fake({
      'src/web/client/fixtures/demo.ts': `const id = 'minecraft';`,
      'src/web/client/demo.fixture.ts': `const id = 'vtuber';`,
      'src/web/client/live.ts': [
        `const a = 'qq'; // arch-allow: 迁移期临时兼容,Stage 9 删`,
        `const b = 'dream'; // arch-allow:`, // 没写理由 → 不豁免
      ].join('\n'),
    });
    expect(findDomainWords(f.names, f.read)).toEqual([
      `src/web/client/live.ts:2  出现领域词 [dream]  |  const b = 'dream'; // arch-allow:`,
    ]);
    expect(fileAllowReason('src/web/client/fixtures/demo.ts')).toBe('fixtures 目录');
    expect(fileAllowReason('src/web/client/demo.fixture.ts')).toBe('*.fixture.ts');
    expect(fileAllowReason('src/web/client/live.ts')).toBe(null);
  });

  it('Guard E 的发现逻辑不依赖写死名单:临时目录里造个没人听过的 World 也能找到', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arch-guard-'));
    try {
      for (const rel of ['src/worlds/zzz-imaginary/console', 'bots/nobody-knows-me/console', 'src/worlds/no-console/core']) {
        mkdirSync(join(dir, rel), { recursive: true });
      }
      writeFileSync(join(dir, 'src/worlds/zzz-imaginary/console/client.ts'), 'export default {};', 'utf8');
      writeFileSync(join(dir, 'bots/nobody-knows-me/console/client.ts'), 'export default {};', 'utf8');
      expect(findProviderConsoleClients(dir)).toEqual([
        'bots/nobody-knows-me/console/client.ts',
        'src/worlds/zzz-imaginary/console/client.ts',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('目录不存在视为空集合', () => {
    expect(walk('src/web/does-not-exist-yet')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Guard F:扩展不得绕过 ConsolePanelContext
// ---------------------------------------------------------------------------

/** 扫描扩展浏览器代码中的裸网络、定时器与无 signal 监听；带理由的 arch-allow 行可豁免。 */
const BYPASS_RULES: Array<{ why: string; re: RegExp }> = [
  { why: '裸 fetch(应走 ctx.invoke / ctx.invokeBinary)', re: /(^|[^.\w])fetch\s*\(/ },
  { why: '裸 setInterval(应走 ctx.interval)', re: /(^|[^.\w])setInterval\s*\(/ },
  { why: '裸 setTimeout(应走 ctx.timeout)', re: /(^|[^.\w])setTimeout\s*\(/ },
  { why: '裸 new WebSocket(应走 ctx.stream)', re: /new\s+WebSocket\s*\(/ },
  { why: '直接摸 document.body(扩展只往 ctx.root 里写)', re: /document\s*\.\s*body/ },
  { why: '窗口级全局(window.__*)', re: /window\s*\.\s*__/ },
];

/** provider 浏览器端代码的全部文件(client.ts 及其同目录兄弟)。 */
function providerClientFiles(base = REPO): string[] {
  const dirs = new Set(findProviderConsoleClients(base).map((rel) => rel.replace(/\/client\.ts$/, '')));
  const out: string[] = [];
  for (const d of dirs) out.push(...walk(d, base).filter((f) => f.endsWith('.ts')));
  return out.sort();
}

/** 逐行去除注释，跨行保留块注释状态，仅检查代码部分。 */
function codeLines(lines: string[]): string[] {
  let inBlock = false;
  return lines.map((raw) => {
    let out = '';
    let i = 0;
    while (i < raw.length) {
      if (inBlock) {
        const end = raw.indexOf('*/', i);
        if (end < 0) return out;
        inBlock = false;
        i = end + 2;
        continue;
      }
      const lineAt = raw.indexOf('//', i);
      const blockAt = raw.indexOf('/*', i);
      if (blockAt >= 0 && (lineAt < 0 || blockAt < lineAt)) {
        out += raw.slice(i, blockAt);
        inBlock = true;
        i = blockAt + 2;
        continue;
      }
      if (lineAt >= 0) return out + raw.slice(i, lineAt);
      return out + raw.slice(i);
    }
    return out;
  });
}

function findCtxBypasses(files: string[], read: (f: string) => string[] = readLines): string[] {
  const out: string[] = [];
  for (const file of files) {
    if (fileAllowReason(file)) continue;
    const raw = read(file);
    codeLines(raw).forEach((code, i) => {
      if (lineAllowed(raw[i] ?? '')) return;
      for (const r of BYPASS_RULES) {
        if (r.re.test(code)) out.push(`${file}:${i + 1}  ${r.why}  |  ${(raw[i] ?? '').trim()}`);
      }
    });
  }
  return out;
}

describe('Guard F:扩展不得绕过 ConsolePanelContext', () => {
  it('provider 的浏览器端代码里没有裸 fetch / 定时器 / WebSocket / document.body / window.__', () => {
    expect(findCtxBypasses(providerClientFiles())).toEqual([]);
  });

  it('护栏自检:合成样本里的绕过都能抓到,经 ctx 的写法不误伤', () => {
    const files = {
      'src/worlds/x/console/bad.ts': [
        'const r = await fetch("/api/x");',
        'setInterval(tick, 1000);',
        'const ws = new WebSocket(url);',
        'document.body.appendChild(el);',
      ].join('\n'),
      'src/worlds/x/console/good.ts': [
        '/* 本扩展没有 fetch、没有 document.body、没有裸 setInterval。 */',
        '// 行注释里提到 fetch( 也不算',
        'const r = await ctx.invoke("state");',
        'ctx.interval(tick, 1000);',
        'ctx.stream({ message: onMsg });',
        'ctx.root.appendChild(el);',
        'el.addEventListener("click", f, { signal: ctx.signal });',
      ].join('\n'),
    };
    const read = (f: string): string[] => (files[f as keyof typeof files] ?? '').split('\n');
    const hits = findCtxBypasses(Object.keys(files), read);
    expect(hits.map((h) => h.split('  ')[0])).toEqual([
      'src/worlds/x/console/bad.ts:1', 'src/worlds/x/console/bad.ts:2',
      'src/worlds/x/console/bad.ts:3', 'src/worlds/x/console/bad.ts:4',
    ]);
  });
});
