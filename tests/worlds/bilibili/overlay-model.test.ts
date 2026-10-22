import { describe, expect, it } from 'vitest';
import {
  BILIBILI_OVERLAY_DEFAULTS,
  BUILTIN_OVERLAY_STYLES,
  matchAudienceGroup,
  normalizeOverlayDesign,
  testAudienceRule,
} from '../../../src/worlds/bilibili/overlay/model.ts';
import type { AudienceGroup, AudienceRule } from '../../../src/worlds/bilibili/overlay/types.ts';

describe('Bilibili Overlay 模型', () => {
  it('内置主题保留持久化设计引用的 id,首项是默认样式', () => {
    expect(BUILTIN_OVERLAY_STYLES.map((style) => style.id)).toEqual([
      'builtin:translucent',
      'builtin:sky',
      'builtin:navy',
      'builtin:white',
      'builtin:minimal',
    ]);
  });

  it('颜色统一规范成带 alpha 的八位十六进制且 v4 归一化幂等', () => {
    const design = structuredClone(BILIBILI_OVERLAY_DEFAULTS.design);
    const style = structuredClone(BUILTIN_OVERLAY_STYLES[0]);
    style.id = 'rgba';
    style.name = 'RGBA';
    style.background = '#AABBCC';
    style.borderColor = '#0102037F';
    style.radius = 27;
    style.username.color = '#11223300';
    style.username.strokeColor = '#445566';
    style.body.color = '#77889980';
    style.body.strokeColor = '#ABCDEF';
    style.nineSlice = {
      assetId: 'texture.png',
      slice: { top: 8, right: 16, bottom: 24, left: 32 },
      width: { top: 4.5, right: 5.5, bottom: 6.5, left: 7.5 },
      fill: false,
      repeat: 'round',
    };
    design.styles.push(style);
    design.groups.push({
      id: 'rgba-group',
      name: 'RGBA 用户组',
      enabled: true,
      priority: 1,
      rule: { op: 'leaf', field: 'vip', compare: 'eq', value: true },
      username: { color: '#10203040', strokeColor: '#506070' },
      body: { color: '#8090A000', strokeColor: '#B0C0D0FF' },
    });

    const normalized = normalizeOverlayDesign(design);
    expect(normalized.styles[0]).toMatchObject({
      background: '#aabbccff',
      borderColor: '#0102037f',
      radius: 27,
      username: { color: '#11223300', strokeColor: '#445566ff' },
      body: { color: '#77889980', strokeColor: '#abcdefff' },
      nineSlice: {
        slice: { top: 8, right: 16, bottom: 24, left: 32 },
        width: { top: 4.5, right: 5.5, bottom: 6.5, left: 7.5 },
        fill: false,
        repeat: 'round',
      },
    });
    expect(normalized.groups[0]).toMatchObject({
      username: { color: '#10203040', strokeColor: '#506070ff' },
      body: { color: '#8090a000', strokeColor: '#b0c0d0ff' },
    });
    expect(normalizeOverlayDesign(normalized)).toEqual(normalized);
  });

  it('v1 Nine-slice 迁移时切线和目标边宽都保留旧四值', () => {
    const legacy = structuredClone(BILIBILI_OVERLAY_DEFAULTS.design) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 1;
    const style = structuredClone(BUILTIN_OVERLAY_STYLES[0]) as unknown as Record<string, unknown>;
    style.id = 'legacy-nine';
    style.name = '旧九宫格';
    delete style.radius;
    style.nineSlice = {
      assetId: 'legacy.png',
      top: 8,
      right: 16,
      bottom: 24,
      left: 32,
      fill: false,
    };
    legacy.styles = [style];

    const migrated = normalizeOverlayDesign(legacy);
    expect(migrated.schemaVersion).toBe(4);
    expect(migrated.styles[0]).toMatchObject({
      radius: 0,
      nineSlice: {
        assetId: 'legacy.png',
        slice: { top: 8, right: 16, bottom: 24, left: 32 },
        width: { top: 8, right: 16, bottom: 24, left: 32 },
        fill: false,
        repeat: 'stretch',
      },
    });
    expect(normalizeOverlayDesign(migrated)).toEqual(migrated);
  });

  it('Nine-slice 源切片超过 4096 像素仍可无损往返', () => {
    const design = structuredClone(BILIBILI_OVERLAY_DEFAULTS.design);
    const style = structuredClone(BUILTIN_OVERLAY_STYLES[0]);
    style.id = 'large-slice';
    style.nineSlice = {
      assetId: 'large-texture.png',
      slice: { top: 8192, right: 16, bottom: 24, left: 32 },
      width: { top: 8, right: 8, bottom: 8, left: 8 },
      fill: true,
      repeat: 'stretch',
    };
    design.styles.push(style);

    const normalized = normalizeOverlayDesign(design);
    expect(normalized.styles[0].nineSlice?.slice.top).toBe(8192);
    expect(normalizeOverlayDesign(normalized).styles[0].nineSlice?.slice.top).toBe(8192);
  });

  it('新弹幕上限和逐行公告时序使用可调的安全边界', () => {
    const design = structuredClone(BILIBILI_OVERLAY_DEFAULTS.design) as unknown as Record<string, unknown>;
    design.components = [
      {
        ...(design.components as Array<Record<string, unknown>>)[0],
        usernameMaxChars: -10,
        bodyMaxChars: 9000,
      },
      {
        id: 'timed-scroll',
        name: '逐行公告',
        kind: 'scroll-notice',
        styleId: 'builtin:sky',
        axis: 'vertical',
        text: '一\n二',
        speed: 70,
        gap: 20,
        lineHoldMs: 1234.4,
        lineTransitionMs: 20000,
        edgeFadePx: 32,
      },
    ];
    design.placements = [];

    const normalized = normalizeOverlayDesign(design);
    expect(normalized.components).toMatchObject([
      { usernameMaxChars: 0, bodyMaxChars: 5000 },
      { lineHoldMs: 1234, lineTransitionMs: 10000 },
    ]);
  });

  it('标题和组件动效设置经过归一化后可无损往返', () => {
    const design = structuredClone(BILIBILI_OVERLAY_DEFAULTS.design);
    const danmaku = design.components[0];
    if (danmaku.kind !== 'danmaku') throw new Error('默认弹幕机组件缺失');
    danmaku.edgeFadePx = 0;
    danmaku.title = {
      text: '实时弹幕',
      position: 'left',
      align: 'center',
      style: {
        fontFamily: 'Noto Sans SC',
        fontSize: 21.5,
        fontWeight: 600,
        color: '#12345678',
        strokeColor: '#ABCDEF',
        strokeWidth: 1.5,
      },
    };
    const agent = design.components[1];
    if (agent.kind !== 'agent-notice') throw new Error('默认 Agent 公告组件缺失');
    agent.typingMs = 0;
    agent.title = {
      text: 'Agent 公告',
      position: 'bottom',
      align: 'right',
      style: {
        fontFamily: 'serif',
        fontSize: 28,
        fontWeight: 800,
        color: '#FFEEDD',
        strokeColor: '#01020304',
        strokeWidth: 2,
      },
    };

    const normalized = normalizeOverlayDesign(design);
    expect(normalized.components[0]).toMatchObject({
      edgeFadePx: 0,
      title: {
        text: '实时弹幕',
        position: 'left',
        align: 'center',
        style: {
          fontFamily: 'Noto Sans SC',
          fontSize: 21.5,
          fontWeight: 600,
          color: '#12345678',
          strokeColor: '#abcdefff',
          strokeWidth: 1.5,
        },
      },
    });
    expect(normalized.components[1]).toMatchObject({
      typingMs: 0,
      title: {
        text: 'Agent 公告',
        position: 'bottom',
        align: 'right',
        style: {
          fontFamily: 'serif',
          fontSize: 28,
          fontWeight: 800,
          color: '#ffeeddff',
          strokeColor: '#01020304',
          strokeWidth: 2,
        },
      },
    });
    expect(normalizeOverlayDesign(normalized)).toEqual(normalized);
  });

  it('标题缺省字段和关闭动效的零值稳定归一化', () => {
    const design = structuredClone(BILIBILI_OVERLAY_DEFAULTS.design) as unknown as Record<string, unknown>;
    design.components = [
      {
        id: 'titled-scroll',
        name: '带标题公告',
        kind: 'scroll-notice',
        styleId: 'builtin:sky',
        axis: 'horizontal',
        text: '测试',
        speed: 70,
        gap: 60,
        edgeFadePx: 0,
        title: { text: '公告标题', position: 'invalid', align: 'invalid', style: {} },
      },
      {
        id: 'agent',
        name: 'Agent 公告',
        kind: 'agent-notice',
        styleId: 'builtin:navy',
        emptyText: '空',
        hideWhenEmpty: false,
        typingMs: -5,
      },
    ];
    design.placements = [];

    const normalized = normalizeOverlayDesign(design);
    expect(normalized.components[0]).toMatchObject({
      edgeFadePx: 0,
      lineHoldMs: 1600,
      lineTransitionMs: 420,
      title: {
        text: '公告标题',
        position: 'top',
        align: 'left',
        style: {
          fontFamily: 'Microsoft YaHei, sans-serif',
          fontSize: 26,
          fontWeight: 700,
          color: '#ffffffff',
          strokeColor: '#17324dff',
          strokeWidth: 0,
        },
      },
    });
    expect(normalized.components[1]).toMatchObject({ typingMs: 0 });
  });

  it('未来 schema 版本不会被静默当成 v4', () => {
    const future = { ...structuredClone(BILIBILI_OVERLAY_DEFAULTS.design), schemaVersion: 5 };
    expect(() => normalizeOverlayDesign(future)).toThrow(/schema|schemaVersion|版本/i);
  });

  it('非法 schema 版本和未知组件类型不会被改写后保存', () => {
    for (const schemaVersion of ['4', null, 1.5, 0]) {
      const design = { ...structuredClone(BILIBILI_OVERLAY_DEFAULTS.design), schemaVersion };
      expect(() => normalizeOverlayDesign(design)).toThrow(/schemaVersion/i);
    }

    const design = structuredClone(BILIBILI_OVERLAY_DEFAULTS.design) as unknown as Record<string, unknown>;
    design.components = [{
      id: 'future-component',
      name: '未来组件',
      kind: 'future-kind',
      styleId: 'builtin:sky',
    }];
    design.placements = [];
    expect(() => normalizeOverlayDesign(design)).toThrow(/组件.*类型/i);
  });

  it('all/any 可递归组合，exists 不把缺失字段当成 0 或 false', () => {
    const rule: AudienceRule = {
      op: 'all',
      rules: [
        { op: 'leaf', field: 'guardLevel', compare: 'gte', value: 1 },
        {
          op: 'any',
          rules: [
            { op: 'leaf', field: 'isAdmin', compare: 'eq', value: true },
            { op: 'leaf', field: 'medalName', compare: 'contains', value: '蓝' },
          ],
        },
      ],
    };
    expect(testAudienceRule(rule, { eventKind: 'danmaku', guardLevel: 2, medalName: '蓝天' })).toBe(true);
    expect(testAudienceRule(rule, { eventKind: 'danmaku', guardLevel: 0, isAdmin: true })).toBe(false);
    expect(testAudienceRule({ op: 'leaf', field: 'vip', compare: 'exists' }, { eventKind: 'gift' })).toBe(false);
    expect(testAudienceRule({ op: 'leaf', field: 'vip', compare: 'exists' }, { eventKind: 'gift', vip: false })).toBe(true);
  });

  it('只采用最高优先级匹配组', () => {
    const groups: AudienceGroup[] = [
      group('normal', 1),
      group('captain', 20),
      { ...group('disabled', 100), enabled: false },
    ];
    expect(matchAudienceGroup(groups, { eventKind: 'danmaku', guardLevel: 3 })?.id).toBe('captain');
  });

  it('保存时钉住组件到样式、布局到组件的引用完整性', () => {
    const design = structuredClone(BILIBILI_OVERLAY_DEFAULTS.design);
    design.components[0].styleId = 'missing';
    expect(() => normalizeOverlayDesign(design)).toThrow('不存在的样式');

    const next = structuredClone(BILIBILI_OVERLAY_DEFAULTS.design);
    next.placements[0].componentId = 'missing';
    expect(() => normalizeOverlayDesign(next)).toThrow('不存在的组件');
  });
});

function group(id: string, priority: number): AudienceGroup {
  return {
    id,
    name: id,
    enabled: true,
    priority,
    rule: { op: 'leaf', field: 'guardLevel', compare: 'gte', value: 1 },
    username: {},
    body: {},
  };
}
