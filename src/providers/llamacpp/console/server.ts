/**
 * Named-endpoint operations for the runtime and model sections of the endpoint page.
 * Runtime operations manage installation, launch configuration and the process; model operations
 * call llama-server /models*.
 */
import type { ConsolePageContribution } from '../../../web/shared/console-protocol.ts';
import type { ProviderConsoleHost } from '../../console/types.ts';
import type { RouterCatalog, RouterModel } from '../catalog.ts';
import { LAUNCH_DEFAULTS, PINNED_RELEASE, backendChoices, defaultBackend, llamacppOptions, type LaunchOptions } from '../options.ts';
import type { LlamaRuntime } from '../runtime.ts';
import { text } from '../strings.ts';

interface Control {
  runtime: LlamaRuntime;
  catalog: RouterCatalog;
}

export interface ModelsState {
  name: string;
  reachable: boolean;
  cacheDir: string;
  localModelsDir: string;
  models: RouterModel[];
}

/** The launch fields the panel edits, each optional and applied over the stored values. */
type LaunchPatch = Partial<Record<keyof LaunchOptions, unknown>>;

export function llamacppConsole(host: ProviderConsoleHost): Partial<ConsolePageContribution> {
  const S = text(host.language);
  const control = (name: string): Control => host.instance(name).control as Control;
  const body = (args: unknown[]): Record<string, unknown> => {
    const [raw] = args;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(S.bodyRequired);
    const value = raw as Record<string, unknown>;
    if (typeof value.name !== 'string') throw new Error(S.instanceNameRequired);
    return value;
  };
  const entryOf = (name: string) => {
    const found = host.entries().find((entry) => entry.name === name);
    if (!found) throw new Error(S.instanceNameRequired);
    return found.entry;
  };
  return {
    panels: [
      { id: 'runtime', title: S.runtimePanel, description: S.runtimePanelDescription, slot: 'instance' },
      { id: 'models', title: S.modelsPanel, description: S.modelsPanelDescription, slot: 'instance' },
    ],
    invoke: async (panel, method, args) => {
      if (panel === 'runtime') {
        const value = body(args);
        const name = value.name as string;
        if (method === 'state') return { name, ...(await control(name).runtime.state(host.language)) };
        if (method === 'enable') {
          const entry = entryOf(name);
          const options = llamacppOptions(entry);
          const backend = typeof value.backend === 'string' && backendChoices().includes(value.backend) ? value.backend : defaultBackend();
          host.save(name, {
            ...entry,
            options: {
              ...entry.options,
              runtime: { release: typeof value.release === 'string' && value.release.trim() ? value.release.trim() : PINNED_RELEASE, backend },
              launch: { ...LAUNCH_DEFAULTS, ...(options.launch ?? {}) },
            },
          });
          return { ok: true };
        }
        if (method === 'disable') {
          await control(name).runtime.stop(host.language);
          const entry = entryOf(name);
          const { runtime: _runtime, launch: _launch, ...rest } = entry.options ?? {};
          host.save(name, { ...entry, options: rest });
          return { ok: true };
        }
        if (method === 'configure') {
          const entry = entryOf(name);
          const options = llamacppOptions(entry);
          if (!options.runtime) throw new Error(S.notManaged);
          const runtimeOptions = { ...options.runtime };
          if (typeof value.release === 'string') runtimeOptions.release = value.release.trim();
          if (typeof value.backend === 'string') runtimeOptions.backend = value.backend;
          if (typeof value.runtimeDir === 'string') {
            const dir = value.runtimeDir.trim();
            if (dir) runtimeOptions.runtimeDir = dir;
            else delete runtimeOptions.runtimeDir;
          }
          const launch = { ...LAUNCH_DEFAULTS, ...(options.launch ?? {}), ...((value.launch ?? {}) as LaunchPatch) };
          host.save(name, {
            ...entry,
            options: {
              ...entry.options,
              runtime: runtimeOptions,
              launch,
              ...(value.autoStart === undefined ? {} : { autoStart: value.autoStart }),
            },
          });
          return { ok: true };
        }
        if (method === 'install') {
          await control(name).runtime.install(host.language);
          return { ok: true };
        }
        if (method === 'start') return control(name).runtime.start(host.language);
        if (method === 'stop') return control(name).runtime.stop(host.language);
        throw new Error(S.unknownMethod);
      }
      if (panel === 'models') {
        const value = body(args);
        const name = value.name as string;
        const { runtime, catalog } = control(name);
        if (method === 'state') {
          const dirs = runtime.modelDirs();
          try {
            return { name, reachable: true, ...dirs, models: await catalog.list() } satisfies ModelsState;
          } catch {
            return { name, reachable: false, ...dirs, models: [] } satisfies ModelsState;
          }
        }
        if (method === 'reload') {
          await catalog.list(true);
          return { ok: true };
        }
        if (typeof value.model !== 'string' || !value.model.trim()) throw new Error(S.modelIdRequired);
        const model = value.model.trim();
        if (method === 'pull') await catalog.download(model);
        else if (method === 'load') await catalog.load(model);
        else if (method === 'unload' || method === 'cancel') await catalog.unload(model);
        else throw new Error(S.unknownMethod);
        return { ok: true };
      }
      throw new Error(S.unknownPanel);
    },
  };
}
