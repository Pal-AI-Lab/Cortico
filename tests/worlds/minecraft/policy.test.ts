import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultPolicy, loadPolicy, loadPolicyReport, parsePolicy, policyNoteText,
  renderFightRollback, renderPolicy, renderPolicyEnv, PolicyBook, POLICY_SCHEMA,
} from '../../../src/worlds/minecraft/policy.ts';

const DEFS = { scaffold: ['dirt', 'cobblestone'], light: ['torch'] };

const dirs: string[] = [];
function tmpFile(): string {
  const d = mkdtempSync(join(tmpdir(), 'mc-policy-'));
  dirs.push(d);
  return join(d, 'minecraft-policy.json');
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** set 之后回读的一句(与工具回执同一条渲染) */
function receipt(args: Record<string, unknown>, combatOff = false): string {
  const book = new PolicyBook(null);
  const { patch, notes } = parsePolicy(args);
  book.set(patch);
  const head = notes.length > 0 ? `${notes.map(policyNoteText).join(';')}。` : '';
  return head + renderPolicy(book.get(), DEFS, combatOff);
}

describe('mc_policy 契约面:六格各自的合法值与不认的值', () => {
  it('六格全收下,给哪个改哪个;没给的一个字都不动', () => {
    const { patch, notes } = parsePolicy({
      scaffold: ['dirt'], light: ['lantern'], lightWhen: 'anywhere',
      travel: 'dig', reserve: ['iron_pickaxe'], fight: 'armed',
    });
    expect(notes).toEqual([]);
    expect(patch).toEqual({
      scaffold: ['dirt'], light: ['lantern'], lightWhen: 'anywhere',
      travel: 'dig', reserve: ['iron_pickaxe'], fight: 'armed',
    });
    expect(parsePolicy({ travel: 'place' }).patch).toEqual({ travel: 'place' });
  });

  it('空调用合法且只回读:补丁是空的,一格都不动', () => {
    const { patch, notes } = parsePolicy({});
    expect(patch).toEqual({});
    expect(notes).toEqual([]);
    // 队列会自己变,规矩只有她自己改得动:空调用读不到任何新读数,没有轮询的动机
    expect(receipt({})).toContain('现在生效的规矩:');
  });

  /**
   * 参数被静默吃掉是这条链上最贵的一类失败。不认的值那一格不动、别的照改,
   * 理由与认哪几个一起进回执 —— 回执里读回来的那六格本来就说得出结果。
   */
  it('枚举不认的值进 note 并列出认哪几个,别的格照改', () => {
    const { patch, notes } = parsePolicy({ travel: 'mine', scaffold: ['dirt'] });
    expect(patch).toEqual({ scaffold: ['dirt'] });
    expect(notes).toHaveLength(1);
    expect(policyNoteText(notes[0])).toBe('travel 写的 "mine",只认 auto/dig/place,没收下');
    const text = receipt({ travel: 'mine', scaffold: ['dirt'] });
    expect(text).toContain('只认 auto/dig/place,没收下');
    expect(text).toContain('垫一格只用泥土');
    expect(text).toContain('赶路遇坎按代价自选挖还是垫');
  });

  it('名单不是数组进 note;未知键也进 note,不静默丢弃', () => {
    const { patch, notes } = parsePolicy({ scaffold: 'dirt', scafold: ['dirt'] });
    expect(patch).toEqual({});
    expect(notes.map((n) => n.field)).toEqual(['scaffold', 'scafold']);
    expect(policyNoteText(notes[0])).toContain('要一串英文 id');
    expect(notes.map(policyNoteText).join(';')).toContain('mc_policy 没有这一格');
  });

  it('null 不算她想说什么:照 schema 填的空位不进 note 也不改值', () => {
    const { patch, notes } = parsePolicy({ scaffold: null, fight: null, reserve: undefined });
    expect(patch).toEqual({});
    expect(notes).toEqual([]);
  });

  it('名字不校验存在性:写错的 id 照收(包里找不找得到由世界说了算)', () => {
    expect(parsePolicy({ reserve: ['stone_pick'] }).patch).toEqual({ reserve: ['stone_pick'] });
  });

  it('schema 声明六个可选策略字段', () => {
    const props = (POLICY_SCHEMA as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(['scaffold', 'light', 'lightWhen', 'travel', 'reserve', 'fight']);
    expect((POLICY_SCHEMA as { required: string[] }).required).toEqual([]);
  });
});

describe('mc_policy 回读契约', () => {

  it('六格全念,没改过的念默认值', () => {
    expect(receipt({})).toBe(
      '现在生效的规矩:垫一格用默认名单(泥土、圆石);插一根用默认名单(火把),'
      + '只在挖通道和挖空间的时候插;赶路遇坎按代价自选挖还是垫;没有收着不用的家伙什;'
      + '手上有趁手的家伙才主动动手,挨打照旧还手。',
    );
  });

  it('回执来自 set 之后的 get():改一格,另外五格原样念出来', () => {
    const text = receipt({ reserve: ['iron_pickaxe'], fight: 'auto' });
    expect(text).toContain('铁镐收着不主动拿');
    expect(text).toContain('怪贴到跟前一律动手');
    expect(text).toContain('垫一格用默认名单(泥土、圆石)');
    expect(text).toContain('赶路遇坎按代价自选挖还是垫');
  });

  it('默认名单念的是接线上真正在用的那一份,不是写死的字面量', () => {
    const book = new PolicyBook(null);
    const text = renderPolicy(book.get(), { scaffold: ['oak_planks'], light: ['lantern'] });
    expect(text).toContain('垫一格用默认名单(橡木木板)');
    expect(text).toContain('插一根用默认名单(灯笼)');
    expect(text).not.toContain('圆石');
  });

  it('空名单 = 关着;照明关着时照明场合那一格照实说用不上', () => {
    expect(receipt({ scaffold: [] })).toContain('垫一格关着');
    expect(receipt({ light: [] })).toContain('插一根关着(照明场合那一格用不上)');
  });

  // 一份名单四个消费者:寻路器装载、执行器垫脚、环境提示词都剔重力方块,
  // 只有 mc_policy 回执照旧念原表 —— 同日同配置里一个说「只用沙子、泥土、圆石」,
  // 另一个说「沙子垫下去会自己掉,不收」
  it('垫脚回执与环境提示词同一份过滤:重力方块不算数,而且要说出来', () => {
    const text = receipt({ scaffold: ['sand', 'dirt', 'cobblestone'] });
    expect(text).toContain('垫一格只用泥土、圆石');
    expect(text).toContain('沙子垫下去会自己掉,不收');
    expect(text).not.toContain('只用沙子');
  });

  it('名单里的全是重力方块:照实说一样都没收下,不是「不垫」', () => {
    const text = receipt({ scaffold: ['sand', 'gravel'] });
    expect(text).toContain('垫一格料单里沙子、沙砾垫下去会自己掉,一样都没收下');
    expect(text).not.toContain('垫一格关着');
  });

  it('默认名单里的重力方块同样剔掉:回执念的是真正在用的那几样', () => {
    const book = new PolicyBook(null);
    const text = renderPolicy(book.get(), { scaffold: ['sand', 'dirt'], light: ['torch'] });
    expect(text).toContain('垫一格用默认名单(泥土)');
    expect(text).toContain('沙子垫下去会自己掉,不收');
  });

  // 措辞是对世界的陈述,不是对她说话;「战斗模式/脚本/接管」那一组同理
  it('回执不出现第二人称,也不出现内部机制名', () => {
    const text = receipt({ scaffold: ['dirt'], fight: 'off', lightWhen: 'anywhere' }, true);
    for (const banned of ['你', '您', '战斗模式', '脚本', '接管', '工具', '设置项']) {
      expect(text).not.toContain(banned);
    }
  });

  // 总开关是人的兜底,她那一侧的表达由 fight:"off" 承担:两者不是同一件事,
  // 关着的时候不假装这一格设上了
  it('WebUI 把战斗总开关关着时,回执照实说这一格不起作用', () => {
    expect(receipt({ fight: 'off' }, true)).toContain('战斗总开关在 WebUI 关着,主动动手这一格现在不起作用');
    expect(receipt({ fight: 'off' }, false)).not.toContain('总开关');
  });
});

describe('mc_policy 进环境提示词与落盘', () => {
  it('全默认返回空串:一个字都不加', () => {
    expect(renderPolicyEnv(defaultPolicy())).toBe('');
  });

  it('只念与默认不同的那几条', () => {
    const s = { ...defaultPolicy(), fight: 'off' as const, reserve: ['iron_pickaxe'] };
    const line = renderPolicyEnv(s);
    expect(line).toContain('铁镐收着不主动拿');
    expect(line).toContain('不主动动手');
    expect(line).not.toContain('垫一格');
    expect(line).not.toContain('赶路遇坎');
  });

  // 环境回执与 bridge.applyTuning 使用同一垫脚名单，均排除重力方块。
  it('重力方块不进「垫一格只用」,而且如实说出它没被收下', () => {
    const line = renderPolicyEnv({ ...defaultPolicy(), scaffold: ['dirt', 'gravel'] });
    expect(line).toContain('垫一格只用泥土');
    expect(line).not.toContain('垫一格只用泥土、沙砾');
    expect(line).toContain('沙砾垫下去会自己掉,不收');
  });

  it('名单里全是重力方块:不是「不垫脚」,是一样没收下、回默认名单', () => {
    const line = renderPolicyEnv({ ...defaultPolicy(), scaffold: ['gravel', 'sand'] });
    expect(line).not.toContain('不垫脚');
    expect(line).toContain('一样都没收下');
    expect(line).toContain('仍走默认名单');
  });

  it('显式清空仍是禁垫', () => {
    expect(renderPolicyEnv({ ...defaultPolicy(), scaffold: [] })).toContain('不垫脚');
  });

  // 回执所列垫脚料须与执行侧实际可用库存一致。
  it('被蓝图施工预留收口的垫脚料在名单旁标注,并指到 reserve_override', () => {
    const line = renderPolicyEnv(
      { ...defaultPolicy(), scaffold: ['dirt', 'sandstone'] }, false, ['sandstone'],
    );
    expect(line).toContain('垫一格只用泥土、砂岩');
    expect(line).toContain('砂岩正在蓝图预留中');
    expect(line).toContain('reserve_override');
    // 六格里的 reserve 是另一件事,措辞不许混
    expect(line).not.toContain('砂岩收着不主动拿');
  });

  it('六格全默认、只有蓝图预留这一条事实时也照说,且不冒充成「与默认不同的规矩」', () => {
    const line = renderPolicyEnv(defaultPolicy(), false, ['sandstone']);
    expect(line).toContain('砂岩正在蓝图预留中');
    expect(line).not.toContain('与默认不同');
  });

  it('六格回读也带同一句标注', () => {
    const text = renderPolicy(
      { ...defaultPolicy(), scaffold: ['dirt', 'sandstone'] }, DEFS, false, ['sandstone'],
    );
    expect(text).toContain('砂岩正在蓝图预留中');
  });

  it('写盘 → 新实例读回同一份(fight 除外)', () => {
    const file = tmpFile();
    const a = new PolicyBook(file);
    a.set({ fight: 'off', reserve: ['iron_pickaxe'], scaffold: [] });
    const b = new PolicyBook(file);
    expect(b.get()).toEqual({
      scaffold: [], light: null, lightWhen: 'dig', travel: 'auto',
      reserve: ['iron_pickaxe'], fight: 'armed',
    });
  });

  it('fight 不跨重启:盘上存着 off,新实例照样是默认的 armed', () => {
    const file = tmpFile();
    new PolicyBook(file).set({ fight: 'off' });
    expect(JSON.parse(readFileSync(file, 'utf8')).fight).toBe('off');
    expect(new PolicyBook(file).get().fight).toBe('armed');
    expect(loadPolicy(file).fight).toBe('armed');
  });

  it('只有 fight 非默认时,常驻规矩那一行为空 —— 可播报的是回弹,不是规矩', () => {
    const file = tmpFile();
    new PolicyBook(file).set({ fight: 'auto' });
    const b = new PolicyBook(file);
    expect(renderPolicyEnv(b.get())).toBe('');
    expect(b.restored()).toBe(false);
    expect(b.takeFightRollback()).toBe('auto');
  });

  it('上一场留下的五格:连入播报点明来路,她一改就不再是上一场的', () => {
    const file = tmpFile();
    new PolicyBook(file).set({ reserve: ['iron_pickaxe'] });
    const b = new PolicyBook(file);
    expect(b.restored()).toBe(true);
    expect(renderPolicyEnv(b.get(), b.restored())).toContain('上一场设下的常驻规矩还在');
    expect(renderPolicyEnv(b.get(), b.restored())).toContain('铁镐收着不主动拿');
    b.set({ travel: 'dig' });
    expect(b.restored()).toBe(false);
    expect(renderPolicyEnv(b.get(), b.restored()).startsWith('常驻规矩(')).toBe(true);
  });

  it('全默认起步的新实例不算「上一场留下的」', () => {
    expect(new PolicyBook(tmpFile()).restored()).toBe(false);
    expect(new PolicyBook(null).restored()).toBe(false);
  });

  it('清除回默认,并把默认写回盘', () => {
    const file = tmpFile();
    const a = new PolicyBook(file);
    a.set({ fight: 'off' });
    expect(a.clear()).toContain('已清回默认');
    expect(new PolicyBook(file).get()).toEqual(defaultPolicy());
    expect(a.clear()).toContain('本来就都是默认');
  });

  it('文件坏了/字段类型不对:那一格回默认,不炸', () => {
    const file = tmpFile();
    writeFileSync(file, '{ 这不是 json', 'utf8');
    expect(loadPolicy(file)).toEqual(defaultPolicy());
    writeFileSync(file, JSON.stringify({ fight: 'sometimes', travel: 'dig' }), 'utf8');
    expect(loadPolicy(file)).toEqual({ ...defaultPolicy(), travel: 'dig' });
    expect(loadPolicy(null)).toEqual(defaultPolicy());
  });

  it('落盘的是六格本身,不是渲染文本', () => {
    const file = tmpFile();
    new PolicyBook(file).set({ travel: 'place' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ travel: 'place', fight: 'armed' });
  });

  it('get() 交出的是副本:外面改不动书里那一份', () => {
    const book = new PolicyBook(null);
    book.set({ reserve: ['iron_pickaxe'] });
    book.get().reserve.push('diamond_pickaxe');
    expect(book.get().reserve).toEqual(['iron_pickaxe']);
  });
});

/**
 * fight 回弹:这一格不跨重启是有意的(见 loadPolicyReport),但**静默**回弹不是。
 * 她按「我设过了」行事而系统按默认档执行 —— 回弹那一刻必须有一句话出线。
 */
describe('fight 回弹播报', () => {
  it('盘上那一档丢了就是一条待播报的事实,而且只播一次', () => {
    const file = tmpFile();
    new PolicyBook(file).set({ fight: 'off' });
    const b = new PolicyBook(file);
    expect(b.get().fight).toBe('armed');
    expect(b.takeFightRollback()).toBe('off');
    // 一次重启只回弹一次;重连不重建本对象,不会跟着 56 次 socketClosed 重播
    expect(b.takeFightRollback()).toBe(null);
  });

  it('播报点名原来那一档和现在按什么规矩转,并说怎么改回去', () => {
    const line = renderFightRollback('off');
    expect(line).toContain('不主动动手');
    expect(line).toContain('手上有趁手的家伙才主动动手');
    expect(line).toContain('fight');
    expect(renderFightRollback('auto')).toContain('怪贴到跟前一律动手');
  });

  it('播完才把盘上写回真话:下一次重启不重播这条旧账', () => {
    const file = tmpFile();
    new PolicyBook(file).set({ fight: 'off' });
    const b = new PolicyBook(file);
    // 只是建起来还没播:盘上原样留着
    expect(JSON.parse(readFileSync(file, 'utf8')).fight).toBe('off');
    expect(b.takeFightRollback()).toBe('off');
    expect(JSON.parse(readFileSync(file, 'utf8')).fight).toBe('armed');
    expect(new PolicyBook(file).takeFightRollback()).toBe(null);
  });

  it('起来了没连上就死掉,这条事实不丢:下一个进程照样报得出来', () => {
    const file = tmpFile();
    new PolicyBook(file).set({ fight: 'off' });
    new PolicyBook(file);                       // 建起来就没了,一次都没播
    expect(new PolicyBook(file).takeFightRollback()).toBe('off');
  });

  it('她自己重新拧过这一格,或清回默认,就没什么可报的了', () => {
    const file = tmpFile();
    new PolicyBook(file).set({ fight: 'off' });
    const a = new PolicyBook(file);
    a.set({ fight: 'armed' });
    expect(a.takeFightRollback()).toBe(null);
    const clr = tmpFile();
    new PolicyBook(clr).set({ fight: 'off' });
    const b = new PolicyBook(clr);
    b.clear();
    expect(b.takeFightRollback()).toBe(null);
  });

  it('盘上是默认档 / 坏值 / 没有盘 / 只改了别的格:都不算回弹', () => {
    expect(new PolicyBook(tmpFile()).takeFightRollback()).toBe(null);
    expect(new PolicyBook(null).takeFightRollback()).toBe(null);
    const other = tmpFile();
    new PolicyBook(other).set({ reserve: ['iron_pickaxe'] });
    expect(new PolicyBook(other).takeFightRollback()).toBe(null);
    const bad = tmpFile();
    writeFileSync(bad, JSON.stringify({ fight: 'sometimes' }), 'utf8');
    expect(new PolicyBook(bad).takeFightRollback()).toBe(null);
  });

  it('loadPolicyReport 带出丢掉的那一档,loadPolicy 只给六格且不写盘', () => {
    const file = tmpFile();
    new PolicyBook(file).set({ fight: 'off', travel: 'dig' });
    const r = loadPolicyReport(file);
    expect(r.droppedFight).toBe('off');
    expect(r.settings.fight).toBe('armed');
    expect(r.settings.travel).toBe('dig');
    expect(loadPolicy(file).fight).toBe('armed');
    // 纯读法不改盘:回弹只在 PolicyBook 建起来那一刻结算一次
    expect(JSON.parse(readFileSync(file, 'utf8')).fight).toBe('off');
  });
});
