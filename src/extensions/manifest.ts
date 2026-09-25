/**
 * 解析 package.json 的 cortico 扩展声明，不访问文件系统；装载器与 check:extension 共用。
 * kind 必须为 world、provider 或 bot；api 必须等于这一类的契约版本。
 * consoleClient 和 consoleStyle 是预构建产物的包内相对路径；服务端分配 URL。
 * 包必须使用 type=module，使扩展与框架通过同一 ESM 解析方式共享模块实例。
 */

export type ExtensionKind = 'world' | 'provider' | 'bot';
export const EXTENSION_KINDS: readonly ExtensionKind[] = ['world', 'provider', 'bot'];

/**
 * 三类扩展各自的契约版本。一类的接口不兼容变更只递增这一类:
 * world 看 `WorldDefinition`,provider 看 `ProviderModule`,bot 看 `BotDefinition`
 * (连同 `BotParts`、`Persona`、`LoadedConfig`);`ConsolePanelContext` 与其余共用接口
 * 变更时三类一起加一。同一次发布里的多处变更合计加一。
 */
export const EXTENSION_API_VERSIONS: Readonly<Record<ExtensionKind, number>> = {
  world: 5,
  provider: 5,
  bot: 6,
};

/** npm 上按类发现用的关键字。 */
export const EXTENSION_KEYWORDS: Readonly<Record<ExtensionKind, string>> = {
  world: 'cortico-world',
  provider: 'cortico-provider',
  bot: 'cortico-bot',
};

/** 框架导入前缀 cortico/ 对应 src/ 下的路径，由 runtime.ts 的模块钩子解析。 */
export const FRAMEWORK_SPECIFIER = 'cortico';

export interface ExtensionManifest {
  /** 不导入包代码即可读取的市场显示名称。 */
  displayName?: string;
  kind: ExtensionKind;
  api: number;
  /** 包内相对路径,`.js` / `.mjs`。 */
  consoleClient?: string;
  /** 包内相对路径,`.css`。要有 `consoleClient` 才有意义。 */
  consoleStyle?: string;
}

/** package.json 里我们会看的字段。 */
export interface ExtensionPackageJson {
  name?: string;
  version?: string;
  description?: string;
  author?: string | { name?: string };
  license?: string;
  homepage?: string;
  repository?: string | { url?: string };
  bugs?: string | { url?: string };
  engines?: Record<string, string>;
  type?: string;
  main?: string;
  module?: string;
  exports?: unknown;
  keywords?: string[];
  dependencies?: Record<string, string>;
  cortico?: unknown;
}

export type ExtensionManifestResult =
  | { ok: true; manifest: ExtensionManifest; warnings: string[] }
  | { ok: false; reasons: string[]; warnings: string[] };

