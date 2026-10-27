import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, isAbsolute, normalize } from 'node:path';
import { deploymentNameProblem } from '../deploy.ts';
import { botPackages } from '../deployment-code.ts';
import { importBotDefinition, locateBotPackage, loadExtensions } from '../extensions.ts';
import { loadBuiltinWorlds } from '../worlds/index.ts';
import { packageDir, repoRoot } from '../paths.ts';
import { providerModules } from '../providers/registry.ts';
import type { Profile, Role } from './types.ts';
export const PROFILES: Profile[] = [];
/** Catalog uses the same definitions and extension loader as the native launcher. */
export async function loadCatalog() {
    const builtin = await loadBuiltinWorlds();
    const extensions = await loadExtensions(repoRoot(), {reserved: builtin.map(w => w.id), reservedProviders: providerModules.map(p => p.id)});
    const worlds = [...builtin, ...extensions.worlds];
    const profiles: Profile[] = [];
    for (const {id} of botPackages()) {
      try {
        const location = locateBotPackage(repoRoot(), id, packageDir(id));
        const definition = await importBotDefinition(location, {treeHas: name => existsSync(join(packageDir(name), 'index.ts'))});
        const defaults = definition.defaults();
        const connections: Profile['connections'] = {};
        for (const world of worlds) {
            // Undeclared copy contracts may contain credentials; copy only on explicit opt-in.
            const connection = world.copy?.connection;
            if (connection || !world.copy) connections[world.id] = {label: world.label,
                keys: connection?.keys ?? Object.keys(world.defaults()), secrets: connection?.secrets ?? []};
        }
        const candidate: Profile = {id, label: defaults.displayName ? `${id} · ${defaults.displayName}` : id, memoryDir: defaults.paths.memory,
            dataDir: defaults.paths.data, settingsInMemory: definition.copy?.settingsInMemory ?? [], copyDeclared: !!definition.copy,
            worldState: worlds.flatMap(w => w.copy?.state ?? []), connections};
        for (const path of [candidate.memoryDir, candidate.dataDir, ...candidate.settingsInMemory, ...candidate.worldState]) {
            if (typeof path !== 'string' || isAbsolute(path) || normalize(path).startsWith('..') || path === '.') throw new Error(`Invalid copy path: ${path}`);
        }
        profiles.push(candidate);
      } catch (error) { console.warn(`Bot template ${id}: ${String(error)}`); }
    }
    PROFILES.splice(0, PROFILES.length, ...profiles);
}
export function profile(id: string): Profile {
    const p = PROFILES.find(p => p.id === id);
    if (!p) throw new Error(`Bot template unavailable: ${id}`);
    return p;
}
export function validId(id: string): boolean { return typeof id === 'string' && deploymentNameProblem(id, []) === null; }
export function json<T = any>(path: string, fallback?: T): T {
    if (!existsSync(path) && fallback !== undefined) return structuredClone(fallback);
    return JSON.parse(readFileSync(path, 'utf8')) as T;
}
export function listRoles(home: string): Role[] {
    if (!existsSync(home)) return [];
    return readdirSync(home, {withFileTypes: true}).filter(e => e.isDirectory() && validId(e.name) && existsSync(join(home, e.name, 'deployment.json'))).map(e => {
        const dir = join(home, e.name), config = json<any>(join(dir, 'config.json'), {});
        return {id: e.name, name: config.displayName || e.name, bot: json(join(dir, 'deployment.json')).bot,
            port: config.web?.port ?? 0, state: 'stopped', avatar: existsSync(join(dir, 'avatar.png'))};
    });
}
