/**
 * 读取部署的 deployment.json，加载其 bot 字段指定的 BotDefinition。
 * 部署根由 src/paths.ts 解析，代码包来自 bots/ 或已安装的 bot 扩展。
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webAssetsProblem } from '../bin/web-assets.mjs';
import { LOG_LEVEL_RANK, type CoreConfig, type LogLevel } from './core/types.ts';
import type { BotDefinition } from './bot.ts';
import { createBot } from './bot.ts';
import { createDeployment, ensureDeployment, listBots, loadDeployment } from './deploy.ts';
import { buildListing, type BotDefaults } from './deploy-listing.ts';
import { secretReader } from './core/secrets.ts';
import { announceDataDir, consoleUrlOf, consumeBootFlags, listensOnEveryInterface, startsPaused, providerAtBoot } from './boot.ts';
import { extensionIconFile, extensionsDir, importBotDefinition, loadExtensions, locateBotPackage, readInstalled, resolveExtensionEntry, type ActiveBotPackage } from './extensions.ts';
import { parseExtensionManifest } from './extensions/manifest.ts';
import { withWorlds } from './world.ts';
import { BUILTIN_WORLDS } from './worlds/index.ts';
import { providerModules, registerProviderModules } from './providers/registry.ts';
import { deploymentDir, deploymentRoot, mainRepoRoot, packageDir, providerDir, providersRoot, readDeploymentManifest, repoRoot } from './paths.ts';

/**
 * botPackage 仅在部署引用扩展 bot 包时返回。
 */
async function loadBotDefinition(
  name: string,
): Promise<{ definition: BotDefinition<CoreConfig>; deployDir: string; pkgDir: string; botPackage?: ActiveBotPackage }> {
  const deployDir = deploymentDir(name);
  const manifest = readDeploymentManifest(name);
  if (!manifest) {
    throw new Error(`${resolve(deployDir, 'deployment.json')} 不存在`);
  }
  const location = locateBotPackage(repoRoot(), manifest.bot, packageDir(manifest.bot));
  const definition = await importBotDefinition(location, {
    treeHas: (id) => existsSync(resolve(packageDir(id), 'index.ts')),
  });
  return {
    definition,
    deployDir,
    pkgDir: location.pkgDir,
    ...(location.source === 'extension' ? { botPackage: { name: location.name, id: definition.id } } : {}),
  };
}

/** 浏览器启动失败时保留终端已输出的地址。 */
function openBrowser(url: string): void {
  try {
    const p = process.platform;
    const [cmd, args] =
      p === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : p === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
    spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* 地址已在终端输出。 */ }
}

function pickBotName(): string {
  const fromArgv = process.argv.slice(2).find((a) => !a.startsWith('-'));
  const name = fromArgv || process.env.CORTICO_BOT || '';
  const available = listBots();
  if (available.length === 0) throw new Error(`${deploymentRoot()} 下没有含 deployment.json 的部署目录`);
  if (!name) {
    if (available.length === 1) return available[0];
    throw new Error(`请指定部署:pnpm start <${available.join(' | ')}>`);
  }
  if (!available.includes(name)) {
    throw new Error(`没有这个部署: ${name}。可选:${available.join(' / ')}`);
  }
  return name;
}

/** 代码包的默认值:展示名与它选的配色方案 id。 */
async function botDefaults(bot: string): Promise<BotDefaults> {
  const location = locateBotPackage(repoRoot(), bot, packageDir(bot));
  const definition = await importBotDefinition(location, {
    treeHas: (id) => existsSync(resolve(packageDir(id), 'index.ts')),
  });
  const defaults = definition.defaults();
  return { displayName: defaults.displayName, scheme: defaults.web.theme };
}

/** 可以拿来建部署的代码包:仓内 `bots/<名>/`,加上装好的、声明为 bot 且入口文件在的扩展。 */
function botPackages(): Array<{ id: string; source: 'tree' | 'extension' }> {
  const treeDir = resolve(mainRepoRoot(), 'bots');
  const tree = existsSync(treeDir)
    ? readdirSync(treeDir).filter((id) => existsSync(resolve(treeDir, id, 'index.ts')))
    : [];
  const installed = readInstalled(extensionsDir(repoRoot())).filter((p) => {
    try {
      const dir = resolve(extensionsDir(repoRoot()), 'node_modules', p.name);
      const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'));
      const parsed = parseExtensionManifest(pkg);
      return parsed.ok && parsed.manifest.kind === 'bot' && existsSync(resolveExtensionEntry(dir, pkg));
    } catch { return false; }
  }).map((p) => p.name);
  return [
    ...tree.map((id) => ({ id, source: 'tree' as const })),
    ...installed.filter((id) => !tree.includes(id)).map((id) => ({ id, source: 'extension' as const })),
  ];
}

