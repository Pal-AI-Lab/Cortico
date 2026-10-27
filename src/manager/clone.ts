import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import type { CoreStateData } from '../core/state.ts';
import { createDeployment } from '../deploy.ts';
import { packageAvatar } from '../deployment-code.ts';
import { json, profile, validId } from './catalog.ts';
import { EMPTY_COPY, type CopyOptions, type CreateInput, type Profile } from './types.ts';
export function writeJson(path: string, value: unknown): void {
    mkdirSync(resolve(path, '..'), { recursive: true });
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    renameSync(tmp, path);
}
export function normalizeCopy(raw: Partial<CopyOptions>): CopyOptions {
    const value = { ...EMPTY_COPY, ...raw };
    for (const key of ['memory', 'session', 'history', 'timers', 'pending', 'worldState'] as const)
        value[key] = raw[key] === true;
    value.connections = Array.isArray(raw.connections) ? [...new Set(raw.connections.filter((v): v is string => typeof v === 'string'))] : [];
    // Pending delivery resumes against the source conversation and persona state.
    if (value.pending) {
        value.history = true;
        value.session = true;
        value.memory = true;
        value.worldState = true;
    }
    if (value.timers)
        value.memory = true;
    return value;
}
function copy(from: string, to: string): void {
    if (!existsSync(from))
        return;
    cpSync(from, to, { recursive: true, filter: (p) => {
            if (lstatSync(p).isSymbolicLink())
                throw new Error(`复制范围中有符号链接，请单独处理：${p}`);
            return true;
        } });
}
function checkPaths(dir: string, p: Profile): void {
    const config = json<any>(join(dir, 'config.json'), {});
    for (const [key, expected] of [['memory', p.memoryDir], ['data', p.dataDir]]) {
        const v = config.paths?.[key];
        if (v && (isAbsolute(v) || v !== expected))
            throw new Error(`自定义 paths.${key} 尚未适配，请先核对数据目录。`);
    }
}
export function inspectClone(home: string, id: string): {
    bot: string;
    connections: {
        id: string;
        label: string;
    }[];
    extraData: string[];
} {
    if (!validId(id))
        throw new Error('角色标识无效');
    const dir = join(home, id), p = profile(json(join(dir, 'deployment.json')).bot);
    if (!p.copyDeclared) throw new Error('这个 Bot 尚未声明复制规则，请由模板提供 copy.settingsInMemory。');
    checkPaths(dir, p);
    const config = json<any>(join(dir, 'config.json'), {});
    const known = new Set(['core-state.json', 'timers.json', 'session-main.jsonl', 'runs', 'usage.jsonl', 'media', 'instance.lock', 'web-auth.key', '.restart-request', 'service.stdout.log', 'service.stderr.log', ...p.worldState.map(path => path.replaceAll('\\', '/').split('/')[0])]);
    const extraData = existsSync(join(dir, p.dataDir)) ? readdirSync(join(dir, p.dataDir)).filter(f => !known.has(f) && !f.endsWith('.tmp')) : [];
    if (extraData.length)
        throw new Error(`这些本地状态还没有复制分类：${extraData.join('、')}。请补充模板规则后再复制。`);
    return { bot: p.id, connections: Object.entries(p.connections).filter(([id]) => config.worlds?.[id]).map(([id, c]) => ({ id, label: c.label })), extraData };
}
export function validateCreate(home: string, input: CreateInput): void {
    if (!validId(input.id))
        throw new Error('目录名使用小写字母开头，包含字母、数字或短横线，最长 48 字符。');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80)
        throw new Error('请填写 1–80 字的角色名称。');
    if (existsSync(join(home, input.id)))
        throw new Error('这个目录名已经存在。');
    profile(input.bot);
    if (input.source) {
        const info = inspectClone(home, input.source);
        if (info.bot !== input.bot)
            throw new Error('复制时需要使用来源角色的 Bot 模板。');
        for (const id of input.copy.connections)
            if (!info.connections.some(c => c.id === id))
                throw new Error('连接选项无效');
    }
}
function eventsSnapshot(src: string, dst: string, fullHistory: boolean): number {
    let high = 0;
    const runs = join(src, 'runs');
    if (!existsSync(runs))
        return high;
    if (fullHistory)
        copy(runs, join(dst, 'runs'));
    for (const run of readdirSync(runs, { withFileTypes: true }).filter(e => e.isDirectory())) {
        const f = join(runs, run.name, 'events.jsonl');
        if (!existsSync(f))
            continue;
        for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
            const event = JSON.parse(line);
            if (!Number.isInteger(event.cursor))
                throw new Error('事件记录缺少有效 cursor');
            high = Math.max(high, event.cursor);
        }
        if (!fullHistory) {
            copy(f, join(dst, 'runs', run.name, 'events.jsonl'));
            copy(join(runs, run.name, 'run.json'), join(dst, 'runs', run.name, 'run.json'));
        }
    }
    return high;
}
/** Stop the source when copying runtime data. Writes use an unpublished staging directory. */
export function createSnapshot(home: string, input: CreateInput, port: number): string {
    input = { ...input, copy: normalizeCopy(input.copy) };
    validateCreate(home, input);
    const p = profile(input.bot), target = join(home, input.id), stage = join(home, `.creating-${input.id}`);
    if (existsSync(stage))
        throw new Error('同名创建任务尚未结束');
    if (!input.source) {
        createDeployment({name: input.id, bot: input.bot, displayName: input.name.trim(), root: home, avatarFrom: packageAvatar(input.bot) ?? undefined});
        writeJson(join(target, 'config.json'), {displayName: input.name.trim(), web: {port}});
        return target;
    }
    mkdirSync(stage);
    try {
        const src = join(home, input.source);
        const config: any = json(join(src, 'config.json'), {});
        config.displayName = input.name.trim();
        config.web = { ...config.web, host: '127.0.0.1', port };
        delete config.web.password; // Managed deployments share the manager's access policy.
        config.paths = { ...config.paths, memory: p.memoryDir, data: p.dataDir };
        mkdirSync(join(stage, p.memoryDir), { recursive: true });
        mkdirSync(join(stage, p.dataDir), { recursive: true });
        for (const name of ['prompts', 'avatar.png', 'theme.json'])
            copy(join(src, name), join(stage, name));
        const worldPrompts = join(src, 'worlds');
        if (existsSync(worldPrompts)) for (const world of readdirSync(worldPrompts, {withFileTypes:true})) {
            if (world.isDirectory()) copy(join(worldPrompts, world.name, 'ENV_PROMPT.md'), join(stage, 'worlds', world.name, 'ENV_PROMPT.md'));
        }
        if (input.copy.memory)
            copy(join(src, p.memoryDir), join(stage, p.memoryDir));
        else
            for (const name of p.settingsInMemory)
                copy(join(src, p.memoryDir, name), join(stage, p.memoryDir, name));
        const sd = join(src, p.dataDir), dd = join(stage, p.dataDir), o = input.copy;
        const state = json<any>(join(sd, 'core-state.json'), {});
        const high = (o.history || o.session) ? eventsSnapshot(sd, dd, o.history) : 0;
        if (o.session)
            copy(join(sd, 'session-main.jsonl'), join(dd, 'session-main.jsonl'));
        if (o.session || o.memory || o.history || o.worldState)
            copy(join(sd, 'media'), join(dd, 'media'));
        if (o.history)
            copy(join(sd, 'usage.jsonl'), join(dd, 'usage.jsonl'));
        if (o.timers)
            copy(join(sd, 'timers.json'), join(dd, 'timers.json'));
        if (o.worldState)
            for (const name of p.worldState)
                copy(join(sd, name), join(dd, name));
        writeJson(join(dd, 'core-state.json'), {
            lastTruncateAt: o.session ? (state.lastTruncateAt ?? null) : null,
            lastDeliveredCursor: o.pending ? (state.lastDeliveredCursor ?? 0) : high,
            llmStall: { since: 0, at: [] }, persona: o.memory ? (state.persona ?? {}) : {}, worldVisibility: state.worldVisibility ?? {}
        } satisfies CoreStateData);
        const secrets = new Set<string>();
        for (const [id, connection] of Object.entries(p.connections)) {
            if (o.connections.includes(id)) {
                connection.secrets.forEach(k => secrets.add(k));
                continue;
            }
            {
                config.worlds ??= {};
                config.worlds[id] ??= {};
                config.worlds[id].enabled = false;
                for (const key of connection.keys)
                    delete config.worlds[id][key];
            }
        }
        const env = existsSync(join(src, '.env')) ? readFileSync(join(src, '.env'), 'utf8') : '';
        const selected = env.split('\n').filter(line => {
            const key = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
            return !!key && secrets.has(key);
        });
        if (selected.length)
            writeFileSync(join(stage, '.env'), selected.join('\n') + '\n', { mode: 0o600 });
        writeJson(join(stage, 'deployment.json'), { bot: input.bot });
        writeJson(join(stage, 'config.json'), config);
        renameSync(stage, target);
        return target;
    }
    catch (error) {
        rmSync(stage, { recursive: true, force: true });
        throw error;
    }
}
