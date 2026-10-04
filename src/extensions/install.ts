/** 包管理器在临时副本中修改依赖；文件替换失败时恢复原安装。 */
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'node_modules'];

function linkTarget(file: string, from: string, to: string): string {
  const raw = readlinkSync(file).replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, '');
  const target = resolve(dirname(file), raw);
  const inside = relative(from, target);
  return inside !== '..' && !inside.startsWith('../') && !inside.startsWith('..\\') && !isAbsolute(inside) ? join(to, inside) : target;
}

function copyTree(source: string, destination: string, from: string, to: string): void {
  const entry = lstatSync(source);
  if (entry.isSymbolicLink()) {
    symlinkSync(linkTarget(source, from, to), destination, existsSync(source) && statSync(source).isDirectory() ? 'junction' : 'file');
  } else if (entry.isDirectory()) {
    mkdirSync(destination);
    for (const name of readdirSync(source)) copyTree(join(source, name), join(destination, name), from, to);
  } else copyFileSync(source, destination);
}

/** pnpm 在 Windows 使用绝对 junction；副本与正式目录各自指向自己的依赖。 */
function rebaseLinks(tree: string, from: string, to: string): void {
  if (!existsSync(tree)) return;
  for (const entry of readdirSync(tree)) {
    const file = join(tree, entry);
    if (lstatSync(file).isSymbolicLink()) {
      const mapped = linkTarget(file, from, to);
      const directory = existsSync(file) && statSync(file).isDirectory();
      rmSync(file);
      symlinkSync(mapped, file, directory ? 'junction' : 'file');
    } else if (lstatSync(file).isDirectory()) rebaseLinks(file, from, to);
  }
}

export async function mutateInstallation<T>(dir: string, work: (stage: string) => Promise<T>): Promise<T> {
  mkdirSync(dir, { recursive: true });
  const lockFile = join(dir, '.install-lock');
  let lock: number;
  try { lock = openSync(lockFile, 'wx'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('共享扩展目录已有安装 / 卸载操作。若上次进程意外退出，请检查临时副本后移除 .install-lock。');
    throw error;
  }
  try {
    writeFileSync(lock, String(process.pid));
    return await prepareInstallation(dir, work);
  } finally { closeSync(lock); unlinkSync(lockFile); }
}

async function prepareInstallation<T>(dir: string, work: (stage: string) => Promise<T>): Promise<T> {
  // 与正式目录同级，保持 package.json 和锁文件中的相对本机路径有效。
  const stage = mkdtempSync(join(dirname(dir), `.${basename(dir)}-operations-`));
  const backup = join(stage, '.backup');
  const replaced: string[] = [];
  let preserve = false;
  try {
    for (const name of readdirSync(dir)) if (name !== '.install-lock') copyTree(join(dir, name), join(stage, name), dir, stage);
    mkdirSync(backup);
    const pkgFile = join(stage, 'package.json');
    if (!existsSync(pkgFile)) writeFileSync(pkgFile, JSON.stringify({ name: 'cortico-extensions', private: true, dependencies: {} }, null, 2) + '\n');
    const result = await work(stage);
    rebaseLinks(join(stage, 'node_modules'), stage, dir);
    try {
      for (const name of FILES) {
        const current = join(dir, name), next = join(stage, name);
        if (!existsSync(current) && !existsSync(next)) continue;
        if (existsSync(current)) renameSync(current, join(backup, name));
        replaced.push(name);
        if (existsSync(next)) renameSync(next, current);
      }
    } catch (error) {
      try {
        for (const name of replaced.reverse()) {
          rmSync(join(dir, name), { recursive: true, force: true });
          if (existsSync(join(backup, name))) renameSync(join(backup, name), join(dir, name));
        }
      } catch (recoveryError) {
        preserve = true;
        throw new Error(`安装替换失败，恢复未完成。原文件保留在 ${backup}。\n${String(error)}\n${String(recoveryError)}`);
      }
      throw error;
    }
    return result;
  } catch (error) {
    if (preserve) throw error;
    throw new Error(`操作失败，原安装已保留或恢复。\n${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (!preserve) rmSync(stage, { recursive: true, force: true });
  }
}