/** 装好的 bot 扩展包声明的 PNG 图标,新建部署时复制成初始头像;仓内包与其他格式没有。 */
function packageAvatar(bot: string): string | null {
  if (botPackages().find((p) => p.id === bot)?.source !== 'extension') return null;
  const dir = resolve(extensionsDir(repoRoot()), 'node_modules', bot);
  const icon = extensionIconFile(dir, JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')));
  return icon?.type === 'image/png' ? icon.file : null;
}

/** 命令行上 `--名=值` 的值;没给这个开关时为 null。 */
function flagValue(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

async function main(): Promise<void> {
  if (process.argv.includes('--create-default')) {
    process.stdout.write(ensureDeployment() + '\n');
    return;
  }

  const created = flagValue('create-deployment');
  if (created !== null) {
    const bot = flagValue('bot');
    if (!bot) throw new Error('--create-deployment 需要同时给 --bot=<代码包>');
    const displayName = flagValue('display-name');
    const avatarFrom = packageAvatar(bot);
    process.stdout.write(
      createDeployment({ name: created, bot, ...(displayName ? { displayName } : {}), ...(avatarFrom ? { avatarFrom } : {}) }) + '\n',
    );
    return;
  }

  if (process.argv.includes('--json')) {
    const listing = await buildListing({
      root: deploymentRoot(),
      deployments: listBots(),
      packages: botPackages(),
      defaultsOf: botDefaults,
    });
    process.stdout.write(JSON.stringify(listing) + '\n');
    return;
  }

  if (process.argv.includes('--list')) {
    process.stdout.write(listBots().join('\n') + '\n');
    return;
  }

  const botName = pickBotName();
  const { definition: loadedDefinition, deployDir: botDir, pkgDir, botPackage } = await loadBotDefinition(botName);

  // 扩展 provider 必须在 createBot 解析端点配置前注册。
  const extensions = await loadExtensions(repoRoot(), {
    reserved: BUILTIN_WORLDS.map((m) => m.id),
    reservedProviders: providerModules.map((m) => m.id),
    ...(botPackage ? { activeBot: botPackage } : {}),
  });
  registerProviderModules(extensions.providers);
  const definition = withWorlds(loadedDefinition, [...BUILTIN_WORLDS, ...extensions.worlds]);

  const loaded = loadDeployment(definition, botDir, repoRoot(), pkgDir, providersRoot());
  const cfg = loaded.config;

  announceDataDir(loaded.dataDir);

  // 日志落盘门槛:--log-level=<级别> > CORTICO_LOG > config.json
  const levelArg = process.argv.find((a) => a.startsWith('--log-level='))?.slice('--log-level='.length) ?? process.env.CORTICO_LOG;
  if (levelArg) {
    if (!(levelArg in LOG_LEVEL_RANK)) {
      console.error(`无效日志级别: ${levelArg}(可选 ${Object.keys(LOG_LEVEL_RANK).join(' / ')})`);
      process.exit(1);
    }
    cfg.logging.file = levelArg as LogLevel;
  }

  // 监听地址与端口:--host= / --port= 只覆盖本次运行,不写回 config.json。
  const hostArg = flagValue('host');
  if (hostArg !== null) {
    if (!hostArg.trim()) { console.error('--host 需要一个地址,如 0.0.0.0'); process.exit(1); }
    cfg.web.host = hostArg.trim();
  }
  const portArg = flagValue('port');
  if (portArg !== null) {
    const port = Number(portArg);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error(`无效端口: ${portArg}(0–65535 的整数,0 由系统分配)`);
      process.exit(1);
    }
    cfg.web.port = port;
  }

  // 重启标志必须在装配与 session 加载之前处理
  consumeBootFlags(loaded.dataDir);

  const activeProvider = providerAtBoot(cfg);
  const endpointDir = activeProvider ? providerDir(cfg.activeProvider) : null;
  const missingSecret =
    activeProvider?.secret && endpointDir && !secretReader(resolve(endpointDir, '.env'))(activeProvider.secret)
      ? activeProvider.secret
      : null;

  const bot = createBot(loaded, definition, { extensions });

  // 必须在启动主循环前暂停，避免首批事件提前投递。
  const paused = startsPaused();
  if (paused) bot.core.bus.setPaused(true);

  const { port } = await bot.start();

  console.log(`\n  Bot:       ${botName}${cfg.displayName && cfg.displayName !== botName ? ` (${cfg.displayName})` : ''}`);
  const consoleUrl = port === null ? null : consoleUrlOf(bot.webApp?.boundAddress ?? null, port);
  if (port !== null) {
    console.log(`  控制台:    ${consoleUrl}${listensOnEveryInterface(bot.webApp?.boundAddress ?? null) ? `(监听 ${bot.webApp?.boundAddress},所有网卡)` : ''}`);
    const assetsProblem = webAssetsProblem(fileURLToPath(new URL('..', import.meta.url)));
    if (assetsProblem) {
      console.log(`  ⚠ 控制台产物需要重建(${assetsProblem});停止 bot 后运行 pnpm build:web`);
    }
  }
  for (const slot of bot.assembly.slots) {
    console.log(slot.mounted ? `  World:    ${slot.id}` : `  World:    ${slot.id} · 未激活`);
  }
  for (const entry of bot.assembly.missing) {
    console.log(`  World:    ${entry.id} 不可用: ${entry.reason}`);
  }
  for (const ext of extensions.records) {
    console.log(ext.loaded
      ? `  扩展:      ${ext.name}@${ext.version} → ${ext.kind === 'provider' ? 'provider' : ext.kind === 'bot' ? 'bot' : 'World'} ${ext.worldId}`
      : ext.idle
        ? `  扩展:      ${ext.name}@${ext.version} · bot 包,本部署未引用`
        : `  扩展:      ${ext.name} 未加载: ${ext.reason}`);
  }
  console.log(`  主模型:    ${activeProvider?.spec?.model || '未配置；请在控制台「模型供应商」页选择连接与模型'}`);
  if (missingSecret && endpointDir) {
    const envFile = resolve(endpointDir, '.env');
    const where = existsSync(envFile) ? `${envFile} 里也没有` : `${envFile} 不存在`;
    console.log(`  ⚠ 缺少 ${missingSecret}:进程环境里没有,${where}；可在控制台「模型提供商」页修改密钥变量名或补填密钥`);
  }
  if (paused) {
    console.log('  ⏸ 已暂停');
  }
  console.log('');

  const openBrowserFlag =
    process.env.CORTICO_OPEN_BROWSER === '1' ||
    process.env.CORTICO_OPEN_BROWSER === 'true' ||
    process.argv.includes('--open');
  if (openBrowserFlag && consoleUrl !== null) openBrowser(consoleUrl);

  // 此时限覆盖整个关机流程；各步骤的时限由 bot.shutdown() 管理。
  const SHUTDOWN_GRACE_MS = 35_000;
  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n收到 ${sig}，正在关机…`);
    let code = 0;
    try {
      const report = await Promise.race([
        bot.shutdown(sig),
        new Promise<null>((r) => setTimeout(() => r(null), SHUTDOWN_GRACE_MS)),
      ]);
      if (!report) {
        console.log(`  关机超过 ${SHUTDOWN_GRACE_MS / 1000} 秒，强制退出。`);
        code = 1;
      } else {
        for (const step of report.steps) {
          console.log(`  ${step.ok ? '✓' : '✗'} ${step.label}${step.ok ? '' : ` — ${step.detail ?? '未完成'}`}`);
        }
        for (const check of report.externalChecks) {
          if (check.status === 'verified-ended') {
            console.log(`  ✓ ${check.label} — ${check.detail}`);
            continue;
          }
          console.log(`  ⚠ [P0] ${check.label} — ${check.status}: ${check.detail}`);
          console.log(`    人工动作: ${check.manualAction}`);
        }
        if (!report.complete) code = 1;
      }
    } catch (e) {
      console.error('关机失败:', e instanceof Error ? e.message : e);
      code = 1;
    } finally {
      process.exit(code);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Windows 关闭窗口触发 SIGHUP,Ctrl+Break 触发 SIGBREAK;系统的退出时限可能短于关机流程。
  process.on('SIGHUP', () => void shutdown('SIGHUP(窗口被关闭)'));
  if (process.platform === 'win32') {
    process.on('SIGBREAK', () => void shutdown('SIGBREAK(Ctrl+Break)'));
  }
  const processLog = bot.core.runlog.logger('process');
  process.on('uncaughtException', (err) => {
    processLog.emit('error', '未捕获异常，正在关机', { event: 'uncaught-exception', err });
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    processLog.emit('error', '未处理的 promise 拒绝', { event: 'unhandled-rejection', err: reason });
  });
}

main().catch((e) => {
  console.error('启动失败:', e instanceof Error ? e.message : e);
  process.exit(1);
});
