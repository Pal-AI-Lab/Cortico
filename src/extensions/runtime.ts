/**
 * 将扩展的 cortico/<路径> 导入映射到框架 src/<路径>。
 * 使用同步 module.registerHooks 与 tsx 的解析链协作；映射后继续调用下一个解析器，
 * 使最终 URL 与框架内部导入一致，保留共享模块实例。扩展须使用 type=module。
 * 上一版契约的包 import 改过名的模块时,路径先经 previous-contract.ts 换成新名。
 * childExecArgv 保留父进程加载器并通过 --import 注册本模块，供引擎子进程使用。
 */
import { registerHooks } from 'node:module';
import { FRAMEWORK_SPECIFIER } from './manifest.ts';
import { previousContractModulePath } from './previous-contract.ts';

const PREFIX = `${FRAMEWORK_SPECIFIER}/`;
/** `src/` 的 URL:本文件在 `src/extensions/`。 */
const SRC_URL = new URL('../', import.meta.url);
const FLAG = Symbol.for('cortico.extensions.resolver');

/** 重复注册无效。 */
export function registerFrameworkResolver(): void {
  const g = globalThis as unknown as Record<symbol, unknown>;
  if (g[FLAG]) return;
  g[FLAG] = true;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith(PREFIX)) {
        const path = specifier.slice(PREFIX.length);
        return next(new URL(previousContractModulePath(path, context.parentURL) ?? path, SRC_URL).href, context);
      }
      return next(specifier, context);
    },
  });
}

/** 本文件的 URL:`--import` 它就等于调了一次 {@link registerFrameworkResolver}。 */
export const RESOLVER_URL = import.meta.url;

/** 保留父进程加载器参数；未配置时补充 --import tsx，最后导入本模块注册解析钩子。 */
export function childExecArgv(): string[] {
  const inherited = process.execArgv.some((a) => /[\\/]tsx[\\/]|(^|\s)tsx$/.test(a))
    ? [...process.execArgv]
    : ['--import', 'tsx'];
  return [...inherited, '--import', RESOLVER_URL];
}

// --import 本模块时注册钩子。
registerFrameworkResolver();
