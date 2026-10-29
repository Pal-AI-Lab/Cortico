/**
 * 迁移部署中的 World、Memory、Core 名称及端点类型。
 *
 *   tsx scripts/migrate-rename.ts            # 只列出要做什么
 *   tsx scripts/migrate-rename.ts --apply    # 执行:每份 config.json 先备份,再原子替换
 *
 * 逐个部署(部署根下含 deployment.json 的目录)执行以下迁移:
 *   1. config.json:顶层 `io` → `worlds`;`paths.persona` → `paths.memory`
 *   2. `io/` → `worlds/`(部署侧的环境提示词覆盖)
 *   3. `persona/` → `memory/`(仅当 Memory 目录按默认名解析且 `memory/` 不存在)
 *   4. `data/harness-state.json` → `data/core-state.json`
 *   5. `prompts/HARNESS.md` → `prompts/CORE.md`
 *   6. Memory 中的 World 记录目录 `io/` → `external/`
 * 端点表(`<部署根>/providers/<端点名>/config.json`)只改一处:`kind` `openai-compat` →
 * `openai-responses-compat`。事件库、session 与游标一律不碰。
 */
import { existsSync, readdirSync, renameSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { deploymentRoot } from '../src/paths.ts';
import { readTextFile } from '../src/core/util.ts';

const apply = process.argv.includes('--apply');
const root = deploymentRoot();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

interface Step { what: string; run(): void }
const steps: Step[] = [];

function moveIf(from: string, to: string, what: string): void {
  if (!existsSync(from) || existsSync(to)) return;
  steps.push({ what: `${what}: ${from} → ${to}`, run: () => renameSync(from, to) });
}

function migrateConfig(dir: string): { memoryDefault: boolean; memoryDir: string } {
  const file = join(dir, 'config.json');
  if (!existsSync(file)) return { memoryDefault: true, memoryDir: join(dir, 'memory') };
  const raw = JSON.parse(readTextFile(file)) as Record<string, unknown>;
  let changed = false;
  if ('io' in raw && !('worlds' in raw)) {
    raw.worlds = raw.io;
    delete raw.io;
    changed = true;
  }
  const paths = raw.paths as Record<string, unknown> | undefined;
  if (paths && 'persona' in paths && !('memory' in paths)) {
    paths.memory = paths.persona;
    delete paths.persona;
    changed = true;
  }
  const memoryDefault = !paths || paths.memory === undefined || paths.memory === 'memory';
  if (changed) {
    steps.push({
      what: `config.json 键改名(备份到 config.json.bak-${stamp}): ${file}`,
      run: () => {
        copyFileSync(file, `${file}.bak-${stamp}`);
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
        renameSync(tmp, file);
      },
    });
  }
  const memoryDir = typeof paths?.memory === 'string' ? join(dir, paths.memory) : join(dir, 'memory');
  return { memoryDefault, memoryDir };
}

if (!existsSync(root)) {
  console.log(`部署根不存在: ${root}`);
  process.exit(0);
}
for (const name of readdirSync(root)) {
  const dir = join(root, name);
  if (!statSync(dir).isDirectory() || !existsSync(join(dir, 'deployment.json'))) continue;
  const { memoryDefault, memoryDir } = migrateConfig(dir);
  moveIf(join(dir, 'io'), join(dir, 'worlds'), `${name}: 环境提示词覆盖目录`);
  if (memoryDefault) moveIf(join(dir, 'persona'), join(dir, 'memory'), `${name}: Memory 目录`);
  moveIf(join(memoryDir, 'io'), join(memoryDir, 'external'), `${name}: Memory 中的 World 记录目录`);
  moveIf(join(dir, 'data', 'harness-state.json'), join(dir, 'data', 'core-state.json'), `${name}: Core 状态文件`);
  moveIf(join(dir, 'prompts', 'HARNESS.md'), join(dir, 'prompts', 'CORE.md'), `${name}: 提示词覆盖`);
}

const providersDir = join(root, 'providers');
const PROVIDER_KIND_RENAMES: Record<string, string> = { 'openai-compat': 'openai-responses-compat' };
if (existsSync(providersDir)) {
  for (const name of readdirSync(providersDir)) {
    const file = join(providersDir, name, 'config.json');
    if (!existsSync(file)) continue;
    const raw = JSON.parse(readTextFile(file)) as Record<string, unknown>;
    const next = typeof raw.kind === 'string' ? PROVIDER_KIND_RENAMES[raw.kind] : undefined;
    if (!next) continue;
    steps.push({
      what: `端点 ${name}: kind ${String(raw.kind)} → ${next}(备份到 config.json.bak-${stamp})`,
      run: () => {
        copyFileSync(file, `${file}.bak-${stamp}`);
        raw.kind = next;
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
        renameSync(tmp, file);
      },
    });
  }
}

if (steps.length === 0) {
  console.log(`没有待迁移项(部署根 ${root})`);
} else {
  for (const s of steps) {
    console.log(`${apply ? '做' : '将'}: ${s.what}`);
    if (apply) s.run();
  }
  if (!apply) console.log('\n以上是计划;加 --apply 执行。');
}
