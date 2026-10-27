import { instanceIsRunning } from '../core/instance-lock.ts';
import { existsSync } from 'node:fs';
import { fork, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJson } from './clone.ts';
import { repoRoot } from '../paths.ts';
import { listRoles, json, profile } from './catalog.ts';
import type { Role, RunState } from './types.ts';
interface ProcessEntry {
    child: ChildProcess;
    state: RunState;
    error?: string;
}
export class Supervisor {
    private processes = new Map<string, ProcessEntry>();
    private busy = new Set<string>();
    constructor(readonly home: string, readonly managerPort: number, private host = '127.0.0.1') { }
    roles(): Role[] {
        return listRoles(this.home).map(role => {
            const p = this.processes.get(role.id);
            return { ...role, state: p?.state ?? 'stopped', error: p?.error };
        });
    }
    role(id: string): Role { const role = this.roles().find(r => r.id === id); if (!role)
        throw new Error('找不到角色'); return role; }
    async exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
        if (this.busy.has(id))
            throw new Error('这个角色正在执行操作，请稍后再试');
        this.busy.add(id);
        try {
            return await fn();
        }
        finally {
            this.busy.delete(id);
        }
    }
    private dataDir(id: string) {
        const role = this.role(id);
        const path = json<any>(join(this.home, id, 'config.json'), {}).paths?.data ?? profile(role.bot).dataDir;
        return resolve(this.home, id, path);
    }
    assertStopped(id: string) {
        if (instanceIsRunning(this.dataDir(id))) throw new Error('角色仍在运行，请先正常关机');
    }
    forget(id: string): void { this.processes.delete(id); }
    /** The callback publishes the port synchronously before another allocation can use it. */
    async withAvailablePort<T>(write: (port: number) => T): Promise<T> {
        const used = new Set(this.roles().map(r => r.port));
        used.add(this.managerPort);
        for (let p = this.managerPort + 1; p < this.managerPort + 150; p++)
            if (!used.has(p) && await freePort(p, this.host) && !this.roles().some(role => role.port === p))
                return write(p);
        throw new Error('没有可用端口');
    }
    async start(id: string): Promise<void> {
        const role = this.role(id), old = this.processes.get(id);
        if (old && ['running', 'paused'].includes(old.state))
            return;
        if (old && ['starting', 'stopping'].includes(old.state))
            throw new Error('进程正在切换状态');
        if (old?.child.pid && old.child.exitCode === null && old.child.signalCode === null)
            throw new Error('旧进程尚未退出，请先关机');
        if (!role.port) {
            await this.withAvailablePort(port => {
                role.port = port;
                const file = join(this.home, id, 'config.json'), config = json<any>(file, {});
                config.web = {...config.web, port};
                writeJson(file, config);
            });
        }
        const child = fork(new URL('../launcher.ts', import.meta.url), [id, `--host=${this.host}`, `--port=${role.port}`], {
            execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], cwd: repoRoot(),
            env: {...process.env, CORTICO_HOME: this.home, CORTICO_SUPERVISED: '1', CORTICO_START_PAUSED: '1',
                CORTICO_OPEN_BROWSER: '0', CORTICO_MANAGER_HOST: this.host === '0.0.0.0' ? '127.0.0.1' : this.host === '::' ? '::1' : this.host, CORTICO_MANAGER_PORT: String(this.managerPort)}
        });
        const entry: ProcessEntry = { child, state: 'starting' };
        this.processes.set(id, entry);
        child.on('message', (m: any) => { if (m?.type === 'state' && !['starting','stopping','stopped','error'].includes(entry.state)) entry.state = m.state; });
        let stderr = '';
        child.stderr?.on('data', b => { stderr = (stderr + String(b)).slice(-1500); });
        child.stdout?.resume();
        child.on('exit', (code) => {
            const restart = code === 0 && entry.state !== 'stopping' && existsSync(join(this.dataDir(id), '.restart-request'));
            entry.state = code === 0 ? 'stopped' : 'error';
            if (restart) void this.exclusive(id, () => this.start(id)).catch(error => { entry.state = 'error'; entry.error = String(error); });
            if (code !== 0)
                entry.error = stderr.trim() || `角色进程退出 (${code})`;
        });
        await new Promise<void>((resolve, reject) => {
            const finish = (err?: Error) => { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError); err ? reject(err) : resolve(); };
            const onMessage = (m: any) => { if (m?.type === 'ready') {
                entry.state = 'paused';
                finish();
            } };
            const onExit = () => finish(new Error(stderr.trim() || '启动失败'));
            const onError = (e: Error) => { entry.state = 'error'; entry.error = e.message; finish(e); };
            const timer = setTimeout(() => { child.kill('SIGTERM'); entry.error = '角色后台启动超时'; finish(new Error(entry.error)); }, 30000);
            child.on('message', onMessage);
            child.once('exit', onExit);
            child.once('error', onError);
        });
    }
    async command(id: string, action: 'pause' | 'resume'): Promise<void> {
        const p = this.processes.get(id);
        if (!p || !['running', 'paused'].includes(p.state)) throw new Error('角色尚未启动');
        const requestId = randomUUID();
        await new Promise<void>((resolve, reject) => {
            const onMessage = (message: any) => {
                if (message?.requestId === requestId) { p.state = message.state; finish(); }
            };
            const onExit = () => finish(new Error('角色进程已退出'));
            const finish = (error?: Error) => { clearTimeout(timer); p.child.off('message', onMessage); p.child.off('exit', onExit); error ? reject(error) : resolve(); };
            const timer = setTimeout(() => finish(new Error('操作超时')), 5000);
            p.child.on('message', onMessage); p.child.once('exit', onExit);
            p.child.send({type: 'manager-command', action, requestId}, error => {if (error) finish(error);});
        });
    }
    async stop(id: string): Promise<void> {
        const p = this.processes.get(id);
        if (!p || !p.child.pid || p.child.exitCode !== null || p.child.signalCode !== null) return;
        p.state = 'stopping';
        await new Promise<void>((resolve, reject) => {
            const onExit = (code: number | null) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('源角色未正常关机，取消复制')); };
            const timer = setTimeout(() => { p.child.off('exit', onExit); p.state = 'error'; p.error = '关机超时，复制已停止'; reject(new Error(p.error)); }, 40000);
            p.child.once('exit', onExit);
            p.child.kill('SIGTERM');
        });
    }
    async close(): Promise<void> { await Promise.allSettled(this.roles().filter(r => ['paused', 'running'].includes(r.state)).map(r => this.stop(r.id))); }
}
export async function freePort(port: number, host = '127.0.0.1'): Promise<boolean> {
    return new Promise((resolve, reject) => { const s = createServer(); s.once('error', (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE' ? resolve(false) : reject(error)); s.listen(port, host, () => s.close(() => resolve(true))); });
}
