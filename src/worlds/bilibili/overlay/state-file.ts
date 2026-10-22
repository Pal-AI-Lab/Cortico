import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/** 原子替换 JSON 状态文件：先写临时文件再改名；替换失败时把旧文件改回原名并抛出。 */
export function writeStateFile(file: string, value: unknown): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const suffix = `${process.pid}-${randomUUID()}`;
  const temporary = `${file}.tmp-${suffix}`;
  const backup = `${file}.bak-${suffix}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (!existsSync(file)) {
    renameSync(temporary, file);
    return;
  }
  renameSync(file, backup);
  try {
    renameSync(temporary, file);
  } catch (error) {
    renameSync(backup, file);
    throw error;
  }
  rmSync(backup);
}
