/**
 * 把部署 config.json 里的 `worlds.minecraft.local.serverEnabled` 改名为 `startWithWorld`,值不变。
 *
 *   tsx scripts/migrate-minecraft-start-with-world.ts            # 只列出要做什么
 *   tsx scripts/migrate-minecraft-start-with-world.ts --apply    # 执行:每份 config.json 先备份,再原子替换
 *
 * 旧键为 true 时 World 启动即起受管服务器,新键 true 的行为相同。两个键都在时保留新键、删掉旧键。
 * 只处理部署根下含 deployment.json 的目录。
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deploymentRoot } from '../src/paths.ts';

const apply = process.argv.includes('--apply');
const root = deploymentRoot();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

if (!existsSync(root)) {
  console.log(`部署根不存在: ${root}`);
  process.exit(0);
}
let planned = 0;
for (const name of readdirSync(root)) {
  const dir = join(root, name);
  const file = join(dir, 'config.json');
  if (!statSync(dir).isDirectory() || !existsSync(join(dir, 'deployment.json')) || !existsSync(file)) continue;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const worlds = raw.worlds as Record<string, unknown> | undefined;
  const minecraft = worlds?.minecraft as Record<string, unknown> | undefined;
  const local = minecraft?.local as Record<string, unknown> | undefined;
  if (!local || !('serverEnabled' in local)) continue;
  const kept = 'startWithWorld' in local;
  if (!kept) local.startWithWorld = local.serverEnabled;
  delete local.serverEnabled;
  planned++;
  const what = kept
    ? `删除 serverEnabled,保留已有的 startWithWorld=${String(local.startWithWorld)}`
    : `serverEnabled → startWithWorld=${String(local.startWithWorld)}`;
  console.log(`${apply ? '做' : '将'}: ${name}: ${what}(备份到 config.json.bak-${stamp})`);
  if (!apply) continue;
  copyFileSync(file, `${file}.bak-${stamp}`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  renameSync(tmp, file);
}
if (planned === 0) console.log(`没有待迁移项(部署根 ${root})`);
else if (!apply) console.log('\n以上是计划;加 --apply 执行。');
