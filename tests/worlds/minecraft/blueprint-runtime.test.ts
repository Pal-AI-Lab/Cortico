/**
 * 蓝图 runtime 覆盖工具面、构思分档与降级、缓存与世界归属、build 集成和采集搭车。
 * cognition RPC 在 proxy 测试中验证，此处不起真实子进程。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MinecraftWorld, BlueprintBook, encodeBlueprint, parseBlueprintArgs } from '../../../src/worlds/minecraft/world.ts';
import { MINECRAFT_DEFAULTS, type MinecraftConfigSection } from '../../../src/worlds/minecraft/config.ts';
import { acceptBlueprint } from '../../../src/worlds/minecraft/blueprint-plan.ts';
import {
  Executor, describeSkill, parseScoutSteps, parseSteps,
  type BlueprintDesk, type TaskReport,
} from '../../../src/worlds/minecraft/executor.ts';
import { ChestBook } from '../../../src/worlds/minecraft/chests.ts';
import type { CognitionRequest, CognitionResult, Logger } from '../../../src/core/types.ts';
import { Vec3 } from 'vec3';
import { FakeHost } from '../../helpers/fake-host.ts';

const log = { child() { return this; }, info() {}, warn() {}, error() {}, debug() {}, trace() {}, emit() {} } as unknown as Logger;
const ctx = { role: 'test', log } as never;

function cfg(over: Partial<MinecraftConfigSection> = {}): MinecraftConfigSection {
  return structuredClone({ ...MINECRAFT_DEFAULTS, enabled: true, port: 1, ...over }) as MinecraftConfigSection;
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-bp-'));
  dirs.push(dir);
  return dir;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** 2×1×2 一片圆石地板:非空气 4 格,贪心并成一步 */
function floorSubmission(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'home-v2',
    name: '新家',
    site_mode: 'new',
    size_xyz: [2, 1, 2],
    axis_order: 'YZX',
    palette: ['minecraft:cobblestone'],
    layers: [[[0, 0], [0, 0]]],
    ...over,
  };
}

/** 一株瓜藤,图里没画耕地层:支撑格在图外,只汇总成提醒,不拦受理 */
function cropSubmission(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'melon-row',
    site_mode: 'new',
    size_xyz: [1, 1, 1],
    axis_order: 'YZX',
    palette: ['minecraft:melon_stem'],
    layers: [[[0]]],
    ...over,
  };
}

/** 两层:下层圆石、上层橡木板;每层一步,给 stopAfter 与分批用 */
function twoLayerSubmission(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'tower',
    site_mode: 'new',
    size_xyz: [1, 2, 1],
    axis_order: 'YZX',
    palette: ['minecraft:cobblestone', 'minecraft:oak_planks'],
    layers: [[[0]], [[1]]],
    ...over,
  };
}

interface Rig {
  m: MinecraftWorld;
  host: FakeHost & { cognition?: { request(req: CognitionRequest): Promise<CognitionResult> } };
  dir: string;
  bp: (args?: Record<string, unknown>) => Promise<string>;
  goal: (args?: Record<string, unknown>) => Promise<string>;
}

function rig(opts: {
  dir?: string;
  over?: Partial<MinecraftConfigSection>;
  cognition?: (req: CognitionRequest) => Promise<CognitionResult>;
} = {}): Rig {
  const dir = opts.dir ?? tempDir();
  const m = new MinecraftWorld({
    cfg: cfg(opts.over),
    dataDir: dir,
  });
  const host = new FakeHost() as Rig['host'];
  if (opts.cognition) host.cognition = { request: opts.cognition };
  Object.assign(m, { host });
  const tools = Object.fromEntries(m.tools().map((t) => [t.name, t]));
  return {
    m, host, dir,
    bp: (args = {}) => tools.mc_blueprint.handler(args, ctx) as Promise<string>,
    goal: (args = {}) => tools.mc_goal.handler(args, ctx) as Promise<string>,
  };
}

/**
 * 把一份已保存的图在当前 realm 里绑锚点 = 开工(`startedAt` 落下)。
 * 材料 reserve 只认开工的图,所以凡是要验 reserve 的用例都得先过这一步。
 */
function startBlueprint(m: MinecraftWorld, key: string, anchor: [number, number, number] = [0, 64, 0]): void {
  const inner = m as any;
  inner.blueprints.bind(key, anchor);
  inner.syncBlueprintResources();
}

async function waitUntil(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitUntil 超时');
    await vi.advanceTimersByTimeAsync(5);
  }
}

function jobIdFromBrief(brief: string): string {
  const id = brief.match(/job_id 是「([^」]+)」/)?.[1];
  if (!id) throw new Error('构思 brief 没带 job_id');
  return id;
}

function draftRef(receipt: string): { version_id: string; content_hash: string } {
  const version_id = receipt.match(/draft version_id:([^\s]+)/)?.[1];
  const content_hash = receipt.match(/content_hash:([0-9a-f]{64})/)?.[1];
  if (!version_id || !content_hash) throw new Error(`draft 回执缺版本身份:\n${receipt}`);
  return { version_id, content_hash };
}

// ---------------------------------------------------------------------------
// 工具面:save
// ---------------------------------------------------------------------------

describe('mc_blueprint{save}:整份交', () => {
  it('收下:回执报尺寸、用料、步数,并说清 build 怎么用', async () => {
    const { bp } = rig();
    const receipt = await bp({ save: floorSubmission() });
    expect(receipt).toContain('「home-v2」');
    expect(receipt).toContain('2×1×2');
    expect(receipt).toContain('施工 4 格');
    expect(receipt).toContain('圆石 4');
    expect(receipt).toContain('编译成 1 步');
    expect(receipt).toContain('已装载');
    expect(receipt).toContain('"blueprint":"home-v2"');
    // save 是语义写:带记笔记那句(进度变化才不带)
    expect(receipt).toContain('记进你的笔记');
  });

  it('依赖现场的那几条前提照收,但在回执里逐条摆出来', async () => {
    const { bp } = rig();
    const receipt = await bp({ save: cropSubmission() });
    expect(receipt).toContain('收下了'); // 不拦受理:编译期看不见工地
    expect(receipt).toContain('这几条得靠现场满足');
    expect(receipt).toContain('layers[0][0][0]');
    expect(receipt).toContain('支撑那一格不在图里');
  });

  it('没收下:精确到某一格的错误路径原样回执,不装载', async () => {
    const { bp } = rig();
    const bad = await bp({ save: floorSubmission({ layers: [[[0, 9], [0, 0]]] }) });
    expect(bad).toContain('[mc_blueprint 失败]');
    expect(bad).toContain('layers[0][0][1]');
    expect(bad).toContain('越界');
    expect(await bp()).toContain('一份蓝图都没装载');
  });

  it('层数与声明对不上:宽容层按矩阵实测值改声明,并把改了什么说出来', async () => {
    const { bp } = rig();
    // 完整提交按矩阵实测尺寸接收；分批提交按声明的 Y 累积层数。
    // 两条路径的尺寸口径不同，回执须各自说清。
    const fixed = await bp({ save: twoLayerSubmission({ layers: [[[0]]] }) });
    expect(fixed).toContain('收下了');
    expect(fixed).toContain('1×1×1');
    expect(fixed).toContain('收下前顺手补了');
    expect(fixed).toContain('声明尺寸');
  });

  it('水源作为功能步骤收下,流动水仍点名拒收', async () => {
    const { bp } = rig();
    const source = await bp({
      save: floorSubmission({ palette: ['minecraft:water[level=0]'], layers: [[[0, 0], [0, 0]]] }),
    });
    expect(source).toContain('收下了');
    expect(source).toContain('水桶 4');
    const bad = await bp({
      save: floorSubmission({ palette: ['minecraft:water[level=1]'], layers: [[[0, 0], [0, 0]]] }),
    });
    expect(bad).toContain('[mc_blueprint 失败]');
    expect(bad).toContain('level=0');
  });

  it('axis_order 不再必填:缺了照收,当成同一份设计(轴序只有一种)', async () => {
    const { bp, m } = rig();
    const bare = floorSubmission({ key: 'bare' });
    delete bare.axis_order;
    const receipt = await bp({ save: bare });
    expect(receipt).toContain('收下了');
    expect(receipt).not.toContain('[mc_blueprint 失败]');
    // 与写明轴序的同一份图内容摘要相同 = 缺省真的按 YZX 读的
    const hash = (text: string) => text.match(/内容摘要 ([0-9a-f]+)/)?.[1];
    expect(hash(receipt)).toBe(hash(await bp({ save: floorSubmission({ key: 'spelled' }) })));

    // 工具面同步放宽:必填里没有它,blueprint-repair 那段修复才够得到
    const decl = m.tools().find((t) => t.name === 'mc_blueprint')!;
    const save = (decl.parameters as {
      properties: { save: { required: string[]; properties: Record<string, unknown> } };
    }).properties.save;
    expect(save.required).not.toContain('axis_order');
    expect(save.properties.axis_order).toBeDefined();
  });

  it('键不合规当场退回(不进受理管线)', async () => {
    const { bp } = rig();
    expect(await bp({ save: floorSubmission({ key: 'Home V2' }) })).toContain('save.key');
    expect(await bp({ design: { key: 'ok', brief: '' } })).toContain('design.brief');
    expect(await bp({ save: floorSubmission(), unload: 'x' })).toContain('一次只受理一件事');
  });
});

describe('mc_blueprint{save append}:分批交', () => {
  it('按声明的 Y 层数攒齐才受理;每批回执说收到哪几层、还差几层', async () => {
    const { bp } = rig();
    const first = await bp({
      save: { ...twoLayerSubmission({ layers: [[[0]]] }), append: true },
    });
    expect(first).toContain('收到第 0..0 层');
    expect(first).toContain('还差 1 层');
    expect(await bp()).toContain('分批交着的:tower 收了 1/2 层');
    const second = await bp({
      save: { ...twoLayerSubmission({ layers: [[[1]]] }), append: true },
    });
    expect(second).toContain('仍是 draft');
    expect(second).toContain('1×2×1');
    expect(await bp()).toContain('待 accept');
    const ref = draftRef(second);
    expect(await bp({ accept: { key: 'tower', ...ref, content_hash: '0'.repeat(64) } }))
      .toContain('content_hash 对不上');
    expect(await bp()).toContain('一份蓝图都没装载');
    const accepted = await bp({ accept: { key: 'tower', ...ref } });
    expect(accepted).toContain('收下了');
    expect(await bp()).toContain('装载着 1 份');
  });

  it('这一批形状不对:整批不收,指着绝对层号说', async () => {
    const { bp } = rig();
    await bp({ save: { ...twoLayerSubmission({ layers: [[[0]]] }), append: true } });
    const bad = await bp({
      save: { ...twoLayerSubmission({ layers: [[[0, 0]]] }), append: true },
    });
    expect(bad).toContain('layers[1][0]');
    expect(bad).toContain('整批没收');
    // 缓冲没被这一批污染
    expect(await bp()).toContain('收了 1/2 层');
  });

  it('palette / size 中途换了就拒:索引对不上就是另一份图', async () => {
    const { bp } = rig();
    await bp({ save: { ...twoLayerSubmission({ layers: [[[0]]] }), append: true } });
    const other = await bp({
      save: {
        ...twoLayerSubmission({ layers: [[[0]]], palette: ['minecraft:stone', 'minecraft:oak_planks'] }),
        append: true,
      },
    });
    expect(other).toContain('palette 必须逐条一样');
    const bigger = await bp({
      save: { ...twoLayerSubmission({ layers: [[[0]]], size_xyz: [1, 3, 1] }), append: true },
    });
    expect(bigger).toContain('对不上');
  });

  it('层数超了:这一批一层都不收', async () => {
    const { bp } = rig();
    await bp({ save: { ...twoLayerSubmission({ layers: [[[0]]] }), append: true } });
    const over = await bp({
      save: { ...twoLayerSubmission({ layers: [[[1]], [[1]]] }), append: true },
    });
    expect(over).toContain('超过声明的 2 层');
  });
});

