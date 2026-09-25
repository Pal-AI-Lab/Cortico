/** Deployment-local extension activation and shared-environment reference checks. */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CoreConfig } from '../core/types.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { WorldAssembly } from '../world.ts';
import type { ExtensionInfo } from '../web/server.ts';
import { ExtensionManager, type ExtensionSet } from '../extensions.ts';

interface Intent { name: string; version: string; moduleId: string }
interface State { providers: Record<string, boolean>; pending: Intent[]; errors: Record<string, string> }
const read = (file: string): Record<string, any> => JSON.parse(readFileSync(file, 'utf8'));
export class ExtensionActivation {
  readonly manager: ExtensionManager;
  private readonly file: string;
  private readonly state: State;
  private readonly leaseFile: string;
  private timer?: ReturnType<typeof setInterval>;
  private changing = new Set<string>();
  constructor(private readonly deployment: string, repo: string, private readonly booted: ExtensionSet,
    private readonly config: CoreConfig, private readonly assembly: WorldAssembly, private readonly registry: ProviderRegistry,
    private readonly providersDir: string, private readonly worldVisible: (id: string) => boolean = () => true) {
    this.file = join(deployment, 'extension-state.json');
    this.state = existsSync(this.file) ? read(this.file) as State : { providers: Object.fromEntries(booted.providers.map(p => [p.id, true])), pending: [], errors: {} };
    this.save();
    const extensionKinds = new Set(booted.providers.map(p => p.id));
    registry.setModulePolicy(kind => !extensionKinds.has(kind) || this.state.providers[kind] === true);
    this.manager = new ExtensionManager(repo, booted, {
      decorate: item => this.decorate(item), references: async name => this.references(name),
      activation: (name, enabled, pending) => this.activate(name, enabled, pending),
    });
    const leaseDir = join(dirname(booted.dir), '.' + basename(booted.dir) + '-instances');
    mkdirSync(leaseDir, { recursive: true });
    this.leaseFile = join(leaseDir, randomUUID() + '.json');
  }
  private save(): void { writeFileSync(this.file + '.tmp', JSON.stringify(this.state, null, 2)); renameSync(this.file + '.tmp', this.file); }
  startLease(): void {
    const beat = () => { writeFileSync(this.leaseFile, JSON.stringify({ deployment: resolve(this.deployment), providersDir: this.providersDir, pid: process.pid, at: Date.now(), packages: this.manager.list().extensions.filter(p => p.enabled || p.inUse).map(p => p.name) })); };
    beat(); this.timer = setInterval(beat, 10_000); this.timer.unref();
  }
  dispose(): void { clearInterval(this.timer); rmSync(this.leaseFile, { force: true }); }
  private decorate(item: ExtensionInfo): ExtensionInfo {
    const id = item.worldId;
    const enabled = item.state !== 'removed' && (item.kind === 'world' ? !!this.assembly.slots.find(s => s.id === id)?.mounted
      : item.kind === 'provider' ? !!id && this.registry.isModuleEnabled(id) && item.loaded : item.kind === 'bot' && this.booted.bot?.name === item.name);
    const inUse = item.kind === 'provider' && !!id && (this.config.providers[this.config.activeProvider]?.kind === id || this.registry.moduleUsage(id) > 0);
    return { ...item, enabled, inUse, ...(item.kind === 'world' && id ? { hidden: !this.worldVisible(id) } : {}), ...(inUse ? { disableReason: '当前模型或任务仍在使用此模块。' } : {}),
      ...(this.state.errors[item.name] ? { activationError: this.state.errors[item.name] } : {}) };
  }
  async activate(name: string, enabled: boolean, afterRestart = false): Promise<void> {
    if (this.changing.has(name) || this.manager.operationBusy) throw new Error('扩展操作正在进行。');
    const item = this.manager.list().extensions.find(p => p.name === name);
    if (!item || item.state === 'removed' || item.kind === 'bot') throw new Error('此扩展不能加载到当前 Bot。');
    if (afterRestart) {
      const checked = await this.manager.validateInstalled(name);
      this.state.pending = this.state.pending.filter(i => i.name !== name);
      this.state.pending.push({ name, version: checked.version, moduleId: checked.moduleId }); this.save(); return;
    }
    if (item.state === 'pending-restart' || !item.loaded || !item.worldId) throw new Error('需要先重启进程注册扩展。');
    if (!enabled && item.inUse) throw new Error(item.disableReason);
    this.changing.add(name);
    try {
      if (item.kind === 'world') {
        if (enabled) await this.assembly.activate(item.worldId); else await this.assembly.deactivate(item.worldId);
      } else {
        const id = item.worldId;
        // Block new bindings before awaiting resource shutdown.
        this.state.providers[id] = false;
        try { if (!enabled) await this.registry.stopModule(id); }
        catch (error) { this.state.providers[id] = true; throw error; }
        this.state.providers[id] = enabled;
      }
      delete this.state.errors[name]; this.save();
    } catch (error) { this.state.errors[name] = String(error); this.save(); throw error; }
    finally { this.changing.delete(name); }
  }
  async runPending(): Promise<void> {
    const intents = this.state.pending.splice(0); this.save();
    for (const intent of intents) {
      try {
        const record = this.booted.records.find(p => p.name === intent.name);
        if (!record?.loaded || record.version !== intent.version || record.worldId !== intent.moduleId) throw new Error('待加载扩展的版本或定义已改变。');
        await this.activate(intent.name, true);
      } catch (error) { this.state.errors[intent.name] = String(error); this.save(); }
    }
  }
  references(name: string): string[] {
    const item = this.manager.list().extensions.find(p => p.name === name);
    if (!item) return [];
    const refs = new Set<string>();
    if (item.enabled || item.inUse) refs.add(this.deployment);
    const roots = new Set([dirname(this.deployment)]);
    const providerRoots = new Set([this.providersDir]);
    for (const file of readdirSync(dirname(this.leaseFile))) {
      const lease = read(join(dirname(this.leaseFile), file));
      roots.add(dirname(lease.deployment)); providerRoots.add(lease.providersDir);
      if (resolve(lease.deployment) !== resolve(this.deployment) && lease.packages?.includes(name)) {
        if (Date.now() - lease.at < 30_000) refs.add(`运行进程: ${lease.deployment}`);
        else { try { process.kill(lease.pid, 0); refs.add(`无法确认过期进程登记已释放: ${lease.deployment}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') refs.add(`无法检查进程: ${lease.deployment}`); } }
      }
    }
    for (const root of roots) for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const dep = join(root, dir.name); const manifest = join(dep, 'deployment.json');
      if (!existsSync(manifest)) continue;
      if (item.kind === 'bot' && read(manifest).bot === name) refs.add(dep);
      const configFile = join(dep, 'config.json');
      const cfg = existsSync(configFile) ? read(configFile) : {};
      if (item.kind === 'world' && item.worldId && cfg.worlds?.[item.worldId]?.enabled !== false) refs.add(dep + ' (World 配置或模板默认值可能引用)');
      if (item.kind === 'provider' && Object.values(cfg.providers ?? {}).some((p: any) => p.kind === item.worldId)) refs.add(configFile);
    }
    if (item.kind === 'provider') for (const root of providerRoots) {
      if (!existsSync(root)) continue;
      for (const dir of readdirSync(root, { withFileTypes: true })) {
        const file = join(root, dir.name, 'config.json');
        if (dir.isDirectory() && existsSync(file) && read(file).kind === item.worldId) refs.add(file);
      }
    }
    for (const other of this.manager.list().extensions) {
      if (other.name === name || other.state === 'removed') continue;
      const file = join(this.booted.dir, 'node_modules', ...other.name.split('/'), 'package.json');
      if (existsSync(file)) { const pkg = read(file); if (pkg.dependencies?.[name] || pkg.peerDependencies?.[name] || pkg.optionalDependencies?.[name]) refs.add(other.name); }
    }
    return [...refs];
  }
}
