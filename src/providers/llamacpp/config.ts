import type { ConfigGroup, ConfigProperty } from '../../core/config-schema.ts';
import type { Language } from '../../core/language.ts';
import type { LLMProviderEntry } from '../../core/types.ts';
import { backendChoices, llamacppOptions } from './options.ts';
import { panel } from './strings.ts';

export function runtimeConfig(name: string, entry: LLMProviderEntry, language: Language): ConfigGroup[] {
  if (!llamacppOptions(entry).runtime) return [];
  const S = panel[language];
  const group = (
    id: string, title: string, description: string, properties: Record<string, ConfigProperty>,
  ): ConfigGroup => ({
    id: `llm.llamacpp.${name}.${id}`,
    owner: 'provider:llamacpp',
    schema: {
      type: 'object', title, description,
      properties: Object.fromEntries(Object.entries(properties).map(([path, property]) => [
        `providers.${name}.options.${path}`, { ...property, 'x-hot': true },
      ])),
    },
  });
  return [
    group('runtime', S.runtimeSection, S.runtimeSectionDesc, {
      'runtime.release': { type: 'string', title: S.release, description: S.releaseHint },
      'runtime.backend': { type: 'string', title: S.backend, enum: backendChoices(), description: S.backendHint },
      'runtime.runtimeDir': {
        type: 'string', title: S.runtimeDir, description: S.runtimeDirHint, 'x-path': { kind: 'directory' },
      },
    }),
    group('launch', S.launchSection, S.launchSectionDesc, {
      'launch.contextSize': { type: 'integer', title: S.contextSize, minimum: 1 },
      'launch.nGpuLayers': { type: 'integer', title: S.nGpuLayers, minimum: 0 },
      'launch.parallel': { type: 'integer', title: S.parallel, minimum: 1 },
      'launch.extraArgs': { type: 'string', title: S.extraArgs, description: S.extraArgsHint },
      autoStart: { type: 'boolean', title: S.autoStart },
    }),
  ];
}