// ---------------------------------------------------------------------------
// 工具面:查询 / unload
// ---------------------------------------------------------------------------

describe('mc_blueprint{} 与 {unload}', () => {
  it('查询列出键、尺寸、进度与缺料', async () => {
    const { bp } = rig();
    await bp({ save: floorSubmission() });
    const all = await bp();
    expect(all).toContain('装载着 1 份');
    expect(all).toContain('home-v2「新家」 2×1×2');
    expect(all).toContain('4 格 / 1 步');
    expect(all).toContain('还没开工');
    // 没连上服务器 = 随身与在箱都空:缺料如实报
    expect(all).toContain('还缺圆石 4');
  });

  /**
   * 施工游标只在施工时前进，不回读世界；清单须标明进度是上次施工时点的读数。
   */
  it('施工进度标明是上次施工时点的数', async () => {
    const r = rig();
    await r.bp({ save: floorSubmission() });
    (r.m as any).blueprints.bind('home-v2', [0, 64, 0]);
    (r.m as any).blueprints.progress('home-v2', 1);
    expect(await r.bp()).toContain('已施工 1/1 步(100%,截至上次施工)');
  });

  it('unload 连缓存一起清,回执说清没了什么', async () => {
    const { bp, dir } = rig();
    await bp({ save: floorSubmission() });
    const file = join(dir, 'minecraft-blueprints.json');
    expect(readFileSync(file, 'utf8')).toContain('home-v2');
    const gone = await bp({ unload: 'home-v2' });
    expect(gone).toContain('设计连 data/ 缓存一起删');
    expect(gone).toContain('一份都不剩');
    expect(readFileSync(file, 'utf8')).not.toContain('home-v2');
    expect(await bp({ unload: 'home-v2' })).toContain('本来就没装载');
  });
});

// ---------------------------------------------------------------------------
// 构思两档
// ---------------------------------------------------------------------------

describe('mc_blueprint{design}:认知档', () => {
  it('受理刻立刻回执;交稿后浮一条「构思完成」,带键与三件事', async () => {
    let saved: ((args: Record<string, unknown>) => Promise<string>) | null = null;
    const r = rig({
      cognition: async (req) => {
        expect(req.tools).toEqual(['mc_blueprint']);
        expect(req.hint?.rounds).toBe(8);
        expect(req.brief).toContain('home-v2');
        expect(req.brief).toContain('要一间小木屋'); // 主意识写下的原文原样进 brief
        expect(req.brief).toContain('我在主意识那一侧');
        expect(req.brief).toContain('第一人称写回');
        expect(req.brief).not.toContain('她自己刚才写下的');
        expect(req.brief).toContain('layers[y][z][x]');
        await saved!({ save: floorSubmission({ job_id: jobIdFromBrief(req.brief) }) });
        return { text: '我给你画了个 2×2 的地基,先把地面找平。' };
      },
    });
    saved = r.bp;
    const receipt = await r.bp({ design: { key: 'home-v2', brief: '要一间小木屋' } });
    expect(receipt).toContain('构思在后台开工了');
    expect(receipt).toContain('先跟观众交代一声');
    await waitUntil(() => r.host.events.length > 0);
    const said = r.host.events[0].text;
    expect(said).toContain('构思出来了');
    expect(said).toContain('我给你画了个 2×2 的地基');
    expect(said).toContain('接下来三件事');
    expect(said).toContain('记进笔记');
    expect(said).toContain('"blueprint":"home-v2"');
  });

  it('fork 在轮内自己 accept 了交稿:收尾照样浮「构思完成」,不误报没交稿', async () => {
    // 构思中已通过 save/accept 装载成功时，收尾须认作交稿成功，回执不再邀约 accept。
    let bp: ((args: Record<string, unknown>) => Promise<string>) | null = null;
    const r = rig({
      cognition: async (req) => {
        const receipt = await bp!({ save: floorSubmission({ job_id: jobIdFromBrief(req.brief) }) });
        expect(receipt).toContain('不用交 accept');
        expect(receipt).not.toContain('确认提升请交');
        const ref = draftRef(receipt);
        const accepted = await bp!({
          accept: { key: 'home-v2', version_id: ref.version_id, content_hash: ref.content_hash },
        });
        expect(accepted).toContain('收下了');
        return { text: '我画好了,也自己确认过了。' };
      },
    });
    bp = r.bp;
    await r.bp({ design: { key: 'home-v2', brief: '小木屋' } });
    await waitUntil(() => r.host.events.length > 0);
    const said = r.host.events[0].text;
    expect(said).toContain('构思出来了');
    expect(said).not.toContain('构思没成');
    expect(await r.bp()).toContain('home-v2');
  });

  /**
   * accept 须幂等；draft 晋级并离开 readyDrafts 后，再次 accept 仍能识别已成功装载的结果。
   */
  /** 攒齐两层才形成 draft:accept 这条路只有分批交与后台 job 两个入口 */
  async function towerDraft(bp: (args?: Record<string, unknown>) => Promise<string>) {
    await bp({ save: { ...twoLayerSubmission({ layers: [[[0]]] }), append: true } });
    const second = await bp({ save: { ...twoLayerSubmission({ layers: [[[1]]] }), append: true } });
    return draftRef(second);
  }

  it('accept 幂等:指的是已经生效的那一份时,回执说清没有需要提升的,不报失败', async () => {
    const { bp } = rig();
    const ref = await towerDraft(bp);
    expect(await bp({ accept: { key: 'tower', ...ref } })).toContain('收下了');

    const again = await bp({ accept: { key: 'tower', ...ref } });
    expect(again).not.toContain('失败');
    expect(again).toContain('已经是当前可执行版本');
    expect(again).toContain(ref.version_id);
    // current 还是那一份,没被这次幂等 accept 动过
    expect(await bp()).toContain('装载着 1 份');
  });

  it('版本对得上但 content_hash 不对:仍是失败,不当成同一份', async () => {
    const { bp } = rig();
    const ref = await towerDraft(bp);
    await bp({ accept: { key: 'tower', ...ref } });

    const wrong = await bp({
      accept: { key: 'tower', version_id: ref.version_id, content_hash: '0'.repeat(64) },
    });
    expect(wrong).toContain('失败');
  });

  it('她那边报错:必须有一条「构思没成」,原因如实', async () => {
    const r = rig({ cognition: async () => ({ error: '上一件后台思考还没结束' }) });
    await r.bp({ design: { key: 'home-v2', brief: '小木屋' } });
    await waitUntil(() => r.host.events.length > 0);
    expect(r.host.events[0].text).toContain('构思没成');
    expect(r.host.events[0].text).toContain('上一件后台思考还没结束');
  });

  it('同键修订把上一版与现场初探交给 fork,完成回写保持第一人称', async () => {
    let save: ((args: Record<string, unknown>) => Promise<string>) | null = null;
    const r = rig({
      cognition: async (req) => {
        expect(req.brief).toContain('这是同键修订轮');
        expect(req.brief).toContain('上一版:retrofit');
        expect(req.brief).toContain('现场锚点(12,64,-8)');
        expect(req.brief).toContain('错块 2');
        expect(req.brief).toContain('冲突样本');
        expect(req.brief).toContain('第一人称写回');
        await save!({
          save: floorSubmission({
            site_mode: 'new', name: '改成独立农场', job_id: jobIdFromBrief(req.brief),
          }),
        });
        return { text: '我根据现场初探把它改成了独立新建方案，也重新交好了蓝图。' };
      },
    });
    save = r.bp;
    await r.bp({ save: floorSubmission({ site_mode: 'retrofit' }) });
    (r.m as any).blueprints.survey('home-v2', [12, 64, -8], {
      at: Date.now(), matched: 1, missing: 3, unknown: 0,
      wrongBlock: 2, shouldBeAir: 1, samples: ['(12,64,-8) 泥土→圆石'],
    });
    await r.bp({ design: { key: 'home-v2', brief: '根据探测结果避开旧墙，改成可独立运行的农场' } });
    await waitUntil(() => r.host.events.length > 0);
    expect(r.host.events.at(-1)?.text).toContain('我根据现场初探把它改成了独立新建方案');
    expect(await r.bp()).toContain('[空地新建]');
  });

  it('同键构思没有新 save 时不把同毫秒的旧版误认成本轮交稿', async () => {
    vi.setSystemTime(123_456);
    const r = rig({ cognition: async () => ({ text: '我只写了说明，没有调用 save。' }) });
    await r.bp({ save: floorSubmission() });
    await r.bp({ design: { key: 'home-v2', brief: '把旧版再调整一下' } });
    await waitUntil(() => r.host.events.length > 0);
    expect(r.host.events.at(-1)?.text).toContain('构思没成');
    expect(r.host.events.at(-1)?.text).toContain('没有交稿');
  });

  it('收工但一次 save 都没成 = 没交稿(判据只看装载,不看她说了什么)', async () => {
    const r = rig({ cognition: async () => ({ text: '画好了,交给你了!' }) });
    await r.bp({ design: { key: 'home-v2', brief: '小木屋' } });
    await waitUntil(() => r.host.events.length > 0);
    expect(r.host.events[0].text).toContain('构思没成');
    expect(r.host.events[0].text).toContain('一次都没成');
    expect(await r.bp()).toContain('一份蓝图都没装载');
  });

  it('随身盘点含光标上悬着的那一叠:槽位事务中途不被记成假消耗', async () => {
    // 装备时 items() 暂时缺少手持堆叠，不能据此记作 borrow 并消耗 reserve_override 预算。
    const { m } = rig();
    const inner = m as any;
    inner.bridge = {
      bot: {
        inventory: { items: () => [{ name: 'cobblestone', count: 3 }], selectedItem: { name: 'torch', count: 8 } },
        game: { dimension: 'overworld' },
      },
    };
    expect(inner.stockNow().carried).toEqual({ cobblestone: 3, torch: 8 });
    // 箱子窗开着时,光标叠在 currentWindow 上
    inner.bridge = {
      bot: {
        inventory: { items: () => [] },
        currentWindow: { selectedItem: { name: 'torch', count: 8 } },
        game: { dimension: 'overworld' },
      },
    };
    expect(inner.stockNow().carried).toEqual({ torch: 8 });
  });

  it('单实例:在途时同键或换键都拒,并说清在想哪一份', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const r = rig({ cognition: async () => { await gate; return { error: 'x' }; } });
    await r.bp({ design: { key: 'home-v2', brief: '小木屋' } });
    const second = await r.bp({ design: { key: 'shed', brief: '工具房' } });
    expect(second).toContain('「home-v2」那一份还在想');
    expect(second).toContain('一次只跑一份');
    release!();
    await waitUntil(() => r.host.events.length > 0);
  });

  it('两档都不可用:受理刻就如实说,不留一个等不到的下文', async () => {
    const r = rig();
    const receipt = await r.bp({ design: { key: 'home-v2', brief: '小木屋' } });
    expect(receipt).toContain('走不通');
    expect(receipt).toContain('这一单没受理');
    expect(r.host.events).toHaveLength(0);
  });
});

