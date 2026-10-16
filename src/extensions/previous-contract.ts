/**
 * 上一版扩展契约(world 5、provider 5、bot 6)的过渡层,Cortico 下一个大版本删除。
 *
 * 当前契约把 WebUI 一侧的接口名由 console 改成 webUi,三类契约各加一;`cortico.api` 还是上一版的包
 * 照常加载,manifest 解析给一条 warning。本模块把旧名接到新名上,只作用于这些包:
 * - manifest 的 `consoleClient` / `consoleStyle` 当 `webUiClient` / `webUiStyle`;
 * - World 实例、Persona、provider 模块的 `console()` 当 `webUi()`。包展开了框架模块再改写 `console` 时
 *   两个名字都在,取 `console`;
 * - `BotParts.console` 当 `webUi`,其中 `consolePages` 当 `webUiPages`;bot 声明的 World `terminal` 当 `console`;
 * - 包 import 的 `cortico/` 下改过名的模块路径映到新路径;
 * - 框架内建 provider 模块多一个不可枚举的 `console`,等于 `webUi`,给包装框架模块的旧 provider 调;
 * - 面板脚本直接请求的 `/api/console/providers/...` 转到 `/api/webui/providers/...` 的处理,只放行这些包的页。
 *
 * `check:extension` 不经过本模块,上一版契约的包在那里判失败。删除时连同调用点(搜 previous-contract)、
 * 各语言 strings 里的 `previousContract` 与文档里写过渡层的段落一起删。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextFunction, Request, Response } from 'express';
import type { BotDefinition, BotParts, WebUiContribution } from '../bot.ts';
import type { CoreConfig } from '../core/types.ts';
import type { ProviderModule } from '../providers/base.ts';
import type { WorldDeclaration, WorldDefinition, WorldSection } from '../world.ts';
import type { ExtensionKind } from './manifest.ts';

/** 写死而不由当前版本减一推出:契约再加一时这里不会跟着指向新的上一版。 */
export const PREVIOUS_CONTRACT_VERSIONS: Readonly<Record<ExtensionKind, number>> = {
  world: 5,
  provider: 5,
  bot: 6,
};

export const UPGRADING_URL = 'https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/upgrading.md';

export function isPreviousContract(kind: string, api: unknown): boolean {
  return Object.hasOwn(PREVIOUS_CONTRACT_VERSIONS, kind) && PREVIOUS_CONTRACT_VERSIONS[kind as ExtensionKind] === api;
}

/** cortico 块里的旧字段名换成新名;新旧都写了时取新名。 */
export function renamePreviousManifestFields(block: Record<string, unknown>): Record<string, unknown> {
  const { consoleClient, consoleStyle, ...rest } = block;
  return {
    ...(consoleClient === undefined ? {} : { webUiClient: consoleClient }),
    ...(consoleStyle === undefined ? {} : { webUiStyle: consoleStyle }),
    ...rest,
  };
}

/** 对象有 `console()` 时让 `webUi` 转调它;对象身份不变。 */
function exposeConsoleAsWebUi<T extends object>(target: T): T {
  const legacy = target as { console?: (...args: unknown[]) => unknown };
  if (typeof legacy.console !== 'function') return target;
  Object.defineProperty(target, 'webUi', {
    value: (...args: unknown[]) => legacy.console!(...args),
    configurable: true,
    enumerable: true,
    writable: true,
  });
  return target;
}

/** 定义与模块对象是包的默认导出,改它的副本;原型照留,方法写在原型上的定义也能用。 */
function copyWith<T extends object>(base: T, patch: Partial<T>): T {
  return Object.assign(Object.create(Object.getPrototypeOf(base) as object | null) as T, base, patch);
}

export function adaptWorldDefinition(def: WorldDefinition<WorldSection>): WorldDefinition<WorldSection> {
  return copyWith(def, { create: (ctx) => exposeConsoleAsWebUi(def.create(ctx)) });
}

