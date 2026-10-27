/** Manager-owned lifecycle tasks. Schedules and recoverable deletions never enter a bot's memory. */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { json, validId } from './catalog.ts';
import { writeJson } from './clone.ts';
import type { Supervisor } from './supervisor.ts';
import type { Action, Schedule, Operation, DeletedRole } from './types.ts';
export type { Action } from './types.ts';
interface State {
    schedules: Schedule[];
    records: Operation[];
}
export class Operations {
    private state: State;
    private limit = Infinity;
    private ticking: Promise<void> | null = null;
    private timer?: ReturnType<typeof setInterval>;
    constructor(private root: string, private supervisor: Supervisor) {
        this.state = json<State>(join(root, 'operations.json'), { schedules: [], records: [] });
        for (const record of this.state.records)
            if (record.status === 'working') {
                record.status = 'failed';
                record.message = '管理服务中断，请检查角色当前状态后决定是否重试。';
            }
        mkdirSync(join(root, 'trash'), { recursive: true });
        this.save();
    }
    private save() {
        let finished = 0;
        this.state.records = this.state.records.filter(r => r.status === 'working' || ++finished <= this.limit);
        writeJson(join(this.root, 'operations.json'), this.state);
    }
    setLimit(limit: number) { this.limit = limit; this.save(); }
    clear() { this.state.records = this.state.records.filter(r => r.status === 'working'); this.save(); }
    records() { return this.state.records; }
    schedules() { return this.state.schedules; }
    private begin(role: string, name: string, action: string, schedule?: string) {
        const record: Operation = { id: randomUUID(), role, name, action, at: new Date().toISOString(), status: 'working', schedule };
        this.state.records.unshift(record);
        this.save();
        return record;
    }
    private finish(record: Operation, error?: unknown) { record.status = error ? 'failed' : 'done'; record.message = error instanceof Error ? error.message : error ? String(error) : undefined; this.save(); }
    async action(id: string, action: Action, schedule?: string) {
        const role = this.supervisor.role(id), record = this.begin(id, role.name, action, schedule);
        try {
            await this.supervisor.exclusive(id, async () => {
                const s = this.supervisor;
                if (action === 'start')
                    await s.start(id);
                else if (action === 'run') {
                    await s.start(id);
                    await s.command(id, 'resume');
                }
                else if (action === 'stop')
                    await s.stop(id);
                else if (action === 'restart') {
                    await s.stop(id);
                    await s.start(id);
                }
                else if (action === 'pause' || action === 'resume')
                    await s.command(id, action);
                else
                    throw Error('未知操作');
            });
            this.finish(record);
        }
        catch (e) {
            this.finish(record, e);
            throw e;
        }
        return this.supervisor.role(id);
    }
    async archive(id: string) {
        const role = this.supervisor.role(id), record = this.begin(id, role.name, 'delete');
        try {
            await this.supervisor.exclusive(id, async () => {
                await this.supervisor.stop(id);
                this.supervisor.assertStopped(id);
                const key = randomUUID(), entry: DeletedRole = { key, id, name: role.name, at: new Date().toISOString() }, dir = join(this.root, 'trash', key);
                mkdirSync(dir);
                writeJson(join(dir, 'entry.json'), entry);
                renameSync(join(this.supervisor.home, id), join(dir, 'deployment'));
                for (const schedule of this.state.schedules)
                    if (schedule.role === id)
                        schedule.enabled = false;
                this.supervisor.forget(id);
            });
            this.finish(record);
        }
        catch (e) {
            this.finish(record, e);
            throw e;
        }
    }
    deleted(): DeletedRole[] { return readdirSync(join(this.root, 'trash')).filter(key => existsSync(join(this.root, 'trash', key, 'deployment'))).map(key => json<DeletedRole>(join(this.root, 'trash', key, 'entry.json'))).sort((a, b) => b.at.localeCompare(a.at)); }
    purge(keys: string[]) {
        if (!Array.isArray(keys) || !keys.length || keys.some(k => typeof k !== 'string'))
            throw Error('请选择已删除角色');
        const entries = this.deleted();
        const selected = [...new Set(keys)].map(key => {
            const entry = entries.find(e => e.key === key);
            if (!entry) throw Error('找不到已删除角色，请刷新列表');
            return entry;
        });
        for (const entry of selected) {
            const record = this.begin(entry.id, entry.name, 'purge');
            try {
                rmSync(join(this.root, 'trash', entry.key), { recursive: true });
                if (!existsSync(join(this.supervisor.home, entry.id)))
                    this.state.schedules = this.state.schedules.filter(s => s.role !== entry.id);
                this.finish(record);
            } catch (error) { this.finish(record, error); throw error; }
        }
    }
    async restore(key: string) {
        const entry = this.deleted().find(x => x.key === key);
        if (!entry)
            throw Error('找不到已删除角色');
        const record = this.begin(entry.id, entry.name, 'restore');
        try {
            await this.supervisor.exclusive(entry.id, async () => {
                if (existsSync(join(this.supervisor.home, entry.id)))
                    throw Error('同名目录已存在，请先处理同名角色');
                const source = join(this.root, 'trash', key, 'deployment'), config = json(join(source, 'config.json'));
                await this.supervisor.withAvailablePort(port => {
                    config.web = {...config.web, port};
                    writeJson(join(source, 'config.json'), config);
                    renameSync(source, join(this.supervisor.home, entry.id));
                });
                rmSync(join(this.root, 'trash', key), { recursive: true });
            });
            this.finish(record);
        }
        catch (e) {
            this.finish(record, e);
            throw e;
        }
        return this.supervisor.role(entry.id);
    }
    setSchedule(input: Partial<Schedule>, now = new Date()) {
        if (!input.role || !validId(input.role))
            throw Error('请选择角色');
        this.supervisor.role(input.role);
        if (!['run', 'pause', 'stop'].includes(input.action!))
            throw Error('请选择运行、暂停或关机');
        if (!['once', 'daily'].includes(input.repeat!))
            throw Error('请选择执行频率');
        const next = new Date(input.next!);
        if (!Number.isFinite(next.getTime()) || next <= now)
            throw Error('执行时间必须晚于当前时间');
        if (input.id && !this.state.schedules.some(s => s.id === input.id))
            throw Error('找不到定时任务');
        const schedule: Schedule = { id: input.id || randomUUID(), role: input.role, action: input.action!, next: next.toISOString(), repeat: input.repeat!, enabled: true };
        this.state.schedules = this.state.schedules.filter(s => s.id !== schedule.id);
        this.state.schedules.push(schedule);
        this.save();
        return schedule;
    }
    changeSchedule(id: string, action: 'enable' | 'disable' | 'remove', now = new Date()) {
        const s = this.state.schedules.find(s => s.id === id);
        if (!s)
            throw Error('找不到定时任务');
        if (action === 'remove')
            this.state.schedules = this.state.schedules.filter(s => s.id !== id);
        else if (action === 'disable')
            s.enabled = false;
        else if (action === 'enable') {
            this.supervisor.role(s.role);
            if (new Date(s.next) <= now)
                throw Error('执行时间已过，请编辑为新的时间');
            s.enabled = true;
        }
        else
            throw Error('未知操作');
        this.save();
    }
    tick(now = new Date()): Promise<void> {
        if (this.ticking)
            return this.ticking;
        this.ticking = this.due(now).finally(() => { this.ticking = null; });
        return this.ticking;
    }
    private async due(now: Date) {
        for (const s of this.state.schedules.filter(s => s.enabled && new Date(s.next) <= now)) {
            // Consume before execution: restart will not execute the same occurrence twice.
            if (s.repeat === 'once')
                s.enabled = false;
            else {
                const next = new Date(s.next);
                do {
                    next.setDate(next.getDate() + 1);
                } while (next <= now);
                s.next = next.toISOString();
            }
            this.save();
            try {
                await this.action(s.role, s.action, s.id);
                s.lastResult = '已完成';
            }
            catch (e) {
                s.lastResult = (e as Error).message;
            }
            this.save();
        }
    }
    start() { this.timer = setInterval(() => void this.tick(), 1000); this.timer.unref(); }
    async close() { clearInterval(this.timer); await this.ticking; }
}
