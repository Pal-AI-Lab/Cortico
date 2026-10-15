/**
 * 部署的 WebUI 配色记录：`<部署>/theme.json`。WebUI 读写，启动器只读。
 * 文件内容就是浏览器侧的主题记录形状，写入前逐个 token 规范化。
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeStoredTheme, type StoredTheme } from './shared/theme.ts';

export const THEME_FILE = 'theme.json';

export interface DeploymentTheme {
  /** 部署还没有记录时为 null；调用方落到框架默认方案。 */
  state: StoredTheme | null;
  /** 文件在但读不成 JSON 时的原因。此时 state 为 null，下一次保存会覆盖它。 */
  error?: string;
}

export function readDeploymentTheme(botDir: string): DeploymentTheme {
  const file = join(botDir, THEME_FILE);
  if (!existsSync(file)) return { state: null };
  try {
    return { state: normalizeStoredTheme(JSON.parse(readFileSync(file, 'utf8')) as unknown) };
  } catch (err) {
    return { state: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 规范化后整份替换，返回真正写进去的记录。 */
export function writeDeploymentTheme(botDir: string, value: unknown): StoredTheme {
  const state = normalizeStoredTheme(value);
  const file = join(botDir, THEME_FILE);
  const temporary = join(botDir, `.${THEME_FILE}.${process.pid}.tmp`);
  writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', 'utf8');
  rmSync(file, { force: true });
  renameSync(temporary, file);
  return state;
}
