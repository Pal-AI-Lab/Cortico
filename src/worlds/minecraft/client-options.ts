/**
 * 启动前写入 options.txt 和 SpectatorPlus 客户端配置。
 * 共用 gameDir 的客户端共用设置文件；独立设置需要不同目录。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from '../../core/types.ts';
import { readTextFile } from '../../core/util.ts';

/**
 * 合并 options.txt 时保留行序与未覆盖键,缺失键追加到末尾。
 * 值允许包含冒号,解析时只分割第一个冒号。
 */
export function mergeOptions(prev: string, overrides: Record<string, string>): string {
  const remaining = new Map(Object.entries(overrides));
  const lines = prev.split(/\r?\n/).map((line) => {
    const at = line.indexOf(':');
    if (at <= 0) return line;
    const key = line.slice(0, at);
    if (!remaining.has(key)) return line;
    const value = remaining.get(key)!;
    remaining.delete(key);
    return `${key}:${value}`;
  });
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const [key, value] of remaining) lines.push(`${key}:${value}`);
  return `${lines.join('\n')}\n`;
}

/** 写入 options.txt，保留未覆盖键；缺失文件只包含传入键。 */
function writeOptions(gameDir: string, overrides: Record<string, string>, note: string, log: Logger): void {
  const file = join(gameDir, 'options.txt');
  try {
    const prev = existsSync(file) ? readTextFile(file) : '';
    const next = mergeOptions(prev, overrides);
    if (next === prev) return;
    writeFileSync(file, next, 'utf8');
    log.info(`已调整 ${file}:${note}`);
  } catch (err) {
    log.warn(`options.txt 调整失败(不影响启动): ${(err as Error).message}`);
  }
}

export function applyLaunchOptions(gameDir: string, log: Logger): void {
  writeOptions(
    gameDir,
    { pauseOnLostFocus: 'false', onboardAccessibility: 'false', soundCategory_master: '1.0' },
    '失焦不弹暂停菜单,跳过首启引导屏,主音量拉满',
    log,
  );
}

/** 将 chatVisibility 设为 FULL，以启用聊天框和命令输入。 */
export function applyChatVisible(gameDir: string, log: Logger): void {
  writeOptions(gameDir, { chatVisibility: '0' }, '聊天框与命令行可用', log);
}

/** SpectatorPlus 的 openScreens 控制附身目标的 GUI 同步，由 client.syncGui 配置。 */
export function mergeSpectatorPlusConfig(prev: string, overrides: Record<string, boolean>): string {
  let obj: Record<string, unknown> = {};
  if (prev.trim()) {
    const parsed: unknown = JSON.parse(prev);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      obj = parsed as Record<string, unknown>;
    }
  }
  for (const [k, v] of Object.entries(overrides)) obj[k] = v;
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/** 启动前合并 config/spectatorplus/client.json；缺失文件只写 openScreens。 */
export function applySpectatorPlusConfig(gameDir: string, log: Logger, openScreens: boolean): void {
  const file = join(gameDir, 'config', 'spectatorplus', 'client.json');
  try {
    const prev = existsSync(file) ? readTextFile(file) : '';
    const next = mergeSpectatorPlusConfig(prev, { openScreens });
    if (next === prev) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, next, 'utf8');
    log.info(`已调整 ${file}:${openScreens
      ? 'bot 开箱子/合成/熔炉时把界面同步到摄像机画面上(GUI 演出)'
      : 'bot 开箱子/熔炉时不把界面同步到摄像机画面上'}`);
  } catch (err) {
    log.warn(`SpectatorPlus 配置调整失败(不影响启动): ${(err as Error).message}`);
  }
}
