/**
 * Reasoning section of one endpoint: the replay form, written on change, and the probe that
 * determines it. The endpoint comes from `ctx.scope.instance`.
 */
import type { ConsolePanel, ConsolePanelContext } from '../../../web/shared/client-panel.ts';
import type { DetectResult, ProbeOutcome, ReasoningPanelState } from './server.ts';
import { panel } from '../strings.ts';

export const reasoningPanel: ConsolePanel = {
  mount: async (ctx: ConsolePanelContext) => {
    const { ui, root } = ctx;
    const S = ctx.language === 'en' ? panel.en : panel.zh;
    const name = ctx.scope.instance;
    const path = `providers.${name}.options.reasoningReplay`;
    const labels: Record<string, string> = { encrypted: S.encrypted, plaintext: S.plaintext };
    const card = ui.sheet({ title: S.title });
    const message = ui.msgline();
    root.append(card.el, message);

    const outcome = (probe: ProbeOutcome | undefined): string =>
      !probe ? S.skipped : probe.ok ? S.accepted : S.rejected(probe.status, probe.error);
    const describe = (result: DetectResult): string =>
      `${S.outcome(outcome(result.bare), outcome(result.withReasoning))}。${result.verdict ? S.applied(labels[result.verdict]) : S.undetermined}`;

    async function save(groupId: string, value: string): Promise<void> {
      try {
        await ctx.setConfig(groupId, { [path]: value });
        message.textContent = S.saved;
      } catch (error) {
        message.textContent = String(error);
      }
    }

    async function detect(button: HTMLButtonElement): Promise<void> {
      const release = ui.disable(button);
      message.textContent = S.detecting;
      try {
        message.textContent = describe(await ctx.invoke<DetectResult>('detect', [{ name }]));
      } catch (error) {
        message.textContent = String(error);
      } finally {
        release.dispose();
      }
      await load();
    }

    async function load(): Promise<void> {
      let state: ReasoningPanelState;
      try {
        state = await ctx.invoke<ReasoningPanelState>('state', [{ name }]);
      } catch (error) {
        message.textContent = String(error);
        return;
      }
      if (ctx.signal.aborted) return;
      const { group, values } = state.config[0];
      const property = group.schema.properties[path];
      const current = values[path];
      const select = ui.select({
        value: typeof current === 'string' && current ? current : 'encrypted',
        options: Object.entries(labels).map(([value, label]) => ({ value, label })),
        onChange: (value) => void save(group.id, value),
      });
      select.setAttribute('aria-label', property.title);
      const button = ui.button(S.detect, { onClick: () => void detect(button) });
      const row = ui.rowbar();
      row.append(select, button);
      card.body.replaceChildren(ui.field(property.title, row));
      if (property.description) card.body.append(ui.msgline(property.description));
    }

    await load();
  },
};
