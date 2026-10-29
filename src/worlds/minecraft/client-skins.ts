/**
 * 通过 CustomSkinLoader 的 LocalSkin 按账号名读取本地 PNG。
 * 所选图片保存在部署 data/ 下，启动前写入每个客户端 gameDir 的 CustomSkinLoader/LocalSkin/skins/。
 * model 设置为 auto，由 CustomSkinLoader 识别 classic 或 slim。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from '../../core/types.ts';
import { readTextFile } from '../../core/util.ts';

export type SkinRole = 'bot' | 'player';

export interface SkinInfo {
  /** 材质尺寸;64x64 是现行格式,64x32 是 1.8 之前的老皮肤(没有第二层与左臂左腿) */
  width: number;
  height: number;
  bytes: number;
  at: string;
}

const CSL_DIR = 'CustomSkinLoader';
const CSL_CONFIG = 'CustomSkinLoader.json';
const LOCAL_SKIN_PATTERN = 'LocalSkin/skins/{USERNAME}.png';

/** 本地皮肤那条 loader 的完整声明;`Legacy` 是 CustomSkinLoader 里"按 URL 模板取图"的那类 */
const LOCAL_SKIN_ENTRY = {
  name: 'LocalSkin',
  type: 'Legacy',
  checkPNG: false,
  skin: LOCAL_SKIN_PATTERN,
  model: 'auto',
  cape: 'LocalSkin/capes/{USERNAME}.png',
  elytra: 'LocalSkin/elytras/{USERNAME}.png',
};

/** 读取 PNG IHDR 的宽高；文件头不完整或格式不符时返回 null。 */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) return null;
  for (let i = 0; i < SIG.length; i++) if (bytes[i] !== SIG[i]) return null;
  const u32 = (at: number): number =>
    ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  return { width: u32(16), height: u32(20) };
}

/** 能不能当皮肤用:PNG,且是 64x64(现行)或 64x32(1.8 之前) */
export function checkSkinBytes(bytes: Uint8Array): { width: number; height: number } | { error: string } {
  const size = pngSize(bytes);
  if (!size) return { error: '不是 PNG 图片' };
  const { width, height } = size;
  const ok = width === 64 && (height === 64 || height === 32);
  if (!ok) return { error: `皮肤材质得是 64x64(或 1.8 之前的 64x32),这张是 ${width}x${height}` };
  return size;
}

function storedSkinPath(storeDir: string, role: SkinRole): string {
  return join(storeDir, `minecraft-skin-${role}.png`);
}

export function readStoredSkin(storeDir: string, role: SkinRole): Buffer | null {
  if (!storeDir) return null;
  const path = storedSkinPath(storeDir, role);
  return existsSync(path) ? readFileSync(path) : null;
}

export function storedSkinInfo(storeDir: string, role: SkinRole): SkinInfo | null {
  const bytes = readStoredSkin(storeDir, role);
  if (!bytes) return null;
  const size = pngSize(bytes);
  if (!size) return null;
  const stat = statSync(storedSkinPath(storeDir, role));
  return { ...size, bytes: bytes.length, at: stat.mtime.toISOString() };
}

export function setStoredSkin(storeDir: string, role: SkinRole, bytes: Uint8Array): SkinInfo | { error: string } {
  if (!storeDir) return { error: '没有留底的地方:这份部署没有 data/ 目录' };
  const checked = checkSkinBytes(bytes);
  if ('error' in checked) return checked;
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(storedSkinPath(storeDir, role), bytes);
  return { ...checked, bytes: bytes.length, at: new Date().toISOString() };
}

/** 删除保存的皮肤并返回原字节，供调用方核对客户端文件内容。 */
export function clearStoredSkin(storeDir: string, role: SkinRole): Buffer | null {
  const prev = readStoredSkin(storeDir, role);
  if (prev) rmSync(storedSkinPath(storeDir, role));
  return prev;
}

/** 将本地皮肤 loader 排在首位，优先于远端来源；其余配置保持原样。 */
export function mergeSkinLoaderConfig(prev: string): string {
  let obj: Record<string, unknown> = {};
  if (prev.trim()) {
    const parsed: unknown = JSON.parse(prev);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
  }
  const list = Array.isArray(obj.loadlist) ? [...(obj.loadlist as unknown[])] : [];
  const isLocal = (item: unknown): boolean => {
    if (!item || typeof item !== 'object') return false;
    const skin = (item as Record<string, unknown>).skin;
    return typeof skin === 'string' && skin === LOCAL_SKIN_PATTERN;
  };
  const found = list.find(isLocal);
  const rest = list.filter((item) => !isLocal(item));
  obj.loadlist = [found ?? LOCAL_SKIN_ENTRY, ...rest];
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/** 检测游戏目录中的 CustomSkinLoader 模组。 */
export function hasSkinMod(gameDir: string): boolean {
  const mods = join(gameDir, 'mods');
  if (!gameDir || !existsSync(mods)) return false;
  return readdirSync(mods).some((f) => /^customskinloader.*\.jar$/i.test(f));
}

export function installedSkinPath(gameDir: string, username: string): string {
  return join(gameDir, CSL_DIR, 'LocalSkin', 'skins', `${username}.png`);
}

export function installedMatches(gameDir: string, username: string, bytes: Buffer | null): boolean {
  if (!gameDir || !username || !bytes) return false;
  const path = installedSkinPath(gameDir, username);
  return existsSync(path) && readFileSync(path).equals(bytes);
}

/** 启动前按账号名写入所选 PNG，并合并本地 loader 配置；未选择皮肤时不写配置。 */
export function applySkins(
  gameDir: string,
  entries: Array<{ username: string; bytes: Buffer }>,
  log: Logger,
): void {
  const wanted = entries.filter((e) => e.username && e.bytes.length > 0);
  if (!gameDir || wanted.length === 0) return;
  const done: string[] = [];
  try {
    for (const { username, bytes } of wanted) {
      const dst = installedSkinPath(gameDir, username);
      if (existsSync(dst) && readFileSync(dst).equals(bytes)) continue;
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, bytes);
      done.push(username);
    }
    const configFile = join(gameDir, CSL_DIR, CSL_CONFIG);
    const prev = existsSync(configFile) ? readTextFile(configFile) : '';
    const next = mergeSkinLoaderConfig(prev);
    if (next !== prev) {
      mkdirSync(join(gameDir, CSL_DIR), { recursive: true });
      writeFileSync(configFile, next, 'utf8');
    }
    if (done.length > 0) log.info(`已铺皮肤到 ${gameDir}:${done.join('、')}`);
    if (!hasSkinMod(gameDir)) {
      log.warn(`${join(gameDir, 'mods')} 里没有 CustomSkinLoader,皮肤铺了也不会被读`);
    }
  } catch (err) {
    log.warn(`皮肤铺设失败(不影响启动): ${(err as Error).message}`);
  }
}

/** 仅删除内容与 expect 相同的账号皮肤文件。 */
export function removeInstalledSkin(gameDir: string, username: string, expect: Buffer | null): boolean {
  if (!installedMatches(gameDir, username, expect)) return false;
  rmSync(installedSkinPath(gameDir, username));
  return true;
}
