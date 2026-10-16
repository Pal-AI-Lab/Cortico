import { pick, type Language } from '../core/language.ts';
import { text as zhHant } from './strings.zh-Hant.ts';
import { text as ja } from './strings.ja.ts';
import { text as ko } from './strings.ko.ts';
import { text as fr } from './strings.fr.ts';
import { text as de } from './strings.de.ts';
import { text as es419 } from './strings.es-419.ts';
import { text as ptBR } from './strings.pt-BR.ts';
import { text as it } from './strings.it.ts';
import { text as ru } from './strings.ru.ts';

/** 扩展页上的装载原因、包声明问题、安装与卸载的回执和报错。 */
const zh = {
  // ── 包声明(package.json 的 cortico 块) ─────────────────────────────
  typeModule: 'package.json 需要 "type": "module"，以保持扩展与框架的 ESM 模块实例一致。',
  corticoMissing: 'package.json 缺少 cortico 块(至少要 kind 与 api)。',
  displayNameEmpty: 'cortico.displayName 必须是非空字符串,已忽略。',
  iconBad: (types: string, got: string) => `cortico.icon 必须是包内相对路径,指向 ${types},现在是 ${got};已忽略。`,
  kindBad: (kinds: readonly string[], got: string) => `cortico.kind 必须是 ${kinds.join(' 或 ')},现在是 ${got}。`,
  apiNotInteger: (got: string, kind?: string, expected?: number) =>
    `cortico.api 必须是正整数${kind === undefined ? '' : `(本框架的 ${kind} 契约是 v${expected})`},现在是 ${got}。`,
  apiTooOld: (kind: string, api: number, expected: number) =>
    `扩展按 ${kind} 契约 v${api} 编写,本框架的 ${kind} 契约是 v${expected}:扩展需要升级。`,
  previousContract: (kind: string, api: number, expected: number, url: string) =>
    `扩展按 ${kind} 契约 v${api} 编写,本框架是 v${expected}:现经过渡层加载,Cortico 下一个大版本起不再加载。作者按 ${url} 升级并发布后,更新到新版即可。`,
  apiTooNew: (kind: string, api: number, expected: number) =>
    `扩展要求 ${kind} 契约 v${api},本框架的 ${kind} 契约只到 v${expected}:框架需要升级。`,
  clientPath: (got: string) => `cortico.webUiClient 必须是包内相对路径(不含 ..、不以 / 开头、只用 /),现在是 ${got}。`,
  clientNotJs: 'cortico.webUiClient 必须指向预构建好的 .js / .mjs;浏览器不跑 TypeScript。',
  styleWithoutClient: 'cortico.webUiStyle 要与 webUiClient 一起给:样式随面板 bundle 注入。',
  stylePath: (got: string) => `cortico.webUiStyle 必须是包内相对路径,现在是 ${got}。`,
  styleNotCss: 'cortico.webUiStyle 必须指向 .css。',
  keywordMissing: (keyword: string) => `keywords 里没有 "${keyword}":发布到 npm 后 WebUI 的搜索找不到它(本地安装不受影响)。`,
  describeBad: (got: string) => `cortico.describe 必须是包内相对路径,指向 .json,现在是 ${got};已忽略。`,
  tagsBad: (got: string) => `cortico.tags 必须是字符串数组,现在是 ${got}。`,
  localesBad: (got: string) => `cortico.locales 必须是 { zh?, en? } 对象,每项只含字符串 displayName 与 description,现在是 ${got}。`,
  screenshotsBad: (got: string) => `cortico.screenshots 必须是字符串数组,现在是 ${got}。`,
  // ── 装载 ───────────────────────────────────────────────────────────
  shapeMismatch: (kind: string, type: string, members: string) => `声明是 ${kind} 类,但默认导出缺 ${type} 的 ${members}。`,
  notInNodeModules: 'node_modules 里没有这个包;在 extensions/ 下重新安装一次。',
  importFailed: (detail: string) => `导入失败: ${detail}`,
  worldIdTaken: (id: string) => `World id「${id}」已被内建 World 或先加载的扩展占用。`,
  providerIdTaken: (id: string) => `provider id「${id}」已被内建 provider 或先加载的扩展占用。`,
  // ── 安装、卸载与查询 ───────────────────────────────────────────────
  localPackageMissing: '本机包缺失',
  versionIncomparable: (installed: string, latest: string) => `无法比较版本 ${installed} 与 ${latest}`,
  badPackageName: (name: string) => `不是合法的 npm 包名: ${name}`,
  registryNoVersion: (name: string, version: string) => `registry 没有给出 ${name} 的 ${version} 版本`,
  registryUnreadable: (command: string, code: number | null, output: string) =>
    `读不到 pnpm 的 registry 配置(${command} 退出码 ${code}):\n${output}`,
  noPackageJson: (target: string) => `目录里没有 package.json: ${target}`,
  noNameOrVersion: '扩展缺少有效包名或版本。',
  kindMismatch: (kind: string) => `扩展实际类型为 ${kind}，请切换到对应分类。`,
  manifestUnusable: '扩展声明不可用。',
  installed: (spec: string) => `已安装 ${spec}。重启进程后加载。`,
  notInstalled: (name: string) => `没有安装这个包: ${name}`,
  uninstalled: (name: string) => `已卸载 ${name}。重启进程后生效。`,
  badPathChars: '路径含有不接受的字符。',
  dirMissing: (path: string) => `目录不存在: ${path}`,
  badVersion: (version: string) => `不是合法的版本: ${version}`,
  badRegistry: (value: string) => `npm 源要填 http:// 或 https:// 开头的地址,现在是 ${value}`,
  busy: '已有一个安装 / 卸载在进行,等它结束。',
  pnpmFailed: (command: string, code: number | null, output: string) => `pnpm ${command} 退出码 ${code}:\n${output}`,
  buildsPending: (names: string, dir: string) => `这些包的构建脚本没有运行:${names}。它们不是已装扩展的直接依赖;确认可信后把 ${dir} 里 pnpm-workspace.yaml 的 allowBuilds 中它们的值改成 true,在那里运行 corepack pnpm rebuild ${names},再重启进程。`,
  // ── 扩展市场(官方索引与讨论区) ─────────────────────────────────────
  indexMissing: (file: string) => `官方索引仓里没有 ${file}`,
  indexSchema: (file: string, got: string, expected: number) => `${file} 的格式版本是 ${got}，本机 Cortico 只认 ${expected}`,
  githubLoginRequired: '需要先登录 GitHub。',
  githubFailed: (detail: string) => `GitHub 返回错误：${detail}`,
  noDiscussion: (name: string) => `${name} 的讨论帖还没开：官方索引定时扫描 npm，新发布的包要等下一次扫描。`,
  badCursor: (cursor: string) => `cursor 不是这个接口给出的值：${cursor}`,
};

