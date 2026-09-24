/**
 * Reasoning section of one endpoint: the replay form, written on change, and the probe that
 * determines it. The endpoint comes from `ctx.scope.instance`.
 */
import type { ConsolePanel, ConsolePanelContext } from '../../../web/shared/client-panel.ts';
import { configField } from '../../../web/client/features/config/view.ts';
import type { DetectResult, ProbeOutcome, ReasoningPanelState } from './server.ts';
import { panel } from '../strings.ts';

export const reasoningPanel: ConsolePanel = {
  mount: async (ctx: ConsolePanelContext) => {
    const { ui, root } = ctx;
    const S = ctx.language === 'en' ? panel.en : panel.zh;
    const name = ctx.scope.instance;
    const path = `providers.${name}.options.reasoningReplay`;
    const textPath = `providers.${name}.options.syntheticReasoningText`;
    const labels: Record<string, string> = { encrypted: S.encrypted, plaintext: S.plaintext };
    const card = ui.sheet({ title: S.title });
    const message = ui.msgline();
    root.append(card.el, message);

    const outcome = (probe: ProbeOutcome | undefined): string =>
      !probe ? S.skipped : probe.ok ? S.accepted : S.rejected(probe.status, probe.error);
    const describe = (result: DetectResult): string =>
      `${S.outcome(outcome(result.bare), outcome(result.withReasoning))}。${result.verdict ? S.applied(labels[result.verdict]) : S.undetermined}`;

    async function save(groupId: string, key: string, value: string): Promise<void> {
      message.classList.remove('bad');
      try {
        await ctx.setConfig(groupId, { [key]: value });
        message.textContent = S.saved;
      } catch (error) {
        message.textContent = String(error);
        message.classList.add('bad');
      }
    }

    async function detect(button: HTMLButtonElement): Promise<void> {
      const release = ui.disable(button);
      message.textContent = S.detecting;
      message.classList.remove('bad');
      try {
        const result = await ctx.invoke<DetectResult>('detect', [{ name }]);
        message.textContent = describe(result);
        message.classList.toggle('bad', !result.verdict);
      } catch (error) {
        message.textContent = String(error);
        message.classList.add('bad');
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
        root.append(message);
        message.textContent = String(error);
        message.classList.add('bad');
        return;
      }
      if (ctx.signal.aborted) return;
      const { group, values } = state.config[0];
      const property = group.schema.properties[path];
      const current = values[path];
      const select = ui.select({
        value: typeof current === 'string' && current ? current : 'encrypted',
        options: Object.entries(labels).map(([value, label]) => ({ value, label })),
        onChange: (value) => void save(group.id, path, value),
      });
      select.setAttribute('aria-label', property.title);
      const button = ui.button(S.detect, { onClick: () => void detect(button) });
      const row = ui.rowbar();
      row.append(select, button, message);
      card.body.replaceChildren(ui.field(property.title, row));
      if (property.description) card.body.append(ui.msgline(property.description));

      const textProperty = group.schema.properties[textPath];
      const text = configField(ui, textProperty, values[textPath], () => {
        if (text.read) void save(group.id, textPath, String(text.read()).trim());
      }, ctx.signal);
      text.node.setAttribute('aria-label', textProperty.title);
      card.body.append(ui.field(textProperty.title, text.node));
      if (textProperty.description) card.body.append(ui.msgline(textProperty.description));
    }

    await load();
  },
};