/** 包内相对路径仅使用 /；拒绝绝对路径、盘符、.. 段和开头的分隔符。 */
export function isSafeRelativeFile(p: unknown): p is string {
  if (typeof p !== 'string' || p === '') return false;
  if (p.includes('\\') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  return !p.split('/').some((seg) => seg === '..' || seg === '');
}

export function parseExtensionManifest(pkg: ExtensionPackageJson): ExtensionManifestResult {
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (pkg.type !== 'module') {
    reasons.push("package.json 需要 \"type\": \"module\"，以保持扩展与框架的 ESM 模块实例一致。");
  }

  const block = pkg.cortico;
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    reasons.push('package.json 缺少 cortico 块(至少要 kind 与 api)。');
    return { ok: false, reasons, warnings };
  }
  const m = block as Record<string, unknown>;
  if (m.displayName !== undefined && (typeof m.displayName !== 'string' || !m.displayName.trim())) reasons.push('cortico.displayName 必须是非空字符串。');

  const kind = m.kind;
  const kindOk = typeof kind === 'string' && (EXTENSION_KINDS as readonly string[]).includes(kind);
  if (!kindOk) {
    reasons.push(`cortico.kind 必须是 ${EXTENSION_KINDS.map((k) => `"${k}"`).join(' 或 ')},现在是 ${JSON.stringify(kind)}。`);
  }

  const api = m.api;
  // kind 认不出时不比版本:每一类的契约版本各走各的,不知道是哪一类就没有可比的数。
  const expected = kindOk ? EXTENSION_API_VERSIONS[kind as ExtensionKind] : undefined;
  if (typeof api !== 'number' || !Number.isInteger(api) || api < 1) {
    const note = expected === undefined ? '' : `(本框架的 ${kind} 契约是 v${expected})`;
    reasons.push(`cortico.api 必须是正整数${note},现在是 ${JSON.stringify(api)}。`);
  } else if (expected !== undefined && api < expected) {
    reasons.push(`扩展按 ${kind} 契约 v${api} 编写,本框架的 ${kind} 契约是 v${expected}:扩展需要升级。`);
  } else if (expected !== undefined && api > expected) {
    reasons.push(`扩展要求 ${kind} 契约 v${api},本框架的 ${kind} 契约只到 v${expected}:框架需要升级。`);
  }

  const client = m.consoleClient;
  if (client !== undefined) {
    if (!isSafeRelativeFile(client)) {
      reasons.push(`cortico.consoleClient 必须是包内相对路径(不含 ..、不以 / 开头、只用 /),现在是 ${JSON.stringify(client)}。`);
    } else if (!/\.m?js$/.test(client)) {
      reasons.push('cortico.consoleClient 必须指向预构建好的 .js / .mjs;浏览器不跑 TypeScript。');
    }
  }
  const style = m.consoleStyle;
  if (style !== undefined) {
    if (client === undefined) {
      reasons.push('cortico.consoleStyle 要与 consoleClient 一起给:样式随面板 bundle 注入。');
    } else if (!isSafeRelativeFile(style)) {
      reasons.push(`cortico.consoleStyle 必须是包内相对路径,现在是 ${JSON.stringify(style)}。`);
    } else if (!/\.css$/.test(style)) {
      reasons.push('cortico.consoleStyle 必须指向 .css。');
    }
  }

  if (kindOk) {
    const keyword = EXTENSION_KEYWORDS[kind as ExtensionKind];
    if (!(pkg.keywords ?? []).includes(keyword)) {
      warnings.push(`keywords 里没有 "${keyword}":发布到 npm 后控制台的搜索找不到它(本地安装不受影响)。`);
    }
  }

  if (reasons.length) return { ok: false, reasons, warnings };
  return {
    ok: true,
    warnings,
    manifest: {
      ...(typeof m.displayName === 'string' ? { displayName: m.displayName.trim() } : {}),
      kind: kind as ExtensionKind,
      api: api as number,
      ...(typeof client === 'string' ? { consoleClient: client } : {}),
      ...(typeof style === 'string' ? { consoleStyle: style } : {}),
    },
  };
}

// 浏览器端产物:服务端分配 URL

/**
 * pageId 是控制台产物键，格式为 world:<id>、llm:<id> 或 persona:<id>。
 * 版本写入 URL，使新版本使用新的 ESM 模块地址。服务端仅提供所列绝对文件路径。
 */
export interface ExtensionConsoleAsset {
  pageId: string;
  packageName: string;
  version: string;
  jsFile: string;
  cssFile?: string;
}

/** 进 URL 的一段:只留 `isSafeAssetUrl` 放行的字符,其余(`@` `/` `+` `~`…)换成 `-` / `__`。 */
export function extensionAssetSegment(raw: string): string {
  return raw.replace(/^@/, '').replace(/\//g, '__').replace(/[^A-Za-z0-9._-]/g, '-');
}

export const EXTENSION_ASSET_PREFIX = '/assets/extensions/';

/** `/assets/extensions/<包>/<版本>/<文件名>`。 */
export function extensionAssetUrl(packageName: string, version: string, fileName: string): string {
  return `${EXTENSION_ASSET_PREFIX}${extensionAssetSegment(packageName)}/${extensionAssetSegment(version)}/${extensionAssetSegment(fileName)}`;
}
