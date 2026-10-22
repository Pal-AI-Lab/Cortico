import { randomUUID } from 'node:crypto';
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readTextFile } from './core/util.ts';

export type JsonObject = Record<string, unknown>;

export function readJsonObject(file: string): JsonObject {
  if (!existsSync(file)) return {};
  try {
    const value = JSON.parse(readTextFile(file)) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('root must be an object');
    }
    return value as JsonObject;
  } catch {
    throw new Error('config.json解析失败,拒绝写回(请手工检查文件)');
  }
}

/**
 * Writes a file that holds secrets: only its owner may read it (mode 0600 where the system has modes), and it
 * is replaced by one rename, so a crash leaves the old file or the new one.
 */
export function writeSecretFile(file: string, contents: string | Buffer): void {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function updateJsonObject(file: string, update: (root: JsonObject) => void): void {
  const root = readJsonObject(file);
  update(root);

  const suffix = `${process.pid}-${randomUUID()}`;
  const tmp = `${file}.tmp-${suffix}`;
  const backup = `${file}.bak-${suffix}`;
  writeFileSync(tmp, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
  if (!existsSync(file)) {
    renameSync(tmp, file);
    return;
  }

  renameSync(file, backup);
  try {
    renameSync(tmp, file);
  } catch (error) {
    renameSync(backup, file);
    throw error;
  }
  rmSync(backup);
}
