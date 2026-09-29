/**
 * llama-server's own model endpoints. In router mode `GET /models` lists everything it can
 * serve with a status per model, `POST /models` pulls one from HuggingFace into `LLAMA_CACHE`,
 * and `/models/load` / `/models/unload` move one in and out of memory (unload also cancels a
 * download). A single-model server answers the listing without statuses.
 */
import type { ListedModel } from '../base.ts';
import { EventDecoder } from '../transport/response-http.ts';

export type RouterModelStatus = 'loaded' | 'loading' | 'unloaded' | 'downloading' | 'sleeping' | 'failed' | 'unknown';

export interface RouterModel {
  id: string;
  status: RouterModelStatus;
  path: string | null;
  /** From `architecture.input_modalities`; null when the server does not state it. */
  inputModalities: string[] | null;
  /** Bytes done / total across the files of a running download. */
  progress: { done: number; total: number } | null;
}

export interface RouterEndpoint {
  baseUrl: string;
  apiKey?: string;
}

/** `/props` re-probe interval; a reloaded model may run with a different `-c`. */
const PROPS_REFRESH_MS = 60_000;

export class RouterCatalog {
  private readonly fetchImpl: typeof fetch;
  private readonly refreshMs: number;
  private last: RouterModel[] = [];
  private readonly windows = new Map<string, { value: number | undefined; probedAt: number; inFlight: Promise<void> | null }>();
  /** Byte progress per downloading model, fed by `/models/sse`; the listing itself carries none. */
  private readonly progress = new Map<string, { done: number; total: number }>();
  private sse: AbortController | null = null;

  constructor(
    private readonly endpoint: () => RouterEndpoint,
    opts: { fetchImpl?: typeof fetch; refreshMs?: number } = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.refreshMs = opts.refreshMs ?? PROPS_REFRESH_MS;
  }

  private origin(): string {
    return new URL(this.endpoint().baseUrl).origin;
  }

