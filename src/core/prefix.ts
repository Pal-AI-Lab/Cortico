/**
 * Assembles the main-session system prefix from Persona.systemSegments().
 * World environment text is rendered from templates and supplied to that hook.
 * Core joins the returned segments in order; their text remains opaque to Core.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderTemplate } from './template.ts';
import type {
  World,
  WorldPrefixContext,
  Persona,
  PrefixSegment,
  PromptDocDecl,
} from './types.ts';

export interface AssembleSystemDeps {
  persona: Persona;
  worlds: World[];
  now: Date;
  timezone: string;
  /** 找环境提示词覆盖的两个目录。缺席(测试、预建实例)= 只用 World 自带的模板。 */
  dirs?: EnvPromptDirs;
}

/**
 * World 环境模板按以下顺序覆盖，同名文件整份替换：
 * src/worlds/<id>/ENV_PROMPT.md → <代码包>/worlds/<id>/ENV_PROMPT.md
 * → <部署>/worlds/<id>/ENV_PROMPT.md。
 * 部署文件不进版本控制；WebUI 仅写入部署覆盖，删除后回退到代码包或 World 模板。
 */
export interface EnvPromptDirs {
  /** bot 代码包目录。 */
  packageDir?: string;
  /** 部署目录。 */
  deploymentDir?: string;
}

/** 某一层里这个 World 的覆盖文件路径:`<dir>/worlds/<Worldid>/ENV_PROMPT.md`。 */
export function envPromptOverridePath(dir: string, worldId: string): string {
  return join(dir, 'worlds', worldId, 'ENV_PROMPT.md');
}

/** World 环境提示词模板此刻读哪份文件。自后向前找第一份存在的。 */
export function envPromptTemplateSource(
  doc: PromptDocDecl,
  worldId: string,
  dirs: EnvPromptDirs | undefined,
): { path: string; origin: EnvPromptOrigin } {
  for (const [dir, origin] of [
    [dirs?.deploymentDir, 'deployment'],
    [dirs?.packageDir, 'package'],
  ] as const) {
    if (!dir) continue;
    const override = envPromptOverridePath(dir, worldId);
    if (existsSync(override)) return { path: override, origin };
  }
  return { path: doc.path, origin: 'module' };
}

export type EnvPromptOrigin = 'deployment' | 'package' | 'module';

/** 按 role=envPrompt 查找模板声明；未声明时不提供环境前缀。 */
export function envPromptDocOf(mod: World): PromptDocDecl | undefined {
  let decl;
  try {
    decl = mod.webUi?.();
  } catch {
    return undefined; // WebUI 声明异常时省略该 World 的模板。
  }
  return decl?.promptDocs?.find((doc) => doc.role === 'envPrompt');
}

/** 读取模板并代入 World 当前值；前缀组装与 WebUI 预览共用。 */
export async function renderWorldEnvPrompt(
  mod: World,
  dirs?: EnvPromptDirs,
): Promise<{ text: string; sourceKey?: string }> {
  // null 表示省略整段，不读取模板。
  const vars = await mod.envPromptVars();
  const doc = vars === null ? undefined : envPromptDocOf(mod);
  if (!doc) return { text: '' };
  const { path } = envPromptTemplateSource(doc, mod.id, dirs);
  const text = renderTemplate(readFileSync(path, 'utf8'), vars ?? {}).trim();
  // 空段不提供模板编辑来源。
  return text ? { text, sourceKey: doc.key } : { text: '' };
}

/** 环境模板提供 World 的前缀文本；工具 description 随工具定义发送。 */
export async function collectWorldContexts(
  worlds: World[],
  dirs?: EnvPromptDirs,
): Promise<WorldPrefixContext[]> {
  const sorted = [...worlds].sort((a, b) => a.id.localeCompare(b.id));
  return Promise.all(
    sorted.map(async (mod) => {
      const { text, sourceKey } = await renderWorldEnvPrompt(mod, dirs);
      return {
        id: mod.id,
        envPrompt: text,
        ...(sourceKey ? { sourceKey } : {}),
      };
    }),
  );
}

/** 供 WebUI 观察:前缀的分段视图(与实际发出的前缀同一来源) */
export async function assembleSystemSegments(deps: AssembleSystemDeps): Promise<PrefixSegment[]> {
  const { persona, worlds, now, timezone, dirs } = deps;
  return persona.systemSegments({
    now,
    timezone,
    worlds: await collectWorldContexts(worlds, dirs),
  });
}

/** 按顺序直接拼接各段，分隔符由 Persona 的段文本提供。 */
export async function assembleSystem(deps: AssembleSystemDeps): Promise<string> {
  const segments = await assembleSystemSegments(deps);
  return segments.map((segment) => segment.text).join('');
}