describe('data/ 缓存与两层世界性', () => {
  it('重启从缓存装回,现状一行说得出「缓存 N 份已装回」', async () => {
    const dir = tempDir();
    const first = rig({ dir });
    await first.bp({ save: floorSubmission() });
    const second = rig({ dir });
    expect(await second.bp()).toContain('home-v2');
    const line = (second.m as any).pwsr.statusLine() as string;
    expect(line).toContain('蓝图 1 份');
    expect(line).toContain('缓存 1 份已装回');
  });

  it('改造初探跨重启保留为未开工,不会被旧缓存迁移误判', async () => {
    const dir = tempDir();
    const first = rig({ dir });
    await first.bp({ save: floorSubmission({ site_mode: 'retrofit' }) });
    (first.m as any).blueprints.survey('home-v2', [12, 64, -8], {
      at: 123, matched: 1, missing: 3, unknown: 0,
      wrongBlock: 2, shouldBeAir: 1, samples: ['(12,64,-8) 泥土→圆石'],
    });
    const second = rig({ dir });
    const query = await second.bp(); // 正常工具入口先把账本切到当前 realm
    const binding = (second.m as any).blueprints.binding('home-v2');
    expect(binding).toMatchObject({
      anchor: [12, 64, -8], startedAt: null,
      survey: { wrongBlock: 2, shouldBeAir: 1 },
    });
    expect(query).toContain('初探已保存,尚未开工');
  });

  it('换世界:施工进度下桌,设计留着——两件事在同一句话里说清', async () => {
    const r = rig();
    await r.bp({ save: floorSubmission() });
    const m = r.m as any;
    m.blueprints.bind('home-v2', [10, 64, 10]);
    m.realmKey = () => 'weak:另一个世界';
    m.syncRealm();
    m.noteWorldSwitch();
    const said = r.host.events.map((e) => e.text).join('\n');
    expect(said).toContain('暂态已清');
    expect(said).toContain('1 处蓝图施工进度');
    expect(said).toContain('设计 1 份还在');
    expect(said).toContain('进度不算数');
    // 设计还在,只是这个世界里没开工
    const all = await r.bp();
    expect(all).toContain('home-v2');
    expect(all).toContain('还没开工');
  });

  it('旧世界的绑定原样留着:切回去还在(命名空间保留而非删除)', async () => {
    const r = rig();
    await r.bp({ save: floorSubmission() });
    const m = r.m as any;
    m.blueprints.bind('home-v2', [10, 64, 10]);
    m.blueprints.progress('home-v2', 1);
    const home = m.realmKey();
    m.realmKey = () => 'weak:别处';
    m.syncRealm();
    expect(m.blueprints.binding('home-v2')).toBeUndefined();
    m.realmKey = () => home;
    m.syncRealm();
    expect(m.blueprints.binding('home-v2').cursor).toBe(1);
  });

  it('前台同键 save 不能冒充后台交稿；后台自己的版本也不会覆盖期间变更的 current', async () => {
    let release: (() => void) | null = null;
    let started: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let save: Rig['bp'] | null = null;
    const r = rig({
      cognition: async (req) => {
        started!();
        await gate;
        await save!({
          save: floorSubmission({ name: '后台版本', job_id: jobIdFromBrief(req.brief) }),
        });
        return { text: '我交了后台版本。' };
      },
    });
    save = r.bp;
    await r.bp({ save: floorSubmission({ name: '起始版本' }) });
    await r.bp({ design: { key: 'home-v2', brief: '重画' } });
    await entered;
    await r.bp({
      save: floorSubmission({ name: '前台版本', palette: ['minecraft:oak_planks'] }),
    });
    release!();
    await waitUntil(() => r.host.events.length > 0);

    expect(r.host.events.at(-1)?.text).toContain('只留作 draft');
    expect(r.host.events.at(-1)?.text).toContain('没有替换可执行版本');
    expect((r.m as any).blueprints.get('home-v2').name).toBe('前台版本');
    expect(await r.bp()).toContain('后台版本');
    expect(await r.bp()).toContain('待 accept');
  });

  it('后台 job 捕获同键代次，前台 save 后 unload 回空也不能让旧 job 自动提升', async () => {
    let release: (() => void) | null = null;
    let started: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let save: Rig['bp'] | null = null;
    const r = rig({
      cognition: async (req) => {
        started!();
        await gate;
        await save!({
          save: floorSubmission({ name: '后台旧任务', job_id: jobIdFromBrief(req.brief) }),
        });
        return { text: '后台旧任务交稿。' };
      },
    });
    save = r.bp;

    await r.bp({ design: { key: 'home-v2', brief: '从空白开始画' } });
    await entered;
    await r.bp({ save: floorSubmission({ name: '前台临时版本' }) });
    expect(await r.bp({ unload: 'home-v2' })).toContain('卸了');
    release!();
    await waitUntil(() => r.host.events.length > 0);

    expect(r.host.events.at(-1)?.text).toContain('只留作 draft');
    expect(r.host.events.at(-1)?.text).toContain('保存、卸载或清空');
    expect((r.m as any).blueprints.get('home-v2')).toBeUndefined();
    expect(await r.bp()).toContain('后台旧任务');
    expect(await r.bp()).toContain('待 accept');
  });

  it('同一世界的主世界与下界分别保留锚点和施工游标', () => {
    const file = join(tempDir(), 'minecraft-blueprints.json');
    const accepted = acceptBlueprint(floorSubmission());
    const book = new BlueprintBook(file);
    book.save({ key: 'home-v2', name: null }, {
      blueprint: accepted.blueprint!, plan: accepted.plan!, metrics: accepted.metrics!,
    });

    book.useRealm('realm-a', 'overworld');
    book.bind('home-v2', [10, 64, 10], 1000);
    book.progress('home-v2', 1);
    expect(book.binding('home-v2')).toMatchObject({
      dimension: 'minecraft:overworld', anchor: [10, 64, 10], cursor: 1,
    });

    book.useRealm('realm-a', 'the_nether');
    expect(book.binding('home-v2')).toBeUndefined();
    expect(book.noteOf('home-v2')).toContain('还没开工');
    book.bind('home-v2', [-3, 70, 1], 2000);
    expect(book.binding('home-v2')).toMatchObject({
      dimension: 'minecraft:the_nether', anchor: [-3, 70, 1], cursor: 0,
    });

    const restored = new BlueprintBook(file);
    restored.useRealm('realm-a', 'overworld');
    expect(restored.binding('home-v2')).toMatchObject({ anchor: [10, 64, 10], cursor: 1 });
    restored.useRealm('realm-a', 'minecraft:the_nether');
    expect(restored.binding('home-v2')).toMatchObject({ anchor: [-3, 70, 1], cursor: 0 });
  });

  it('「清除所有数据」清得掉缓存文件', async () => {
    const r = rig();
    await r.bp({ save: floorSubmission() });
    const part = (r.m.webUi().storage ?? []).find((p) => p.key === 'minecraft-blueprints')!;
    expect(part.stat()).toContain('1 份');
    expect(await part.clear()).toContain('已清空');
    expect(readFileSync(join(r.dir, 'minecraft-blueprints.json'), 'utf8')).not.toContain('home-v2');
    expect(await r.bp()).toContain('一份蓝图都没装载');
  });

  it('缓存里过不了校验的那一份不装回,别的照装', () => {
    const dir = tempDir();
    const file = join(dir, 'bp.json');
    const good = acceptBlueprint(floorSubmission());
    const book = new BlueprintBook(file);
    book.save({ key: 'home-v2', name: null }, {
      blueprint: good.blueprint!, plan: good.plan!, metrics: good.metrics!,
    });
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { designs: unknown[] };
    raw.designs.push({
      key: 'broken', name: null, savedAt: 1, size_xyz: [1, 1, 1], axis_order: 'YZX',
      palette: ['minecraft:not_a_block'], layers: [[[0]]],
    });
    writeFileSync(file, JSON.stringify(raw), 'utf8');
    const back = new BlueprintBook(file);
    expect(back.keys()).toEqual(['home-v2']);
  });

  it('encodeBlueprint 往返:palette 编码存下去、原路读回来还是同一份', () => {
    const accepted = acceptBlueprint(twoLayerSubmission());
    const encoded = encodeBlueprint(accepted.blueprint!);
    expect(encoded.palette).toHaveLength(2);
    const again = acceptBlueprint({ key: 'tower', ...encoded });
    expect(again.ok).toBe(true);
    expect(again.blueprint!.layers).toEqual(accepted.blueprint!.layers);
  });

  it('缓存保存并恢复不可变 version id 与内容 hash', () => {
    const file = join(tempDir(), 'minecraft-blueprints.json');
    const accepted = acceptBlueprint(floorSubmission());
    const book = new BlueprintBook(file);
    const saved = book.save({ key: 'home-v2', name: null }, {
      blueprint: accepted.blueprint!, plan: accepted.plan!, metrics: accepted.metrics!,
    });
    expect(saved.versionId).toMatch(/^bpv_/);
    expect(saved.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const restored = new BlueprintBook(file).get('home-v2')!;
    expect(restored.versionId).toBe(saved.versionId);
    expect(restored.contentHash).toBe(saved.contentHash);
  });

  it('材料临时覆盖要求 reason/TTL/max 三项，未借料时不谎报需补料', async () => {
    const r = rig();
    const bp = r.bp;
    await bp({ save: floorSubmission({ palette: ['minecraft:glass'] }) });
    // reserve 只对开工的图生效:存了图不动土不锁料,所以这里先绑锚点开工
    startBlueprint(r.m, 'home-v2');
    expect(await bp({ reserve_override: { ttl_sec: 30, max_blocks: 4 } }))
      .toContain('reason');
    const opened = await bp({
      reserve_override: { reason: '两血时先垫出水面', ttl_sec: 30, max_blocks: 4 },
    });
    expect(opened).toContain('最多借 4 块');
    expect(opened).toContain('首次实际借料后才会标记“需补料”');
    expect(await bp()).toContain('材料临时覆盖');
    expect(await bp()).not.toContain('需补料:');
  });

  it('模块放置 permit 先用库存盈余，进入 reserve 后逐块扣临时覆盖并收口', async () => {
    const r = rig();
    const stock = { glass: 5 };
    const bot = {
      inventory: {
        items: () => Object.entries(stock).map(([name, count]) => ({ name, count })),
      },
      game: { dimension: 'overworld' },
    };
    const retune = vi.fn();
    const m = r.m as any;
    m.bridge = { bot, retune };
    await r.bp({ save: floorSubmission({ palette: ['minecraft:glass'] }) });
    startBlueprint(r.m, 'home-v2');
    m.observeBlueprintResources();

    const surplus = m.permitBlueprintResourcePlacement('glass');
    expect(surplus.ok).toBe(true);
    expect(m.permitBlueprintResourcePlacement('glass')).toMatchObject({
      ok: false, reason: '上一块材料还在结算,这次放置稍后再试',
    });
    stock.glass = 4;
    surplus.finish(true);
    expect(m.permitBlueprintResourcePlacement('glass')).toMatchObject({ ok: false });

    await r.bp({
      reserve_override: { reason: '两血时先垫出水面', ttl_sec: 30, max_blocks: 1 },
    });
    const emergency = m.permitBlueprintResourcePlacement('glass');
    expect(emergency.ok).toBe(true);
    stock.glass = 3;
    emergency.finish(true);

    expect(m.blueprintResources.activeOverride()).toBeNull();
    expect(m.blueprintResources.restockMarkers().at(-1)).toMatchObject({
      reason: '两血时先垫出水面', borrowed: { glass: 1 },
    });
    expect(m.permitBlueprintResourcePlacement('glass')).toMatchObject({ ok: false });
    expect(retune).toHaveBeenCalled();
  });

  it('蓝图同步撞上库存跨线:同一拍完成借料记账、诊断与候选重调', async () => {
    const r = rig();
    const stock = { glass: 5 };
    const retune = vi.fn();
    const m = r.m as any;
    m.bridge = {
      bot: {
        inventory: { items: () => [{ name: 'glass', count: stock.glass }] },
        game: { dimension: 'overworld' },
      },
      retune,
    };
    await r.bp({ save: floorSubmission({ palette: ['minecraft:glass'] }) });
    startBlueprint(r.m, 'home-v2');
    await r.bp({
      reserve_override: { reason: '撤离时临时垫脚', ttl_sec: 30, max_blocks: 2 },
    });
    retune.mockClear();

    stock.glass = 3;
    m.syncBlueprintResources();

    expect(retune).toHaveBeenCalledOnce();
    expect(m.blueprintResources.restockMarkers().at(-1)).toMatchObject({
      reason: '撤离时临时垫脚', borrowed: { glass: 1 },
    });
    expect(m.diag.after(0).filter((entry: { event: string }) => entry.event === 'blueprint-reserve-borrow'))
      .toHaveLength(1);
  });

  it('槽位交换的中间态不触发 reserve 重调或借料，安静后只观察最终库存', async () => {
    const r = rig();
    await r.bp({ save: floorSubmission({ palette: ['minecraft:glass'] }) });
    startBlueprint(r.m, 'home-v2');
    const stock = { glass: 4 };
    let onUpdate: (() => void) | null = null;
    const retune = vi.fn();
    const bot = {
      inventory: {
        items: () => stock.glass > 0 ? [{ name: 'glass', count: stock.glass }] : [],
        on: (event: string, handler: () => void) => { if (event === 'updateSlot') onUpdate = handler; },
      },
      game: { dimension: 'overworld' },
      on: () => {},
      _client: { on: () => {} },
    };
    const m = r.m as any;
    m.bridge = { bot, retune };
    m.observeBlueprintResources();
    m.hookBotEvents(bot);
    retune.mockClear();

    stock.glass = 0;
    onUpdate!();
    await vi.advanceTimersByTimeAsync(200);
    stock.glass = 4;
    onUpdate!();
    await vi.advanceTimersByTimeAsync(600);

    expect(retune).not.toHaveBeenCalled();
    expect(m.blueprintResources.restockMarkers()).toEqual([]);

    stock.glass = 5;
    onUpdate!();
    await vi.advanceTimersByTimeAsync(600);
    expect(retune).toHaveBeenCalledOnce();
  });
});

// 垫脚名单的唯一事实源

/**
 * 夹具下层含 dirt、cobblestone、oak_planks、sandstone 各一格，上层四格 sandstone。
 * sandstone 模拟自定义垫脚料；蓝图 reserve 的豁免依据当前生效的垫脚名单。
 */
function mixedSubmission(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'yard',
    site_mode: 'new',
    size_xyz: [2, 2, 2],
    axis_order: 'YZX',
    palette: [
      'minecraft:dirt', 'minecraft:cobblestone', 'minecraft:oak_planks', 'minecraft:sandstone',
    ],
    layers: [[[0, 1], [2, 3]], [[3, 3], [3, 3]]],
    ...over,
  };
}

