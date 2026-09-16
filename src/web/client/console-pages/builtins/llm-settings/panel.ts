/**
 * 内置 llm-settings 面板，通过 ctx.invoke 使用声明方的数据面。
 * 每一格在 change 时写回端点条目，模块自有的段落挂在 `instance` 插槽里。
 * reasoningTiers 非空时限制为所列档位；为空时接受开放字符串。空值使用端点默认，none 关闭推理，其余写入 reasoningEffort。
 */
import type {
  ConsoleDisablable,
  ConsoleFormat,
  ConsolePanelContext,
  ConsolePanel,
  ConsoleUi,
  Disposable,
} from '../../../../shared/client-panel.ts';
import { pricingEditor, type ModelQuote } from './pricing-panel.ts';
import { panel } from './strings.ts';

/** 每个端点实例的模型与推理配置。 */
interface Spec {
  model: string;
  thinking: boolean;
  reasoningEffort?: string;
  temperature?: number;
  maxTokens?: number;
  contextWindow?: number;
}
interface Tier {
  id: string;
  label: string;
  thinking: boolean;
  effort?: string;
  note?: string;
}
interface Entry {
  kind: string;
  baseUrl: string;
  secret?: string;
  multimodal?: boolean;
  spec?: Spec;
  pricing?: unknown[];
  serviceTier?: string;
  options?: Record<string, unknown>;
}
interface Instance {
  name: string;
  entry: Entry;
  quotes: ModelQuote[];
  secretConfigured: 'env' | 'file' | 'none';
}
interface SettingsState {
  active: string;
  reasoningTiers: Tier[];
  serviceTiers: Array<{ id: string; label: string; note?: string }>;
  temperatureNote?: string;
  baseUrlSuggestions?: string[];
  effortSuggestions?: string[];
  instances: Instance[];
}
interface ModelEntry {
  id: string;
  contextWindow?: number;
}
interface ProbeResult {
  ok: boolean;
  status: number | null;
  elapsedMs: number;
  model?: string;
  usage?: {
    input: number | null;
    cachedInput: number | null;
    output: number | null;
    reasoning: number | null;
  };
  encryptedReasoning?: boolean;
  charges?: Array<{ currency: string; amount: number | null }>;
  error?: string;
  hint?: string;
}

const DEFAULT_ENDPOINT_PATH = '/responses';

/** 模块自有段落挂在这个插槽里，排在连接与模型档之间。 */
const MODULE_SLOT = 'instance';

/** 开放模式的 effort 格 ↔ spec 的 thinking/reasoningEffort。 */
function effortOf(spec: Spec): string {
  if (!spec.thinking) return 'none';
  return spec.reasoningEffort ?? '';
}
function applyEffort(spec: Spec, value: string): void {
  const effort = value.trim();
  spec.thinking = effort !== 'none';
  if (effort === '' || effort === 'none') delete spec.reasoningEffort;
  else spec.reasoningEffort = effort;
}

function datalist(ui: ConsoleUi, id: string, values: readonly string[]): HTMLDataListElement {
  const list = ui.h('datalist');
  list.id = id;
  for (const value of values) {
    const option = ui.h('option');
    option.value = value;
    list.append(option);
  }
  return list;
}

function probeCard(ui: ConsoleUi, S: typeof panel.zh, result: ProbeResult): HTMLElement {
  const fmt: ConsoleFormat = ui.fmt;
  const usage = result.usage;
  const rows = [
    {
      k: S.probeStatus,
      v: ui.pill(
        `${result.ok ? S.probeOk : S.probeFailed}${result.status === null ? '' : ` · ${result.status}`}`,
        result.ok ? 'on' : 'off',
      ),
    },
    { k: S.probeLatency, v: fmt.duration(result.elapsedMs) },
    { k: S.probeModel, v: result.model ?? '' },
    {
      k: S.probeUsage,
      v: usage
        ? S.probeUsageLine(
            fmt.count(usage.input),
            fmt.count(usage.cachedInput),
            fmt.count(usage.output),
            fmt.count(usage.reasoning),
          )
        : '',
    },
    {
      k: S.probeEncrypted,
      v: result.encryptedReasoning === undefined ? '' : result.encryptedReasoning ? S.yes : S.no,
    },
    {
      k: S.probeCost,
      v: (result.charges ?? [])
        .map((charge) => fmt.money(charge.amount, charge.currency))
        .join(' · '),
    },
  ];
  const sheet = ui.sheet({ title: S.probeTitle });
  sheet.body.append(ui.kv(rows));
  if (!result.ok) {
    if (result.error) sheet.body.append(ui.msgline(result.error, true));
    if (result.hint) sheet.body.append(ui.msgline(result.hint, true));
  }
  return sheet.el;
}