export const en: typeof zh = {
  typeModule: 'package.json needs "type": "module" so the extension and the framework share one ESM module instance.',
  corticoMissing: 'package.json has no cortico block (it needs at least kind and api).',
  displayNameEmpty: 'cortico.displayName must be a nonempty string; ignored.',
  iconBad: (types, got) => `cortico.icon must be a relative path inside the package pointing to ${types}; got ${got}. Ignored.`,
  kindBad: (kinds, got) => `cortico.kind must be ${kinds.join(' or ')}; got ${got}.`,
  apiNotInteger: (got, kind, expected) =>
    `cortico.api must be a positive integer${kind === undefined ? '' : ` (this framework's ${kind} contract is v${expected})`}; got ${got}.`,
  apiTooOld: (kind, api, expected) =>
    `The extension was written for ${kind} contract v${api}; this framework's ${kind} contract is v${expected}. Upgrade the extension.`,
  previousContract: (kind, api, expected, url) =>
    `The extension was written for ${kind} contract v${api}; this framework is at v${expected}. It loads through a transition layer that the next major Cortico release removes. Once the author upgrades it as described in ${url} and publishes, update to the new version.`,
  apiTooNew: (kind, api, expected) =>
    `The extension needs ${kind} contract v${api}; this framework's ${kind} contract only reaches v${expected}. Upgrade the framework.`,
  clientPath: (got) => `cortico.webUiClient must be a relative path inside the package (no .., no leading /, / separators only); got ${got}.`,
  clientNotJs: 'cortico.webUiClient must point to a prebuilt .js / .mjs file; browsers do not run TypeScript.',
  styleWithoutClient: 'cortico.webUiStyle needs webUiClient: the stylesheet is injected with the panel bundle.',
  stylePath: (got) => `cortico.webUiStyle must be a relative path inside the package; got ${got}.`,
  styleNotCss: 'cortico.webUiStyle must point to a .css file.',
  keywordMissing: (keyword) => `keywords does not include "${keyword}": WebUI search will not find the package on npm (local installs are unaffected).`,
  describeBad: (got) => `cortico.describe must be a relative path inside the package pointing to a .json file; got ${got}. Ignored.`,
  tagsBad: (got) => `cortico.tags must be an array of strings; got ${got}.`,
  localesBad: (got) => `cortico.locales must be a { zh?, en? } object whose entries hold only string displayName and description; got ${got}.`,
  screenshotsBad: (got) => `cortico.screenshots must be an array of strings; got ${got}.`,
  shapeMismatch: (kind, type, members) => `Declared as a ${kind} extension, but the default export lacks ${type}'s ${members}.`,
  notInNodeModules: 'The package is not in node_modules; install it again under extensions/.',
  importFailed: (detail) => `Import failed: ${detail}`,
  worldIdTaken: (id) => `World id "${id}" is already taken by a built-in World or an extension loaded earlier.`,
  providerIdTaken: (id) => `Provider id "${id}" is already taken by a built-in provider or an extension loaded earlier.`,
  localPackageMissing: 'The local package is missing',
  versionIncomparable: (installed, latest) => `Cannot compare versions ${installed} and ${latest}`,
  badPackageName: (name) => `Not a valid npm package name: ${name}`,
  registryNoVersion: (name, version) => `The registry has no ${version} version of ${name}`,
  registryUnreadable: (command, code, output) => `Cannot read the pnpm registry setting (${command} exited with ${code}):\n${output}`,
  noPackageJson: (target) => `No package.json in the directory: ${target}`,
  noNameOrVersion: 'The extension has no valid package name or version.',
  kindMismatch: (kind) => `The extension is actually a ${kind} extension; switch to that category.`,
  manifestUnusable: 'The extension declaration is unusable.',
  installed: (spec) => `Installed ${spec}. It loads after the process restarts.`,
  notInstalled: (name) => `This package is not installed: ${name}`,
  uninstalled: (name) => `Uninstalled ${name}. It takes effect after the process restarts.`,
  badPathChars: 'The path contains characters that are not accepted.',
  dirMissing: (path) => `Directory does not exist: ${path}`,
  badVersion: (version) => `Not a valid version: ${version}`,
  badRegistry: (value) => `The npm registry must be an http:// or https:// URL, got ${value}`,
  busy: 'An install or uninstall is already running; wait for it to finish.',
  pnpmFailed: (command, code, output) => `pnpm ${command} exited with ${code}:\n${output}`,
  buildsPending: (names, dir) => `Build scripts did not run for: ${names}. They are not direct dependencies of an installed extension; if you trust them, set their allowBuilds values to true in pnpm-workspace.yaml in ${dir}, run corepack pnpm rebuild ${names} there, then restart the process.`,
  indexMissing: (file) => `The official index repository has no ${file}`,
  indexSchema: (file, got, expected) => `${file} has format version ${got}; this Cortico reads version ${expected}`,
  githubLoginRequired: 'Sign in with GitHub first.',
  githubFailed: (detail) => `GitHub returned an error: ${detail}`,
  noDiscussion: (name) => `${name} has no discussion yet: the official index scans npm on a schedule, and a newly published package gets one at the next scan.`,
  badCursor: (cursor) => `cursor is not a value this endpoint returned: ${cursor}`,
};

export const text = (language: Language) => pick(language, {
  zh, en, 'zh-Hant': zhHant, ja, ko, fr, de, 'es-419': es419, 'pt-BR': ptBR, it, ru,
});