const YARD_SCAFFOLD = ['dirt', 'cobblestone', 'oak_planks', 'jungle_planks', 'sandstone'];

function stockedRig(stock: Record<string, number>): Rig & { inner: any; retune: ReturnType<typeof vi.fn> } {
  const r = rig();
  const retune = vi.fn();
  const inner = r.m as any;
  inner.bridge = {
    bot: {
      inventory: { items: () => Object.entries(stock).map(([name, count]) => ({ name, count })) },
      game: { dimension: 'overworld' },
    },
    retune,
  };
  return { ...r, inner, retune };
}

function policyLine(m: MinecraftWorld): string {
  return (m.envPromptVars() as Record<string, string>)['minecraft.policy'];
}

async function setScaffold(m: MinecraftWorld, list: string[]): Promise<void> {
  const tools = Object.fromEntries(m.tools().map((t) => [t.name, t]));
  await tools.mc_policy.handler({ scaffold: list }, ctx);
}

describe('蓝图 reserve 与垫脚名单只有一个事实源', () => {
  it('存了图没开工:策略文本、寻路器名单、逐块 permit 三者说同一件事(全部放行)', async () => {
    const r = stockedRig({ dirt: 8, cobblestone: 8, oak_planks: 16, sandstone: 4 });
    await setScaffold(r.m, YARD_SCAFFOLD);
    await r.bp({ save: mixedSubmission() });
    r.inner.syncBlueprintResources();

    // (a) 她读到的策略文本:名单原样,没有任何一样标成蓝图预留
    const line = policyLine(r.m);
    expect(line).toContain('砂岩');
    expect(line).not.toContain('蓝图预留');
    // (b) 寻路器拿到的名单:一样都不少,顺序即优先
    expect(r.inner.scaffoldBlocksForUse()).toEqual(YARD_SCAFFOLD);
    // (c) 逐块 permit:未开工不锁料
    const dirt = r.inner.permitBlueprintResourcePlacement('dirt');
    expect(dirt.ok).toBe(true);
    dirt.finish();
    const sandstone = r.inner.permitBlueprintResourcePlacement('sandstone');
    expect(sandstone.ok).toBe(true);
    sandstone.finish();
    expect(r.inner.blueprintResources.reserve()).toEqual({});
  });

  it('开工后:名单外的材料 permit 硬否决;把它加进垫脚名单当场放行(豁免集与名单同源)', async () => {
    const r = stockedRig({ dirt: 8, cobblestone: 8, oak_planks: 16, sandstone: 4 });
    const withoutSandstone = YARD_SCAFFOLD.filter((item) => item !== 'sandstone');
    await setScaffold(r.m, withoutSandstone);
    await r.bp({ save: mixedSubmission() });
    startBlueprint(r.m, 'yard');

    // 砂岩不在当前垫脚名单里:剩余需求 5 > 随身 4,进入收口
    const permit = r.inner.permitBlueprintResourcePlacement('sandstone');
    expect(permit.ok).toBe(false);
    expect(permit.reason).toContain('reserve_override');
    // 名单里的那几样一律不进 reserve,名单本身也不缩水
    expect(r.inner.scaffoldBlocksForUse()).toEqual(withoutSandstone);
    for (const item of withoutSandstone) {
      const permitted = r.inner.permitBlueprintResourcePlacement(item);
      expect(permitted.ok).toBe(true);
      permitted.finish();
    }

    // 她把垫脚料改成砂岩:硬编码豁免时代砂岩照锁,现在当场放行(同一个名单同一个事实)
    await setScaffold(r.m, [...withoutSandstone, 'sandstone']);
    const again = r.inner.permitBlueprintResourcePlacement('sandstone');
    expect(again.ok).toBe(true);
    again.finish();
    expect(r.inner.blueprintResources.reserve()).toEqual({});
  });

  it('箱子里囤够蓝图所需时,随身同名物不再被收口;不够则按差额收口', async () => {
    const r = stockedRig({ sandstone: 4 });
    await setScaffold(r.m, ['dirt']);
    await r.bp({ save: mixedSubmission() });
    startBlueprint(r.m, 'yard');
    expect(r.inner.blueprintResources.reserve()).toMatchObject({ sandstone: 5 });
    expect(r.inner.permitBlueprintResourcePlacement('sandstone').ok).toBe(false);

    // 箱子里 5 块砂岩正好覆盖剩余需求:随身那 4 块可以自由垫脚
    r.inner.chests.remember('overworld', { x: 10, y: 64, z: 10 }, [{ name: 'sandstone', count: 5 }], 1, 27);
    expect(r.inner.blueprintResources.reserve()).not.toHaveProperty('sandstone');
    const permit = r.inner.permitBlueprintResourcePlacement('sandstone');
    expect(permit.ok).toBe(true);
    permit.finish();

    // 箱子只剩 3 块:差额 2 仍收口(随身 4 > 2,还有盈余可用)
    r.inner.chests.remember('overworld', { x: 10, y: 64, z: 10 }, [{ name: 'sandstone', count: 3 }], 1, 27);
    expect(r.inner.blueprintResources.reserve()).toMatchObject({ sandstone: 2 });
  });

  it('垫脚名单只剩收口那一样时也不返回空数组(空名单只该出自她自己关掉 scaffold)', async () => {
    const r = stockedRig({ sandstone: 4 });
    await setScaffold(r.m, ['sandstone']);
    await r.bp({ save: mixedSubmission() });
    startBlueprint(r.m, 'yard');

    expect(r.inner.scaffoldBlocksForUse()).toEqual(['sandstone']);
    await setScaffold(r.m, []);
    expect(r.inner.scaffoldBlocksForUse()).toEqual([]);
  });

  it('换世界后不按 cursor=0 全额锁料:另一个世界的施工绑定不算这边的预留', async () => {
    const r = stockedRig({ sandstone: 4 });
    await r.bp({ save: mixedSubmission() });
    startBlueprint(r.m, 'yard');
    // 没设过名单 = 寻路器默认那份(泥土、圆石);木板不在里面,所以照锁
    expect(r.inner.blueprintResources.reserve()).toEqual({ sandstone: 5, oak_planks: 1 });

    r.inner.blueprints.useRealm('另一个世界');
    r.inner.syncBlueprintResources();
    expect(r.inner.blueprintResources.reserve()).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// goalLine 联动
// ---------------------------------------------------------------------------

describe('目标行上的蓝图进度', () => {
  it('没装载报「待装载」;装载后报进度与缺料', async () => {
    const r = rig();
    expect(await r.goal({ add: { plan: [{ do: '验收', judgment: '现场确认目标完成' }], text: '盖新家', blueprint: 'home-v2' } }))
      .toContain('(蓝图 home-v2:待装载)');
    await r.bp({ save: floorSubmission() });
    expect(await r.goal()).toContain('(蓝图 home-v2:已装载,还没开工,还缺圆石 4)');
    (r.m as any).blueprints.bind('home-v2', [0, 64, 0]);
    (r.m as any).blueprints.progress('home-v2', 1);
    expect(await r.goal()).toContain('已施工完');
  });

  it('只清场不放方块的陷阱蓝图，正式开工后也报已施工完', () => {
    const accepted = acceptBlueprint({
      key: 'trap-pit', site_mode: 'new', size_xyz: [1, 1, 1], axis_order: 'YZX',
      palette: ['minecraft:air'], layers: [[[0]]],
    });
    const book = new BlueprintBook(null);
    book.useRealm('realm');
    book.save({ key: 'trap-pit', name: null }, {
      blueprint: accepted.blueprint!, plan: accepted.plan!, metrics: accepted.metrics!,
    });
    book.bind('trap-pit', [0, 64, 0]);
    // 游标不回读世界:这个数是什么时候的,写在字面上
    expect(book.noteOf('trap-pit')).toBe('已施工完(截至上次施工)');
  });
});

// ---------------------------------------------------------------------------
// build 集成
// ---------------------------------------------------------------------------

/** 立体假世界:y=63 一层石头地板,放下去的方块回读得到 */
function worldBot(opts: {
  stock?: Record<string, number>;
  unloaded?: string[];
  blocks?: Record<string, string>;
  /** 每挖掉一格之后世界还会自己变什么(草蔓延就是这个形状) */
  onDig?: (dug: string, put: (key: string, name: string) => void) => void;
} = {}) {
  const solid = new Set<string>();
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) solid.add(`${x},63,${z}`);
  const placed = new Map<string, string>();
  const properties = new Map<string, Record<string, boolean | number | string>>();
  for (const [key, state] of Object.entries(opts.blocks ?? {})) {
    const bracket = state.indexOf('[');
    const name = state.slice(0, bracket === -1 ? undefined : bracket).replace('minecraft:', '');
    placed.set(key, name);
    solid.add(key);
    if (bracket !== -1) {
      properties.set(key, Object.fromEntries(state.slice(bracket + 1, -1).split(',').map((pair) => {
        const [name, value] = pair.split('=', 2);
        return [name, /^\d+$/.test(value) ? Number(value) : value === 'true' ? true : value === 'false' ? false : value];
      })));
    }
  }
  const unloaded = new Set(opts.unloaded ?? []);
  const bag = Object.entries(opts.stock ?? { cobblestone: 64 })
    .map(([name, count], i) => ({ name, count, type: 100 + i }));
  const keyOf = (x: number, y: number, z: number): string => `${x},${y},${z}`;
  let aim: { x: number; y: number; z: number } | null = null;
  const bot = {
    placedAt: [] as string[],
    dugAt: [] as string[],
    blockName: (key: string) => placed.get(key) ?? (solid.has(key) ? 'stone' : 'air'),
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), onGround: true },
    entities: {},
    health: 20,
    food: 20,
    players: {},
    game: { dimension: 'overworld' },
    // itemsByName/blocksByName 是材料名判据要问的两张表(真 bot 上一定有)
    registry: { blocksByName: {}, itemsByName: {}, items: {} },
    inventory: { items: () => bag.filter((b) => b.count > 0) },
    heldItem: null as null | { name: string; count: number; type: number },
    // build 按 material 挑手上那件;假 bot 让 placeBlock 用"排在最前面且有货"的那件
    equip: async (item: { name: string }) => {
      const hit = bag.findIndex((b) => b.name === item.name);
      if (hit > 0) bag.unshift(...bag.splice(hit, 1));
      bot.heldItem = bag.find((entry) => entry.name === item.name) ?? null;
    },
    // 瞄哪儿决定「使用物品」落在哪一格,记下来给 activateItem 用
    lookAt: async (p: { x: number; y: number; z: number }) => { aim = p; },
    setControlState: () => {},
    blockAt: (p: { x: number; y: number; z: number }) => {
      const k = keyOf(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      if (unloaded.has(k)) return null;
      const name = placed.get(k) ?? (solid.has(k) ? 'stone' : 'air');
      return {
        name,
        position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
        boundingBox: name === 'air' || name === 'water' || name === 'wheat' ? 'empty' : 'block',
        diggable: true,
        stateId: `${name}:${JSON.stringify(properties.get(k) ?? {})}`,
        getProperties: () => properties.get(k) ?? {},
        canHarvest: () => true,
      };
    },
    placeBlock: async (ref: { position: { x: number; y: number; z: number } }, face: { x: number; y: number; z: number }) => {
      const held = bot.heldItem ?? bag.find((b) => b.count > 0)!;
      const spot = keyOf(
        Math.floor(ref.position.x) + face.x,
        Math.floor(ref.position.y) + face.y,
        Math.floor(ref.position.z) + face.z,
      );
      solid.add(spot);
      placed.set(spot, held.name);
      const defaults: Record<string, Record<string, boolean | number | string>> = {
        repeater: { delay: 1, facing: 'north', locked: false, powered: false },
        lever: { face: 'floor', facing: 'north', powered: false },
      };
      properties.set(spot, defaults[held.name] ?? {});
      bot.placedAt.push(spot);
      held.count--;
    },
    canDigBlock: () => true,
    digTime: () => 20,
    stopDigging: () => {},
    dig: async (block: { position: { x: number; y: number; z: number } }) => {
      const key = keyOf(block.position.x, block.position.y, block.position.z);
      placed.delete(key);
      properties.delete(key);
      solid.delete(key);
      bot.dugAt.push(key);
      opts.onDig?.(key, (at, name) => { placed.set(at, name); solid.add(at); });
    },
    activateBlock: async (block: { name: string; position: { x: number; y: number; z: number } }) => {
      const key = keyOf(block.position.x, block.position.y, block.position.z);
      const held = bot.heldItem?.name ?? null;
      if (block.name === 'repeater') {
        const state = properties.get(key) ?? {};
        state.delay = (Number(state.delay ?? 1) % 4) + 1;
        properties.set(key, state);
        return;
      }
      if (block.name === 'lever') {
        const state = properties.get(key) ?? {};
        state.powered = state.powered !== true;
        properties.set(key, state);
        return;
      }
      if (held?.endsWith('_hoe')) {
        placed.set(key, 'farmland');
        properties.set(key, { moisture: 0 });
        return;
      }
      if (held?.endsWith('_shovel')) {
        placed.set(key, 'dirt_path');
        properties.set(key, {});
        return;
      }
      const crops: Record<string, string> = {
        wheat_seeds: 'wheat', beetroot_seeds: 'beetroots', carrot: 'carrots', potato: 'potatoes',
      };
      if (held && crops[held]) {
        const cropKey = keyOf(block.position.x, block.position.y + 1, block.position.z);
        placed.set(cropKey, crops[held]);
        properties.set(cropKey, { age: 0 });
        const item = bag.find((entry) => entry.name === held);
        if (item) item.count--;
        return;
      }
    },
    // 满桶走的是「使用物品」而不是「对方块使用」:原版 BucketItem 只实现了 use(),
    // 服务端拿玩家视线自己做射线,液体落在瞄到的那一格。看准之后要等一个物理 tick
    // 让朝向包先发出去(aimThenUse),假 bot 的 tick 立刻返回
    waitForTicks: async () => {},
    activateItem: async () => {
      const held = bot.heldItem?.name ?? null;
      if (aim === null || (held !== 'water_bucket' && held !== 'lava_bucket')) return;
      const liquidKey = keyOf(Math.floor(aim.x), Math.floor(aim.y), Math.floor(aim.z));
      placed.set(liquidKey, held.replace('_bucket', ''));
      properties.set(liquidKey, { level: 0 });
      const full = bag.find((entry) => entry.name === held);
      if (full) full.count--;
      const empty = bag.find((entry) => entry.name === 'bucket');
      if (empty) empty.count++;
      else bag.push({ name: 'bucket', count: 1, type: 999 });
    },
    closeWindow: () => {},
    pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
  };
  return bot;
}

/** 内存版施工面:BlueprintBook 的最小替身,断言 bind/progress 有没有被写 */
function fakeDesk(submissions: Array<Record<string, unknown>>): BlueprintDesk & {
  bound: Array<[string, number[]]>;
  surveyed: Array<[string, number[]]>;
  cursors: Array<[string, number]>;
} {
  const sites = new Map<string, {
    key: string; name: string | null;
    blueprint: NonNullable<ReturnType<typeof acceptBlueprint>['blueprint']>;
    plan: NonNullable<ReturnType<typeof acceptBlueprint>['plan']>;
    anchor: [number, number, number] | null;
    cursor: number;
    survey: import('../../../src/worlds/minecraft/executor.ts').BlueprintSurvey | null;
    startedAt: number | null;
  }>();
  for (const submission of submissions) {
    const accepted = acceptBlueprint(submission);
    if (!accepted.ok) throw new Error(`台架蓝图自己就过不了:${accepted.failures[0]?.reason}`);
    const key = String(submission.key);
    sites.set(key, {
      key, name: null, blueprint: accepted.blueprint!, plan: accepted.plan!, anchor: null, cursor: 0,
      survey: null, startedAt: null,
    });
  }
  const desk = {
    bound: [] as Array<[string, number[]]>,
    surveyed: [] as Array<[string, number[]]>,
    cursors: [] as Array<[string, number]>,
    get: (key: string) => sites.get(key) ?? null,
    keys: () => [...sites.keys()],
    activeKey: () => (sites.size === 1 ? [...sites.keys()][0] : null),
    bind: (key: string, anchor: [number, number, number]) => {
      const site = sites.get(key);
      if (site) { site.anchor = anchor; site.cursor = 0; site.startedAt = Date.now(); }
      desk.bound.push([key, [...anchor]]);
    },
    survey: (key: string, anchor: [number, number, number], result: import('../../../src/worlds/minecraft/executor.ts').BlueprintSurvey) => {
      const site = sites.get(key);
      if (site) { site.anchor = anchor; site.cursor = 0; site.survey = result; site.startedAt = null; }
      desk.surveyed.push([key, [...anchor]]);
    },
    progress: (key: string, cursor: number) => {
      const site = sites.get(key);
      if (site) site.cursor = cursor;
      desk.cursors.push([key, cursor]);
    },
    stored: () => ({}),
  };
  return desk as unknown as BlueprintDesk & {
    bound: Array<[string, number[]]>;
    surveyed: Array<[string, number[]]>;
    cursors: Array<[string, number]>;
  };
}

function execOn(bot: unknown, desk?: BlueprintDesk) {
  const reports: TaskReport[] = [];
  let seq = 0;
  const exec = new Executor({
    getBot: () => bot as never,
    report: (r) => reports.push(r),
    log,
    nextId: () => ++seq,
    ...(desk ? { blueprints: () => desk } : {}),
  });
  return { exec, reports };
}

describe('build 的蓝图形态', () => {
  it('没装载:不动工,回执指路', async () => {
    const { exec, reports } = execOn(worldBot(), fakeDesk([]));
    exec.submit([{ skill: 'build', blueprint: 'home-v2', at: [0, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('没装载');
    expect(reports[0].text).toContain('design 重新出一张图');
  });

  it('第一次没给锚点:如实说要 at,不猜一个', async () => {
    const { exec, reports } = execOn(worldBot(), fakeDesk([floorSubmission()]));
    exec.submit([{ skill: 'build', blueprint: 'home-v2' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('要给 at');
  });

  it('首次给锚点:登记绑定、逐步盖完、回读逐格全同,游标写回', async () => {
    const desk = fakeDesk([floorSubmission()]);
    const bot = worldBot();
    const { exec, reports } = execOn(bot, desk);
    exec.submit([{ skill: 'build', blueprint: 'home-v2', at: [0, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 15000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('我这一趟放上了 1 步');
    expect(reports[0].text).toContain('游标到 1/1');
    expect(reports[0].text).toContain('整张图施工完了');
    // 游标没落后于放上的步数就不挂那句解释,免得没矛盾的时候先教一遍口径
    expect(reports[0].text).not.toContain('游标卡在');
    expect(reports[0].text).toContain('回读 4/4 格逐格全同');
    expect(desk.bound).toEqual([['home-v2', [0, 64, 0]]]);
    expect(desk.cursors.at(-1)).toEqual(['home-v2', 1]);
    expect(bot.placedAt).toHaveLength(4);
  });

  it('续建省 at:从绑定取锚点,已经对上的格子跳过', async () => {
    const desk = fakeDesk([floorSubmission()]);
    const bot = worldBot();
    const { exec, reports } = execOn(bot, desk);
    exec.submit([{ skill: 'build', blueprint: 'home-v2', at: [0, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 15000);
    exec.submit([{ skill: 'build', blueprint: 'home-v2' }]);
    await waitUntil(() => reports.length === 2, 15000);
    expect(reports[1].kind).toBe('done');
    expect(reports[1].text).toContain('锚点 (0, 64, 0)');
    expect(reports[1].text).toContain('已经跟世界对上了');
    expect(reports[1].text).toContain('我没有改动方块');
    expect(bot.placedAt).toHaveLength(4); // 第二单一块都没再放
  });

  it('料尽:自然收束成「做了一部分」,报游标与还缺什么', async () => {
    const desk = fakeDesk([floorSubmission()]);
    const bot = worldBot({ stock: { cobblestone: 2 } });
    const { exec, reports } = execOn(bot, desk);
    exec.submit([{ skill: 'build', blueprint: 'home-v2', at: [0, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 15000);
    expect(reports[0].kind).toBe('partial');
    // 停在哪一步、那一步差哪几格,原样来自内层的标准 build 回执
    expect(reports[0].text).toContain('第 1/1 步(圆石 (0, 64, 0)–(1, 64, 1))只放上一部分');
    expect(reports[0].text).toContain('还差 2 处没放上');
    expect(reports[0].text).toContain('游标到 0/1');
    expect(reports[0].text).toContain('圆石 要 4(随身 0、在箱 0、还缺 4)');
    expect(reports[0].text).toContain('还差 1 步没完成');
  });


  it('一步缺料只跳过这一步,后面盖得动的照盖,收工汇总没推进的步', async () => {
    const mixed = {
      key: 'mixed', site_mode: 'new', size_xyz: [2, 1, 1], axis_order: 'YZX',
      palette: ['minecraft:cobblestone', 'minecraft:oak_planks'], layers: [[[0, 1]]],
    };
    const desk = fakeDesk([mixed]);
    const bot = worldBot({ stock: { oak_planks: 8 } });
    const { exec, reports } = execOn(bot, desk);
    exec.submit([{ skill: 'build', blueprint: 'mixed', at: [0, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 15000);
    expect(reports[0].kind).toBe('partial');
    expect(reports[0].text).toContain('我这一趟放上了 1 步');
    expect(reports[0].text).toContain('没推进 1 步');
    expect(reports[0].text).toContain('包里没有圆石');
    // `placed` 数的是整个索引空间、不要求连续,`cursor` 是连续前缀:第 1 步没成、
    // 第 2 步成了,两个数就必然对不上。并排放读起来像「做了 1 步进度却是 0」,
    // 所以要点名放上的是第几步,并说破游标卡在哪一步
    expect(reports[0].text).toContain('我这一趟放上了 1 步(第 2 步)');
    expect(reports[0].text).toContain('游标到 0/2');
    expect(reports[0].text).toContain('游标卡在第 1 步没做成上');
    expect(bot.placedAt).toEqual(['1,64,0']);
  });

  it('连着 5 步没推进就提前收工:不对着同一处障碍空转到底', async () => {
    const alternating = {
      key: 'alt', site_mode: 'new', size_xyz: [6, 1, 1], axis_order: 'YZX',
      palette: ['minecraft:cobblestone', 'minecraft:oak_planks', 'minecraft:stone'],
      layers: [[[0, 1, 0, 1, 0, 2]]],
    };
    const desk = fakeDesk([alternating]);
    const bot = worldBot({ stock: { stone: 8 } });
    const { exec, reports } = execOn(bot, desk);
    exec.submit([{ skill: 'build', blueprint: 'alt', at: [0, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 20000);
    expect(reports[0].text).toContain('连着 5 步没推进,先收工');
    // 第 6 步够料,但没轮到:提前收工的意思就是这一趟不再往下走
    expect(bot.placedAt).toEqual([]);
  });

  it('stopAfter 按 y 层截断:终态说停在第几层', async () => {
    const desk = fakeDesk([twoLayerSubmission()]);
    const bot = worldBot({ stock: { cobblestone: 8, oak_planks: 8 } });
    const { exec, reports } = execOn(bot, desk);
    exec.submit([{ skill: 'build', blueprint: 'tower', at: [0, 64, 0], stopAfter: 0 }]);
    await waitUntil(() => reports.length === 1, 15000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('按你说的停在第 0 层');
    expect(reports[0].text).toContain('游标到 1/2');
    expect(bot.placedAt).toEqual(['0,64,0']);
  });

  it('区块没加载的格子如实说:不当已建也不当缺', async () => {
    const desk = fakeDesk([floorSubmission()]);
    const bot = worldBot({ unloaded: ['1,64,1'] });
    const { exec, reports } = execOn(bot, desk);
    exec.submit([{ skill: 'build', blueprint: 'home-v2', at: [0, 64, 0], dryRun: true }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('区块没加载');
    expect(reports[0].text).toContain('既没算已建也没算还缺');
  });

  it('回读认得出 state 漂:type 对、属性不同,如实报 drift 不当失败', async () => {
    const stairs = {
      key: 'steps', site_mode: 'new', size_xyz: [1, 1, 1], axis_order: 'YZX',
      palette: ['minecraft:oak_stairs[facing=north]'], layers: [[[0]]],
    };
    const desk = fakeDesk([stairs]);
    const bot = worldBot({ stock: { oak_stairs: 4 } });
    const { exec, reports } = execOn(bot, desk);
    exec.submit([{ skill: 'build', blueprint: 'steps', at: [0, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 15000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('drift 1');
    expect(reports[0].text).not.toContain('失败 1');
  });

  /**
   * 栅栏与门的连接面由服务端按邻接自动计算，放置方不能指定；回读时不作为漂移。
   */
  it('回读不比邻接自算的属性:连接面不同不算漂', async () => {
    const fence = {
      key: 'fence', site_mode: 'new', size_xyz: [1, 1, 1], axis_order: 'YZX',
      palette: ['minecraft:oak_fence'], layers: [[[0]]],
    };
    const desk = fakeDesk([fence]);
    const bot = worldBot({ stock: { oak_fence: 4 } });
    const read = bot.blockAt;
    bot.blockAt = (p: { x: number; y: number; z: number }) => {
      const b = read(p);
      // 放下去之后服务端把四个连接面算好推回来:图纸那一侧是 north=false
      return b?.name === 'oak_fence'
        ? {
            ...b,
            getProperties: () => ({
              east: 'false', north: 'true', south: 'false', west: 'false', waterlogged: 'false',
            }),
          }
        : b;
    };
    const { exec, reports } = execOn(bot, desk);
    exec.submit([{ skill: 'build', blueprint: 'fence', at: [0, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 15000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('回读 1/1 格逐格全同');
    expect(reports[0].text).not.toContain('drift');
    expect(reports[0].text).toContain('整张图施工完了');
  });

  it('dryRun:三分账单 + 能连着施工到第几步,一块不动', async () => {
    const desk = fakeDesk([floorSubmission()]);
    const bot = worldBot({ stock: { cobblestone: 1 } });
    const { exec, reports } = execOn(bot, desk);
    exec.submit([{ skill: 'build', blueprint: 'home-v2', at: [0, 64, 0], dryRun: true }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('试算');
    expect(reports[0].text).toContain('随身 1、在箱 0、还缺 3');
    expect(reports[0].text).toContain('一步都不够');
    expect(reports[0].text).toContain('逐层图');
    expect(reports[0].text).toContain('没动工');
    expect(bot.placedAt).toHaveLength(0);
    expect(desk.bound).toHaveLength(0); // 试算不登记锚点
  });

  it('dryRun 也摆出靠现场满足的那几条:动工前唯一一次核对的机会', async () => {
    const desk = fakeDesk([cropSubmission()]);
    const bot = worldBot({ stock: { melon_seeds: 1 } });
    const { exec, reports } = execOn(bot, desk);
    exec.submit([{ skill: 'build', blueprint: 'melon-row', at: [0, 64, 0], dryRun: true }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('这几条得靠现场满足');
    expect(reports[0].text).toContain('支撑那一格不在图里');
  });

  it('new:先清明确空气格,structure_void 保留现场,并提醒登记工地路标', async () => {
    const pit = {
      key: 'trap-pit', site_mode: 'new', size_xyz: [2, 1, 1], axis_order: 'YZX',
      palette: ['minecraft:air', 'minecraft:structure_void'], layers: [[[0, 1]]],
    };
    const desk = fakeDesk([pit]);
    const bot = worldBot({ blocks: { '0,64,0': 'minecraft:dirt', '1,64,0': 'minecraft:oak_log' } });
    const { exec, reports } = execOn(bot, desk);
    // 冲突确认闸适用于所有工地模式，new 图第一次施工也须审阅冲突。
    exec.submit([{ skill: 'build', blueprint: 'trap-pit', at: [0, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 15000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('多出 1 个冲突格');
    expect(reports[0].text).toContain('confirm:true');
    expect(bot.blockName('0,64,0')).toBe('dirt');
    expect(desk.bound).toEqual([]);

    exec.submit([{ skill: 'build', blueprint: 'trap-pit', at: [0, 64, 0], confirm: true }]);
    await waitUntil(() => reports.length === 2, 15000);
    expect(reports[1].kind).toBe('done');
    expect(reports[1].text).toContain('清掉了 1 个冲突格');
    expect(reports[1].text).toContain('mc_map 的 set');
    expect(reports[1].text).toContain('我已经把开工位置写入施工绑定');
    expect(reports[1].text).not.toContain('没动工');
    expect(bot.blockName('0,64,0')).toBe('air');
    expect(bot.blockName('1,64,0')).toBe('oak_log');
    expect(desk.bound).toEqual([['trap-pit', [0, 64, 0]]]);
  });

  /**
   * 清场过程不补光，避免火把重新占据刚清空的目标格。
   */
  it('清场路上不补光:黑着也不往刚清空的格里插火把', async () => {
    const pit = {
      key: 'dark-pit', site_mode: 'new', size_xyz: [2, 1, 1], axis_order: 'YZX',
      palette: ['minecraft:air'], layers: [[[0, 0]]],
    };
    const desk = fakeDesk([pit]);
    const bot = worldBot({
      stock: { torch: 8 },
      blocks: { '0,64,0': 'minecraft:dirt', '1,64,0': 'minecraft:dirt' },
    });
    // 全黑的夜:补光的每一条判据都成立,拦着它的只有「清场这条路不补光」
    Object.assign(bot, {
      time: { timeOfDay: 18000 },
      world: { getBlockLight: () => 0, getSkyLight: () => 0 },
    });
    const { exec, reports } = execOn(bot, desk);
    exec.submit([{ skill: 'build', blueprint: 'dark-pit', at: [0, 64, 0], confirm: true }]);
    await waitUntil(() => reports.length === 1, 15000);
    expect(reports[0].kind).toBe('done');
    expect(bot.blockName('0,64,0')).toBe('air');
    expect(bot.placedAt).toEqual([]);
    expect(reports[0].text).not.toContain('火把');
  });

  /**
   * 清场受阻回执须包含 excavate 的账本保护原因。
   */
  it('清场被账本保护挡住:那一段 excavate 说的话并进受阻回执', async () => {
    const pit = {
      key: 'guard-pit', site_mode: 'new', size_xyz: [2, 1, 1], axis_order: 'YZX',
      palette: ['minecraft:air'], layers: [[[0, 0]]],
    };
    const desk = fakeDesk([pit]);
    const bot = worldBot({ blocks: { '0,64,0': 'minecraft:chest', '1,64,0': 'minecraft:dirt' } });
    const chests = new ChestBook(null);
    chests.remember('overworld', { x: 0, y: 64, z: 0 }, [{ name: 'iron_ingot', count: 5 }], 1, 27);
    const reports: TaskReport[] = [];
    let seq = 0;
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: () => ++seq,
      blueprints: () => desk,
      chests,
    });
    exec.submit([{ skill: 'build', blueprint: 'guard-pit', at: [0, 64, 0], confirm: true }]);
    await waitUntil(() => reports.length === 1, 15000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('清场后回读仍有 1 个冲突格');
    expect(reports[0].text).toContain('没动它');
    expect(bot.blockName('0,64,0')).toBe('chest');
    expect(bot.blockName('1,64,0')).toBe('air');
  });

  /**
   * 并进现场的清场回执封顶 4 条(26 段全展开会淹掉回执),被略去的那些不是「都一样」:
   * 够不着/账本护住/挖不动混在里头。只报段数会把整类诊断吞掉,种类数如实带出来。
   */
  it('清场回执略去时:带上没展示的那部分里有几类受阻原因', async () => {
    // 22 格长的线分成六段冲突区，前五段长度各异；最后一段放入账本保护的箱子，验证后续分段原因仍进入回执。
    const dirt: Record<string, string> = {};
    for (const x of [0, 2, 3, 5, 6, 7, 9, 10, 11, 12, 14, 15, 16, 17, 18, 21]) {
      dirt[`${x},64,0`] = 'minecraft:dirt';
    }
    dirt['20,64,0'] = 'minecraft:chest';
    const strip = {
      key: 'long-strip', site_mode: 'new', size_xyz: [22, 1, 1], axis_order: 'YZX',
      palette: ['minecraft:air'], layers: [[new Array(22).fill(0)]],
    };
    const desk = fakeDesk([strip]);
    const bot = worldBot({ blocks: dirt });
    const chests = new ChestBook(null);
    chests.remember('overworld', { x: 20, y: 64, z: 0 }, [{ name: 'iron_ingot', count: 5 }], 1, 27);
    const reports: TaskReport[] = [];
    let seq = 0;
    const exec = new Executor({
      getBot: () => bot as never,
      report: (r) => reports.push(r),
      log,
      nextId: () => ++seq,
      blueprints: () => desk,
      chests,
    });
    exec.submit([{ skill: 'build', blueprint: 'long-strip', at: [0, 64, 0], confirm: true }]);
    await waitUntil(() => reports.length === 1, 20000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('另外 2 段清场回执略去,含 1 类没展示的受阻原因');
  });

  it('new:清场里有带 level 属性的液体时整段不动，不会先挖掉旁边方块', async () => {
    const pit = {
      key: 'wet-pit', site_mode: 'new', size_xyz: [2, 1, 1], axis_order: 'YZX',
      palette: ['minecraft:air'], layers: [[[0, 0]]],
    };
    const desk = fakeDesk([pit]);
    const bot = worldBot({
      blocks: { '0,64,0': 'minecraft:water[level=0]', '1,64,0': 'minecraft:dirt' },
    });
    const { exec, reports } = execOn(bot, desk);
    exec.submit([{ skill: 'build', blueprint: 'wet-pit', at: [0, 64, 0], confirm: true }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('清场范围里有 1 格液体');
    expect(bot.blockName('0,64,0')).toBe('water');
    expect(bot.blockName('1,64,0')).toBe('dirt');
    expect(bot.dugAt).toEqual([]);
    expect(desk.bound).toEqual([]);
  });

  it('retrofit:第一轮只初探,冲突未确认不动,confirm 后才清场施工', async () => {
    const retrofit = floorSubmission({
      key: 'retrofit-wall', name: '旧墙改造', site_mode: 'retrofit',
      size_xyz: [1, 1, 1], layers: [[[0]]], palette: ['minecraft:cobblestone'],
    });
    const desk = fakeDesk([retrofit]);
    const bot = worldBot({ stock: { cobblestone: 4 }, blocks: { '0,64,0': 'minecraft:dirt' } });
    const { exec, reports } = execOn(bot, desk);

    exec.submit([{ skill: 'build', blueprint: 'retrofit-wall', at: [0, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('我完成并保存了初始探测');
    expect(reports[0].text).toContain('这一次没有改动任何方块');
    expect(bot.blockName('0,64,0')).toBe('dirt');
    expect(desk.surveyed).toEqual([['retrofit-wall', [0, 64, 0]]]);

    exec.submit([{ skill: 'build', blueprint: 'retrofit-wall' }]);
    await waitUntil(() => reports.length === 2, 8000);
    expect(reports[1].kind).toBe('blocked');
    expect(reports[1].text).toContain('confirm:true');
    expect(bot.blockName('0,64,0')).toBe('dirt');

    exec.submit([{ skill: 'build', blueprint: 'retrofit-wall', confirm: true }]);
    await waitUntil(() => reports.length === 3, 15000);
    expect(reports[2].kind).toBe('done');
    expect(reports[2].text).toContain('清掉了 1 个冲突格');
    expect(reports[2].text).toContain('mc_map 的 set');
    expect(bot.blockName('0,64,0')).toBe('cobblestone');
  });

  /**
   * 剩余冲突全部是清场开始时不存在的新格，且不超过 5 格时，可再清一轮；最多一轮。
   */
  function regrowSite(over: Record<string, unknown> = {}): Record<string, unknown> {
    return floorSubmission({
      key: 'regrow', name: '菜地', site_mode: 'new',
      size_xyz: [2, 1, 1], axis_order: 'YZX',
      palette: ['minecraft:air', 'minecraft:cobblestone'],
      layers: [[[1, 0]]],
      ...over,
    });
  }

  it('清场后长出来的是新格且不超过 5 格:再清一轮就开工', async () => {
    const desk = fakeDesk([regrowSite()]);
    let grown = false;
    const bot = worldBot({
      stock: { cobblestone: 4 },
      blocks: { '0,64,0': 'minecraft:dirt' },
      onDig: (dug, put) => {
        // 清掉 (0,64,0) 的同一刻,草蔓延到该是空气的 (1,64,0):那一格清场开始时没有冲突
        if (dug === '0,64,0' && !grown) { grown = true; put('1,64,0', 'grass_block'); }
      },
    });
    const { exec, reports } = execOn(bot, desk);
    exec.submit([{ skill: 'build', blueprint: 'regrow', at: [0, 64, 0], confirm: true }]);
    await waitUntil(() => reports.length === 1, 20000);
    expect(reports[0].kind).toBe('done');
    expect(bot.blockName('0,64,0')).toBe('cobblestone');
    expect(bot.blockName('1,64,0')).toBe('air');
  });

  it('残留的是清场开始就有的老格:不再清,抛错并逐格摆出那一格现在是什么', async () => {
    const desk = fakeDesk([regrowSite()]);
    let back = false;
    const bot = worldBot({
      stock: { cobblestone: 4 },
      blocks: { '0,64,0': 'minecraft:dirt' },
      // 挖掉又被填回原处:这不是"跑赢清场",是那一格根本清不掉
      onDig: (dug, put) => {
        if (dug === '0,64,0' && !back) { back = true; put('0,64,0', 'dirt'); }
      },
    });
    const { exec, reports } = execOn(bot, desk);
    exec.submit([{ skill: 'build', blueprint: 'regrow', at: [0, 64, 0], confirm: true }]);
    await waitUntil(() => reports.length === 1, 20000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('清场后回读仍有 1 个冲突格');
    expect(reports[0].text).toContain('(0, 64, 0) 现在是泥土,该是圆石');
    expect(bot.dugAt).toEqual(['0,64,0']); // 只清了一轮,没有第二轮
  });

  /** 跳过是给她的一个选项(她的可选动作从 1 个变回 3 个),不是系统替她跳 */
  it('skipConflicts:冲突格原样留着先放能放的,回执点名跳过了哪几格', async () => {
    const desk = fakeDesk([regrowSite({
      size_xyz: [2, 1, 1], palette: ['minecraft:cobblestone'], layers: [[[0, 0]]],
    })]);
    const bot = worldBot({ stock: { cobblestone: 4 }, blocks: { '0,64,0': 'minecraft:dirt' } });
    const { exec, reports } = execOn(bot, desk);
    exec.submit([{ skill: 'build', blueprint: 'regrow', at: [0, 64, 0], skipConflicts: true }]);
    await waitUntil(() => reports.length === 1, 20000);
    expect(reports[0].text).toContain('按你说的跳过了 1 个冲突格');
    expect(reports[0].text).toContain('(0, 64, 0) 现在是泥土,该是圆石');
    expect(bot.dugAt).toEqual([]);
    expect(bot.blockName('0,64,0')).toBe('dirt');
    expect(bot.blockName('1,64,0')).toBe('cobblestone');
  });

  it('冲突未确认时的指路把三条可选动作都摆出来', async () => {
    const desk = fakeDesk([regrowSite()]);
    const bot = worldBot({ stock: { cobblestone: 4 }, blocks: { '0,64,0': 'minecraft:dirt' } });
    const { exec, reports } = execOn(bot, desk);
    exec.submit([{ skill: 'build', blueprint: 'regrow', at: [0, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 20000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('confirm:true');
    expect(reports[0].text).toContain('skipConflicts:true');
    expect(reports[0].text).toContain('重新 design');
  });

  it('功能工程:耕地、水源、播种与四档中继器走真实施工动作并回读', async () => {
    const farm = {
      key: 'functional-farm', site_mode: 'new', size_xyz: [3, 2, 1], axis_order: 'YZX',
      palette: [
        'minecraft:farmland[moisture=0]',
        'minecraft:water[level=0]',
        'minecraft:repeater[delay=4,facing=north,locked=false,powered=false]',
        'minecraft:wheat[age=0]',
        'minecraft:structure_void',
      ],
      layers: [[[0, 1, 2]], [[3, 4, 4]]],
    };
    const desk = fakeDesk([farm]);
    const bot = worldBot({
      stock: {
        dirt: 1, wooden_hoe: 1, water_bucket: 1, wheat_seeds: 1, repeater: 1,
      },
    });
    const { exec, reports } = execOn(bot, desk);
    exec.submit([{ skill: 'build', blueprint: 'functional-farm', at: [0, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 20000);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('整张图施工完了');
    expect(reports[0].text).toContain('mc_map 的 set');
    expect(bot.blockName('0,64,0')).toBe('farmland');
    expect(bot.blockName('0,65,0')).toBe('wheat');
    expect(bot.blockName('1,64,0')).toBe('water');
    expect(bot.blockName('2,64,0')).toBe('repeater');
    expect(bot.blockAt(new Vec3(2, 64, 0))?.getProperties()).toMatchObject({ delay: 4 });
  });

  it('现场已有同类红石开关但状态相反时，不重放方块而是交互校正', async () => {
    const switchboard = {
      key: 'switchboard', site_mode: 'new', size_xyz: [1, 1, 1], axis_order: 'YZX',
      palette: ['minecraft:lever[face=floor,facing=north,powered=false]'], layers: [[[0]]],
    };
    const desk = fakeDesk([switchboard]);
    const bot = worldBot({
      stock: {},
      blocks: { '0,64,0': 'minecraft:lever[face=floor,facing=north,powered=true]' },
    });
    const { exec, reports } = execOn(bot, desk);
    exec.submit([{ skill: 'build', blueprint: 'switchboard', at: [0, 64, 0] }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(bot.placedAt).toEqual([]);
    expect(bot.blockAt(new Vec3(0, 64, 0))?.getProperties()).toMatchObject({ powered: false });
  });

  it('受理刻的重力闸认蓝图:图会把沙放到我头顶就整单驳回', async () => {
    const sand = {
      key: 'sandy', site_mode: 'new', size_xyz: [1, 1, 1], axis_order: 'YZX',
      palette: ['minecraft:sand'], layers: [[[0]]],
    };
    const desk = fakeDesk([sand]);
    const { exec, reports } = execOn(worldBot({ stock: { sand: 4 } }), desk);
    const receipt = exec.submit([{ skill: 'build', blueprint: 'sandy', at: [0, 65, 0] }]);
    expect(receipt).toContain('这一单我没接');
    expect(receipt).toContain('埋住闷死');
    expect(reports).toHaveLength(0);
  });


  describe('工地垫脚', () => {
    /** 2×2×2:下层圆石,上层是"该空着"的空气 —— 上层格在工地里但不是落点 */
    const yard = {
      key: 'yard', site_mode: 'new', size_xyz: [2, 2, 2], axis_order: 'YZX',
      palette: ['minecraft:cobblestone', 'minecraft:air'],
      layers: [[[0, 0], [0, 0]], [[1, 1], [1, 1]]],
    };

    it('收工回收:垫进工地体积的那块挖回来,工地外的留着当路', async () => {
      const desk = fakeDesk([yard]);
      const bot = worldBot({ stock: { cobblestone: 64 } });
      // 寻路器路上垫的两块(与 mineflayer-fixes 的记账同形):一块落在工地里,一块在外面
      const ledger = ((bot as unknown as { placedLedger?: unknown[] }).placedLedger ??= []);
      const origEquip = bot.equip;
      let seeded = false;
      bot.equip = async (item: { name: string }) => {
        await origEquip(item);
        if (seeded) return;
        seeded = true;
        await bot.placeBlock({ position: { x: 0, y: 64, z: 0 } }, { x: 0, y: 1, z: 0 });
        await bot.placeBlock({ position: { x: 5, y: 63, z: 5 } }, { x: 0, y: 1, z: 0 });
        ledger.push({ name: 'cobblestone', x: 0, y: 65, z: 0 }, { name: 'cobblestone', x: 5, y: 64, z: 5 });
      };
      const { exec, reports } = execOn(bot, desk);
      exec.submit([{ skill: 'build', blueprint: 'yard', at: [0, 64, 0] }]);
      await waitUntil(() => reports.length === 1, 20000);
      expect(reports[0].text).toContain('顺手清掉了工地里的垫脚 1 块');
      expect(bot.dugAt).toContain('0,65,0');
      expect(bot.dugAt).not.toContain('5,64,5');
      expect(bot.blockName('5,64,5')).toBe('cobblestone');
    });

    it('有意放下的落点不当垫脚收走', async () => {
      const desk = fakeDesk([floorSubmission()]);
      const bot = worldBot();
      const { exec, reports } = execOn(bot, desk);
      exec.submit([{ skill: 'build', blueprint: 'home-v2', at: [0, 64, 0] }]);
      await waitUntil(() => reports.length === 1, 15000);
      expect(reports[0].text).not.toContain('顺手清掉');
      expect(bot.dugAt).toEqual([]);
      expect(bot.blockName('0,64,0')).toBe('cobblestone');
    });

    /** 垫脚名单把圆石排在泥土前面;正在砌的墙也是圆石,两者靠这条区分不开 */
    function policyOn(scaffold: string[]) {
      return {
        get: () => ({
          scaffold, light: null, lightWhen: 'dig' as const, travel: 'auto' as const,
          reserve: [], fight: { engage: 'auto' as const, fleeHealth: 6, space: 2.6 },
        }),
        defaults: () => ({ scaffold, light: ['torch'] }),
      } as never;
    }

    it('工地建材垫脚降到末位:包里有别的就先用别的,只剩建材时照旧用', async () => {
      const desk = fakeDesk([twoLayerSubmission()]);
      const bot = worldBot({ stock: { cobblestone: 64, oak_planks: 64, dirt: 8 } });
      const reports: TaskReport[] = [];
      let seq = 0;
      const exec = new Executor({
        getBot: () => bot as never,
        report: (r) => reports.push(r),
        log,
        nextId: () => ++seq,
        blueprints: () => desk,
        policy: policyOn(['cobblestone', 'dirt']),
      });
      // 工地还没绑定:名单顺序说了算,报的是圆石
      exec.submit([{ skill: 'tunnel', at: [0, 70, 0], dryRun: true }]);
      await waitUntil(() => reports.length === 1, 8000);
      expect(reports[0].text).toContain('个圆石');

      // 只盖第 0 层:工地在建,圆石是它的建材,垫脚改报泥土
      exec.submit([{ skill: 'build', blueprint: 'tower', at: [0, 64, 0], stopAfter: 0 }]);
      await waitUntil(() => reports.length === 2, 20000);
      exec.submit([{ skill: 'tunnel', at: [0, 70, 0], dryRun: true }]);
      await waitUntil(() => reports.length === 3, 8000);
      expect(reports[2].text).toContain('个泥土');
    });

    it('禁垫区:塔要垫的那一格落在工地里就不垫,受阻文案点名是哪张图', async () => {
      const desk = fakeDesk([twoLayerSubmission()]);
      const bot = worldBot({ stock: { cobblestone: 64, oak_planks: 64, dirt: 64 } });
      const { exec, reports } = execOn(bot, desk);
      // 只盖第 0 层:锚点绑上了、游标没走完,工地就此在建
      exec.submit([{ skill: 'build', blueprint: 'tower', at: [0, 64, 0], stopAfter: 0 }]);
      await waitUntil(() => reports.length === 1, 20000);
      // 塔从 (0,64,0) 往上垫,第一格就落在工地体积里
      exec.submit([{ skill: 'tunnel', at: [0, 66, 0] }]);
      await waitUntil(() => reports.length === 2, 20000);
      expect(reports[1].text).toContain('塔没到顶:(0, 64, 0) 在蓝图「tower」工地里,不垫');
      expect(bot.placedAt).toEqual(['0,64,0']); // 第 0 层那一块之外一块都没垫
    });
  });

  it('入参:mc_scout 里按试算跑;误写的形状与材料点名丢掉;stopAfter 收任意非负层号', () => {
    const scouted = parseScoutSteps([{ skill: 'build', blueprint: 'home-v2', at: [0, 64, 0] }]);
    expect(scouted).toMatchObject({ steps: [{ skill: 'build', blueprint: 'home-v2', dryRun: true }] });
    const strayed = parseSteps([
      { skill: 'build', blueprint: 'home-v2', material: 'cobblestone', shape: 'box' },
    ]);
    expect(strayed).toMatchObject({ steps: [{ skill: 'build', blueprint: 'home-v2' }] });
    expect(('notes' in strayed ? strayed.notes : [])?.map((n) => n.field)).toEqual(['material', 'shape']);
    expect(parseSteps([{ skill: 'build', blueprint: 'home-v2', stopAfter: 99 }]))
      .toMatchObject({ steps: [{ stopAfter: 99 }] });
    expect(parseSteps([{ skill: 'build', blueprint: 'home-v2', stopAfter: -1 }]))
      .toMatchObject({ error: expect.stringContaining('stopAfter') });
    expect(parseSteps([{ skill: 'build', blueprint: 'home-v2', at: [1, 2] }]))
      .toMatchObject({ error: expect.stringContaining('at') });
    expect(describeSkill({ skill: 'build', blueprint: 'home-v2', at: [0, 64, 0], stopAfter: 2 }))
      .toBe('按蓝图「home-v2」施工,锚点 (0,64,0),施工到第 2 层');
  });
});

/** 地上躺着一件掉落物,走过去就进包 */
function dropRig(gain: Record<string, number>) {
  const bag = Object.entries(gain).map(([name], i) => ({ name, count: 0, type: 200 + i }));
  const bot = worldBot({ stock: {} }) as ReturnType<typeof worldBot> & {
    entities: Record<string, unknown>;
  };
  bot.inventory.items = () => bag.filter((b) => b.count > 0);
  bot.entities = {
    7: {
      id: 7, name: 'item',
      position: new Vec3(2.5, 64, 2.5),
    },
  };
  bot.pathfinder.goto = async () => {
    for (const b of bag) b.count = gain[b.name];
    bot.entities = {};
  };
  return bot;
}

describe('采集搭车', () => {
  it('捡到图里要的料:回执尾巴上报缺口从多少变到多少', async () => {
    const desk = fakeDesk([floorSubmission()]);
    const bot = dropRig({ cobblestone: 2 });
    const { exec, reports } = execOn(bot, desk);
    exec.submit([{ skill: 'pickup' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('捡了');
    expect(reports[0].text).toContain('home-v2 还缺圆石 4→2');
    // 措辞是读数,不给建议
    expect(reports[0].text).not.toContain('建议');
  });

  it('够多盖几步时把这件事也说出来', async () => {
    const desk = fakeDesk([twoLayerSubmission()]);
    const bot = dropRig({ cobblestone: 1 });
    const { exec, reports } = execOn(bot, desk);
    exec.submit([{ skill: 'pickup' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('够再往前施工 1 步(到第 0 层)了');
  });

  it('捡到的跟图无关:一个字都不加(限频是天然的)', async () => {
    const desk = fakeDesk([floorSubmission()]);
    const bot = dropRig({ wheat_seeds: 3 });
    const { exec, reports } = execOn(bot, desk);
    exec.submit([{ skill: 'pickup' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).not.toContain('home-v2');
  });

  it('一张图都没装载时不搭车', async () => {
    const bot = dropRig({ cobblestone: 2 });
    const { exec, reports } = execOn(bot, fakeDesk([]));
    exec.submit([{ skill: 'pickup' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('捡了');
    expect(reports[0].text).not.toContain('还缺');
  });
});

// ---------------------------------------------------------------------------
// 入参解析
// ---------------------------------------------------------------------------

describe('parseBlueprintArgs', () => {
  it('空 = 查询;三件事互斥;unload 要字符串', () => {
    expect(parseBlueprintArgs({})).toEqual({ kind: 'query' });
    expect(parseBlueprintArgs({ unload: 'k' })).toEqual({ kind: 'unload', key: 'k' });
    expect(parseBlueprintArgs({ unload: 3 })).toHaveProperty('error');
    expect(parseBlueprintArgs({ design: { key: 'k', brief: 'b' }, unload: 'k' }))
      .toHaveProperty('error');
  });

  it('design 收 key/name/brief;save 认得出 append', () => {
    expect(parseBlueprintArgs({ design: { key: 'k', name: '名', brief: ' b ' } }))
      .toEqual({ kind: 'design', key: 'k', name: '名', brief: 'b' });
    const save = parseBlueprintArgs({ save: { key: 'k', append: true } });
    expect(save).toMatchObject({ kind: 'save', append: true });
  });
});
