export type RunState = 'stopped' | 'starting' | 'paused' | 'running' | 'stopping' | 'error';
export interface Role {
    id: string;
    name: string;
    bot: string;
    port: number;
    state: RunState;
    error?: string;
    avatar: boolean;
}
export interface CopyOptions {
    memory: boolean;
    session: boolean;
    history: boolean;
    timers: boolean;
    pending: boolean;
    worldState: boolean;
    connections: string[];
}
export const EMPTY_COPY: CopyOptions = { memory: false, session: false, history: false, timers: false, pending: false, worldState: false, connections: [] };
export interface CreateInput {
    id: string;
    name: string;
    bot: string;
    source?: string;
    copy: CopyOptions;
    allowStop: boolean;
}
export interface Step {
    label: string;
    at: string;
}
export interface Job {
    id: string;
    input: CreateInput;
    status: 'working' | 'done' | 'failed';
    steps: Step[];
    error?: string;
    result?: string;
}
export interface Profile {
    id: string;
    label: string;
    memoryDir: string;
    dataDir: string;
    settingsInMemory: string[];
    copyDeclared: boolean;
    worldState: string[];
    connections: Record<string, {
        label: string;
        keys: string[];
        secrets: string[];
    }>;
}

/** Mutable runtime data requires a stopped source for a consistent snapshot. */
export function copiesRuntime(copy: Partial<CopyOptions>): boolean {
    return !!(copy.memory || copy.session || copy.history || copy.timers || copy.pending || copy.worldState);
}

export type Action = 'start' | 'run' | 'pause' | 'resume' | 'stop' | 'restart';
export interface Schedule {
    id: string;
    role: string;
    action: Action;
    next: string;
    repeat: 'once' | 'daily';
    enabled: boolean;
    lastResult?: string;
}
export interface Operation {
    id: string;
    role: string;
    name: string;
    action: string;
    at: string;
    status: 'done' | 'failed' | 'working';
    message?: string;
    schedule?: string;
}
export interface DeletedRole {
    key: string;
    id: string;
    name: string;
    at: string;
}
