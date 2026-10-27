import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CoreConfig } from './core/types.ts';
import type { BotDefinition } from './bot.ts';
import type { BotDefaults } from './deploy-listing.ts';
import { extensionIconFile, extensionsDir, importBotDefinition, locateBotPackage, readInstalled, resolveExtensionEntry, type ActiveBotPackage } from './extensions.ts';
import { parseExtensionManifest } from './extensions/manifest.ts';
import { deploymentDir, mainRepoRoot, packageDir, readDeploymentManifest, repoRoot } from './paths.ts';
/**
 * botPackage 仅在部署引用扩展 bot 包时返回。
 */
export async function loadBotDefinition(
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

/** 代码包的默认值:展示名与它选的配色方案 id。 */
export async function botDefaults(bot: string): Promise<BotDefaults> {
  const location = locateBotPackage(repoRoot(), bot, packageDir(bot));
  const definition = await importBotDefinition(location, {
    treeHas: (id) => existsSync(resolve(packageDir(id), 'index.ts')),
  });
  const defaults = definition.defaults();
  return { displayName: defaults.displayName, scheme: defaults.web.theme };
}

/** 可以拿来建部署的代码包:仓内 `bots/<名>/`,加上装好的、声明为 bot 且入口文件在的扩展。 */
export function botPackages(): Array<{ id: string; source: 'tree' | 'extension' }> {
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
export function packageAvatar(bot: string): string | null {
  if (botPackages().find((p) => p.id === bot)?.source !== 'extension') return null;
  const dir = resolve(extensionsDir(repoRoot()), 'node_modules', bot);
  const icon = extensionIconFile(dir, JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')));
  return icon?.type === 'image/png' ? icon.file : null;
}
