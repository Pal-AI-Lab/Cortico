/**
 * 读取部署的 deployment.json，加载其 bot 字段指定的 BotDefinition。
 * 部署根由 src/paths.ts 解析，代码包来自 bots/ 或已安装的 bot 扩展。
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { LOG_LEVEL_RANK, type CoreConfig, type LogLevel } from './core/types.ts';
import type { BotDefinition } from './bot.ts';
import { createBot } from './bot.ts';
import { loadDeployment } from './deploy.ts';
import { secretReader } from './core/secrets.ts';
import { announceDataDir, consumeBootFlags } from './boot.ts';
import { importBotDefinition, loadExtensions, locateBotPackage, type ActiveBotPackage } from './extensions.ts';
import { withWorlds } from './world.ts';
import { BUILTIN_WORLDS } from './worlds/index.ts';
import { providerModules, registerProviderModules } from './providers/registry.ts';
import { deploymentDir, deploymentRoot, packageDir, providerDir, providersRoot, readDeploymentManifest, repoRoot } from './paths.ts';

/** 部署根下每个含 deployment.json 的目录就是一份可启动的部署 */
export function listBots(): string[] {
  const root = deploymentRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => {
      const dir = resolve(root, name);
      return statSync(dir).isDirectory() && existsSync(resolve(dir, 'deployment.json'));
    })
    .sort();
}

/**
 * botPackage 仅在部署引用扩展 bot 包时返回。
 */
async function loadBotDefinition(
  name: string,
): Promise<{ definition: BotDefinition<CoreConfig>; deployDir: string; pkgDir: string; botPackage?: ActiveBotPackage }> {
  const deployDir = deploymentDir(name);
  const manifest = readDeploymentManifest(name);
  if (!manifest) {
    throw new Error(`${resolve(deployDir, 'deployment.json')} 缺失或没有 bot 字段`);
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

async function main(): Promise<void> {
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

  // 重启标志必须在装配与 session 加载之前处理
  consumeBootFlags(loaded.dataDir);

  const activeProvider = cfg.providers?.[cfg.activeProvider];
  if (!activeProvider) {
    console.error(
      `activeProvider="${cfg.activeProvider}" 在 providers 段里不存在(现有: ${Object.keys(cfg.providers ?? {}).join(' / ') || '无'})`,
    );
    process.exit(1);
  }
  const endpointDir = providerDir(cfg.activeProvider);
  const missingSecret =
    activeProvider.secret && !secretReader(resolve(endpointDir, '.env'))(activeProvider.secret)
      ? activeProvider.secret
      : null;

  const bot = createBot(loaded, definition, { extensions });

  // 必须在启动主循环前暂停，避免首批事件提前投递。
  const startPaused =
    process.env.CORTICO_START_PAUSED === '1' ||
    process.env.CORTICO_START_PAUSED === 'true' ||
    process.argv.includes('--paused');
  if (startPaused) bot.core.bus.setPaused(true);

  const { port } = await bot.start();

  console.log(`\n  Bot:       ${botName}${cfg.displayName && cfg.displayName !== botName ? ` (${cfg.displayName})` : ''}`);
  if (port !== null) {
    console.log(`  控制台:    http://127.0.0.1:${port}/`);
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
  console.log(`  主模型:    ${bot.core.mainSessionSpec().model}`);
  if (missingSecret) {
    console.log(`  ⚠ 缺少 ${missingSecret}(进程环境或 ${resolve(endpointDir, '.env')})；可在控制台「语言模型」页修改密钥变量名或补填密钥`);
  }
  if (startPaused) {
    console.log('  ⏸ 已暂停');
  }
  console.log('');

  const openBrowserFlag =
    process.env.CORTICO_OPEN_BROWSER === '1' ||
    process.env.CORTICO_OPEN_BROWSER === 'true' ||
    process.argv.includes('--open');
  if (openBrowserFlag && port !== null) openBrowser(`http://127.0.0.1:${port}/`);

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
