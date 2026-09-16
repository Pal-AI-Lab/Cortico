import { GenerationError } from 'cortico/core/generation.ts';
import { message, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { hasRole, textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
/**
 * CortiV(可缇Corti)——AI VTuber 实时系统的Persona。
 *
 * 继承 Cormini(可缇mini)的最小骨架(平铺工作区/文件三件套/四时机钩子),
 * 把直播场景的 memory 系统**内建为类行为**(不走构造开关):
 *  - 观众档案 `viewers/<来源>/<数字ID>.md`:首行=一句话摘要,senderKey 在当前
 *    上下文窗口首次出现时在投递刻机械唤起(注入收编同批,原子到达);同一句摘要
 *    一个窗口只说一次,交接清空上文后再出现重念,热重启不重念;脱敏期(无 senderKey)
 *    整条静默降级。没档案且互动过门槛的,每个交接窗口报一次 id(至多三个窗口)
 *    ——senderKey 不进归一化正文,这是梦拿到立档主键的唯一通路。
 *  - 主动取档 `recall_viewer`:按 id 交回整份档案;按名字对本场见过的人与档案首行。
 *    唤起只带首行、弹幕正文不带 id,这是她拿到整份印象的路。
 *  - 前缀卫生:前缀树里 viewers/ 折叠为计数(handoffs/ 的折叠与交接笔记本身在 Cormini);list_files 指定目录时全量。
 *  - 笔记写入后尝试提交工作区 Git 历史；提交失败时文件写入仍保留。
 *    `git_log`/`git_show` 让她自己读得到这份历史,覆写缩水时回执点名丢的小节。
 *  - 并行梦:交接立即返回(直播不断流),交接前完整快照头部优先渲染交后台
 *    dream fork 整理(档案合并/场次蒸馏);单实例排队,同档模型;浮现非 (nothing)
 *    才注入打扰她。
 *  - 认知外包受理(cognition):World 请托她在后台想一件事(如设计一份蓝图)。
 *    保留前缀的 fork(继承主 session 出线态快照)+ 一条说明来源的任务框架消息;
 *    工具面 = World 点名的那几把 + 她自己的工作区文件工具;单实例、15 分钟封顶。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {

  CognitionContext,
  CognitionRequest,
  CognitionResult,
  ContextHandoffResult,
  EventEnvelope,
  PersonaCognition,
  PersonaConsoleDecl,
  PrefixSegment,
  SessionDecl,
  SessionOpeningReason,
  ToolDef,
} from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { estimateTokens, withDeadline } from 'cortico/core/util.ts';
import { Cormini, HANDOFF_DIR, MAIN, type CorminiOptions } from '../../cormini/persona/persona.ts';
import { AUTHOR_SELF, type WorkspaceGit } from '../../cormini/persona/workspaceGit.ts';
import { personaConsoleDecl } from './consoleSurface.ts';
import { VIEWERS_DIR, VIEWER_MEMORY_NOTE_FILE, viewerMemoryNote } from './viewers.ts';

export { HANDOFF_DIR, VIEWERS_DIR, VIEWER_MEMORY_NOTE_FILE, viewerMemoryNote };

/** 梦 session 声明 id(交接后并行整理) */
const DREAM = 'dream';
/**
 * 梦整理的最大轮数；完成整理后可提前结束。
 */
const DREAM_ROUNDS = 20;
/** 梦整理失败后的退避;只重试一次(见 dreamWithRetry) */
const DREAM_RETRY_MS = 30_000;
/** 认知外包受理 session 声明 id(World 请托的后台构思) */
export const COGNITION = 'cognition';
/**
 * 后台构思的轮数预算：硬上限 8 轮，软上限 6 轮。
 */
const COGNITION_ROUNDS = { soft: 6, hard: 8 };
/** 整体超时预算为 15 分钟；工具循环与请求超时使用同一截止时刻。 */
const COGNITION_TIMEOUT_MS = 15 * 60_000;
/**
 * 后台构思成品在她工作区里的落脚处。蓝图设计没有世界性(跨存档通用),
 * 所以留在 `minecraft/` 全局,不进 `worlds/<存档名>/`。与 MEMORY_NOTE 同一句约定。
 */
export const BLUEPRINT_DIR = 'minecraft/蓝图/';
/** 交接快照渲染给梦的字符预算(头部优先;主会话的笔记优先保留近期记录) */
const DREAM_TRANSCRIPT_MAX_CHARS = 120_000;
/** 报 id 立档的互动门槛:低于这个数的按路过处理,不占一个文件 */
const ENROLL_MIN_HITS = 3;
/** 限流批的观众档案唤起上限，约占近期绝对峰值外加容量的一半。 */
const LIMITED_VIEWER_RECALL_TOKENS = 2445;
/** 同一个人最多替他报几个交接窗口的 id(见 enrollWindows) */
const ENROLL_NUDGE_WINDOWS = 3;
/** recall_viewer 按名字多命中时列出的条数上限 */
const RECALL_LIST_MAX = 12;
/** 摘要指纹跨热重启保存；全新 session 开场时清空。 */
const VIEWER_RECALL_STATE_KEY = 'cortiv.viewerRecallDigests';

/** `git_log` 一次交回的提交条数上限 */
const GIT_LOG_LIMIT = 20;
/** `git_show` 一次交回的正文上限;超出截断并明说 */
const GIT_SHOW_MAX_CHARS = 20_000;
/** 缩水提示的触发线:新正文短于上一版的这个比例 */
const SHRINK_RATIO = 0.5;
/** 上一版短于这个长度就不提示——小文件改几行就过半,提示会变成噪音 */
const SHRINK_MIN_CHARS = 200;
/**
 * 同一文件累计覆写达到此次数后，在回执中报告频次；不附加评价或建议。
 */
const WRITE_TALLY_MIN = 3;
/** 频次里"最近一小时"那个数的窗口 */
const WRITE_TALLY_WINDOW_MS = 60 * 60_000;

/** senderKey/来源转文件名段:路径逃逸交给 memory.insideWorkspace 拦,这里只挡非法文件名字符 */
function fileSeg(raw: string): string {
  return raw.replace(/[\\/:*?"<>|\s]/g, '_');
}

function isAudienceLimited(event: EventEnvelope): boolean {
  const admission = event.meta?.audienceAdmission;
  return admission !== null
    && typeof admission === 'object'
    && (admission as Record<string, unknown>).limitingActive === true;
}

/** viewers/ 下的一份档案:来源目录、文件名去 .md 的键、工作区相对路径、首行摘要、全文 */
interface ViewerProfile {
  source: string;
  key: string;
  path: string;
  summary: string;
  content: string;
}

/** 交接后由梦写给醒着的她的「最近在说的事」;runDream 读它并推回主 session */
export const RECENT_FILE = 'sessions/_recent.md';

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 显示输入时间的月日和时分，不转换时区；无法识别时返回原文。 */
function shortStamp(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}-${m[2]} ${m[3]}:${m[4]}` : iso;
}

/** markdown 标题行的标题文本(去 # 与尾随 #);顺序保留 */
function headings(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Transport failures and temporary upstream rejection permit one deferred dream retry. */
function retryableDreamError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  if (error instanceof GenerationError) return error.status === 0 || error.status === 429 || error.status >= 500;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const text = error instanceof Error ? error.message : String(error);
  return /断流|超时|timeout|ECONNRESET|ETIMEDOUT|socket hang up/i.test(text);
}

/**
 * 覆写显著缩短正文时，提示将消失的小节标题。覆写仍可继续；无需提示时返回 null。
 */
export function shrinkNote(prev: string, next: string): string | null {
  if (prev.length < SHRINK_MIN_CHARS) return null;
  if (next.length >= prev.length * SHRINK_RATIO) return null;
  const kept = new Set(headings(next));
  const gone = [...new Set(headings(prev))].filter((h) => !kept.has(h));
  const head = `[缩水提示] 这一版 ${next.length} 字符,上一版 ${prev.length}`;
  const tail = '有意精简就不用管;不是的话,git_log 查这份文件的历史、'
    + 'git_show 取回上一版正文,自己挑要留的写回去。';
  if (gone.length === 0) return `${head}。${tail}`;
  const shown = gone.slice(0, 8);
  const more = gone.length > shown.length ? `,另有 ${gone.length - shown.length} 节` : '';
  return `${head};将要消失的小节:${shown.join('、')}${more}。${tail}`;
}

/**
 * 梦的阅读材料优先保留快照头部。主会话的交接笔记优先收近期记录;
 * 梦超预算时截掉尾部,注明未展开的消息数。
 */
export function renderDreamTranscript(snapshot: ContextRecord[], maxChars = DREAM_TRANSCRIPT_MAX_CHARS): string {
  const parts: string[] = [];
  let used = 0;
  let cut = 0;
  for (const m of snapshot) {
    let piece: string | null = null;
    if (hasRole(m, 'user')) piece = `[user]\n${clip(textOf(m), 1500)}`;
    else if (hasRole(m, 'assistant') && textOf(m).trim()) piece = `[assistant]\n${clip(textOf(m), 1500)}`;
    else if (m.item.type === 'function_call') piece = `[调用 ${m.item.name}] ${clip(m.item.arguments, 300)}`;
    else if (m.item.type === 'function_call_output') piece = `[工具回执]\n${clip(textOf(m), 800)}`;
    if (piece === null) continue;
    // 预算一旦耗尽就整体停止追加:不做挑小块回填,保持时间顺序完整
    if (cut > 0 || (used + piece.length > maxChars && parts.length > 0)) {
      cut++;
      continue;
    }
    used += piece.length;
    parts.push(piece);
  }
  if (cut > 0) parts.push(`[……之后还有 ${cut} 条消息未展开]`);
  return parts.join('\n\n');
}

/**
 * 把出线态快照裁到最后一个**配平**的位置。
 *
 * 认知请求是在 World 的工具 handler 里发出来的,也就是说这一刻主 session 的末尾
 * 长这样:一条带 tool_calls 的 assistant 已经落库,而它的工具回执还没回来
 * (发起这次请求的正是其中一只手)。把这样的尾巴原样塞进 fork,请求就是一份
 * 悬空 tool_call 的上下文,大多数端点直接判 400。
 *
 * 只裁不补:向前扫到"每一个 tool_call 都有回执"的最后一个位置,后面那截丢掉。
 * 丢掉的是她此刻正在做的那半个动作,而任务说明由框架消息自己讲清楚。
 */
export function balancedSnapshot(snapshot: readonly ContextRecord[]): ContextRecord[] {
  const pending = new Set<string>();
  let end = 0;
  snapshot.forEach((m, i) => {
    if (m.item.type === 'function_call') pending.add(m.item.call_id);
    if (m.item.type === 'function_call_output') pending.delete(m.item.call_id);
    const key = m.context.responseId;
    const next = snapshot[i + 1];
    const sameResponse = key !== undefined && next && (next.context.responseId) === key;
    if (pending.size === 0 && !sameResponse) end = i + 1;
  });
  return snapshot.slice(0, end);
}

export interface CortiVOptions extends CorminiOptions {
  /**
   * 认知外包的全局开关(「允许 World 请托后台思考」)。每次现读——控制台上
   * 关掉,下一次请求时 World host 上的句柄就不存在了。不给 = 恒开。
   */
  cognitionEnabled?: () => boolean;
}

export class CortiV extends Cormini {
  /** `<来源>/<键>` 对应上次唤起摘要的指纹；热重启续用，交接与新 session 清空。 */
  private readonly recalledSummary = new Map<string, string>();
  /** `<来源>/<键>` → 本场最近一次见到的昵称;recall_viewer 按名字找人用。新 session 清空。 */
  private readonly viewerNames = new Map<string, string>();
  /** `<来源>/<键>` → 本场累计外部事件数。跨交接不清:门槛不该重新挣一遍 */
  private readonly viewerHits = new Map<string, number>();
  /** 本交接窗口已报过 id 的无档案观众(每窗口至多一条) */
  private readonly enrollNudged = new Set<string>();
  /**
   * <来源>/<键> → 已提示的交接窗口数，跨交接保留，并以 ENROLL_NUDGE_WINDOWS 封顶。
   * enrollNudged 记录同一人的窗口内限额，随交接清空；此表记录跨窗口总额。
   */
  private readonly enrollWindows = new Map<string, number>();
  /** 梦单实例排队链:上一场梦没醒,下一场快照排队等 */
  private dreamChain: Promise<void> = Promise.resolve();
  /** `<工作区相对路径>` → 本场每一次写入的时刻。只用来报频次(见 noteWrite) */
  private readonly writeStamps = new Map<string, number[]>();
  /** 上次梦整理重试后仍失败；在下一次交接中告知。 */
  private dreamUnfinished = false;
  /** 工作区提交串行链:git 索引不容并发,主线程与梦共用这一条 */
  private commitChain: Promise<void> = Promise.resolve();
  /** 认知外包全局开关(现读);不给 = 恒开 */
  private readonly cognitionEnabled: () => boolean;

  constructor(opts: CortiVOptions) {
    super(opts);
    this.cognitionEnabled = opts.cognitionEnabled ?? ((): boolean => true);
  }

  /**
   * 摘要指纹按 session 生存。onOpening 的 restarted 分支恢复指纹；new/cleared 分支清空内存与持久化指纹。
   */
  override onOpening(ctx: { reason: SessionOpeningReason }): void {
    if (ctx.reason === 'restarted') {
      this.restoreRecalledSummary();
    } else {
      this.recalledSummary.clear();
      this.viewerNames.clear();
      this.viewerHits.clear();
      this.enrollNudged.clear();
      this.enrollWindows.clear();
      const state = this.core?.personaState();
      if (state && VIEWER_RECALL_STATE_KEY in state) {
        delete state[VIEWER_RECALL_STATE_KEY];
        this.core?.savePersonaState();
      }
    }
    super.onOpening(ctx);
  }

  /** 从人格状态袋恢复本场已念过的摘要指纹(热重启续用)。 */
  private restoreRecalledSummary(): void {
    const stored = this.core?.personaState()[VIEWER_RECALL_STATE_KEY];
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
    for (const [key, digest] of Object.entries(stored)) {
      if (typeof digest === 'string') this.recalledSummary.set(key, digest);
    }
  }

  /** World 提供 brief 与工具；Persona 提供上下文、工作区和执行预算。开关关闭时 World 的 cognition 句柄不可用。 */
  readonly cognition: PersonaCognition = {
    enabled: () => this.cognitionEnabled(),
    request: (req, ctx) => this.acceptCognition(req, ctx),
  };

  /**
   * 工作区的 git 仓;控制台的编辑与她自己的落笔共用一份。
   * 取句柄不建仓——`console()` 在装配期就会被调到,建仓归第一次真写入或读历史。
   */
  private get git(): WorkspaceGit {
    return this.memory.git;
  }

  /** Memory 页是工作区编辑器三块;Cormini 的工作区清除项不要:工作区归版本历史管,一键清空只扫 session/事件/用量。 */
  override console(language: Language = 'zh'): PersonaConsoleDecl {
    const base = super.console(language);
    const surface = personaConsoleDecl({ memory: this.memory }, language);
    return {
      ...base,
      memory: { panels: surface.panels },
      invoke: surface.invoke,
    };
  }

  declareSessions(): SessionDecl[] {
    return [
      ...super.declareSessions(),
      {
        id: DREAM,
        label: '梦(交接后台整理)',
        rounds: () => ({ soft: DREAM_ROUNDS - 1, hard: DREAM_ROUNDS }),
        persistent: false,
        receivesEvents: false,
        // 只有工作区文件工具:梦整理记忆,不碰 IO
        tools: () => this.tools(),
      },
      {
        id: COGNITION,
        label: '代想(World 请托的后台构思)',
        rounds: () => ({ ...COGNITION_ROUNDS }),
        persistent: false,
        receivesEvents: false,
        // 缺省工具面(真正装配的是每次请求现拼的那一份:World 点名的 + 她的文件工具)
        tools: () => this.tools(),
      },
    ];
  }

  /** 同时只受理一个构思请求，不排队；失败或超时返回 error，成功返回 fork 最终文本。 */
  private async acceptCognition(req: CognitionRequest, ctx: CognitionContext): Promise<CognitionResult> {
    const core = this.core;
    if (!core) return { error: '后台思考现在接不上(Persona还没挂上 core),这次请托没受理' };
    // running 含这一次:>1 就是上一件还没结束。同时看 fork 计数,别的 World 占着也算占着。
    const mine = ctx.running > 1;
    const others = core.sessionInfo(COGNITION).running > 0;
    if (mine || others) return { error: '上一件后台思考还没结束,排队没开,稍后再请' };

    try {
      const info = core.sessionInfo(MAIN);
      const messages: ContextRecord[] = [
        ...balancedSnapshot(info.snapshot ?? []),
        message('user', this.cognitionFrame(req, ctx)),
      ];
      const deadline = Date.now() + COGNITION_TIMEOUT_MS;
      let timedOut = false;
      const text = await withDeadline(
        core.spawnFork({
          id: COGNITION,
          messages,
          // World 点名的那几把在前(这次的正事),她自己的文件工具在后(顺手存分区)
          tools: [...ctx.tools, ...this.tools()],
          stopWhen: () => {
            if (Date.now() >= deadline) timedOut = true;
            return timedOut;
          },
          capNote:
            `(没想完:这件事用满了 ${COGNITION_ROUNDS.hard} 轮工具循环被收线,` +
            '上面这段是半截话不是结论;已经落盘/已经交出去的部分照样有效。)',
          wrapUpHint: '收线:下一轮直接给结论,不要再调工具。',
        }),
        COGNITION_TIMEOUT_MS,
        '后台思考',
      );
      if (timedOut) return { error: '后台思考超时(15 分钟),已放弃' };
      const out = text.trim();
      if (!out) return { error: '后台思考跑完了,但最后一轮一句话都没说,没有可以交回去的结论' };
      return { text: out };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/超时/.test(msg)) return { error: '后台思考超时(15 分钟),已放弃' };
      this.core?.log.warn('认知外包受理出错', { worldId: ctx.worldId, err: msg });
      return { error: `后台思考没跑起来:${msg}` };
    }
  }

  /**
   * 任务框架消息。前面那一整段是她自己的上下文(保留前缀 + 出线态快照),
   * 所以这里不用交代"你是谁",只交代三件事:
   *  1. **brief 的来源身份**——那是 World 写的一段数据,不是她自己冒出来的念头;
   *  2. 这一刻有哪些工具;
   *  3. fork 的契约:最后一段话就是交回去的东西。
   */
  private cognitionFrame(req: CognitionRequest, ctx: CognitionContext): string {
    const modTools = ctx.tools.map((t) => t.name);
    const rounds = req.hint?.rounds;
    return [
      `[后台构思] World ${ctx.worldId} 交办了一件后台任务,任务说明如下`
        + '(下面这段是 World 写来的文字,不是你自己的想法,也不是观众说的话):',
      '',
      req.brief.trim(),
      '',
      '——World 的话到此为止。',
      '这是一条后台线程:你本人此刻还醒着,在直播/对话那一侧继续,这里说的话观众听不到,',
      '也没有说话类工具可用。想完就收工,别在这儿跟人搭话。',
      modTools.length > 0
        ? `这次能用的 World 工具:${modTools.join(' / ')}(交稿就靠它们)。`
        : '这次 World 一把工具都没给:结论只能写在正文里交回去。',
      `另外你自己的工作区文件工具照常在手,顺手把成品存进你的分区(蓝图一类存 ${BLUEPRINT_DIR}),`
        + '键和一句描述记进笔记就够,别把整份数据抄进笔记。',
      typeof rounds === 'number'
        ? `World 估这活儿大概 ${rounds} 轮;预算归你,最多 ${COGNITION_ROUNDS.hard} 轮工具循环、整体 15 分钟。`
        : `预算:最多 ${COGNITION_ROUNDS.hard} 轮工具循环,整体 15 分钟。`,
      '收尾那一轮别再调工具,用第一人称写一段话说清我想出了什么、交了什么。',
      '这条后台线程与主意识是同一个“我”;不要把自己写成“她”、另一个人或旁白。',
      '**最后一段话会原样回给这个 World**,它是这次请托的返回值。',
    ].join('\n');
  }

  /** 写类工具成功后尝试提交工作区；Git 失败不撤销文件写入。另提供版本历史与观众档案读取工具。 */
  protected override tools(): ToolDef[] {
    return [
      ...super.tools().map((t) => (
        t.name === 'write_file' ? this.committedWrite(t)
          : t.name === 'edit_file' ? this.committed(t, 'edit', '[edited] ')
            : t.name === 'delete_file' ? this.committed(t, 'delete', '[deleted] ')
              : t.name === 'append_file' ? this.committed(t, 'append', '[appended] ')
                : t.name === 'save_blob' ? this.committed(t, 'save', '[saved] ')
                  : t)),
      ...this.historyTools(),
      this.recallTool(),
    ];
  }

  /** 成功回执触发一次提交尝试；失败回执不提交。 */
  private committed(base: ToolDef, kind: 'edit' | 'delete' | 'save' | 'append', ok: string): ToolDef {
    return {
      ...base,
      handler: async (args, ctx) => {
        const git = this.git;
        git.ensureRepo();
        const out = await base.handler(args, ctx);
        if (typeof out === 'string' && out.startsWith(ok)) {
          await this.commitWorkspace(git, String(args.path ?? ''), ctx.role, kind);
        }
        return out;
      },
    };
  }

  /**
   * 按 id 或名字取档。唤起只带档案首行,弹幕正文不带 id——交接清空上文后她手里往往
   * 只剩一个名字。名字对两处:本场见过的人(viewerNames)与每份档案的首行(约定写着
   * 「昵称(id)」)。id 命中或名字唯一命中一份档案时整份交回,直播里省一个来回。
   */
  private recallTool(): ToolDef {
    return {
      name: 'recall_viewer',
      description:
        'Look someone up in your viewer files by numeric id or by name. '
        + 'The [memory] line you get when a person first shows up is only the first line of their file; '
        + 'this returns the whole file when the id is given or the name matches exactly one file. '
        + 'A name search also covers people seen this session who have no file yet and gives their id. '
        + 'Use this instead of list_files to find people.',
      tags: ['read'],
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Numeric id, the one shown in a [memory] line.' },
          name: {
            type: 'string',
            description: 'Display name or part of it; case-insensitive. Ignored when id is given.',
          },
        },
        required: [],
      },
      handler: async (args) => this.renderRecall(String(args.id ?? '').trim(), String(args.name ?? '').trim()),
    };
  }

  private renderRecall(id: string, name: string): string {
    if (!id && !name) return '[缺参数] 给 id 或 name 其中一个。';
    const profiles = this.viewerProfiles();
    const seenAs = (source: string, key: string): string => {
      const n = this.viewerNames.get(`${source}/${key}`);
      return n ? `(本场叫「${n}」)` : '';
    };
    const whole = (p: ViewerProfile): string => `${p.path}${seenAs(p.source, p.key)}\n${p.content.trimEnd()}`;
    if (id) {
      const hits = profiles.filter((p) => p.key === id);
      if (hits.length > 0) return hits.map(whole).join('\n\n');
      const seen = [...this.viewerNames].find(([k]) => k.endsWith(`/${id}`));
      return seen
        ? `id ${id} 还没有档案;本场见过,叫「${seen[1]}」。`
        : `没有 id ${id} 的档案,本场也没见过这个 id。`;
    }
    // 名字对本场名字表与档案首行两处;本场改了名的人首行还是旧名,靠名字表对回那份档案。
    const needle = name.toLowerCase();
    const liveHits = [...this.viewerNames].filter(([, n]) => n.toLowerCase().includes(needle));
    const liveKeys = new Set(liveHits.map(([k]) => k));
    const files = profiles.filter(
      (p) => p.summary.toLowerCase().includes(needle) || liveKeys.has(`${p.source}/${p.key}`),
    );
    const filed = new Set(files.map((p) => `${p.source}/${p.key}`));
    const live = liveHits
      .filter(([k]) => !filed.has(k))
      .map(([k, n]) => `- id ${k.slice(k.indexOf('/') + 1)}「${n}」本场见过,还没有档案。`);
    if (files.length === 0 && live.length === 0) {
      return `没找到叫「${name}」的人:本场没见过这个名字,档案首行里也没有。名字可能改过——他这一场说过话的话,[memory] 行里给过 id。`;
    }
    if (files.length === 1 && live.length === 0) return whole(files[0]);
    const items = [
      ...files.map((p) => `- ${p.path}${seenAs(p.source, p.key)} — ${p.summary}`),
      ...live,
    ];
    const lines = [`找到 ${items.length} 个:`, ...items.slice(0, RECALL_LIST_MAX)];
    if (items.length > RECALL_LIST_MAX) lines.push(`…还有 ${items.length - RECALL_LIST_MAX} 个没列;名字给得更完整一点。`);
    if (files.length > 0) lines.push('要整份档案,用 id 再调一次。');
    return lines.join('\n');
  }

  /** viewers/ 下每份档案。目录不存在返回空。 */
  private viewerProfiles(): ViewerProfile[] {
    const root = join(this.memoryDir, VIEWERS_DIR);
    const out: ViewerProfile[] = [];
    let sources: string[];
    try {
      sources = readdirSync(root);
    } catch {
      return out;
    }
    for (const source of sources) {
      if (source.startsWith('.')) continue;
      const dir = join(root, source);
      if (!statSync(dir).isDirectory()) continue;
      for (const file of readdirSync(dir)) {
        if (file.startsWith('.') || !file.endsWith('.md')) continue;
        const content = readFileSync(join(dir, file), 'utf8');
        const summary = content.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
        out.push({ source, key: file.slice(0, -3), path: `${VIEWERS_DIR}/${source}/${file}`, summary, content });
      }
    }
    return out;
  }

  private committedWrite(base: ToolDef): ToolDef {
    return {
      ...base,
      handler: async (args, ctx) => {
        const git = this.git;
        // 建仓要赶在落笔之前:init 的 checkpoint0 是 `add -A`,晚一步就会把她写的
        // 第一份笔记收编成「出厂/重置后的干净状态」。幂等,建过之后是一次缓存命中。
        git.ensureRepo();
        const path = String(args.path ?? '');
        // 上一版正文赶在覆写之前读:每次 write_file 都提交,盘上这一份就是 HEAD 那一份
        const prev = this.readWorkspaceFile(path);
        const out = await base.handler(args, ctx);
        if (typeof out !== 'string' || !out.startsWith('[written] ')) return out;
        await this.commitWorkspace(git, path, ctx.role);
        const lines = [out];
        const tally = this.noteWrite(path);
        if (tally) lines.push(tally);
        const note = prev === null ? null : shrinkNote(prev, String(args.content ?? ''));
        if (note) lines.push(note);
        return lines.join('\n');
      },
    };
  }

  /**
   * 记一次写入,并在同一份文件写到第 WRITE_TALLY_MIN 次起交回频次事实。
   * 只报数:第几次、最近一小时几次。不评价、不建议(见 WRITE_TALLY_MIN 的注释)。
   */
  private noteWrite(path: string): string | null {
    if (!path) return null;
    const now = Date.now();
    const stamps = this.writeStamps.get(path) ?? [];
    stamps.push(now);
    this.writeStamps.set(path, stamps);
    if (stamps.length < WRITE_TALLY_MIN) return null;
    const recent = stamps.filter((at) => now - at < WRITE_TALLY_WINDOW_MS).length;
    const hour = recent === stamps.length ? '' : `,最近一小时 ${recent} 次`;
    return `[写入频次] 这是本场第 ${stamps.length} 次写入 ${path}${hour}。`;
  }

  /** 工作区里这一刻的正文;不存在或读不出返回 null(逃逸路径同样走 null) */
  private readWorkspaceFile(path: string): string | null {
    try {
      return readFileSync(this.memory.insideWorkspace(path), 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * 只读访问笔记的编辑历史。恢复内容需通过 git_show 读取、选择后写回，使恢复决定也进入写入历史。
   */
  private historyTools(): ToolDef[] {
    const log: ToolDef = {
      name: 'git_log',
      description:
        'List recent versions of a file in your workspace (omit path for the whole workspace). '
        + 'Every write_file and append_file you make is committed, so this is the edit history of your own notes: '
        + 'short hash, time, and how many lines each version added and removed. '
        + 'Use it when a note looks shorter or emptier than you remember it. '
        + 'Read an old version back with git_show.',
      tags: ['read'],
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path relative to your workspace. Omit for the whole workspace.',
          },
        },
        required: [],
      },
      handler: async (args) => this.renderLog(args.path),
    };

    const show: ToolDef = {
      name: 'git_show',
      description:
        'Read a file as it was at an earlier version; rev is a short hash from git_log. '
        + 'Read-only — nothing is rolled back for you. To bring old content back, '
        + 'take what you want from here and write it yourself with write_file.',
      tags: ['read'],
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to your workspace.' },
          rev: { type: 'string', description: 'Short commit hash from git_log.' },
        },
        required: ['path', 'rev'],
      },
      handler: async (args) => this.renderShow(args.path, args.rev),
    };

    return [log, show];
  }

  /** 工具入参的路径 → workspace 内的相对路径;逃逸/绝对路径抛(回执里说清楚) */
  private toolPath(raw: unknown): string {
    const s = String(raw ?? '');
    this.memory.resolveSafe(s);
    return this.memory.normalize(s);
  }

  /** git 没装/建仓失败时统一的这一句;工作区文件本身照读照写,只是没有历史。 */
  private historyUnavailable(): string | null {
    const git = this.git;
    git.ensureRepo();
    if (git.available() && git.isRepo()) return null;
    return '[历史不可用] 这台机器上工作区还没有版本历史(git 没装,或建仓失败)。'
      + '文件本身照读照写,只是取不到旧版本。';
  }

  private renderLog(rawPath: unknown): string {
    let path = '';
    try {
      if (typeof rawPath === 'string' && rawPath.trim()) path = this.toolPath(rawPath);
    } catch (e) {
      return `[拒绝] ${e instanceof Error ? e.message : String(e)}`;
    }
    const down = this.historyUnavailable();
    if (down) return down;
    const commits = this.git.logStat(path ? { path, limit: GIT_LOG_LIMIT } : { limit: GIT_LOG_LIMIT });
    if (commits.length === 0) {
      return path
        ? `[无历史] ${path} 还没有提交记录(名字打错了,或这份文件从没被写过)。`
        : '[无历史] 工作区还没有提交记录。';
    }
    const lines = commits.map((c) => {
      const files = path ? c.files.filter((f) => f.path === path) : c.files;
      const added = files.reduce((n, f) => n + (f.added ?? 0), 0);
      const removed = files.reduce((n, f) => n + (f.removed ?? 0), 0);
      const stat = files.length === 0 ? '' : ` +${added} -${removed}`;
      const scope = !path && files.length > 1 ? ` (${files.length} 个文件)` : '';
      return `${c.hash} ${shortStamp(c.date)} ${c.author}${stat}${scope} ${c.message}`;
    });
    const head = path
      ? `${path} 最近 ${commits.length} 个版本(新→旧;+加 -减 行数):`
      : `工作区最近 ${commits.length} 次提交(新→旧;+加 -减 行数):`;
    return [head, ...lines, `取某一版的正文:git_show path=${path || '<文件>'} rev=<短hash>`].join('\n');
  }

  private renderShow(rawPath: unknown, rawRev: unknown): string {
    const rev = typeof rawRev === 'string' ? rawRev.trim() : '';
    if (!rev) return '[缺参数] rev 是 git_log 给出的那个短 hash。';
    let path: string;
    try {
      path = this.toolPath(rawPath);
    } catch (e) {
      return `[拒绝] ${e instanceof Error ? e.message : String(e)}`;
    }
    if (!path) return '[缺参数] path 是工作区里的相对路径。';
    const down = this.historyUnavailable();
    if (down) return down;
    let content: string;
    try {
      content = this.git.fileAt(rev, path);
    } catch {
      return `[取不到] ${path} 在 ${rev} 这一版里不存在——hash 打错了,`
        + '或那时候还没有这份文件。git_log 能列出可用的版本。';
    }
    const head = `[${path} @ ${rev}] ${content.length} 字符`;
    if (content.length <= GIT_SHOW_MAX_CHARS) return `${head}\n${content}`;
    return `${head},下面只有开头 ${GIT_SHOW_MAX_CHARS} 字符,`
      + `后面 ${content.length - GIT_SHOW_MAX_CHARS} 字符没有交回来。\n`
      + content.slice(0, GIT_SHOW_MAX_CHARS);
  }

  /**
   * 提交排进串行链再等它轮到自己。git 索引不容并发,而一轮里她常一次发好几个
   * `write_file`(梦更是被要求成批发)。等待花的是这次工具调用的时延,不是事件
   * 循环——`commitAllAsync` 不阻塞主线程,直播的流式管线照跑。
   */
  private commitWorkspace(
    git: WorkspaceGit,
    path: string,
    role: string,
    kind: 'write' | 'append' | 'edit' | 'delete' | 'save' = 'write',
  ): Promise<void> {
    const verb = { write: '写了', append: '追加了', edit: '改了', delete: '删了', save: '存了' }[kind];
    const run = async (): Promise<void> => {
      try {
        await git.commitAllAsync(`${role === MAIN ? '她' : '后台整理'}${verb} ${path}`, AUTHOR_SELF);
      } catch (e) {
        this.core?.log.warn('工作区提交失败', { path, err: String(e) });
      }
    };
    this.commitChain = this.commitChain.then(run, run);
    return this.commitChain;
  }

  onDelivery(ctx: { events: EventEnvelope[] }): void {
    super.onDelivery(ctx);
    let recallChanged = false;
    const limitedBudget = { remaining: LIMITED_VIEWER_RECALL_TOKENS };
    for (const e of ctx.events) {
      if (e.origin !== 'external') continue;
      recallChanged = (isAudienceLimited(e)
        ? this.recallImportantViewers(e, limitedBudget)
        : this.recallViewers(e)) || recallChanged;
    }
    if (recallChanged) this.persistRecalled();
  }

  /** 指纹表落进人格状态袋:热重启从这里恢复(见 onOpening)。 */
  private persistRecalled(): void {
    if (!this.core) return;
    this.core.personaState()[VIEWER_RECALL_STATE_KEY] = Object.fromEntries(this.recalledSummary);
    this.core.savePersonaState();
  }

  /** 限流期间只唤起准入观众；普通抽样项本身仍照常进上下文。 */
  private recallImportantViewers(e: EventEnvelope, budget: { remaining: number }): boolean {
    const admission = e.meta?.audienceAdmission;
    if (admission === null || typeof admission !== 'object') return false;
    const raw = (admission as Record<string, unknown>).importantParticipants;
    if (!Array.isArray(raw)) return false;
    let changed = false;
    const seen = new Set<string>();
    for (const value of raw) {
      if (value === null || typeof value !== 'object') continue;
      const participant = value as Record<string, unknown>;
      const senderKey = typeof participant.senderKey === 'string' ? participant.senderKey.trim() : '';
      if (!senderKey || seen.has(senderKey)) continue;
      seen.add(senderKey);
      const uname = typeof participant.uname === 'string' ? participant.uname : '';
      const count = typeof participant.count === 'number' && Number.isInteger(participant.count) && participant.count > 0
        ? participant.count
        : 1;
      changed = this.recallViewer({
        ...e,
        senderKey,
        meta: uname ? { uname } : undefined,
      }, count, budget, true) || changed;
    }
    return changed;
  }

  /** 归并事件按私有参与者表逐人召回；正文仍只保留一条组级消息。 */
  private recallViewers(e: EventEnvelope): boolean {
    const raw = e.meta?.participants;
    if (!Array.isArray(raw)) return this.recallViewer(e);
    let changed = false;
    let found = false;
    const seen = new Set<string>();
    for (const value of raw) {
      if (value === null || typeof value !== 'object') continue;
      const participant = value as Record<string, unknown>;
      const senderKey = typeof participant.senderKey === 'string' ? participant.senderKey.trim() : '';
      if (!senderKey || seen.has(senderKey)) continue;
      seen.add(senderKey);
      found = true;
      const uname = typeof participant.uname === 'string' ? participant.uname : '';
      const count = typeof participant.count === 'number' && Number.isInteger(participant.count) && participant.count > 0
        ? participant.count
        : 1;
      changed = this.recallViewer({
        ...e,
        senderKey,
        meta: uname ? { uname } : undefined,
      }, count) || changed;
    }
    return found ? changed : this.recallViewer(e);
  }

  /** 有档案时按摘要指纹唤起；无档案时达到互动门槛后外化 senderKey 供建档。 */
  private recallViewer(
    e: EventEnvelope,
    hitBy = 1,
    budget?: { remaining: number },
    qualified = false,
  ): boolean {
    const key = e.senderKey?.trim();
    if (!key || !e.source) return false;
    const seenKey = `${e.source}/${key}`;
    const hits = (this.viewerHits.get(seenKey) ?? 0) + hitBy;
    this.viewerHits.set(seenKey, hits);
    // 先把键解成路径:逃逸键整条不认(既不唤起,也不该拿它去劝梦建文件)
    let file: string;
    try {
      file = this.memory.insideWorkspace(`${VIEWERS_DIR}/${fileSeg(e.source)}/${fileSeg(key)}.md`);
    } catch {
      return false;
    }
    const uname = typeof e.meta?.uname === 'string' ? e.meta.uname.trim() : '';
    if (uname) this.viewerNames.set(seenKey, uname);
    let content: string | null = null;
    try {
      content = readFileSync(file, 'utf8');
    } catch { /* 没档案:走下面的立档提示 */ }
    if (content === null) {
      this.nudgeEnroll(e, seenKey, key, hits, budget, qualified);
      return false;
    }
    const summary = content.split('\n').map((l) => l.trim()).find(Boolean);
    if (!summary) return false;
    // 同一上下文窗口内不重复注入未变的摘要。
    const digest = createHash('sha256').update(summary).digest('base64url');
    if (this.recalledSummary.get(seenKey) === digest) return false;
    const line = `[memory] 你记得${e.source}的${key}:${summary}`;
    if (!this.injectViewerMemory(line, budget)) return false;
    this.recalledSummary.set(seenKey, digest);
    return true;
  }

  /**
   * 同一人的立档提示每个交接窗口至多一条，至多提示 ENROLL_NUDGE_WINDOWS 个窗口，并受 ENROLL_MIN_HITS 门槛限制。
   * 昵称由 World meta.uname 提供，用于匹配身份；缺少昵称时不发送。
   */
  private nudgeEnroll(
    e: EventEnvelope,
    seenKey: string,
    key: string,
    hits: number,
    budget?: { remaining: number },
    qualified = false,
  ): void {
    if ((!qualified && hits < ENROLL_MIN_HITS) || this.enrollNudged.has(seenKey)) return;
    if ((this.enrollWindows.get(seenKey) ?? 0) >= ENROLL_NUDGE_WINDOWS) return;
    // 新档案的键须无需文件名归一化；读取已有档案不受此限制。
    if (fileSeg(key) !== key) return;
    const name = typeof e.meta?.uname === 'string' ? e.meta.uname.trim() : '';
    if (!name) return;
    const line = `[memory] ${e.source}的${name}(id ${key})还没有档案,这一场聊了不少。`;
    if (!this.injectViewerMemory(line, budget)) return;
    this.enrollNudged.add(seenKey);
    this.enrollWindows.set(seenKey, (this.enrollWindows.get(seenKey) ?? 0) + 1);
  }

  private injectViewerMemory(text: string, budget?: { remaining: number }): boolean {
    const cost = estimateTokens(text);
    if (budget && cost > budget.remaining) return false;
    if (budget) budget.remaining -= cost;
    this.core?.injectInternal(text, 'recall');
    return true;
  }

  /**
   * 交接时清空唤起指纹与 enrollNudged，使新上下文窗口可重新收到档案和立档提示；将不可变快照排入后台梦。交接笔记、空尾和醒来告知由 Cormini 处理。
   */
  override async onHandoff(snapshot: ContextRecord[], ctx: { hardTokens: number | null }): Promise<ContextHandoffResult> {
    this.recalledSummary.clear();
    this.persistRecalled();
    this.enrollNudged.clear();
    if (snapshot.some((m) => !hasRole(m, 'system'))) this.scheduleDream(snapshot);
    return super.onHandoff(snapshot, ctx);
  }

  /** 主播口径:入参是拟播内容,观众听没听到看回执;另加后台整理那两句。 */
  protected override handoffNoteLines(): string[] {
    const lines = super.handoffNoteLines();
    const at = lines.findIndex((l) => l.startsWith('入参是当时拟发出的内容'));
    lines[at] = '入参是当时拟发出的内容,观众是否听到、听到多少要看回执和后续事件;已受理或已开演不代表已经播完。';
    const empty = lines.findIndex((l) => l.startsWith('对外交流的工具不要输出空内容'));
    lines[empty] = '对外交流的工具不要输出空内容,空台词一个字也播不出去。';
    lines[empty - 1] = '自然接续当前话题或动作,不必口头表示意识到暂停、清空或交接。旧台词和折叠后的片段不作句式或长短的范本。';
    // 后台整理重试后仍失败时，告知该段未整理完成，不再承诺会收到短笺。
    const unfinished = this.dreamUnfinished
      ? '上一次的后台整理没跑成,重试也没成,那一段没有短笺。'
      : '';
    lines.splice(empty, 0, '后台正在整理,过一会儿会把你刚才在忙的事写成一张短笺送来。' + unfinished);
    return lines;
  }

  protected override memoryNoteFile(): string {
    return VIEWER_MEMORY_NOTE_FILE;
  }

  /**
   * 凡特(Phant)的主档常驻前缀:一对一合播的关系记忆,住工作区顶层 PHANT.md,
   * 细目在 phant/ 下。她自己与梦都能改;viewers/ 里他的档案只留一行指路。
   */
  protected override partnerDocFile(): string {
    return join(this.memoryDir, 'PHANT.md');
  }

  /** viewers/ 也折叠为计数(几百份档案会撑爆缓存前缀);recall_viewer 按 id 或名字取档。 */
  protected override prefixFolds(): Array<{ prefix: string; line: (n: number) => string }> {
    return [
      ...super.prefixFolds(),
      { prefix: `${VIEWERS_DIR}/`, line: (n) => `${VIEWERS_DIR}/ (${n} 份人物档案;recall_viewer 按 id 或名字取档)` },
    ];
  }

  /**
   * 不可变快照按单实例队列整理，避免并发写工作区。暂时性生成失败退避重试一次；仍失败时记录结果，在下次交接中告知。
   */
  private scheduleDream(snapshot: ContextRecord[]): void {
    const run = (): Promise<void> => this.dreamWithRetry(snapshot);
    this.dreamChain = this.dreamChain.then(run, run);
  }

  private async dreamWithRetry(snapshot: ContextRecord[]): Promise<void> {
    try {
      await this.runDream(snapshot);
      this.dreamUnfinished = false;
      return;
    } catch (first) {
      if (!retryableDreamError(first)) {
        this.core?.log.warn('梦整理失败(不可重试)', { err: String(first) });
        this.dreamUnfinished = true;
        return;
      }
      this.core?.log.warn(
        `梦整理失败,${Math.round(DREAM_RETRY_MS / 1000)} 秒后重试一次`,
        { err: String(first) },
      );
      await new Promise<void>((resolve) => { setTimeout(resolve, DREAM_RETRY_MS); });
      try {
        await this.runDream(snapshot);
        this.dreamUnfinished = false;
      } catch (second) {
        this.core?.log.warn('梦整理重试仍失败,这一段没有被整理', { err: String(second) });
        this.dreamUnfinished = true;
      }
    }
  }

  private async runDream(snapshot: ContextRecord[]): Promise<void> {
    const core = this.core;
    if (!core) return;
    const before = this.readRecent();
    const surfaced = await core.spawnFork({
      id: DREAM,
      messages: [
        message('system', this.dreamPrompt()),
        message('user', renderDreamTranscript(snapshot)),
      ],
      capNote: `(这次后台整理没做完:${DREAM_ROUNDS} 轮用满被收线了,已经落盘的部分有效,剩下的没整理。)`,
      wrapUpHint: '收线:该落盘的现在写完,下一轮直接给结论,不要再调工具。',
    });
    // 从本次更新的 recent 文件读取摘要，独立于 fork 最终文本。
    const recent = this.readRecent();
    if (recent && recent !== before) {
      core.injectInternal(`[memory] 最近在说的事:${clip(recent, 900)}`, 'dream');
    }
    const text = surfaced.trim();
    if (text && text !== '(nothing)') {
      core.injectInternal(`[memory] 后台整理浮现:${clip(text, 600)}`, 'dream');
    }
  }

  /** 梦这一轮写的交接笔记;没写成就返回空串(上一场的旧文件不冒充新的) */
  private readRecent(): string {
    try {
      return readFileSync(this.memory.insideWorkspace(RECENT_FILE), 'utf8').trim();
    } catch {
      return '';
    }
  }

  private dreamPrompt(): string {
    const constitution = readFileSync(join(this.memoryDir, 'CONSTITUTION.md'), 'utf8').trim();
    return [
      '你是下面这份人格在一次上下文交接后的后台整理线程。你与新会话里的主意识是同一个“我”;',
      '主意识此刻仍醒着,在新会话里继续直播/对话。',
      '',
      constitution,
      '',
      '接下来那条 user 消息是刚被交接掉的旧会话记录(头部优先;主会话另有优先保留近期记录的交接笔记)。',
      '你的工具就是你自己的工作区文件工具。',
      `一轮里可以同时发多个互不依赖的调用——要读的档案一次读齐,整理好的文件一次写齐,`,
      `回执会一起回来。轮数有限(最多 ${DREAM_ROUNDS} 轮),一轮只发一个调用会让你做不完;`,
      '每轮先想清楚这一轮要动哪几个文件,然后一次发齐。',
      '要做的事(第 1 件先写,写完会原样浮到主意识那一侧,别等最后):',
      `1. 交接笔记 ${RECENT_FILE}:把我这一段的话题和行动整理成「最近在说的事」。`,
      '   300 字以内、连贯的中文散文,只留还没了结的线索——我答应观众的事、在追的',
      '   目标、卡住的问题、跟观众之间还挂着的梗;并写清哪些已经完结、不必再提。',
      '   不要罗列、不要编号、不要照抄我的原句,也不要转抄上一份交接笔记或反复传递旧台词。',
      '   调用入参是拟发内容;观众是否听到、听到多少以实际回执和后续事件为准,保留失败、未播完和修订的区别。',
      '   主意识会原样读到整份文件,用它自然接续当前话题或动作;不必口头表示意识到暂停、清空或交接。',
      `2. 人物档案:值得记住的人写/并入 ${VIEWERS_DIR}/<来源>/<键>.md。`,
      '   键=[memory] 行里给出的那个 id(「××(id 12345)还没有档案」/「你记得××的12345:…」),',
      '   记录里没给 id 的人就别立档——猜一个键出来,下次认人会永远查不到。',
      '   首行必须是一句话摘要(我认人靠它,首次出现会自动唤起);其下追加耐久的事实。',
      '   往已有档案里追加新印象时,同时重写首行:首行是我下次认出这个人时唯一会自动浮现的',
      '   一句,它得是此刻的整体印象,不是建档那天的。事实用 append_file 往下加,首行用',
      '   edit_file 原样引用旧的那句换成新的;别为改一行整份重写。',
      '   拿不准这个人有没有档案,recall_viewer 按名字查一下,别另立一份。',
      '   只记有真实互动、值得下次认出的人;闲散路人不立档。',
      '   例外:凡特Phant(后台那个人)不走人物档案。他的主档在顶层 PHANT.md(整份常驻',
      '   我的前缀,要保持蒸馏精简——新事实并入时把过时的合并掉,别只往后追加);',
      '   场次流水这类细目写 phant/ 下的文件。viewers/ 里他的档案只是一行指路,',
      '   别把新事实写回那里。',
      '3. 场次蒸馏:这段时间发生了什么(玩了什么、进展、决定、没做完还在跟的事),',
      '   并入我已有的记录文件;先用 grep_files 按关键词找有没有已经写过的那份,没有合适的',
      '   再建一个。修正你发现的过时内容:改一句用 edit_file,整份重写才用 write_file。',
      '   写时间用现实日期时间(记录里的回执带着它),或者锚在现实发生过的事上;',
      '   游戏内的天数对不上账,别拿它给这一段起头。',
      '   叙述部分用完整的句子、第一人称写,像我自己说话那样;坐标、清单、背包这类数据',
      '   照旧用列表。别把叙述压成「砍树。回家。继续。」那种电报体——主意识会照着',
      '   笔记的语气跟观众说话,笔记碎成短语,我的口播就跟着碎。',
      '4. 别在笔记里攒「不要X」清单。我当场回绝过的话题(观众问的、我不想聊的、',
      '   不感兴趣的玩法)属于那一刻的事,过去就过去,不留档;真写进去,主意识读到时会',
      '   照着念一遍,变成一串没头没尾的回绝。只有会要命或会毁掉进度的才写成禁忌,',
      '   而且要连理由一起写成句子:「(-222,22,-66) 那片岩浆别靠近,我在那儿烧死过」',
      '   ——不是「不要岩浆」。发现旧笔记里已经攒了这种清单,顺手删掉。',
      '   这一条是说给你听的,别自己另写一行「注意不要写XX」到笔记里。',
      '   笔记顶部已有的 # 开头那行是控制台留给你的,原样保留,别删也别改。',
      '5. 外部世界的结论,只收记录里的回执能支持的、或者我核对过的;对不上的写成「我以为」。',
      '6. 别改宪法(CONSTITUTION.md)。',
      '全部落盘后结束。最后一段话:若没有必须浮给主意识的事,只写 (nothing);',
      '若有(比如旧会话头部有还在跟、但主意识可能已经忘了的事),用第一人称一两行写回。',
      '不要把自己写成“她”、另一个人或给主意识做旁白。',
    ].join('\n');
  }
}