export async function adaptProviderModule(mod: ProviderModule): Promise<ProviderModule> {
  const { providerModules } = await import('../providers/registry.ts');
  for (const builtin of providerModules) {
    if (typeof builtin.webUi === 'function' && !('console' in builtin)) {
      Object.defineProperty(builtin, 'console', { value: builtin.webUi, configurable: true, enumerable: false });
    }
  }
  return exposeConsoleAsWebUi(copyWith(mod, {}));
}

const RENAMED_WORLDS: Readonly<Record<string, string>> = { terminal: 'console' };

function renameDeclaredWorld(declaration: WorldDeclaration): WorldDeclaration {
  if (typeof declaration === 'string') return RENAMED_WORLDS[declaration] ?? declaration;
  const id = RENAMED_WORLDS[declaration.id];
  return id ? { ...declaration, id } : declaration;
}

type PreviousWebUiContribution = Omit<WebUiContribution, 'webUiPages'> & {
  consolePages?: WebUiContribution['webUiPages'];
};

function adaptBotParts<C extends CoreConfig>(parts: BotParts<C>): BotParts<C> {
  exposeConsoleAsWebUi(parts.persona);
  for (const world of parts.worlds ?? []) exposeConsoleAsWebUi(world);
  const legacy = (parts as { console?: PreviousWebUiContribution }).console;
  if (!legacy) return parts;
  const { consolePages, ...rest } = legacy;
  return { ...parts, webUi: { ...rest, ...(consolePages ? { webUiPages: consolePages } : {}) } };
}

export function adaptBotDefinition<C extends CoreConfig>(def: BotDefinition<C>): BotDefinition<C> {
  return copyWith(def, {
    ...(def.declares ? { declares: def.declares.map(renameDeclaredWorld) } : {}),
    build: (loaded, worlds) => adaptBotParts(def.build(loaded, worlds)),
  });
}

/** `cortico/` 之后的路径;按序取第一条命中的规则。 */
const RENAMED_MODULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^worlds\/terminal\//, 'worlds/console/'],
  [/^web\/shared\/console-protocol\.ts$/, 'web/shared/webui-protocol.ts'],
  [/^web\/console-pages\.ts$/, 'web/webui-pages.ts'],
  [/^web\/client\/console-pages\//, 'web/client/webui-pages/'],
  [/^providers\/console\//, 'providers/webui/'],
  [/^((?:providers|worlds)\/[a-z0-9-]+\/)console\//, '$1webui/'],
];

/** 目录 → 它所属的包是不是上一版契约;按最近一个带 cortico 块的 package.json 判断。 */
const importerDirs = new Map<string, boolean>();

function corticoBlockAt(dir: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(join(dir, 'package.json'), 'utf8');
  } catch {
    return null;
  }
  const block = (JSON.parse(raw) as { cortico?: unknown }).cortico;
  return block && typeof block === 'object' ? block as Record<string, unknown> : null;
}

function importerIsPreviousContract(parentURL: string | undefined): boolean {
  if (!parentURL?.startsWith('file:')) return false;
  const visited: string[] = [];
  let dir = dirname(fileURLToPath(parentURL));
  let result = false;
  for (;;) {
    const known = importerDirs.get(dir);
    if (known !== undefined) {
      result = known;
      break;
    }
    visited.push(dir);
    const block = corticoBlockAt(dir);
    if (block) {
      result = isPreviousContract(String(block.kind), block.api);
      break;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const seen of visited) importerDirs.set(seen, result);
  return result;
}

/** 上一版契约的包 import 了改过名的框架模块时给出新路径;其余情况 null。 */
export function previousContractModulePath(path: string, parentURL: string | undefined): string | null {
  const rule = RENAMED_MODULES.find(([from]) => from.test(path));
  if (!rule || !importerIsPreviousContract(parentURL)) return null;
  return path.replace(rule[0], rule[1]);
}

export const PREVIOUS_CONTRACT_PANEL_ROUTE = '/api/console/providers/:provider/panels/:panel/:method';

/** 只让 `pages()` 里的页走旧路由;别的页落到后面的路由,和没有这条路由一样。 */
export function previousContractPagesOnly(pages: () => ReadonlySet<string>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (pages().has(String(req.params.provider ?? ''))) next();
    else next('route');
  };
}