  private headers(): Record<string, string> {
    const { apiKey } = this.endpoint();
    return { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
  }

  private async post(path: string, body: Record<string, unknown>): Promise<void> {
    const res = await this.fetchImpl(`${this.origin()}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`POST ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  async list(reload = false): Promise<RouterModel[]> {
    const res = await this.fetchImpl(`${this.origin()}/models${reload ? '?reload=1' : ''}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GET /models ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { data?: unknown };
    if (!Array.isArray(json.data)) throw new Error('GET /models returned no data array');
    const models: RouterModel[] = [];
    for (const row of json.data) {
      if (!row || typeof row !== 'object' || typeof (row as { id?: unknown }).id !== 'string') continue;
      const model = normalizeModel(row as Record<string, unknown>);
      if (model.status === 'downloading') {
        model.progress ??= this.progress.get(model.id) ?? null;
        this.watchDownloads();
      }
      models.push(model);
    }
    this.last = models.sort((a, b) => a.id.localeCompare(b.id));
    return this.last;
  }

  /** Triggers a HuggingFace pull; `list()` then shows the model as `downloading` with byte progress. */
  async download(model: string): Promise<void> {
    await this.post('/models', { model });
    this.watchDownloads();
  }

  /** Stops the progress subscription (tests and shutdown); it also ends itself when nothing downloads. */
  stop(): void {
    this.sse?.abort();
    this.sse = null;
  }

  /**
   * One `/models/sse` subscription while a download runs: `download_progress` frames carry
   * per-file byte counts, `download_finished` / `download_failed` end the model's entry, and
   * the connection closes once no model is downloading.
   */
  private watchDownloads(): void {
    if (this.sse) return;
    const controller = new AbortController();
    this.sse = controller;
    void (async () => {
      try {
        const res = await this.fetchImpl(`${this.origin()}/models/sse`, { headers: this.headers(), signal: controller.signal });
        if (!res.ok || !res.body) return;
        const decoder = new EventDecoder();
        const text = new TextDecoder();
        const reader = res.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const raw of decoder.feed(text.decode(value, { stream: true }))) this.onDownloadEvent(raw);
          if (this.progress.size === 0 && !this.last.some((model) => model.status === 'downloading')) break;
        }
      } catch {
        // Aborted or unreachable: the next listing restarts the subscription if a download is still running.
      } finally {
        if (this.sse === controller) this.sse = null;
        controller.abort();
      }
    })();
  }

  private onDownloadEvent(raw: string): void {
    let frame: { model?: unknown; event?: unknown; data?: unknown };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      return;
    }
    if (typeof frame.model !== 'string') return;
    if (frame.event === 'download_progress' && frame.data && typeof frame.data === 'object') {
      let done = 0;
      let total = 0;
      for (const file of Object.values(frame.data as Record<string, { done?: unknown; total?: unknown }>)) {
        if (typeof file?.done === 'number') done += file.done;
        if (typeof file?.total === 'number') total += file.total;
      }
      this.progress.set(frame.model, { done, total });
      const listed = this.last.find((model) => model.id === frame.model);
      if (listed) listed.progress = { done, total };
    } else if (frame.event === 'download_finished' || frame.event === 'download_failed' || frame.event === 'model_remove') {
      this.progress.delete(frame.model);
    }
  }

  load(model: string): Promise<void> {
    return this.post('/models/load', { model });
  }

  /** Unloads a loaded model, or cancels its download. */
  unload(model: string): Promise<void> {
    return this.post('/models/unload', { model });
  }

  /** The `ProviderInstance.listModels` view: ids, the window when already probed, image input when the listing states modalities. */
  async listModels(): Promise<ListedModel[]> {
    const models = await this.list();
    return models.map((model) => {
      const listed: ListedModel = { id: model.id };
      const window = this.windows.get(model.id)?.value;
      if (window) listed.contextWindow = window;
      if (model.inputModalities) listed.inputImages = model.inputModalities.includes('image');
      return listed;
    });
  }

  /** Last listing's answer on images for this model; undefined when never listed or not stated. */
  acceptsImage(model: string): boolean | undefined {
    const found = this.last.find((row) => row.id === model);
    if (!found?.inputModalities) return undefined;
    return found.inputModalities.includes('image');
  }

  /**
   * `default_generation_settings.n_ctx` from `/props?model=`: the per-slot context the server
   * enforces. Never blocks; refreshes in the background and keeps the last value while the
   * server is away.
   */
  contextWindow(model: string): number | undefined {
    const entry = this.windows.get(model) ?? { value: undefined, probedAt: 0, inFlight: null };
    this.windows.set(model, entry);
    if (!entry.inFlight && Date.now() - entry.probedAt >= this.refreshMs) {
      entry.inFlight = this.probeProps(model)
        .then((value) => {
          if (value !== undefined) entry.value = value;
        })
        .finally(() => {
          entry.inFlight = null;
          entry.probedAt = Date.now();
        });
    }
    return entry.value;
  }

  /** Resolves once the probe started by the last lookup has settled (tests). */
  settled(model: string): Promise<void> {
    return this.windows.get(model)?.inFlight ?? Promise.resolve();
  }

  private async probeProps(model: string): Promise<number | undefined> {
    try {
      const res = await this.fetchImpl(`${this.origin()}/props?model=${encodeURIComponent(model)}`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as { default_generation_settings?: { n_ctx?: unknown } };
      const n = json.default_generation_settings?.n_ctx;
      return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined;
    } catch {
      return undefined;
    }
  }
}

function normalizeModel(row: Record<string, unknown>): RouterModel {
  const status = row.status as Record<string, unknown> | undefined;
  const value = typeof status?.value === 'string' ? status.value : null;
  let progress: RouterModel['progress'] = null;
  if (status?.progress && typeof status.progress === 'object' && value === 'downloading') {
    let done = 0;
    let total = 0;
    for (const file of Object.values(status.progress as Record<string, { done?: unknown; total?: unknown }>)) {
      if (typeof file?.done === 'number') done += file.done;
      if (typeof file?.total === 'number') total += file.total;
    }
    progress = { done, total };
  }
  const architecture = row.architecture as { input_modalities?: unknown } | undefined;
  const modalities = Array.isArray(architecture?.input_modalities)
    ? architecture.input_modalities.filter((item): item is string => typeof item === 'string')
    : null;
  return {
    id: row.id as string,
    status: status?.failed === true ? 'failed'
      : value === 'loaded' || value === 'loading' || value === 'unloaded' || value === 'downloading' || value === 'sleeping' ? value
      : 'unknown',
    path: typeof row.path === 'string' ? row.path : null,
    inputModalities: modalities,
    progress,
  };
}
