/** Shared package writes are staged beside the environment and committed under a process lock.
 * A journal keeps readers on the previous environment until commit and rolls interrupted swaps back.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, realpathSync, cpSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface PackageOperation {
  id: string;
  action: 'install' | 'delete';
  target: string;
  phase: 'preparing' | 'validating' | 'committing' | 'committed' | 'rolled-back' | 'repair-required';
  name?: string;
  version?: string;
  kind?: 'world' | 'provider' | 'bot';
  moduleId?: string;
  error?: string;
  output?: string;
}
interface Journal { workspace: string; operationId: string; hadEnvironment: boolean; phase: 'preparing' | 'swapping' | 'committed' }
const read = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
function locations(dir: string) {
  dir = existsSync(dir) ? realpathSync(dir) : resolve(dir);
  const parent = dirname(resolve(dir));
  const key = createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 16);
  const control = join(parent, `.cortico-extensions-${key}`);
  return { control, lock: join(control, 'lock'), journal: join(control, 'journal.json'), operations: join(control, 'operations') };
}
function write(file: string, value: unknown) {
  const temp = file + '.tmp';
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  renameSync(temp, file);
}
/** Readers retain the last committed package set while another process swaps directories. */
export function installedEnvironment(dir: string): string {
  const { journal } = locations(dir);
  if (!existsSync(journal)) return dir;
  const state = read<Journal>(journal);
  const backup = join(state.workspace, 'before');
  return state.phase === 'swapping' && existsSync(backup) ? backup : dir;
}
export class ExtensionPackageStore {
  readonly dir: string;
  private readonly paths: ReturnType<typeof locations>;
  constructor(dir: string, private readonly checkpoint?: (phase: string) => void) {
    mkdirSync(dirname(resolve(dir)), { recursive: true });
    this.dir = existsSync(dir) ? realpathSync(dir) : join(realpathSync(dirname(resolve(dir))), resolve(dir).split(/[\\/]/).at(-1)!);
    this.paths = locations(this.dir);
  }
  operation(id: string): PackageOperation | null {
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw new Error('Invalid operation ID.');
    if (existsSync(this.paths.journal) && !this.busy) this.recoverInterrupted();
    const file = join(this.paths.operations, id + '.json');
    return existsSync(file) ? read<PackageOperation>(file) : null;
  }
  get busy(): boolean {
    if (!existsSync(this.paths.lock)) return false;
    try { process.kill(read<{ pid: number }>(this.paths.lock).pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  }
  get virtualStoreDir(): string { return join(this.paths.control, 'store'); }
  private acquire(): () => void {
    mkdirSync(this.paths.operations, { recursive: true });
    if (existsSync(this.paths.lock)) {
      const owner = read<{ pid: number }>(this.paths.lock);
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
      if (alive) throw new Error('共享扩展环境正在处理另一项操作。请稍后重试。');
      rmSync(this.paths.lock);
    }
    writeFileSync(this.paths.lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
    return () => rmSync(this.paths.lock, { force: true });
  }
  private recover(): void {
    if (!existsSync(this.paths.journal)) return;
    const state = read<Journal>(this.paths.journal);
    if (dirname(state.workspace) !== this.paths.control) throw new Error('Invalid extension recovery path.');
    const backup = join(state.workspace, 'before');
    const next = join(state.workspace, 'next');
    if (state.phase === 'swapping') {
      if (existsSync(backup)) {
        if (existsSync(this.dir)) rmSync(this.dir, { recursive: true });
        renameSync(backup, this.dir);
      } else if (!state.hadEnvironment && !existsSync(next) && existsSync(this.dir)) rmSync(this.dir, { recursive: true });
    }
    const operationFile = join(this.paths.operations, state.operationId + '.json');
    if (existsSync(operationFile)) {
      const operation = read<PackageOperation>(operationFile);
      if (!['committed', 'rolled-back', 'repair-required'].includes(operation.phase)) {
        operation.phase = state.phase === 'committed' ? 'committed' : 'rolled-back';
        if (operation.phase === 'rolled-back') operation.error ??= '操作中断，已恢复安装前状态。';
        write(operationFile, operation);
      }
    }
    rmSync(state.workspace, { recursive: true, force: true });
    rmSync(this.paths.journal, { force: true });
  }
  /** Recovery runs before code imports; a live writer must finish first. */
  recoverInterrupted(): void {
    if (!existsSync(this.paths.journal)) return;
    const release = this.acquire();
    try { this.recover(); } finally { release(); }
  }
  async transact(operation: PackageOperation, prepare: (stage: string, progress: (phase: PackageOperation['phase']) => void) => Promise<Partial<PackageOperation>>): Promise<PackageOperation> {
    const existing = this.operation(operation.id);
    if (existing) {
      if (existing.action !== operation.action || existing.target !== operation.target) throw new Error('Operation ID already belongs to another request.');
      return existing;
    }
    const release = this.acquire();
    const file = join(this.paths.operations, operation.id + '.json');
    const progress = (phase: PackageOperation['phase']) => { operation.phase = phase; write(file, operation); };
    try {
      this.recover();
      const workspace = join(this.paths.control, randomUUID());
      const stage = join(workspace, 'next');
      mkdirSync(stage, { recursive: true });
      const state: Journal = { workspace, operationId: operation.id, hadEnvironment: existsSync(this.dir), phase: 'preparing' };
      write(this.paths.journal, state);
      progress('preparing');
      for (const name of existsSync(this.dir) ? readdirSync(this.dir) : []) {
        if (name !== 'node_modules') cpSync(join(this.dir, name), join(stage, name), { recursive: true, dereference: false, verbatimSymlinks: true });
      }
      if (!existsSync(join(stage, 'package.json'))) write(join(stage, 'package.json'), { name: 'cortico-extensions', private: true, dependencies: {} });
      // Relative local links must retain their original source when the environment moves.
      const pkg = read<{ dependencies?: Record<string, string> }>(join(stage, 'package.json'));
      for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
        if (/^(link|file):/.test(spec)) { const at = spec.indexOf(':'); pkg.dependencies![name] = spec.slice(0, at + 1) + resolve(this.dir, spec.slice(at + 1)); }
      }
      write(join(stage, 'package.json'), pkg);
      Object.assign(operation, await prepare(stage, progress));
      progress('committing');
      state.phase = 'swapping'; write(this.paths.journal, state);
      this.checkpoint?.('before-swap');
      if (state.hadEnvironment) renameSync(this.dir, join(workspace, 'before'));
      this.checkpoint?.('after-backup');
      renameSync(stage, this.dir);
      this.checkpoint?.('after-install');
      state.phase = 'committed'; write(this.paths.journal, state);
      progress('committed');
      this.recover();
    } catch (error) {
      operation.error = error instanceof Error ? error.message : String(error);
      try { this.recover(); const recovered = this.operation(operation.id); progress(recovered?.phase === 'committed' ? 'committed' : 'rolled-back'); }
      catch (recovery) { operation.error += '\n恢复失败: ' + String(recovery); progress('repair-required'); }
    } finally { release(); }
    return operation;
  }
}
