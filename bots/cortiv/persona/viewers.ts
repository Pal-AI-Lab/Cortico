import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 人物档案目录;首见唤起按 viewers/<来源>/<键>.md 机械查档。 */
export const VIEWERS_DIR = 'viewers';

/**
 * 前缀 MEMORY 段的模板(机制说明,不是花名册)。散文归可编辑文件——WebUI
 * 「系统提示词」里点得进去改,与 ORIENTATION/宪法同一条路。
 */
export const VIEWER_MEMORY_NOTE_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  'MEMORY_NOTE.md',
);

/** 此刻的说明文本;前缀与 WebUI 记忆面板共读这一份。 */
export function viewerMemoryNote(): string {
  return readFileSync(VIEWER_MEMORY_NOTE_FILE, 'utf8').trim();
}
