/**
 * Endpoint options of the llamacpp module, and the upstream release table.
 *
 * `options.runtime` present = managed: Cortico downloads the pinned release and starts
 * llama-server in router mode. Absent = external: the endpoint is a llama-server someone else
 * started, and only the catalog and the probes apply.
 */
import type { LLMProviderEntry } from '../../core/types.ts';

/** Upstream build this module was verified against. Endpoints may pin another tag. */
export const PINNED_RELEASE = 'b10930';
const RELEASE_BASE = 'https://github.com/ggml-org/llama.cpp/releases/download';

export interface RuntimeOptions {
  release: string;
  backend: string;
  /** A directory holding llama-server and its libraries; when set nothing is downloaded. */
  runtimeDir?: string;
}
export interface LaunchOptions {
  contextSize: number;
  nGpuLayers: number;
  parallel: number;
  /** Whitespace-separated extra arguments, appended verbatim. */
  extraArgs: string;
}
export interface LlamaCppOptions {
  runtime?: RuntimeOptions;
  launch?: LaunchOptions;
  autoStart?: boolean;
  /** Merged into every request body last, so endpoint-specific fields (`thinking`, …) win. */
  extraBody?: Record<string, unknown>;
  /** Don't send `chat_template_kwargs` at all: strict chat-completions relays reject unknown fields wholesale. */
  omitTemplateKwargs?: boolean;
}

export const LAUNCH_DEFAULTS: LaunchOptions = { contextSize: 16384, nGpuLayers: 99, parallel: 1, extraArgs: '' };

export function llamacppOptions(entry: LLMProviderEntry): LlamaCppOptions {
  return (entry.options ?? {}) as LlamaCppOptions;
}

/** Fills the release and launch defaults for managed endpoints; external ones carry no such keys. */
export function normalizeLlamaCpp(entry: LLMProviderEntry): LLMProviderEntry {
  const options = { ...entry.options } as LlamaCppOptions;
  if (options.runtime && typeof options.runtime === 'object') {
    const runtime = options.runtime as Partial<RuntimeOptions>;
    options.runtime = { ...runtime, release: runtime.release ?? PINNED_RELEASE, backend: runtime.backend ?? defaultBackend() };
    if (options.runtime.runtimeDir === '') delete options.runtime.runtimeDir;
    options.launch = { ...LAUNCH_DEFAULTS, ...(options.launch ?? {}) };
  }
  if (options.extraBody && typeof options.extraBody === 'object' && !Array.isArray(options.extraBody) && !Object.keys(options.extraBody).length) delete options.extraBody;
  return { ...entry, options: options as Record<string, unknown> };
}

export interface ReleaseArchive {
  url: string;
  file: string;
  format: 'zip' | 'tgz';
  /** Leading path components to drop; the tarballs wrap everything in `llama-<tag>/`. */
  stripComponents: number;
}
export interface ReleasePlan {
  /** Directory name under the release: `win-cuda-13.3-x64`, `ubuntu-vulkan-x64`, `macos-arm64`. */
  key: string;
  archives: ReleaseArchive[];
  /** Server executable name inside the directory. */
  serverExe: string;
}

type Platform = NodeJS.Platform;
type Arch = string;

/** Backends the upstream ships a prebuilt archive for, per platform. First one is the default. */
export function backendChoices(platform: Platform = process.platform, arch: Arch = process.arch): string[] {
  if (platform === 'win32') {
    if (arch === 'x64') return ['cuda-13.3', 'cuda-12.4', 'vulkan', 'cpu'];
    if (arch === 'arm64') return ['cuda-13.4', 'cpu'];
    return [];
  }
  if (platform === 'linux') {
    if (arch === 'x64') return ['vulkan', 'rocm-10.0', 'cpu'];
    if (arch === 'arm64') return ['vulkan', 'cpu'];
    return [];
  }
  if (platform === 'darwin') return arch === 'x64' || arch === 'arm64' ? ['metal'] : [];
  return [];
}

export function defaultBackend(platform: Platform = process.platform, arch: Arch = process.arch): string {
  return backendChoices(platform, arch)[0] ?? 'cpu';
}

/** The archives that make up one build on one platform; null when the upstream ships none. */
export function releasePlan(
  release: string,
  backend: string,
  platform: Platform = process.platform,
  arch: Arch = process.arch,
): ReleasePlan | null {
  if (!backendChoices(platform, arch).includes(backend)) return null;
  const asset = (file: string, format: 'zip' | 'tgz', stripComponents: number): ReleaseArchive => ({
    url: `${RELEASE_BASE}/${release}/${file}`,
    file,
    format,
    stripComponents,
  });
  if (platform === 'win32') {
    const key = `win-${backend}-${arch}`;
    const archives = [asset(`llama-${release}-bin-${key}.zip`, 'zip', 0)];
    if (backend.startsWith('cuda-')) archives.push(asset(`cudart-llama-bin-win-${backend}-${arch}.zip`, 'zip', 0));
    return { key, archives, serverExe: 'llama-server.exe' };
  }
  if (platform === 'linux') {
    const key = backend === 'cpu' ? `ubuntu-${arch}` : `ubuntu-${backend}-${arch}`;
    return { key, archives: [asset(`llama-${release}-bin-${key}.tar.gz`, 'tgz', 1)], serverExe: 'llama-server' };
  }
  const key = `macos-${arch}`;
  return { key, archives: [asset(`llama-${release}-bin-${key}.tar.gz`, 'tgz', 1)], serverExe: 'llama-server' };
}
