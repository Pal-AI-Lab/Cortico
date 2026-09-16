import type { ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { hasRole } from 'cortico/protocol/open-responses/context-helpers.ts';
/**
 * 继承文件式工作区 Persona，增加 MEMORY 0–4、memo 写入容量检查、角色权限矩阵和后台整理。
 * 交接快照进入串行梦队列，结果经 MEMORY 3 与事件回到主 session。
 * 工作区改动按批次提交 Git；rhythm.ts 提供昼夜心跳和 schedule_wake。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CoreApi, World, MemoryAssemblyContext, PersonaConsoleDecl,
  SessionDecl, SystemPrefixContext, ToolDef, ToolSpec, ContextHandoffResult,
} from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import type { BotConfig } from '../index.ts';
import { hourIn } from 'cortico/core/util.ts';
import { renderTemplate } from 'cortico/core/template.ts';
import { Cormini, MAIN, type CorminiOptions } from '../../cormini/persona/persona.ts';
import { WorkspaceError, normalizeWorkspacePath } from '../../cormini/persona/memory.ts';
import { AUTHOR_SELF, type WorkspaceGit } from '../../cormini/persona/workspaceGit.ts';
import { MemoTiers } from './memoTiers.ts';
import { personaConsoleDecl } from './consoleSurface.ts';
import { memoryVars } from './memory.ts';
import { memoCapGuard, moveFileTool, scheduleWakeSpec, toolUsageText } from './tools.ts';
import { asPersonaRole, checkAccess } from './permissions.ts';
import { WakeManager, tickTimeText } from './rhythm.ts';
import { DREAM, Dream } from './subconscious/index.ts';

export { MAIN };

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** MEMORY 3 反射层最多保留几缕浮现 */
const EMERGENCE_KEEP = 3;

/** CORE.md 是包内只读机制文档；readOverride 提供读取，writeGuard 拒绝写入。 */
const CORE_NAME = 'core.md';

export const WORKSPACE_DIRS = [
  '', 'note', 'note/playbook', 'note/library',
  'people', 'memo', 'memo/active', 'memo/archived',
] as const;

/** 仅供控制台显示的段名，不写入前缀。 */
const SEGMENT_TITLES: Record<string, string> = {
  'persona.orientation': 'ORIENTATION',
  'persona.constitution': '宪法',
  'persona.toolUsage': 'Using your tools',
  'memory.all': '记忆',
};

/** 段 → 可编辑源的 key。没列的段(工具用法)是代码拼的,控制台标只读。 */
const SEGMENT_SOURCES: Record<string, string> = {
  'persona.orientation': 'orientation',
  'persona.constitution': 'constitution',
  'memory.all': 'persona.memory',
};

export interface CortiSoulmateOptions {
  memoryDir: string;
  /** 热配置；轮数、memo 容量与上下文预算在使用时读取。 */
  cfg: BotConfig;
  /** 已挂载的 World(挂载表活引用) */
  worlds?: World[];
  /** 首轮对话三份源文件的目录(这份部署的 `prompts/`);不给 = 没有首轮对话。 */
  firstTurnDir?: string;
  /**
   * 部署侧的人格文本覆盖目录(这份部署的 `prompts/`)。ORIENTATION / PREFIX / ENV_SECTION /
   * MEMORY / CORE 五份,同名文件存在即整份替换包内默认;控制台保存只写这里。
   */
  promptsDir?: string;
}

/** 机制说明那份虚拟文件的名字判定(大小写不敏感)。 */
function isHarnessPath(relPath: string): boolean {
  return normalizeWorkspacePath(relPath).toLowerCase() === CORE_NAME;
}

/** 昼夜作息:深夜按固定间隔(或不心跳),白天在区间内取随机。 */
function tickDelayMs(cfg: BotConfig, now: Date): number | null {
  const t = cfg.tick;
  const h = hourIn(cfg.timezone, now);
  const night = t.nightStartHour <= t.nightEndHour
    ? h >= t.nightStartHour && h < t.nightEndHour
    : h >= t.nightStartHour || h < t.nightEndHour;
  if (night) return t.nightIntervalMinutes === null ? null : t.nightIntervalMinutes * 60_000;
  const [min, max] = t.dayIntervalMinutes;
  return Math.round((min + Math.random() * Math.max(0, max - min)) * 60_000);
}

export class CortiSoulmate extends Cormini {
  private readonly memo: MemoTiers;
  private readonly cfg: BotConfig;
  private readonly promptsDir: string | null;
  private dreamer: Dream | null = null;
  private wakes: WakeManager | null = null;

  constructor(opts: CortiSoulmateOptions) {
    const { cfg } = opts;
    const base: CorminiOptions = {
      memoryDir: opts.memoryDir,
      context: () => cfg.context,
      // getter 在每次使用时读取热配置。
      rounds: { get soft() { return cfg.loop.softCap; }, get hard() { return cfg.loop.hardCap; } },
      seedConstitution: '(宪法尚未写入)\n',
      worlds: opts.worlds,
      orientationFile: join(MODULE_DIR, 'ORIENTATION.md'),
      ...(opts.promptsDir ? { orientationOverrideFile: join(opts.promptsDir, 'ORIENTATION.md') } : {}),
      ...(opts.firstTurnDir ? { firstTurnDir: opts.firstTurnDir } : {}),
      tickDelayMs: (now) => tickDelayMs(cfg, now),
      blobsDir: 'external/qq/images/',
    };
    super(base);
    this.cfg = cfg;
    this.promptsDir = opts.promptsDir ?? null;
    this.memory.ensureDirs(WORKSPACE_DIRS);
    // 保留 cfg.memo 的活引用以读取热配置。
    this.memo = new MemoTiers(this.memory, this.cfg.memo);
  }

  /** Persona 的工作区 Git 版本管理。 */
  get git(): WorkspaceGit {
    return this.memory.git;
  }

  /** 启动时初始化 persona git 并创建 checkpoint0。历史设施初始化失败不阻止Persona运行。 */
  initGit(log?: { info(msg: string): void; warn(msg: string, data?: unknown): void }): void {
    try {
      if (this.git.init().created) log?.info('persona/ 已建 git 仓并打 checkpoint0(当前干净态)');
    } catch (e) {
      log?.warn('persona git 初始化失败(不影响运行)', { err: String(e) });
    }
  }

  override attach(core: CoreApi): void {
    super.attach(core);
    this.wakes = new WakeManager(core, () => this.cfg.timezone);
    this.dreamer = new Dream({
      cfg: this.cfg,
      core,
      dreamTools: () => this.dreamTools(),
      toolUsageText: () => this.toolUsageText(DREAM),
      log: core.log.child('dream'),
      onEmergence: (text) => this.recordEmergence(text),
    });
  }

  /** 已接线的梦(控制台的强制入梦、状态仪表用) */
  get dream(): Dream {
    if (!this.dreamer) throw new Error('Persona尚未 attach 到 core');
    return this.dreamer;
  }

  private api(): CoreApi {
    if (!this.core) throw new Error('Persona尚未 attach 到 core');
    return this.core;
  }

  // ---------------------------------------------------------------------------
  // session 声明与工具
  // ---------------------------------------------------------------------------

  /** 主 session 继承 Cormini 的(文件工具 + World 工具 + end_turn + 闹钟);梦是第二个声明。 */
  override declareSessions(): SessionDecl[] {
    const cfg = this.cfg;
    return [
      ...super.declareSessions(),
      {
        id: DREAM,
        label: '梦(交接后整理)',
        rounds: () => ({ soft: Math.max(1, cfg.dream.maxRounds - 1), hard: cfg.dream.maxRounds }),
        persistent: false,
        receivesEvents: false,
        tools: () => this.dreamTools(),
      },
    ];
  }

  protected override mainTailTools(): ToolDef[] {
    return [...super.mainTailTools(), this.scheduleWakeTool()];
  }

  /** 文件工具之上加 move_file(memo 三级之间搬运;people/ 改名归梦)。 */
  protected override tools(): ToolDef[] {
    return [
      ...super.tools(),
      moveFileTool({
        ws: this.memory,
        guard: (op, path, role) => this.writeGuard(op, path, role),
        capGuard: (to, from) => memoCapGuard(this.memory, this.memo, to, from),
      }),
    ];
  }

  /** 梦的工具面:文件工具 + 只读的 World 工具(翻历史、看图取证)。 */
  private dreamTools(): ToolDef[] {
    return [...this.tools(), ...this.ioTools('read')];
  }

  private scheduleWakeTool(): ToolDef {
    return {
      ...scheduleWakeSpec(),
      handler: async (args) => {
        if (!this.wakes) return '[tool failed] Persona not attached';
        return this.wakes.schedule(args);
      },
    };
  }

  /** 供控制台工具编辑器列 schema:主 session 之外还有梦那一面。 */
  primitiveToolSpecs(): ToolSpec[] {
    return [scheduleWakeSpec()];
  }

  // ---------------------------------------------------------------------------
  // 写纪律
  // ---------------------------------------------------------------------------

  /** 写入需通过角色权限、memo 容量和 CORE.md 只读检查；拒绝原因返回给 agent。 */
  protected override writeGuard(op: 'write' | 'append' | 'rename' | 'delete', path: string, role: string): string | null {
    const rel = normalizeWorkspacePath(path);
    if (isHarnessPath(rel)) return 'CORE.md is a system mechanics doc; read-only.';
    const res = checkAccess(asPersonaRole(role), op, rel);
    if (!res.ok) return res.reason;
    if (op === 'write' || op === 'append') return memoCapGuard(this.memory, this.memo, rel);
    return null;
  }

  /** CORE.md 随软件走,不在工作区里;read_file 照样读得到。 */
  protected override readOverride(path: string): string | null {
    if (!isHarnessPath(path)) return null;
    const file = this.textFile('CORE.md');
    if (!existsSync(file)) throw new WorkspaceError('CORE.md 暂不可用(软件包内未找到该文件)');
    return readFileSync(file, 'utf8');
  }

  /** 读取部署 prompts/ 同名覆盖文件；不存在时读取包内默认文件。 */
  textFile(name: string): string {
    const override = this.promptsDir ? join(this.promptsDir, name) : null;
    return override && existsSync(override) ? override : join(MODULE_DIR, name);
  }

  /** 控制台保存人格文本落到哪:部署 `prompts/`;没给部署目录就写包内那份。 */
  textWritePath(name: string): string {
    return this.promptsDir ? join(this.promptsDir, name) : join(MODULE_DIR, name);
  }

  // ---------------------------------------------------------------------------
  // 前缀
  // ---------------------------------------------------------------------------

  protected override templateFile(name: string): string {
    return this.textFile(name);
  }

  protected override prefixVars(ctx: SystemPrefixContext): Record<string, string> {
    return {
      'persona.orientation': this.orientationText().trim(),
      'persona.constitution': this.constitutionText().trim(),
      'persona.toolUsage': this.toolUsageText(MAIN).trim(),
      'memory.all': this.assembleMemory({ now: ctx.now, timezone: ctx.timezone }),
    };
  }

  protected override segmentTitles(): Record<string, string> {
    return SEGMENT_TITLES;
  }

  protected override segmentSources(): Record<string, string> {
    return SEGMENT_SOURCES;
  }

  orientationText(): string {
    return readFileSync(this.orientationSource(), 'utf8');
  }

  constitutionText(): string {
    return readFileSync(join(this.memoryDir, 'CONSTITUTION.md'), 'utf8');
  }

  toolUsageText(sessionId: string): string {
    return toolUsageText(asPersonaRole(sessionId), {
      residentCap: this.cfg.memo.residentCap,
      activeCap: this.cfg.memo.activeCap,
    });
  }

  /** 各模板占位符此刻的值(纯展示,控制台的旁注用)。`worlds.*` 那几个由各 World 自报。 */
  override promptVarValues(ctx: { now: Date; timezone: string }): Record<string, string> {
    return {
      ...this.prefixVars({ ...ctx, worlds: [] }),
      ...memoryVars(this.memory, this.memo, ctx, this.emergences()),
    };
  }

  /** MEMORY 0~4:模板 + 活数据。五层的引导语与空态措辞全在 MEMORY.md 里。 */
  assembleMemory(ctx: MemoryAssemblyContext): string {
    return renderTemplate(
      readFileSync(this.textFile('MEMORY.md'), 'utf8'),
      memoryVars(this.memory, this.memo, ctx, this.emergences()),
    ).trim();
  }

  // ---------------------------------------------------------------------------
  // 时机
  // ---------------------------------------------------------------------------

  /** 心跳提供日期和时间；普通消息时间行不含日期。 */
  protected override tickText(quietSeconds: number): string {
    return `[system/tick] Time is ${tickTimeText(this.cfg.timezone, new Date())}. `
      + `About ${Math.round(quietSeconds / 60)} min since the last messages.`;
  }

  /** 交接照 Cormini(空尾 + 交接笔记);交接前的快照另排进并行梦。 */
  override async onHandoff(snapshot: ContextRecord[], ctx: { hardTokens: number | null }): Promise<ContextHandoffResult> {
    if (snapshot.some((m) => !hasRole(m, 'system'))) this.dream.schedule(snapshot);
    return super.onHandoff(snapshot, ctx);
  }

  protected override handoffNoteLines(): string[] {
    const lines = super.handoffNoteLines();
    const at = lines.findIndex((l) => l.startsWith('对外交流的工具不要输出空内容'));
    lines.splice(at, 0, '后台正在入梦整理工作区(people/、memo/、WORLDVIEW.md);有值得说的会以 [surfaced from dream] 送来。');
    return lines;
  }

  /** 每批空闲时提交 persona 改动;梦的改动包含在同一次提交中。提交失败不影响主循环。 */
  onIdle(): void {
    try {
      this.git.commitAll('本轮记忆改动', AUTHOR_SELF);
    } catch {
      /* 提交失败不影响主循环 */
    }
  }

  // ---------------------------------------------------------------------------
  // MEMORY 3 反射
  // ---------------------------------------------------------------------------

  emergences(): string[] {
    if (!this.core) return [];
    const raw = this.core.personaState().emergences;
    return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : [];
  }

  private recordEmergence(text: string): void {
    const tagged = `[surfaced from dream] ${text}`;
    const state = this.api().personaState();
    state.emergences = [...this.emergences(), tagged].slice(-EMERGENCE_KEEP);
    this.api().savePersonaState();
    this.api().injectInternal(tagged, 'emergence');
  }

  // ---------------------------------------------------------------------------
  // 控制台
  // ---------------------------------------------------------------------------

  /** 工作区、Memory 分层、版本历史三块归 Memory 页,模板归 Persona 页;部署级控制在 console-page.ts。工作区排除在统一清除清单外。 */
  override console(language: Language = 'zh'): PersonaConsoleDecl {
    const { panels, ...decl } = personaConsoleDecl({
      memory: this.memory,
      memo: this.memo,
      emergences: () => this.emergences(),
      firstTurnDocs: this.firstTurnDocs(language),
      texts: { path: (name) => this.textFile(name), writePath: (name) => this.textWritePath(name) },
    }, language);
    return { ...decl, memory: { panels } };
  }
}
