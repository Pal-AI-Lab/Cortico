/**
 * Install builds under <runtimes root>/llama.cpp/<release>/<plan key>/.
 * Download and unpack into <dir>.partial, write the completion marker, then rename to the destination.
 * A later installation removes any remaining partial directory before starting.
 */
import { existsSync, mkdirSync, rmSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../../core/types.ts';
import type { Language } from '../../core/language.ts';
import { downloadFile, extractArchive } from './archive.ts';
import type { ReleasePlan } from './options.ts';
import { text, type Text } from './strings.ts';
import { readTextFile } from '../../core/util.ts';

export const RUNTIME_MARKER = 'cortico-runtime.json';
const RUNTIME_ID = 'llama.cpp';

export type InstallPhase = 'absent' | 'downloading' | 'extracting' | 'installed' | 'error';

export interface InstallState {
  phase: InstallPhase;
  /** Archive being downloaded or unpacked. */
  file: string | null;
  done: number;
  total: number | null;
  detail: string | null;
}

export interface RuntimeMarker {
  runtime: typeof RUNTIME_ID;
  release: string;
  key: string;
  archives: string[];
  installedAt: string;
}

type Detail = (S: Text) => string;

export class RuntimeStore {
  private active: { dir: string; phase: InstallPhase; file: string | null; done: number; total: number | null } | null = null;
  private failures = new Map<string, Detail>();
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly root: string,
    private readonly log: Logger,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  dir(release: string, plan: ReleasePlan): string {
    return join(this.root, RUNTIME_ID, release, plan.key);
  }

  installed(dir: string): boolean {
    return existsSync(join(dir, RUNTIME_MARKER));
  }

  marker(dir: string): RuntimeMarker | null {
    try {
      return JSON.parse(readTextFile(join(dir, RUNTIME_MARKER))) as RuntimeMarker;
    } catch {
      return null;
    }
  }

  state(dir: string, language: Language = 'zh'): InstallState {
    if (this.active?.dir === dir) {
      const { phase, file, done, total } = this.active;
      return { phase, file, done, total, detail: null };
    }
    const failure = this.failures.get(dir);
    if (failure) return { phase: 'error', file: null, done: 0, total: null, detail: failure(text(language)) };
    return { phase: this.installed(dir) ? 'installed' : 'absent', file: null, done: 0, total: null, detail: null };
  }

  /** Downloads and unpacks every archive of the plan; a second concurrent install is refused. */
  async install(release: string, plan: ReleasePlan, language: Language = 'zh'): Promise<void> {
    const dir = this.dir(release, plan);
    if (this.active) throw new Error(text(language).installBusy);
    this.failures.delete(dir);
    const partial = `${dir}.partial`;
    rmSync(partial, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true });
    this.active = { dir, phase: 'downloading', file: null, done: 0, total: null };
    try {
      for (const archive of plan.archives) {
        const file = join(partial, archive.file);
        this.active = { dir, phase: 'downloading', file: archive.file, done: 0, total: null };
        this.log.info(`llama.cpp 运行时下载 ${archive.url}`);
        try {
          await downloadFile(archive.url, file, {
            fetchImpl: this.fetchImpl,
            onProgress: (done, total) => {
              if (this.active?.dir === dir) Object.assign(this.active, { done, total });
            },
          });
        } catch (error) {
          throw { detail: (S: Text) => S.downloadFailed(archive.file, message(error)) };
        }
        this.active = { dir, phase: 'extracting', file: archive.file, done: 0, total: null };
        try {
          await extractArchive(file, archive.format, partial, archive.stripComponents);
        } catch (error) {
          throw { detail: (S: Text) => S.extractFailed(archive.file, message(error)) };
        }
        unlinkSync(file);
      }
      const marker: RuntimeMarker = {
        runtime: RUNTIME_ID,
        release,
        key: plan.key,
        archives: plan.archives.map((archive) => archive.file),
        installedAt: new Date().toISOString(),
      };
      writeFileSync(join(partial, RUNTIME_MARKER), JSON.stringify(marker, null, 2) + '\n');
      mkdirSync(join(dir, '..'), { recursive: true });
      renameSync(partial, dir);
      this.log.info(`llama.cpp 运行时已安装 ${dir}`);
    } catch (error) {
      rmSync(partial, { recursive: true, force: true });
      const detail: Detail = isDetail(error) ? error.detail : () => message(error);
      this.failures.set(dir, detail);
      this.log.warn(`llama.cpp 运行时安装失败: ${detail(text('zh'))}`);
      throw new Error(detail(text(language)));
    } finally {
      this.active = null;
    }
  }
}

function isDetail(value: unknown): value is { detail: Detail } {
  return typeof value === 'object' && value !== null && typeof (value as { detail?: unknown }).detail === 'function';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
