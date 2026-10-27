import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSnapshot, normalizeCopy, validateCreate, writeJson } from './clone.ts';
import { json } from './catalog.ts';
import { copiesRuntime, type CreateInput, type Job } from './types.ts';
import { Supervisor } from './supervisor.ts';
export class Jobs {
    private active = false;
    private limit = Infinity;
    private work: Promise<void> | null = null;
    constructor(private dir: string, private supervisor: Supervisor) {
        mkdirSync(dir, { recursive: true });
        for (const j of this.list())
            if (j.status === 'working') {
                j.status = 'failed';
                j.error = '管理服务中断，请检查源角色状态后重新创建。';
                this.save(j);
            }
    }
    list(): Job[] { return readdirSync(this.dir).filter(f => f.endsWith('.json')).map(f => json<Job>(join(this.dir, f))).sort((a, b) => (b.steps[0]?.at ?? '').localeCompare(a.steps[0]?.at ?? '')); }
    setLimit(limit: number) { this.limit = limit; this.prune(); }
    clear() { for (const j of this.list()) if (j.status !== 'working') rmSync(join(this.dir, `${j.id}.json`)); }
    private prune() {
        for (const j of this.list().filter(j => j.status !== 'working').slice(this.limit))
            rmSync(join(this.dir, `${j.id}.json`));
    }
    private save(j: Job): void { writeJson(join(this.dir, `${j.id}.json`), j); this.prune(); }
    private step(j: Job, label: string): void { j.steps.push({ label, at: new Date().toISOString() }); this.save(j); }
    create(input: CreateInput): Job {
        if (this.active)
            throw new Error('已有创建任务进行中');
        input = { ...input, copy: normalizeCopy(input.copy) };
        validateCreate(this.supervisor.home, input);
        if (input.source && copiesRuntime(input.copy) && ['running', 'paused'].includes(this.supervisor.role(input.source).state) && !input.allowStop)
            throw new Error('来源角色正在运行，请确认允许短暂关机。');
        const job: Job = { id: randomUUID(), input, status: 'working', steps: [] };
        this.save(job);
        this.active = true;
        this.work = this.perform(job).finally(() => { this.active = false; });
        return job;
    }
    async wait(): Promise<void> { await this.work; }
    private async perform(job: Job): Promise<void> {
        const s = this.supervisor, input = job.input;
        const operation = async () => {
            const before = input.source ? s.role(input.source).state : 'stopped';
            let stopped = false;
            try {
                this.step(job, '检查复制范围与目标目录');
                if (input.source && copiesRuntime(input.copy) && ['running', 'paused'].includes(before)) {
                    this.step(job, '正在保存并关闭来源角色');
                    await s.stop(input.source);
                    stopped = true;
                    this.step(job, '来源角色已正常关闭');
                }
                this.step(job, input.source ? '复制所选数据，生成独立实例身份' : '创建空白角色与配置');
                if (input.source && (copiesRuntime(input.copy) || before === 'stopped')) s.assertStopped(input.source);
                await s.withAvailablePort(port => createSnapshot(s.home, input, port));
                job.result = input.id;
                this.step(job, '新角色已创建，保持停止');
            }
            catch (error) {
                job.error = (error as Error).message;
            }
            finally {
                if (stopped && input.source) {
                    this.step(job, '恢复来源角色');
                    try {
                        await s.start(input.source);
                        if (before === 'running')
                            await s.command(input.source, 'resume');
                        this.step(job, before === 'running' ? '来源角色已恢复运行' : '来源角色已恢复暂停状态');
                    }
                    catch (error) {
                        job.error = [job.error, `恢复来源角色失败：${(error as Error).message}`].filter(Boolean).join('；');
                    }
                }
                job.status = job.error ? 'failed' : 'done';
                this.save(job);
            }
        };
        try {
            if (input.source)
                await s.exclusive(input.source, operation);
            else
                await operation();
        }
        catch (error) {
            job.error = (error as Error).message;
            job.status = 'failed';
            this.save(job);
        }
    }
}
