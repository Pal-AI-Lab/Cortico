/**
 * 解析 package.json 的 cortico 扩展声明，不访问文件系统；装载器与 check:extension 共用。
 * kind 必须为 world、provider 或 bot；api 必须等于这一类的契约版本。
 * webUiClient 和 webUiStyle 是预构建产物的包内相对路径；服务端分配 URL。
 * 包必须使用 type=module，使扩展与框架通过同一 ESM 解析方式共享模块实例。
 */

import type { Language } from '../core/language.ts';
import { text } from './strings.ts';

export type ExtensionKind = 'world' | 'provider' | 'bot';
export const EXTENSION_KINDS: readonly ExtensionKind[] = ['world', 'provider', 'bot'];

/**
 * 三类扩展各自的契约版本。一类的接口不兼容变更只递增这一类:
 * world 看 `WorldDefinition`,provider 看 `ProviderModule`,bot 看 `BotDefinition`
 * (连同 `BotParts`、`Persona`、`LoadedConfig`);`WebUiPanelContext` 与其余共用接口
 * 变更时三类一起加一。同一次发布里的多处变更合计加一。
 */
export const EXTENSION_API_VERSIONS: Readonly<Record<ExtensionKind, number>> = {
  world: 6,
  provider: 6,
  bot: 7,
};

/** npm 上按类发现用的关键字。 */
export const EXTENSION_KEYWORDS: Readonly<Record<ExtensionKind, string>> = {
  world: 'cortico-world',
  provider: 'cortico-provider',
  bot: 'cortico-bot',
};

/** 框架导入前缀 cortico/ 对应 src/ 下的路径，由 runtime.ts 的模块钩子解析。 */
export const FRAMEWORK_SPECIFIER = 'cortico';

/** `cortico.icon` 接受的图片格式,按扩展名给出响应的 Content-Type。 */
export const ICON_TYPES: Readonly<Record<string, string>> = { '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

export interface ExtensionManifest {
  /** WebUI 卡片与详情的标题;缺席时用包名。读它不需要导入包代码。 */
  displayName?: string;
  /** 包内相对路径,`.png` / `.webp` / `.svg`;WebUI 卡片的头像。bot 包的 png 图标还是新建部署的初始头像。 */
  icon?: string;
  kind: ExtensionKind;
  api: number;
  /** 包内相对路径,`.js` / `.mjs`。 */
  webUiClient?: string;
  /** 包内相对路径,`.css`。要有 `webUiClient` 才有意义。 */
  webUiStyle?: string;
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

/** reasons 与 warnings 按 `language` 给。 */
export function parseExtensionManifest(pkg: ExtensionPackageJson, language: Language = 'zh'): ExtensionManifestResult {
  const t = text(language);
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (pkg.type !== 'module') {
    reasons.push(t.typeModule);
  }

  const block = pkg.cortico;
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    reasons.push(t.corticoMissing);
    return { ok: false, reasons, warnings };
  }
  const m = block as Record<string, unknown>;
  const displayName = typeof m.displayName === 'string' ? m.displayName.trim() : '';
  if (m.displayName !== undefined && !displayName) warnings.push(t.displayNameEmpty);
  const icon = isSafeRelativeFile(m.icon) && Object.keys(ICON_TYPES).some((ext) => (m.icon as string).toLowerCase().endsWith(ext)) ? m.icon : undefined;
  if (m.icon !== undefined && icon === undefined) {
    warnings.push(t.iconBad(Object.keys(ICON_TYPES).join(' / '), JSON.stringify(m.icon)));
  }

  const kind = m.kind;
  const kindOk = typeof kind === 'string' && (EXTENSION_KINDS as readonly string[]).includes(kind);
  if (!kindOk) {
    reasons.push(t.kindBad(EXTENSION_KINDS.map((k) => `"${k}"`), JSON.stringify(kind)));
  }

  const api = m.api;
  // kind 认不出时不比版本:每一类的契约版本各走各的,不知道是哪一类就没有可比的数。
  const expected = kindOk ? EXTENSION_API_VERSIONS[kind as ExtensionKind] : undefined;
  if (typeof api !== 'number' || !Number.isInteger(api) || api < 1) {
    reasons.push(expected === undefined ? t.apiNotInteger(JSON.stringify(api)) : t.apiNotInteger(JSON.stringify(api), kind as string, expected));
  } else if (expected !== undefined && api < expected) {
    reasons.push(t.apiTooOld(kind as string, api, expected));
  } else if (expected !== undefined && api > expected) {
    reasons.push(t.apiTooNew(kind as string, api, expected));
  }

  const client = m.webUiClient;
  if (client !== undefined) {
    if (!isSafeRelativeFile(client)) {
      reasons.push(t.clientPath(JSON.stringify(client)));
    } else if (!/\.m?js$/.test(client)) {
      reasons.push(t.clientNotJs);
    }
  }
  const style = m.webUiStyle;
  if (style !== undefined) {
    if (client === undefined) {
      reasons.push(t.styleWithoutClient);
    } else if (!isSafeRelativeFile(style)) {
      reasons.push(t.stylePath(JSON.stringify(style)));
    } else if (!/\.css$/.test(style)) {
      reasons.push(t.styleNotCss);
    }
  }

  if (kindOk) {
    const keyword = EXTENSION_KEYWORDS[kind as ExtensionKind];
    if (!(pkg.keywords ?? []).includes(keyword)) {
      warnings.push(t.keywordMissing(keyword));
    }
  }

  if (reasons.length) return { ok: false, reasons, warnings };
  return {
    ok: true,
    warnings,
    manifest: {
      ...(displayName ? { displayName } : {}),
      ...(icon ? { icon } : {}),
      kind: kind as ExtensionKind,
      api: api as number,
      ...(typeof client === 'string' ? { webUiClient: client } : {}),
      ...(typeof style === 'string' ? { webUiStyle: style } : {}),
    },
  };
}

// 浏览器端产物:服务端分配 URL

/**
 * pageId 是 WebUI 产物键，格式为 world:<id>、llm:<id> 或 persona:<id>。
 * 版本写入 URL，使新版本使用新的 ESM 模块地址。服务端仅提供所列绝对文件路径。
 */
export interface ExtensionWebUiAsset {
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
