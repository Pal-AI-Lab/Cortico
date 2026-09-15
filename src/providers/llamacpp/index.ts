import { connectionGroup } from '../console/config.ts';
import type { ProviderModule } from '../base.ts';
import type { ReasoningTier } from '../../core/types.ts';
import type { Language } from '../../core/language.ts';
import type { ConfigProperty } from '../../core/config-schema.ts';
import { isContextOverflow } from '../transport/errors.ts';
import { modelsRoot, runtimesRoot } from '../../paths.ts';
import { RouterCatalog } from './catalog.ts';
import { llamacppConsole } from './console/server.ts';
import { LlamaCppProvider } from './native.ts';
import { backendChoices, llamacppOptions, normalizeLlamaCpp } from './options.ts';
import { LlamaRuntime } from './runtime.ts';
import { nullLogger } from '../../core/util.ts';
import { text } from './strings.ts';

/** Two tiers: the transport sends the template's thinking switch, effort only when the operator typed one. */
const reasoningTiers = (language: Language): ReasoningTier[] => {
  const S = text(language);
  return [
    { id: 'off', label: S.tierOff, thinking: false },
    { id: 'on', label: S.tierOn, thinking: true },
  ];
};

export default {
  id: 'llamacpp',
  title: 'llama.cpp',
  defaultBaseUrl: 'http://127.0.0.1:8090/v1',
  baseUrlSuggestions: ['http://127.0.0.1:8090/v1', 'http://127.0.0.1:8080/v1'],
  normalize: normalizeLlamaCpp,
  console: llamacppConsole,
  reasoningTiers: reasoningTiers('zh'),
  localize: (language) => ({ reasoningTiers: reasoningTiers(language) }),
  serviceTiers: [],
  config: (name, entry, language) => {
    const S = text(language);
    const options = llamacppOptions(entry);
    const managed: Record<string, ConfigProperty> = options.runtime
      ? {
          'options.runtime.release': { type: 'string', title: S.release, description: S.releaseDescription, 'x-hot': true },
          'options.runtime.backend': { type: 'string', title: S.backend, description: S.backendDescription, enum: backendChoices(), 'x-hot': true },
          'options.runtime.runtimeDir': {
            type: 'string', title: S.runtimeDir, description: S.runtimeDirDescription, 'x-hot': true,
            'x-path': { kind: 'directory' },
          },
          'options.launch.contextSize': { type: 'integer', title: S.contextSize, description: S.launchNote, minimum: 1, 'x-hot': true },
          'options.launch.nGpuLayers': { type: 'integer', title: S.nGpuLayers, minimum: 0, 'x-hot': true },
          'options.launch.parallel': { type: 'integer', title: S.parallel, minimum: 1, 'x-hot': true },
          'options.launch.extraArgs': { type: 'string', title: S.extraArgs, description: S.extraArgsDescription, 'x-hot': true },
          'options.autoStart': { type: 'boolean', title: S.autoStart, 'x-hot': true },
        }
      : {};
    return [connectionGroup(name, entry, managed, language)];
  },
  validateEntry: (entry, language) => {
    const S = text(language);
    const options = llamacppOptions(entry);
    if (options.autoStart !== undefined && typeof options.autoStart !== 'boolean') throw new Error(S.autoStartBoolean);
    if (!options.runtime) return;
    const { runtime, launch } = options;
    if (typeof runtime.release !== 'string' || !runtime.release.trim()) throw new Error(S.releaseRequired);
    if (runtime.runtimeDir !== undefined && typeof runtime.runtimeDir !== 'string') throw new Error(S.runtimeDirString);
    if (!runtime.runtimeDir && !backendChoices().includes(runtime.backend)) throw new Error(S.backendUnsupported(String(runtime.backend)));
    if (launch) {
      for (const key of ['contextSize', 'parallel'] as const)
        if (!Number.isInteger(launch[key]) || launch[key] <= 0) throw new Error(S.positiveInteger(key));
      if (!Number.isInteger(launch.nGpuLayers) || launch.nGpuLayers < 0) throw new Error(S.nonNegativeInteger('nGpuLayers'));
      if (typeof launch.extraArgs !== 'string') throw new Error(S.extraArgsString);
    }
  },
  contextOverflow: isContextOverflow,
  availability: (name, entry, language) => {
    if (!llamacppOptions(entry).runtime) return { ready: true };
    const runtime = new LlamaRuntime({
      name,
      entry: () => entry,
      secret: () => '',
      log: nullLogger(),
      roots: { runtimes: runtimesRoot(), models: modelsRoot() },
    });
    if (runtime.installState(language).phase === 'installed') return { ready: true };
    return { ready: false, reason: text(language).runtimeNotInstalled };
  },
  create(name, entry, host) {
    const current = host.currentEntry ?? (() => entry);
    const apiKey = entry.secret ? host.secret(entry.secret) : undefined;
    const catalog = new RouterCatalog(() => ({ baseUrl: current().baseUrl, apiKey }));
    const createRuntime = () =>
      new LlamaRuntime({
        name,
        entry: current,
        secret: host.secret,
        log: host.log,
        roots: { runtimes: runtimesRoot(), models: modelsRoot() },
      });
    const runtime = host.resource?.('runtime', createRuntime) ?? createRuntime();
    return {
      control: { runtime, catalog },
      listModels: () => catalog.listModels(),
      contextWindow: (model) => catalog.contextWindow(model),
      compatibilityKey: () => [name],
      start: () => (llamacppOptions(current()).autoStart === true ? runtime.start() : Promise.resolve(undefined)),
      stop: async () => {
        catalog.stop();
        await runtime.stop();
      },
      client: new LlamaCppProvider({
        baseUrl: entry.baseUrl,
        apiKey,
        log: host.log,
        media: { enabled: () => entry.multimodal === true, read: host.readBlob },
      }),
    };
  },
} satisfies ProviderModule;