export const llmSettingsPanel: ConsolePanel = {
  mount: async (ctx: ConsolePanelContext) => {
    const { ui, root } = ctx;
    const S = ctx.language === 'en' ? panel.en : panel.zh;
    // `<datalist>` 靠全局 id 绑定;每次挂载一个前缀,同页两份面板互不串。
    const uid = `llm-${Math.random().toString(36).slice(2, 8)}`;
    let selected = '';
    /** 模块段落的句柄，重画前先结束上一批。 */
    let sections: Disposable | null = null;
    /** 重画代号：慢一步回来的那次 load 不再往 DOM 上贴。 */
    let generation = 0;
    const report = ui.msgline();
    const body = ui.h('div');
    root.append(body, report);
    /** 写一格:落盘后只更新状态行与页头徽标,表单留在原处。 */
    const patch = async (fields: Record<string, unknown>): Promise<boolean> => {
      try {
        await ctx.invoke('save', [{ name: selected, ...fields }]);
      } catch (error) {
        report.textContent = String(error);
        return false;
      }
      report.textContent = S.saved;
      await ctx.refresh();
      return true;
    };
    /** 改了实例集合或当前实例的动作:落盘后整页重画。 */
    const action = async (method: string, args: unknown[], done = S.saved): Promise<boolean> => {
      try {
        await ctx.invoke(method, args);
      } catch (error) {
        report.textContent = String(error);
        return false;
      }
      report.textContent = done;
      await ctx.refresh();
      await load();
      return true;
    };
    /** 读类方法(取模型、探测):不重画;失败把服务端措辞放进 report。 */
    const query = async <T>(method: string, args: unknown[], ...locked: ConsoleDisablable[]) => {
      const release = ui.disable(...locked);
      try {
        return await ctx.invoke<T>(method, args);
      } catch (error) {
        report.textContent = String(error);
        return null;
      } finally {
        release.dispose();
      }
    };
    async function load() {
      const gen = ++generation;
      const state = await ctx.invoke<SettingsState>('state');
      if (ctx.signal.aborted || gen !== generation) return;
      sections?.dispose();
      sections = null;
      body.replaceChildren();
      if (!state.instances.some((instance) => instance.name === selected))
        selected =
          state.instances.find((instance) => instance.name === state.active)?.name ??
          state.instances[0]?.name ??
          '';
      const open = state.reasoningTiers.length === 0;
      const top = ui.sheet({
        title: S.instancesTitle,
        desc: S.instancesDescription,
      });
      const selector = ui.select({
        value: selected,
        options: state.instances.map((instance) => ({
          value: instance.name,
          label: instance.name + (instance.name === state.active ? S.activeSuffix : ''),
        })),
        onChange: (name) => {
          selected = name;
          void load();
        },
      });
      top.body.append(ui.field(S.instanceField, selector));
      const createName = ui.input({ placeholder: S.newInstanceName });
      // 候选就是几个已知能用的地址,选不选随意:这一格收任何 URL。
      const createUrl = ui.input({ placeholder: S.newInstanceUrl, cls: 'mono' });
      createUrl.setAttribute('list', `${uid}-baseurls`);
      const createRow = ui.rowbar();
      createRow.append(
        createName,
        createUrl,
        datalist(ui, `${uid}-baseurls`, state.baseUrlSuggestions ?? []),
        ui.button(S.addInstance, {
          onClick: async () => {
            const name = createName.value.trim();
            const before = selected;
            selected = name;
            if (!(await action('create', [{ name, baseUrl: createUrl.value.trim() }])))
              selected = before;
          },
        }),
      );
      top.body.append(createRow);
      body.append(top.el);
      const current = state.instances.find((instance) => instance.name === selected);
      if (!current) return;
      const entry = current.entry;
      const spec: Spec = structuredClone(entry.spec) ?? { model: '', thinking: open };
      const saveSpec = () => void patch({ spec });

      // ---- 连接 ----
      const connection = ui.sheet({ title: S.connectionTitle, desc: S.connectionDescription });
      const options = entry.options ?? {};
      let endpointPath =
        typeof options.endpointPath === 'string' ? options.endpointPath : DEFAULT_ENDPOINT_PATH;
      const jsonText = (value: unknown) =>
        value === undefined ? '' : JSON.stringify(value, null, 2);
      const baseUrlInput = ui.input({
        value: entry.baseUrl,
        cls: 'mono',
        onChange: (value) => void connectionChanged({ baseUrl: value.trim() }),
      });
      baseUrlInput.setAttribute('aria-label', S.baseUrl);
      const secretNameInput = ui.input({
        value: entry.secret ?? '',
        placeholder: S.secretNamePlaceholder,
        cls: 'mono',
        onChange: (value) => void connectionChanged({ secret: value.trim() }),
      });
      secretNameInput.setAttribute('aria-label', S.secretName);
      connection.body.append(
        ui.field(S.baseUrl, baseUrlInput),
        ui.field(S.secretName, secretNameInput),
      );
      {
        const row = ui.rowbar();
        const status = ui.pill(
          S.secretSource[current.secretConfigured],
          current.secretConfigured === 'none' ? 'off' : 'on',
        );
        const value = ui.input({ type: 'password', placeholder: S.secretValuePlaceholder });
        value.setAttribute('aria-label', S.secretValue);
        row.append(status, value, ui.button(S.saveSecret, {
          onClick: () =>
            void action('setSecret', [{ name: selected, value: value.value }], S.secretSaved),
        }));
        connection.body.append(ui.field(S.secretStatus, row));
        if (!entry.secret) connection.body.append(ui.msgline(S.secretNameFirst));
      }
      connection.body.append(
        ui.checkbox(S.multimodal, {
          checked: entry.multimodal === true,
          onChange: (checked) => void patch({ multimodal: checked }),
        }).el,
      );
      let extraHeaders: HTMLTextAreaElement | null = null;
      let extraBody: HTMLTextAreaElement | null = null;
      if (open) {
        const path = ui.input({
          value: endpointPath,
          cls: 'mono',
          onChange: (value) => {
            endpointPath = value.trim();
            saveOptions();
          },
        });
        path.setAttribute('aria-label', S.endpointPath);
        extraHeaders = ui.textarea({
          rows: 3,
          cls: 'mono',
          value: jsonText(options.extraHeaders),
          onChange: saveOptions,
        });
        extraHeaders.setAttribute('aria-label', S.extraHeaders);
        extraBody = ui.textarea({
          rows: 3,
          cls: 'mono',
          value: jsonText(options.extraBody),
          onChange: saveOptions,
        });
        extraBody.setAttribute('aria-label', S.extraBody);
        connection.body.append(
          ui.section(S.advancedProtocolTitle, S.advancedProtocolDescription),
          ui.field(S.endpointPath, path),
          ui.field(S.extraHeaders, extraHeaders),
          ui.field(S.extraBody, extraBody),
        );
      }
      body.append(connection.el);
      /** 面板可编辑的 options 三键并回原 options;空的删掉。非法 JSON 抛错,由保存时报出。 */
      const optionsPayload = (): Record<string, unknown> => {
        const next = { ...options };
        const object = (textarea: HTMLTextAreaElement, label: string): unknown => {
          const text = textarea.value.trim();
          if (!text) return undefined;
          const parsed: unknown = JSON.parse(text);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error(S.jsonObjectRequired(label));
          return parsed;
        };
        const edited: Record<string, unknown> = {
          endpointPath,
          extraHeaders: object(extraHeaders!, S.extraHeaders),
          extraBody: object(extraBody!, S.extraBody),
        };
        for (const [key, value] of Object.entries(edited)) {
          if (value === undefined || value === '') delete next[key];
          else next[key] = value;
        }
        return next;
      };
      function saveOptions(): void {
        try {
          void patch({ options: optionsPayload() });
        } catch (error) {
          report.textContent = String(error);
        }
      }

      // ---- 模块自有段落(llama.cpp 的运行时与模型) ----
      const slot = ui.h('div');
      body.append(slot);

      // ---- 模型档 ----
      const card = ui.sheet({ title: S.specTitle, desc: S.specDescription });
      let catalog: ModelEntry[] = [];
      const modelHolder = ui.h('div');
      const modelNote = ui.msgline();
      /** 目录取到了就给选单,取不到就自由输入:两种都写同一格 spec.model。 */
      function renderModelField(): void {
        const control = catalog.length
          ? ui.select({
              value: spec.model,
              options: [
                ...(catalog.some((item) => item.id === spec.model)
                  ? []
                  : [{ value: spec.model, label: spec.model || S.selectModel }]),
                ...catalog.map((item) => ({ value: item.id, label: item.id })),
              ],
              onChange: (value) => {
                spec.model = value;
                const known = catalog.find((item) => item.id === value)?.contextWindow;
                if (known !== undefined) spec.contextWindow = known;
                saveSpec();
                renderModelField();
              },
            })
          : ui.input({
              value: spec.model,
              placeholder: S.modelName,
              onChange: (value) => {
                spec.model = value;
                saveSpec();
              },
            });
        control.setAttribute('aria-label', S.modelAria);
        const row = ui.rowbar();
        const fetchModels = ui.button(S.fetchModels, {
          size: 'sm',
          onClick: () => void fetchCatalog(fetchModels),
        });
        row.append(control, fetchModels);
        modelHolder.replaceChildren(ui.field(S.modelFieldLabel, row));
      }
      /** 取目录:成功换成选单并带出上下文窗口,失败把原因留在模型格下面。 */
      async function fetchCatalog(...locked: ConsoleDisablable[]): Promise<void> {
        const release = ui.disable(...locked);
        try {
          const result = await ctx.invoke<{ models: ModelEntry[] }>('models', [{ name: selected }]);
          catalog = result.models;
          modelNote.textContent = S.modelsFetched(catalog.length);
          const known = catalog.find((item) => item.id === spec.model)?.contextWindow;
          if (known !== undefined && known !== spec.contextWindow) {
            spec.contextWindow = known;
            contextWindowInput.value = String(known);
            await patch({ spec });
          }
        } catch (error) {
          catalog = [];
          modelNote.textContent = S.modelListFailed(String(error));
        } finally {
          release.dispose();
        }
        if (!ctx.signal.aborted) renderModelField();
      }
      /** 地址或密钥改过就重取目录:换了端点,上一份模型表不作数。 */
      async function connectionChanged(fields: Record<string, unknown>): Promise<void> {
        if (!(await patch(fields))) return;
        catalog = [];
        await fetchCatalog();
      }

      // 推理强度与温度
      const effortSuggestions = datalist(ui, `${uid}-effort`, state.effortSuggestions ?? []);
      let effortControl: HTMLInputElement | HTMLSelectElement;
      if (open) {
        const effort = ui.input({
          value: effortOf(spec),
          placeholder: S.effortPlaceholder,
          onChange: (value) => {
            applyEffort(spec, value);
            saveSpec();
          },
        });
        effort.setAttribute('list', `${uid}-effort`);
        effort.setAttribute('aria-label', S.effortAria);
        effortControl = effort;
      } else {
        const hit = state.reasoningTiers.find(
          (tier) => tier.thinking === spec.thinking && tier.effort === spec.reasoningEffort,
        );
        const tiers = state.reasoningTiers.map((tier) => ({ value: tier.id, label: tier.label }));
        if (!hit)
          tiers.unshift({
            value: '__unsupported',
            label: S.unsupportedTier(
              spec.reasoningEffort ?? (spec.thinking ? S.thinkingOn : S.thinkingOff),
            ),
          });
        const tier = ui.select({
          value: hit?.id ?? '__unsupported',
          options: tiers,
          onChange: (value) => {
            const chosen = state.reasoningTiers.find((tier) => tier.id === value);
            if (!chosen) return;
            spec.thinking = chosen.thinking;
            if (chosen.effort) spec.reasoningEffort = chosen.effort;
            else delete spec.reasoningEffort;
            saveSpec();
          },
        });
        tier.setAttribute('aria-label', S.tierAria);
        effortControl = tier;
      }
      const temperature = ui.input({
        type: 'number',
        placeholder: S.temperaturePlaceholder,
        value: spec.temperature === undefined ? '' : String(spec.temperature),
        onChange: (value) => {
          if (value.trim() === '') delete spec.temperature;
          else spec.temperature = Number(value);
          saveSpec();
        },
      });
      temperature.min = '0';
      temperature.max = '2';
      temperature.step = '0.1';
      temperature.setAttribute('aria-label', S.temperatureAria);

      const controlRow = ui.rowbar();
      controlRow.append(
        ui.field(open ? S.effortFieldLabel : S.tierAria, effortControl),
        effortSuggestions,
        ui.field(S.temperatureFieldLabel, temperature),
      );

      // Token 与上下文限制
      const tokenRow = ui.rowbar();
      const numbers: Partial<Record<'maxTokens' | 'contextWindow', HTMLInputElement>> = {};
      for (const [key, label] of [
        ['maxTokens', S.maxTokens],
        ['contextWindow', S.contextWindow],
      ] as const) {
        const input = ui.input({
          type: 'number',
          placeholder: label,
          value: spec[key] === undefined ? '' : String(spec[key]),
          onChange: (value) => {
            if (value.trim() === '') delete spec[key];
            else spec[key] = Number(value);
            saveSpec();
          },
        });
        input.min = '1';
        input.step = '1';
        input.setAttribute('aria-label', label);
        numbers[key] = input;
        tokenRow.append(ui.field(label, input));
      }
      const contextWindowInput = numbers.contextWindow!;
      renderModelField();
      card.body.append(modelHolder, modelNote, controlRow, tokenRow);
      for (const note of new Set(state.reasoningTiers.map((tier) => tier.note).filter(Boolean)))
        card.body.append(ui.msgline(note!));
      if (state.temperatureNote) card.body.append(ui.msgline(state.temperatureNote));
      if (state.serviceTiers.length)
        card.body.append(
          ui.field(
            S.serviceTier,
            ui.select({
              value: entry.serviceTier ?? '',
              options: [
                { value: '', label: S.serverDefault },
                ...state.serviceTiers.map((tier) => ({ value: tier.id, label: tier.label })),
              ],
              onChange: (value) => void patch({ serviceTier: value }),
            }),
          ),
        );
      for (const tier of state.serviceTiers) if (tier.note) card.body.append(ui.msgline(tier.note));
      body.append(card.el);

      // ---- 报价 ----
      const prices = pricingEditor(
        ui,
        entry.pricing ?? [],
        current.quotes,
        (pricing) => void patch({ pricing }),
        ctx.language,
      );
      body.append(prices.el);

      // ---- 动作 ----
      const buttons = ui.rowbar();
      const probeBox = ui.h('div');
      const duplicateHolder = ui.h('div');
      duplicateHolder.hidden = true;
      const duplicateRow = ui.rowbar();
      duplicateHolder.append(duplicateRow);
      const duplicateName = ui.input({ placeholder: S.duplicateName });
      duplicateName.setAttribute('aria-label', S.duplicateName);
      duplicateRow.append(
        duplicateName,
        ui.button(S.duplicateConfirm, {
          size: 'sm',
          onClick: async () => {
            const as = duplicateName.value.trim();
            const before = selected;
            selected = as;
            if (!(await action('duplicate', [{ name: before, as }], S.duplicated))) selected = before;
          },
        }),
      );
      const probe = ui.button(S.probe, {
        onClick: async () => {
          const result = await query<ProbeResult>('probe', [{ name: selected }], probe);
          if (!result || ctx.signal.aborted) return;
          probeBox.replaceChildren(probeCard(ui, S, result));
        },
      });
      buttons.append(
        ui.button(S.activate, {
          variant: 'primary',
          onClick: () => void action('activate', [{ name: selected }]),
        }),
        probe,
        ui.button(S.duplicate, {
          onClick: () => {
            duplicateHolder.hidden = !duplicateHolder.hidden;
            if (!duplicateHolder.hidden) duplicateName.focus();
          },
        }),
        ui.button(S.delete, {
          variant: 'danger',
          onClick: async () => {
            const ok = await ui.confirm({
              title: S.deleteConfirmTitle(selected),
              body: S.deleteConfirmBody,
              danger: true,
            });
            if (ok) void action('delete', [{ name: selected }], S.deleted);
          },
        }),
      );
      body.append(buttons, duplicateHolder, probeBox);
      const mounted = await ctx.mountSlot(MODULE_SLOT, slot, { instance: selected });
      if (gen === generation) sections = mounted;
      else mounted.dispose();
    }
    await load();
  },
};
