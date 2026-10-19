/**
 * 从扩展的默认导出生成 describe.json 的内容,并核对包里那份与它一致;`pnpm describe:extension` 与
 * `pnpm check:extension` 共用。World 与 bot 在 `dry-mount.ts` 的假部署里构造,读 `webUi('zh')` 声明的
 * 提示词模板原文;provider 只读模块字段。不调用 `start()`。报告只有英文。
 */
import { existsSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { CoreConfig, PromptDocDecl, ToolSchema } from '../core/types.ts';
import type { BotDefinition } from '../bot.ts';
import type { WorldDefinition, WorldSection } from '../world.ts';
import type { ProviderModule } from '../providers/base.ts';
import { extensionPackageFile } from '../extensions.ts';
import type { ExtensionKind } from './manifest.ts';
import type { ExtensionDescribeFile, PromptDescribe } from './describe.ts';
import { fakeLoadedConfig, fakeWorldContext, type BotDryMountOptions, type DryMountReport } from './dry-mount.ts';

/** `cortico.describe` 缺省时的包内路径。 */
export const DEFAULT_DESCRIBE_FILE = 'describe.json';

interface Exported {
  file: ExtensionDescribeFile;
  /** 构造出的实例实际给出的工具名;provider 与没有 `ownToolNames()` 的 Persona 为 null。 */
  toolNames: string[] | null;
  /** World 实例在默认配置下发给模型的工具定义;其他类别缺席。 */
  liveTools?: ToolSchema[];
}

/** 模板文件不存在的项跳过。 */
function promptsOf(docs: readonly PromptDocDecl[]): PromptDescribe[] {
  const seen = new Set<string>();
  const prompts: PromptDescribe[] = [];
  for (const doc of docs) {
    if (seen.has(doc.key) || !existsSync(doc.path)) continue;
    seen.add(doc.key);
    prompts.push({ key: doc.key, title: doc.title, ...(doc.role ? { role: doc.role } : {}), content: readFileSync(doc.path, 'utf8') });
  }
  return prompts;
}

const withPrompts = (file: ExtensionDescribeFile, prompts: PromptDescribe[]): ExtensionDescribeFile =>
  (prompts.length ? { ...file, prompts } : file);

/** 定义没写 describe 时为 null;构造抛错原样抛出。 */
async function exportFrom(kind: ExtensionKind, exported: unknown, opts: BotDryMountOptions): Promise<Exported | null> {
  if (kind === 'world') {
    const def = exported as WorldDefinition<WorldSection>;
    if (!def.describe) return null;
    const world = def.create(fakeWorldContext(def, opts));
    const docs = (world.webUi?.('zh')?.promptDocs ?? []).filter((doc) => doc.role === 'envPrompt');
    const liveTools = world.tools().map(({ name, description, parameters }) => ({ name, description, parameters }));
    return {
      file: withPrompts({ tools: [...def.describe.tools], events: [...def.describe.events] }, promptsOf(docs)),
      toolNames: liveTools.map((tool) => tool.name),
      liveTools,
    };
  }
  if (kind === 'provider') {
    const mod = exported as ProviderModule;
    if (!mod.describe) return null;
    return {
      file: {
        provider: {
          ...mod.describe,
          title: mod.title,
          ...(mod.description ? { description: mod.description } : {}),
          ...(mod.reasoningTiers.length ? { reasoningTiers: [...mod.reasoningTiers] } : {}),
          ...(mod.serviceTiers.length ? { serviceTiers: [...mod.serviceTiers] } : {}),
        },
      },
      toolNames: null,
    };
  }
  const def = exported as BotDefinition<CoreConfig>;
  if (!def.describe) return null;
  const config = def.defaults();
  (config as { worlds?: unknown }).worlds ??= {};
  const parts = def.build(fakeLoadedConfig(config, opts), []);
  const decl = parts.persona.webUi?.('zh');
  const docs = [...(parts.webUi?.promptDocs ?? []), ...(decl?.promptDocs ?? []), ...(decl?.memory?.promptDocs ?? [])];
  return {
    file: withPrompts({
      tools: [...def.describe.tools],
      bot: {
        worlds: (def.declares ?? []).map((decl) => (typeof decl === 'string' ? decl : decl.id)),
        memory: { name: def.memoryName ?? 'Memory', form: def.describe.memory.form },
      },
    }, promptsOf(docs)),
    toolNames: parts.persona.ownToolNames?.() ?? null,
  };
}

/** describe.json 应有的内容(经过一次 JSON 往返,与读回的文件可直接比较);定义没写 describe 时为 null。 */
export async function exportDescribe(kind: ExtensionKind, exported: unknown, opts: BotDryMountOptions): Promise<ExtensionDescribeFile | null> {
  const result = await exportFrom(kind, exported, opts);
  return result ? (JSON.parse(JSON.stringify(result.file)) as ExtensionDescribeFile) : null;
}

/** 定义没写 describe 时给作者的说明。 */
export const MISSING_DESCRIBE: Readonly<Record<ExtensionKind, string>> = {
  world: 'The World definition has no describe. Add describe: { tools, events } to it: every tool tools() can return (name, description, parameters, tags, optional summary) and every event type the World pushes (type, description, optional trigger and tags).',
  provider: 'The provider module has no describe. Add describe: { protocols, auth, local, input } to it: the wire protocols it speaks, its sign-in methods (api-key / oauth / device-code / web-session), whether the model runs on this machine, and the input kinds it accepts (text / image / audio / video).',
  bot: 'The bot definition has no describe. Add describe: { tools, memory: { form } } to it: every tool the Persona provides, written like World tools, and one sentence on the form Memory takes. Set memoryName too; describe.json uses it as the Memory name.',
};

/**
 * check:extension 的自描述检查:定义要有 describe,实例的工具名都在声明里,`cortico.describe` 指的文件
 * 存在且与重新生成的内容一致。
 */
export async function checkDescribe(
  kind: ExtensionKind,
  exported: unknown,
  describePath: string | undefined,
  opts: BotDryMountOptions,
): Promise<DryMountReport> {
  const report: DryMountReport = { ok: [], warnings: [], failures: [] };
  const { ok, warnings, failures } = report;
  const rerun = `Run pnpm describe:extension ${opts.packageDir} and publish the result with the package.`;

  let result: Exported | null;
  try {
    result = await exportFrom(kind, exported, opts);
  } catch (error) {
    failures.push(`Generating the self-description threw: ${error instanceof Error ? error.message : String(error)}`);
    return report;
  }
  if (!result) {
    failures.push(`${MISSING_DESCRIBE[kind]} Then run pnpm describe:extension ${opts.packageDir}.`);
    return report;
  }

  const declared = new Set((result.file.tools ?? []).map((tool) => tool.name));
  if (result.toolNames) {
    const extra = result.toolNames.filter((name) => !declared.has(name));
    const source = kind === 'world' ? 'tools()' : 'persona.ownToolNames()';
    if (extra.length) failures.push(`${source} returns tools missing from describe.tools: ${extra.join(', ')}. Declare them; an instance may change a tool's description and parameters, not its name.`);
    else ok.push(`${source}: every tool is declared in describe.tools.`);
  } else if (kind === 'bot') {
    warnings.push('The Persona has no ownToolNames(), so its tools cannot be compared with describe.tools.');
  }
  if (result.liveTools) {
    const byName = new Map((result.file.tools ?? []).map((tool) => [tool.name, tool]));
    const changed = result.liveTools.flatMap((tool) => {
      const decl = byName.get(tool.name);
      if (!decl) return [];
      const fields = [
        ...(decl.description === tool.description ? [] : ['description']),
        ...(isDeepStrictEqual(decl.parameters, tool.parameters) ? [] : ['parameters']),
      ];
      return fields.length ? [`${tool.name} (${fields.join(', ')})`] : [];
    });
    if (changed.length) warnings.push(`With the default config, tools() returns a description or parameters that differ from describe.tools: ${changed.join(', ')}. The extension market shows the declared tools and their token count. Update the declaration if it is stale; leave it if the difference comes from config.`);
    else ok.push('tools(): descriptions and parameters match describe.tools under the default config.');
  }

  if (describePath === undefined) {
    failures.push(`package.json has no cortico.describe. ${rerun} It writes ${DEFAULT_DESCRIBE_FILE} and adds "describe": "${DEFAULT_DESCRIBE_FILE}" to the cortico block.`);
    return report;
  }
  const file = extensionPackageFile(opts.packageDir, describePath);
  if (!file) {
    failures.push(`cortico.describe points to ${describePath}, which is not in the package. ${rerun}`);
    return report;
  }
  let written: unknown;
  try {
    written = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    failures.push(`${describePath} is not valid JSON (${error instanceof Error ? error.message : String(error)}). ${rerun}`);
    return report;
  }
  if (!isDeepStrictEqual(written, JSON.parse(JSON.stringify(result.file)))) {
    failures.push(`${describePath} differs from the self-description in the code. ${rerun}`);
    return report;
  }
  ok.push(`${describePath} matches the self-description in the code.`);
  return report;
}
