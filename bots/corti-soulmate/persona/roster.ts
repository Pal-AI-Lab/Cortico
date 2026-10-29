/** 从 people/*.md 的文件名和首行生成名册。首行约定为主要称呼与一句概括。 */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readTextFile } from 'cortico/core/util.ts';

/** 没有档案时返回空串，缺省文案由 MEMORY.md 提供。 */
export function buildRoster(memoryDir: string): string {
  const dir = join(memoryDir, 'people');
  if (!existsSync(dir)) return '';
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md')
      && !e.name.startsWith('.') && !e.name.includes('.tmp-'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  if (files.length === 0) return '';

  return files
    .map((f) => {
      let first = '';
      try {
        const text = readTextFile(join(dir, f));
        first = (text.split(/\r?\n/, 1)[0] ?? '').trim();
      } catch {
        first = '(档案读取失败)';
      }
      return `- ${f.replace(/\.md$/i, '')} — ${first || '(档案第一行为空)'}`;
    })
    .join('\n');
}
