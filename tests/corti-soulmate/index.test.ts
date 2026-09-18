import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import definition from '../../bots/corti-soulmate/index.ts';
import { loadDeployment } from '../../src/deploy.ts';
import { mergePersonaContributions, personaPageContribution } from '../../src/bot.ts';

it('部署侧面板挂在 Persona 那一页上:两边的 page id 同一个', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-console-identity-'));
  try {
    const parts = definition.build(loadDeployment(definition, dir), []);
    const pages = parts.console!.consolePages!({ storage: [], language: 'zh' });
    const own = personaPageContribution(definition.id, 'Persona', parts.persona)!;
    expect(pages.map((page) => page.id)).toEqual([own.id]);
    const merged = mergePersonaContributions(own.id, own.label, own, pages);
    expect(merged?.panels?.map((panel) => panel.id)).toEqual(expect.arrayContaining(['checkpoints', 'reset', 'dream']));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
