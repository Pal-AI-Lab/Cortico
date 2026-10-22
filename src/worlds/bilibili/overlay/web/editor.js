/**
 * 单页 Overlay 编辑器。样式、组件与布局共享一份草稿；保存才写入运行态。
 * 中央 iframe 复用 OBS 渲染器，选择框与手柄由父页的独立交互层承载。
 */
(() => {
  'use strict';

  const WALL_MODE_KEY = 'bilibili.overlay-editor.wall.v1';
  /** 须与 src/web/client/theme/handoff.ts 的 THEME_HANDOFF_FRAGMENT_KEY 一致。 */
  const THEME_FRAGMENT_KEY = 'cortico-theme';
  const THEME_KEYS = [
    'paper', 'paper-2', 'sheet', 'sheet-2', 'sheet-3',
    'ink', 'ink-soft', 'ink-dim', 'line', 'line-2', 'line-strong',
    'accent', 'accent-2', 'on-accent', 'danger',
  ];

  /** 页面语言来自 WebUI 链接的 `lang`:zh 与 zh-Hant 用中文,其他语言用英文,缺省用中文。 */
  const REQUESTED_LANG = new URLSearchParams(location.search).get('lang');
  const LANG = !REQUESTED_LANG || REQUESTED_LANG === 'zh' || REQUESTED_LANG === 'zh-Hant' ? 'zh' : 'en';
  const STRINGS = {
    zh: {
      pageTitle: 'Bilibili Overlay 编辑器',
      brandName: 'Overlay 编辑器',
      undo: '撤销',
      undoTitle: '撤销 (Ctrl+Z)',
      redo: '重做',
      redoTitle: '重做 (Ctrl+Shift+Z)',
      demoEvents: '试显事件',
      demo: '试显',
      obsPage: 'OBS 页面 ↗',
      connecting: '正在连接',
      adoptRemote: '采用远端',
      workspaces: '编辑器工作区',
      modeStyles: '样式',
      modeComponents: '组件',
      modeLayout: '布局',
      help: '帮助',
      helpButtonTitle: '快捷键与使用说明',
      create: '新建',
      wall: '画布背景墙',
      wallLight: '浅',
      wallLightTitle: '浅色背景墙',
      wallDark: '深',
      wallDarkTitle: '深色背景墙',
      grid: '网格',
      zoomOut: '缩小',
      zoomIn: '放大',
      fitCanvas: '适合画布',
      fit: '适合',
      previewFrame: 'Overlay 实时草稿预览',
      interactionLayer: '布局交互层',
      loading: '正在装入编辑器',
      selectObject: '请选择一个对象',
      shortcutHint: '拖动移动 · 八向缩放 · 方向键 1px · Shift 10px · Delete 删除',
      stylesEditor: '样式编辑器',
      componentsEditor: '组件编辑器',
      layoutEditor: '布局编辑器',
      kindDanmaku: '弹幕机',
      glyphDanmaku: '弹',
      kindScrollNotice: '滚动公告',
      glyphScrollNotice: '滚',
      kindFixedNotice: '固定公告',
      glyphFixedNotice: '固',
      kindAgentNotice: 'Agent 公告',
      kindImage: '图片',
      glyphImage: '图',
      fieldUid: '用户 UID',
      fieldGuardLevel: '大航海等级',
      fieldMedalLevel: '粉丝牌等级',
      fieldMedalName: '粉丝牌名称',
      fieldMedalAnchorName: '粉丝牌主播',
      fieldMedalRoomId: '粉丝牌房间',
      fieldMedalColor: '粉丝牌颜色值',
      fieldIsAdmin: '房管',
      fieldRank: '排名',
      fieldNameColor: '昵称颜色',
      fieldUserLevel: '用户等级',
      fieldEventKind: '事件类型',
      saved: '已保存',
      loadFailed: '编辑器装入失败',
      connectFailed: '连接失败',
      requestFailed: (status) => `请求失败 (${status})`,
      saving: '正在保存',
      writingNotice: '正在写入公告',
      remoteUpdated: '远端设计已更新',
      unsaved: '有未保存修改',
      noticeDraftPending: '公告草稿未写入',
      saveDesign: '保存设计',
      savedWithNewerDraft: '提交时版本已保存；后续修改仍留在草稿中',
      designSaved: 'Overlay 设计已保存并热更新',
      overwriteRemote: '覆盖远端设计',
      conflictToast: '服务器设计已更新；本地草稿已保留，再次保存将明确覆盖远端',
      saveFailed: '保存失败',
      adoptedRemote: '已采用服务器上的最新设计',
      demoGiftUser: '示例舰长',
      demoGiftBody: '赠送 小电视 ×1',
      sampleViewer: '示例观众',
      demoDanmakuBody: '这是一条实时草稿弹幕',
      tabAppearance: '外观',
      tabText: '文字',
      tabNine: '九宫格',
      tabGroups: '全局用户组',
      builtin: '内置',
      custom: '自定义',
      styleLibrary: '样式库',
      itemsCount: (n) => `${n} 项`,
      copyToEdit: '复制后可编辑。',
      duplicateAsCustom: '复制为自定义样式',
      builtinStyle: '内置样式',
      duplicate: '复制',
      deleteStyle: '删除样式',
      styleActions: '样式操作',
      copyName: (name) => `${name} 副本`,
      newStyle: '新样式',
      styleInUse: (name) => `样式仍被组件「${name}」使用`,
      willDelete: (name) => `将删除「${name}」。`,
      delete: '删除',
      name: '名称',
      backgroundRgba: '背景 RGBA',
      borderRgba: '边框 RGBA',
      borderWidth: '边框宽度',
      radius: '圆角半径',
      padding: '内边距',
      sampleDanmaku: '这是一条弹幕正文',
      panelAppearance: '面板外观',
      username: '用户名',
      bodyText: '弹幕 / 公告正文',
      textPreview: '透明度、字体与描边实时预览',
      font: '字体',
      fontSize: '字号',
      fontWeight: '字重',
      textRgba: '文字 RGBA',
      strokeRgba: '描边 RGBA',
      strokeWidth: '描边宽度',
      hexRgba: '八位十六进制 RGBA',
      alphaPercent: 'Alpha 百分比',
      alphaSlider: 'Alpha 滑条',
      nineNeedsCopy: '复制内置样式后即可绑定素材并手动划分九宫格。',
      deleteAsset: '删除素材',
      uploadAsset: '上传素材',
      disableNine: '停用九宫格',
      pickAsset: '选择一张素材开始划分。',
      uploadHint: '上传 PNG、JPEG、WebP 或 GIF 素材。',
      assetMissing: '当前素材不存在，请重新选择。',
      nineSource: 'Nine-slice 源图',
      sourceSlices: '源图切线',
      outputWidth: '输出边框宽度',
      repeatMode: '拉伸方式',
      repeatStretch: '拉伸',
      repeatTile: '平铺',
      repeatRound: '整片平铺',
      fillCenter: '绘制中心区域',
      dragToResize: '拖动右下角验证不同尺寸',
      insetTop: '上 T',
      insetRight: '右 R',
      insetBottom: '下 B',
      insetLeft: '左 L',
      assetTooLarge: '素材不能超过 8 MiB',
      assetUploaded: '素材已上传',
      ownerStyle: (name) => `样式「${name}」`,
      ownerComponent: (name) => `组件「${name}」`,
      assetInUse: (owner) => `素材仍被${owner}使用；先解除引用并保存`,
      deleteAssetConfirm: '素材文件将从本机素材库中删除，并清空当前撤销记录。',
      assetDeleted: '素材已删除',
      assetGone: '素材已经不存在',
      groupGlyph: '组',
      priorityValue: (n) => `优先级 ${n}`,
      enabled: '启用',
      disabled: '停用',
      noGroups: '还没有用户组。',
      newGroup: '新建用户组',
      groupsNote: '全局生效；命中后覆写所有弹幕机中的用户名与正文样式。',
      groupRules: '全局用户组策略',
      groupsCount: (n) => `${n} 组`,
      groupActions: '组操作',
      priority: '优先级',
      enableGroup: '启用这个用户组',
      groupDefinition: '组定义',
      matchConditions: '匹配条件',
      usernameOverride: '用户名覆写',
      bodyOverride: '正文覆写',
      groupFontOverrides: '分组字体覆写',
      deleteGroup: '删除用户组',
      newGroupName: '新用户组',
      ruleAll: '全部满足',
      ruleAny: '任一满足',
      ruleLeaf: '单个条件',
      remove: '移除',
      addCondition: '添加条件',
      addSubgroup: '添加子组',
      existsOnly: '只检查存在',
      yes: '是',
      no: '否',
      eventDanmaku: '弹幕',
      eventGift: '礼物',
      compareEq: '等于',
      compareGte: '大于等于',
      compareLte: '小于等于',
      compareContains: '包含',
      compareExists: '存在',
      inheritWhenEmpty: '留空继承',
      inherit: '继承',
      restoreInherit: '恢复继承',
      setOverrideColor: '设置覆写颜色',
      placedCount: (n) => `${n} 处`,
      noComponents: '还没有组件。',
      componentLibrary: '组件库',
      stopMock: '停止 Mock',
      mockTest: 'Mock 测试',
      kind: '类型',
      useStyle: '使用样式',
      componentDefinition: '组件定义',
      addToLayout: '添加到布局',
      componentActions: '组件操作',
      scrollDirection: '滚动方向',
      verticalList: '纵向列表',
      horizontalDanmaku: '横向弹幕',
      admission: '显示内容',
      danmakuOnly: '仅弹幕',
      giftOnly: '仅礼物',
      danmakuAndGift: '弹幕 + 礼物',
      showAvatar: '显示用户头像',
      speed: '速度 px/s',
      itemGap: '条目间距',
      maxItems: '最多保留',
      usernameMax: '用户名显示上限',
      bodyMax: '内容显示上限',
      zeroShowsAll: '0 表示完整显示；省略号计入上限。',
      edgeFade: '边缘淡出 px',
      edgeFadeNote: '沿滚动方向的两端淡出；设为 0 可关闭。',
      horizontal: '横向',
      vertical: '纵向',
      noticeText: '公告文本',
      noticeLinesNote: '每个非空行是一条公告。',
      lineHold: '行间暂留 ms',
      lineTransition: '行间交替时长 ms',
      lineTransitionNote: '0 表示整段连续滚动。',
      lineSpeed: '单行速度 px/s',
      scrollGap: '连续滚动间距',
      emptyPlaceholder: '空白占位',
      hideWhenEmpty: '无公告时隐藏组件',
      typingInterval: '打字间隔 ms',
      typingNote: '逐字出现的间隔；设为 0 可关闭动画。',
      imageSource: '图片来源',
      externalUrl: '外部 URL',
      assetLibrary: '素材库',
      fitMode: '填充方式',
      fitContain: '完整显示',
      fitCover: '铺满裁切',
      fitFill: '拉伸铺满',
      opacity: '整体透明度',
      imageUrl: '图片 URL',
      behavior: '行为参数',
      showTitle: '显示组件标题',
      componentTitle: '组件标题',
      notEnabled: '未启用',
      titleText: '标题内容',
      titleSide: '所在边',
      sideTop: '上边',
      sideRight: '右边',
      sideBottom: '下边',
      sideLeft: '左边',
      titleAlign: '标题对齐',
      alignStart: '靠左 / 起点',
      alignCenter: '居中',
      alignEnd: '靠右 / 终点',
      titleFont: '标题字体',
      ownFont: '独立字体',
      previewLoading: '预览画布仍在装入',
      uploadImage: '上传图片',
      keepDraftOverwrite: '保留草稿并覆盖',
      writeNotice: '写入公告栏',
      noticeUpdated: 'Agent 公告已更新',
      noticeCleared: 'Agent 公告已清空',
      noticeConflict: 'Agent 已更新服务器公告。你的草稿仍保留。',
      adoptServer: '采用服务器内容',
      plainText: '纯文本内容',
      noticeWrite: 'Agent 公告写入',
      charLimit: (n) => `上限 ${n} 字`,
      newComponent: '新建组件',
      defaultScrollText: '欢迎来到直播间\n关注主播，不错过开播通知',
      defaultFixedText: '固定公告',
      defaultEmptyText: '公告栏待更新',
      deleteComponent: '删除组件',
      deleteWithPlacements: (n) => `组件与它的 ${n} 个布局实例都会删除。`,
      canvasWidth: '画布宽度',
      canvasHeight: '画布高度',
      liveCanvas: '直播画布',
      missingComponent: '丢失组件',
      hidden: '隐藏',
      locked: '锁定',
      noPlacements: '还没有布局项。',
      layers: '图层',
      component: '组件',
      width: '宽度',
      height: '高度',
      zIndex: '层级 Z',
      showPlacement: '显示这个布局项',
      lockPlacement: '锁定位置与尺寸',
      geometry: '位置与尺寸',
      bringToFront: '移到最上层',
      duplicateInstance: '复制实例',
      deleteInstance: '删除实例',
      layoutActions: '布局操作',
      createComponentFirst: '请先创建组件',
      addToLayoutNote: '同一个组件可以在画布中放置多次。',
      editComponent: (name) => `编辑组件：${name}`,
      editStyle: (name) => `编辑样式：${name}`,
      draftPreview: '草稿预览',
      lockedSuffix: ' · 已锁定',
      selectPlacement: '请选择一个布局项',
      cancel: '取消',
      helpTitle: '编辑器使用说明',
      helpSave: '保存并热更新 OBS 页面',
      helpUndo: '撤销；Shift + Ctrl / ⌘ + Z 重做',
      helpArrowsKey: '方向键',
      helpArrows: '移动选中的布局项 1 px；按住 Shift 移动 10 px',
      helpDelete: '删除选中的布局实例（输入框内不会触发）',
      helpMock: '只在中央预览中填充选中组件；不会改写设计或真实公告',
      helpWallKey: '背景 浅 / 深',
      helpWall: '切换透明组件背后的检查背景；该偏好不进入 OBS 设计',
      helpNine: '源图红线定义切片像素；输出宽度定义最终边框厚度。',
      gotIt: '知道了',
    },
    en: {
      pageTitle: 'Bilibili Overlay editor',
      brandName: 'Overlay editor',
      undo: 'Undo',
      undoTitle: 'Undo (Ctrl+Z)',
      redo: 'Redo',
      redoTitle: 'Redo (Ctrl+Shift+Z)',
      demoEvents: 'Test events',
      demo: 'Test',
      obsPage: 'OBS page ↗',
      connecting: 'Connecting',
      adoptRemote: 'Use server copy',
      workspaces: 'Editor workspaces',
      modeStyles: 'Styles',
      modeComponents: 'Components',
      modeLayout: 'Layout',
      help: 'Help',
      helpButtonTitle: 'Shortcuts and usage',
      create: 'New',
      wall: 'Canvas backdrop',
      wallLight: 'Light',
      wallLightTitle: 'Light backdrop',
      wallDark: 'Dark',
      wallDarkTitle: 'Dark backdrop',
      grid: 'Grid',
      zoomOut: 'Zoom out',
      zoomIn: 'Zoom in',
      fitCanvas: 'Fit canvas',
      fit: 'Fit',
      previewFrame: 'Overlay live draft preview',
      interactionLayer: 'Layout interaction layer',
      loading: 'Loading editor',
      selectObject: 'Select an object',
      shortcutHint: 'Drag to move · resize from 8 handles · arrow keys 1px · Shift 10px · Delete removes',
      stylesEditor: 'Style editor',
      componentsEditor: 'Component editor',
      layoutEditor: 'Layout editor',
      kindDanmaku: 'Danmaku feed',
      glyphDanmaku: 'D',
      kindScrollNotice: 'Scrolling notice',
      glyphScrollNotice: 'S',
      kindFixedNotice: 'Fixed notice',
      glyphFixedNotice: 'F',
      kindAgentNotice: 'Agent announcement',
      kindImage: 'Image',
      glyphImage: 'I',
      fieldUid: 'User UID',
      fieldGuardLevel: 'Guard level',
      fieldMedalLevel: 'Fan medal level',
      fieldMedalName: 'Fan medal name',
      fieldMedalAnchorName: 'Fan medal streamer',
      fieldMedalRoomId: 'Fan medal room',
      fieldMedalColor: 'Fan medal color value',
      fieldIsAdmin: 'Room admin',
      fieldRank: 'Rank',
      fieldNameColor: 'Name color',
      fieldUserLevel: 'User level',
      fieldEventKind: 'Event type',
      saved: 'Saved',
      loadFailed: 'Editor failed to load',
      connectFailed: 'Connection failed',
      requestFailed: (status) => `Request failed (${status})`,
      saving: 'Saving',
      writingNotice: 'Writing announcement',
      remoteUpdated: 'Server design changed',
      unsaved: 'Unsaved changes',
      noticeDraftPending: 'Announcement draft not written',
      saveDesign: 'Save design',
      savedWithNewerDraft: 'The submitted version is saved; later edits stay in the draft',
      designSaved: 'Overlay design saved and applied',
      overwriteRemote: 'Overwrite server design',
      conflictToast: 'The design on the server changed. Your draft is kept; saving again overwrites the server copy.',
      saveFailed: 'Save failed',
      adoptedRemote: 'Loaded the latest design from the server',
      demoGiftUser: 'Sample captain',
      demoGiftBody: 'Sent Little TV ×1',
      sampleViewer: 'Sample viewer',
      demoDanmakuBody: 'A live draft danmaku',
      tabAppearance: 'Appearance',
      tabText: 'Text',
      tabNine: 'Nine-slice',
      tabGroups: 'User groups',
      builtin: 'Built-in',
      custom: 'Custom',
      styleLibrary: 'Style library',
      itemsCount: (n) => (n === 1 ? '1 item' : `${n} items`),
      copyToEdit: 'Duplicate it to edit.',
      duplicateAsCustom: 'Duplicate as custom style',
      builtinStyle: 'Built-in style',
      duplicate: 'Duplicate',
      deleteStyle: 'Delete style',
      styleActions: 'Style actions',
      copyName: (name) => `${name} copy`,
      newStyle: 'New style',
      styleInUse: (name) => `The style is still used by component "${name}"`,
      willDelete: (name) => `"${name}" will be deleted.`,
      delete: 'Delete',
      name: 'Name',
      backgroundRgba: 'Background RGBA',
      borderRgba: 'Border RGBA',
      borderWidth: 'Border width',
      radius: 'Corner radius',
      padding: 'Padding',
      sampleDanmaku: 'This is a danmaku message',
      panelAppearance: 'Panel appearance',
      username: 'Username',
      bodyText: 'Danmaku / announcement text',
      textPreview: 'Live preview of opacity, font and outline',
      font: 'Font',
      fontSize: 'Font size',
      fontWeight: 'Font weight',
      textRgba: 'Text RGBA',
      strokeRgba: 'Outline RGBA',
      strokeWidth: 'Outline width',
      hexRgba: '8-digit hex RGBA',
      alphaPercent: 'Alpha percent',
      alphaSlider: 'Alpha slider',
      nineNeedsCopy: 'Duplicate a built-in style to bind an asset and set its nine-slice.',
      deleteAsset: 'Delete asset',
      uploadAsset: 'Upload asset',
      disableNine: 'Turn off nine-slice',
      pickAsset: 'Pick an asset to slice.',
      uploadHint: 'Upload a PNG, JPEG, WebP or GIF asset.',
      assetMissing: 'The selected asset no longer exists; pick another.',
      nineSource: 'Nine-slice source image',
      sourceSlices: 'Source slice lines',
      outputWidth: 'Output border width',
      repeatMode: 'Fill mode',
      repeatStretch: 'Stretch',
      repeatTile: 'Repeat',
      repeatRound: 'Round',
      fillCenter: 'Draw the center area',
      dragToResize: 'Drag the bottom-right corner to try other sizes',
      insetTop: 'Top',
      insetRight: 'Right',
      insetBottom: 'Bottom',
      insetLeft: 'Left',
      assetTooLarge: 'Assets must not exceed 8 MiB',
      assetUploaded: 'Asset uploaded',
      ownerStyle: (name) => `style "${name}"`,
      ownerComponent: (name) => `component "${name}"`,
      assetInUse: (owner) => `The asset is still used by ${owner}; remove the reference and save first`,
      deleteAssetConfirm: 'The asset file is deleted from the local asset library and the undo history is cleared.',
      assetDeleted: 'Asset deleted',
      assetGone: 'The asset no longer exists',
      groupGlyph: 'G',
      priorityValue: (n) => `Priority ${n}`,
      enabled: 'On',
      disabled: 'Off',
      noGroups: 'No user groups yet.',
      newGroup: 'New user group',
      groupsNote: 'Applies globally; a match overrides the username and text styles in every danmaku feed.',
      groupRules: 'Global user group rules',
      groupsCount: (n) => (n === 1 ? '1 group' : `${n} groups`),
      groupActions: 'Group actions',
      priority: 'Priority',
      enableGroup: 'Enable this user group',
      groupDefinition: 'Group definition',
      matchConditions: 'Match conditions',
      usernameOverride: 'Username override',
      bodyOverride: 'Text override',
      groupFontOverrides: 'Group font overrides',
      deleteGroup: 'Delete user group',
      newGroupName: 'New user group',
      ruleAll: 'All match',
      ruleAny: 'Any matches',
      ruleLeaf: 'Single condition',
      remove: 'Remove',
      addCondition: 'Add condition',
      addSubgroup: 'Add subgroup',
      existsOnly: 'Presence only',
      yes: 'Yes',
      no: 'No',
      eventDanmaku: 'Danmaku',
      eventGift: 'Gift',
      compareEq: 'Equals',
      compareGte: 'At least',
      compareLte: 'At most',
      compareContains: 'Contains',
      compareExists: 'Exists',
      inheritWhenEmpty: 'Empty inherits',
      inherit: 'Inherit',
      restoreInherit: 'Inherit again',
      setOverrideColor: 'Set override color',
      placedCount: (n) => `${n} placed`,
      noComponents: 'No components yet.',
      componentLibrary: 'Component library',
      stopMock: 'Stop mock',
      mockTest: 'Mock test',
      kind: 'Type',
      useStyle: 'Style',
      componentDefinition: 'Component definition',
      addToLayout: 'Add to layout',
      componentActions: 'Component actions',
      scrollDirection: 'Scroll direction',
      verticalList: 'Vertical list',
      horizontalDanmaku: 'Horizontal scroll',
      admission: 'Shows',
      danmakuOnly: 'Danmaku only',
      giftOnly: 'Gifts only',
      danmakuAndGift: 'Danmaku + gifts',
      showAvatar: 'Show avatars',
      speed: 'Speed px/s',
      itemGap: 'Item gap',
      maxItems: 'Max items',
      usernameMax: 'Username length limit',
      bodyMax: 'Text length limit',
      zeroShowsAll: '0 shows the full text; the ellipsis counts toward the limit.',
      edgeFade: 'Edge fade px',
      edgeFadeNote: 'Fades both ends along the scroll direction; 0 turns it off.',
      horizontal: 'Horizontal',
      vertical: 'Vertical',
      noticeText: 'Notice text',
      noticeLinesNote: 'Each non-empty line is one notice.',
      lineHold: 'Line hold ms',
      lineTransition: 'Line transition ms',
      lineTransitionNote: '0 scrolls all lines as one continuous strip.',
      lineSpeed: 'Line speed px/s',
      scrollGap: 'Continuous scroll gap',
      emptyPlaceholder: 'Empty placeholder',
      hideWhenEmpty: 'Hide when there is no announcement',
      typingInterval: 'Typing interval ms',
      typingNote: 'Delay between characters; 0 turns the animation off.',
      imageSource: 'Image source',
      externalUrl: 'External URL',
      assetLibrary: 'Asset library',
      fitMode: 'Fit',
      fitContain: 'Contain',
      fitCover: 'Cover (crop)',
      fitFill: 'Stretch',
      opacity: 'Opacity',
      imageUrl: 'Image URL',
      behavior: 'Behavior',
      showTitle: 'Show component title',
      componentTitle: 'Component title',
      notEnabled: 'Off',
      titleText: 'Title text',
      titleSide: 'Side',
      sideTop: 'Top',
      sideRight: 'Right',
      sideBottom: 'Bottom',
      sideLeft: 'Left',
      titleAlign: 'Title alignment',
      alignStart: 'Left / start',
      alignCenter: 'Center',
      alignEnd: 'Right / end',
      titleFont: 'Title font',
      ownFont: 'Own font',
      previewLoading: 'The preview canvas is still loading',
      uploadImage: 'Upload image',
      keepDraftOverwrite: 'Keep draft and overwrite',
      writeNotice: 'Write to board',
      noticeUpdated: 'Agent announcement updated',
      noticeCleared: 'Agent announcement cleared',
      noticeConflict: 'The Agent updated the announcement on the server. Your draft is kept.',
      adoptServer: 'Use server text',
      plainText: 'Plain text',
      noticeWrite: 'Agent announcement',
      charLimit: (n) => `Limit ${n} chars`,
      newComponent: 'New component',
      defaultScrollText: 'Welcome to the stream\nFollow to get notified when the stream starts',
      defaultFixedText: 'Fixed notice',
      defaultEmptyText: 'Announcement coming soon',
      deleteComponent: 'Delete component',
      deleteWithPlacements: (n) => `The component and its ${n} layout instance${n === 1 ? '' : 's'} will be deleted.`,
      canvasWidth: 'Canvas width',
      canvasHeight: 'Canvas height',
      liveCanvas: 'Stream canvas',
      missingComponent: 'Missing component',
      hidden: 'Hidden',
      locked: 'Locked',
      noPlacements: 'No layout items yet.',
      layers: 'Layers',
      component: 'Component',
      width: 'Width',
      height: 'Height',
      zIndex: 'Layer Z',
      showPlacement: 'Show this layout item',
      lockPlacement: 'Lock position and size',
      geometry: 'Position and size',
      bringToFront: 'Bring to front',
      duplicateInstance: 'Duplicate instance',
      deleteInstance: 'Delete instance',
      layoutActions: 'Layout actions',
      createComponentFirst: 'Create a component first',
      addToLayoutNote: 'A component can be placed on the canvas more than once.',
      editComponent: (name) => `Edit component: ${name}`,
      editStyle: (name) => `Edit style: ${name}`,
      draftPreview: 'Draft preview',
      lockedSuffix: ' · locked',
      selectPlacement: 'Select a layout item',
      cancel: 'Cancel',
      helpTitle: 'Editor help',
      helpSave: 'Save and apply to the OBS page',
      helpUndo: 'Undo; Shift + Ctrl / ⌘ + Z redoes',
      helpArrowsKey: 'Arrow keys',
      helpArrows: 'Move the selected layout item 1 px; hold Shift for 10 px',
      helpDelete: 'Delete the selected layout instance (ignored while typing in a field)',
      helpMock: 'Fills the selected component in the center preview only; the design and the real announcement stay unchanged',
      helpWallKey: 'Backdrop light / dark',
      helpWall: 'Switches the backdrop behind transparent components; this preference is not saved into the OBS design',
      helpNine: 'Red lines on the source image set the slice pixels; output width sets the final border thickness.',
      gotIt: 'Got it',
    },
  };
  const T = STRINGS[LANG];

  applyInheritedTheme();
  applyStaticText();

  const refs = {
    inspector: byId('inspector'),
    title: byId('workspace-title'),
    kicker: byId('workspace-kicker'),
    create: byId('create'),
    save: byId('save'),
    adoptDesign: byId('adopt-design'),
    saveState: byId('save-state'),
    undo: byId('undo'),
    redo: byId('redo'),
    frame: byId('preview-frame'),
    viewport: byId('canvas-viewport'),
    sizer: byId('canvas-sizer'),
    shell: byId('canvas-shell'),
    layer: byId('interaction-layer'),
    loading: byId('loading'),
    canvasSize: byId('canvas-size'),
    selectionStatus: byId('selection-status'),
    zoomLabel: byId('zoom-label'),
    snapGrid: byId('snap-grid'),
    wallButtons: [...document.querySelectorAll('[data-wall-mode]')],
    modal: byId('modal'),
    modalContent: byId('modal-content'),
    toasts: byId('toasts'),
  };

  const workspaceNames = {
    styles: ['STYLE', T.stylesEditor],
    components: ['COMPONENT', T.componentsEditor],
    layout: ['LAYOUT', T.layoutEditor],
  };
  const componentKinds = {
    danmaku: [T.kindDanmaku, T.glyphDanmaku],
    'scroll-notice': [T.kindScrollNotice, T.glyphScrollNotice],
    'fixed-notice': [T.kindFixedNotice, T.glyphFixedNotice],
    'agent-notice': [T.kindAgentNotice, 'A'],
    image: [T.kindImage, T.glyphImage],
  };
  const fontChoices = [
    'Microsoft YaHei, sans-serif',
    'PingFang SC, sans-serif',
    'SimHei, sans-serif',
    'SimSun, serif',
    'KaiTi, serif',
    'Noto Sans CJK SC, sans-serif',
    'Source Han Sans SC, sans-serif',
    'monospace',
  ];
  const audienceFields = [
    ['uid', T.fieldUid, 'text'], ['guardLevel', T.fieldGuardLevel, 'number'], ['medalLevel', T.fieldMedalLevel, 'number'],
    ['medalName', T.fieldMedalName, 'text'], ['medalAnchorName', T.fieldMedalAnchorName, 'text'], ['medalRoomId', T.fieldMedalRoomId, 'number'],
    ['medalColor', T.fieldMedalColor, 'number'], ['isAdmin', T.fieldIsAdmin, 'boolean'], ['vip', 'VIP', 'boolean'],
    ['svip', 'SVIP', 'boolean'], ['rank', T.fieldRank, 'number'], ['nameColor', T.fieldNameColor, 'text'],
    ['userLevel', T.fieldUserLevel, 'number'], ['eventKind', T.fieldEventKind, 'event'],
  ];
  let fieldSequence = 0;

  const editor = {
    state: null,
    design: null,
    saved: '',
    mode: 'styles',
    styleTab: 'appearance',
    selectedStyle: '',
    selectedGroup: '',
    selectedComponent: '',
    selectedPlacement: '',
    zoom: 1,
    fitScale: 1,
    displayScale: 1,
    frameReady: false,
    history: [],
    historyIndex: -1,
    historyTimer: 0,
    previewFrame: 0,
    saving: false,
    previewEvents: [],
    announcementDraft: '',
    announcementBaseRevision: 0,
    announcementDirty: false,
    announcementConflict: false,
    announcementSaving: false,
    eventSource: null,
    designConflict: false,
    wallMode: readWallMode(),
    mockComponentId: '',
  };

  document.querySelectorAll('.mode-button[data-mode]').forEach((button) => {
    button.addEventListener('click', () => switchMode(button.dataset.mode));
  });
  refs.create.addEventListener('click', createForMode);
  refs.save.addEventListener('click', () => void saveDesign());
  refs.adoptDesign.addEventListener('click', adoptRemoteDesign);
  refs.undo.addEventListener('click', undo);
  refs.redo.addEventListener('click', redo);
  byId('zoom-in').addEventListener('click', () => setZoom(editor.zoom * 1.15));
  byId('zoom-out').addEventListener('click', () => setZoom(editor.zoom / 1.15));
  byId('zoom-reset').addEventListener('click', () => setZoom(1));
  byId('demo-danmaku').addEventListener('click', () => previewAudience('danmaku'));
  byId('demo-gift').addEventListener('click', () => previewAudience('gift'));
  refs.wallButtons.forEach((button) => button.addEventListener('click', () => setWallMode(button.dataset.wallMode)));
  byId('help').addEventListener('click', showHelp);
  refs.frame.addEventListener('load', () => {
    editor.frameReady = true;
    sendPreview();
  });
  addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.source !== refs.frame.contentWindow) return;
    if (event.data?.type !== 'overlay-editor-ready') return;
    editor.frameReady = true;
    sendPreview();
  });
  refs.frame.src = refs.frame.dataset.src;
  refs.viewport.addEventListener('pointerdown', (event) => {
    if (event.target === refs.viewport || event.target === refs.sizer || event.target === refs.layer) selectPlacement('');
  });
  new ResizeObserver(() => fitCanvas()).observe(refs.viewport);
  addEventListener('beforeunload', (event) => {
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = '';
  });
  addEventListener('keydown', onKeyDown);

  applyWallMode();

  void loadEditor();

  async function loadEditor() {
    try {
      const state = await api('/api/editor/state');
      editor.state = state;
      editor.design = structuredClone(state.design);
      editor.saved = JSON.stringify(state.design);
      editor.selectedStyle = state.design.styles[0]?.id || state.builtinStyles[0]?.id || '';
      editor.selectedComponent = state.design.components[0]?.id || '';
      editor.selectedPlacement = state.design.placements[0]?.id || '';
      editor.selectedGroup = state.design.groups[0]?.id || '';
      editor.announcementDraft = state.agentAnnouncement?.text || '';
      editor.announcementBaseRevision = state.agentAnnouncement?.revision || 0;
      editor.history = [{ json: JSON.stringify(editor.design), design: structuredClone(editor.design) }];
      editor.historyIndex = 0;
      refs.loading.classList.add('hidden');
      renderAll();
      startEditorEvents();
      requestAnimationFrame(fitCanvas);
      setSaveState('saved', T.saved);
    } catch (error) {
      refs.loading.replaceChildren(h('strong', null, T.loadFailed), h('span', null, errorText(error)));
      setSaveState('error', T.connectFailed);
    }
  }

  async function api(path, method = 'GET', body) {
    const response = await fetch(path, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    let payload;
    try { payload = await response.json(); } catch { payload = {}; }
    if (!response.ok) {
      const error = new Error(payload.error || T.requestFailed(response.status));
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function renderAll() {
    if (!editor.design) return;
    ensureSelections();
    renderWorkspace();
    renderInteraction();
    updateCanvasMetrics();
    updateHistoryButtons();
    updateSaveState();
    sendPreviewSoon();
  }

  function renderWorkspace() {
    const [kicker, title] = workspaceNames[editor.mode];
    refs.kicker.textContent = kicker;
    refs.title.textContent = title;
    document.querySelectorAll('.mode-button[data-mode]').forEach((button) => {
      const active = button.dataset.mode === editor.mode;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    refs.inspector.replaceChildren();
    if (editor.mode === 'styles') renderStylesWorkspace();
    else if (editor.mode === 'components') renderComponentsWorkspace();
    else renderLayoutWorkspace();
  }

  function switchMode(mode) {
    if (!workspaceNames[mode] || editor.mode === mode) return;
    editor.mode = mode;
    renderWorkspace();
    renderInteraction();
  }

  function ensureSelections() {
    const design = editor.design;
    const allStyles = [...editor.state.builtinStyles, ...design.styles];
    if (!allStyles.some((item) => item.id === editor.selectedStyle)) editor.selectedStyle = allStyles[0]?.id || '';
    if (!design.components.some((item) => item.id === editor.selectedComponent)) editor.selectedComponent = design.components[0]?.id || '';
    if (!design.components.some((item) => item.id === editor.mockComponentId)) editor.mockComponentId = '';
    if (!design.placements.some((item) => item.id === editor.selectedPlacement)) editor.selectedPlacement = design.placements[0]?.id || '';
    if (!design.groups.some((item) => item.id === editor.selectedGroup)) editor.selectedGroup = design.groups[0]?.id || '';
  }

  function selectComponentId(id) {
    editor.selectedComponent = id;
    if (editor.mockComponentId && editor.mockComponentId !== id) {
      editor.mockComponentId = '';
      sendPreviewSoon();
    }
  }

  function mutate(change, options = {}) {
    change();
    markChanged(options);
  }

  function markChanged({ render = false, interaction = true, checkpoint = true } = {}) {
    const current = editor.history[editor.historyIndex];
    if (editor.historyIndex < editor.history.length - 1 && current?.json !== JSON.stringify(editor.design)) {
      editor.history.splice(editor.historyIndex + 1);
      updateHistoryButtons();
    }
    if (checkpoint) scheduleCheckpoint();
    updateSaveState();
    if (interaction) renderInteraction();
    if (render) renderWorkspace();
    sendPreviewSoon();
  }

  function scheduleCheckpoint() {
    clearTimeout(editor.historyTimer);
    editor.historyTimer = setTimeout(checkpoint, 350);
  }

  function checkpoint() {
    clearTimeout(editor.historyTimer);
    editor.historyTimer = 0;
    const json = JSON.stringify(editor.design);
    if (editor.history[editor.historyIndex]?.json === json) return;
    editor.history.splice(editor.historyIndex + 1);
    editor.history.push({ json, design: structuredClone(editor.design) });
    if (editor.history.length > 80) editor.history.shift();
    editor.historyIndex = editor.history.length - 1;
    updateHistoryButtons();
  }

  function undo() {
    checkpoint();
    if (editor.historyIndex <= 0) return;
    editor.historyIndex -= 1;
    restoreHistory();
  }

  function redo() {
    if (editor.history[editor.historyIndex]?.json !== JSON.stringify(editor.design)) {
      checkpoint();
      return;
    }
    if (editor.historyIndex >= editor.history.length - 1) return;
    editor.historyIndex += 1;
    restoreHistory();
  }

  function restoreHistory() {
    editor.design = structuredClone(editor.history[editor.historyIndex].design);
    renderAll();
  }

  function resetHistory() {
    editor.history = [{ json: JSON.stringify(editor.design), design: structuredClone(editor.design) }];
    editor.historyIndex = 0;
    clearTimeout(editor.historyTimer);
    editor.historyTimer = 0;
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    refs.undo.disabled = editor.historyIndex <= 0;
    refs.redo.disabled = editor.historyIndex >= editor.history.length - 1;
  }

  function isDesignDirty() {
    return Boolean(editor.design) && JSON.stringify(editor.design) !== editor.saved;
  }

  function isDirty() {
    return isDesignDirty() || editor.announcementDirty;
  }

  function updateSaveState() {
    if (editor.saving) return setSaveState('dirty', T.saving);
    if (editor.announcementSaving) return setSaveState('dirty', T.writingNotice);
    if (editor.designConflict) return setSaveState('error', T.remoteUpdated);
    if (isDesignDirty()) return setSaveState('dirty', T.unsaved);
    if (editor.announcementDirty) return setSaveState('dirty', T.noticeDraftPending);
    setSaveState('saved', T.saved);
  }

  function setSaveState(kind, label) {
    refs.saveState.className = `save-state ${kind}`;
    refs.saveState.querySelector('span').textContent = label;
    refs.saveState.title = label;
  }

  async function saveDesign() {
    if (!editor.design || editor.saving) return;
    checkpoint();
    const submitted = structuredClone(editor.design);
    const submittedJson = JSON.stringify(submitted);
    const baseRevision = editor.state.designRevision;
    editor.saving = true;
    refs.save.disabled = true;
    updateSaveState();
    try {
      const state = await api('/api/editor/design', 'PUT', { design: submitted, baseRevision });
      const hasNewerDraft = JSON.stringify(editor.design) !== submittedJson;
      editor.state = { ...editor.state, ...state };
      if (state.agentAnnouncement) applyAnnouncementState(state.agentAnnouncement);
      editor.saved = JSON.stringify(state.design);
      if (!hasNewerDraft) editor.design = structuredClone(state.design);
      editor.designConflict = false;
      refs.save.textContent = T.saveDesign;
      refs.adoptDesign.classList.add('hidden');
      checkpoint();
      toast(hasNewerDraft ? T.savedWithNewerDraft : T.designSaved);
      if (!hasNewerDraft) renderAll();
    } catch (error) {
      if (error.status === 409) {
        try {
          const latest = await api('/api/editor/state');
          editor.state = { ...editor.state, ...latest };
          if (latest.agentAnnouncement) applyAnnouncementState(latest.agentAnnouncement);
          editor.saved = JSON.stringify(latest.design);
          editor.designConflict = true;
          refs.save.textContent = T.overwriteRemote;
          refs.adoptDesign.classList.remove('hidden');
          toast(T.conflictToast, true);
          return;
        } catch { /* 保留原始冲突错误。 */ }
      }
      setSaveState('error', T.saveFailed);
      toast(errorText(error), true);
    } finally {
      editor.saving = false;
      refs.save.disabled = false;
      updateSaveState();
    }
  }

  function adoptRemoteDesign() {
    if (!editor.designConflict || !editor.state?.design) return;
    editor.design = structuredClone(editor.state.design);
    editor.saved = JSON.stringify(editor.design);
    editor.designConflict = false;
    refs.save.textContent = T.saveDesign;
    refs.adoptDesign.classList.add('hidden');
    resetHistory();
    renderAll();
    toast(T.adoptedRemote);
  }

  function updateCanvasMetrics() {
    const canvas = editor.design.canvas;
    refs.canvasSize.textContent = `${canvas.width} × ${canvas.height}`;
    refs.shell.style.width = `${canvas.width}px`;
    refs.shell.style.height = `${canvas.height}px`;
    fitCanvas();
  }

  function fitCanvas() {
    if (!editor.design) return;
    const canvas = editor.design.canvas;
    const availableWidth = Math.max(200, refs.viewport.clientWidth - 112);
    const availableHeight = Math.max(120, refs.viewport.clientHeight - 112);
    editor.fitScale = Math.min(1, availableWidth / canvas.width, availableHeight / canvas.height);
    editor.displayScale = editor.fitScale * editor.zoom;
    refs.shell.style.transform = `scale(${editor.displayScale})`;
    refs.sizer.style.width = `${canvas.width * editor.displayScale}px`;
    refs.sizer.style.height = `${canvas.height * editor.displayScale}px`;
    refs.zoomLabel.textContent = editor.zoom === 1 ? T.fit : `${Math.round(editor.zoom * 100)}%`;
  }

  function setZoom(value) {
    editor.zoom = Math.max(.35, Math.min(3, value));
    fitCanvas();
  }

  function setWallMode(value) {
    if (value !== 'light' && value !== 'dark') return;
    editor.wallMode = value;
    try { localStorage.setItem(WALL_MODE_KEY, value); } catch { /* 本机偏好写不进去不影响编辑。 */ }
    applyWallMode();
    sendPreviewSoon();
  }

  function applyWallMode() {
    refs.viewport.dataset.wallMode = editor.wallMode;
    refs.wallButtons.forEach((button) => {
      const active = button.dataset.wallMode === editor.wallMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function sendPreviewSoon() {
    cancelAnimationFrame(editor.previewFrame);
    editor.previewFrame = requestAnimationFrame(sendPreview);
  }

  function sendPreview() {
    if (!editor.frameReady || !editor.design) return;
    refs.frame.contentWindow.postMessage({
      type: 'overlay-editor-preview',
      design: editor.design,
      builtinStyles: editor.state.builtinStyles,
      events: editor.previewEvents,
      wallMode: editor.wallMode,
      mockComponentId: editor.mockComponentId,
    }, location.origin);
  }

  function startEditorEvents() {
    if (editor.eventSource) return;
    const source = new EventSource('/stream');
    editor.eventSource = source;
    source.onmessage = (message) => {
      let packet;
      try { packet = JSON.parse(message.data); } catch { return; }
      if ((packet.type === 'snapshot' || packet.type === 'state' || packet.type === 'announcement') && packet.agentAnnouncement) {
        applyAnnouncementState(packet.agentAnnouncement);
      }
    };
  }

  function applyAnnouncementState(next) {
    const revision = Number(next.revision) || 0;
    editor.state.agentAnnouncement = next;
    if (!editor.announcementDirty) {
      editor.announcementDraft = next.text || '';
      editor.announcementBaseRevision = revision;
      editor.announcementConflict = false;
      if (editor.mode === 'components' && componentById(editor.selectedComponent)?.kind === 'agent-notice') renderWorkspace();
      return;
    }
    if (revision !== editor.announcementBaseRevision) {
      editor.announcementConflict = true;
      if (editor.mode === 'components' && componentById(editor.selectedComponent)?.kind === 'agent-notice') renderWorkspace();
    }
    updateSaveState();
  }

  function previewAudience(kind) {
    if (!editor.frameReady) return;
    const event = kind === 'gift'
      ? { eventKind: 'gift', username: T.demoGiftUser, body: T.demoGiftBody, avatarUrl: '', facts: { eventKind: 'gift', guardLevel: 1 } }
      : { eventKind: 'danmaku', username: T.sampleViewer, body: T.demoDanmakuBody, avatarUrl: '', facts: { eventKind: 'danmaku', userLevel: 12 } };
    const group = [...editor.design.groups]
      .filter((item) => item.enabled && testPreviewRule(item.rule, event.facts))
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))[0];
    if (group) event.groupId = group.id;
    editor.previewEvents.push(event);
    if (editor.previewEvents.length > 8) editor.previewEvents.shift();
    refs.frame.contentWindow.postMessage({ type: 'overlay-editor-audience', event }, location.origin);
  }

  function testPreviewRule(rule, facts) {
    if (rule.op === 'all') return rule.rules.every((child) => testPreviewRule(child, facts));
    if (rule.op === 'any') return rule.rules.some((child) => testPreviewRule(child, facts));
    const actual = facts[rule.field];
    if (rule.compare === 'exists') return actual !== undefined && actual !== null && actual !== '';
    if (actual === undefined || actual === null) return false;
    if (rule.compare === 'contains') return String(actual).includes(String(rule.value ?? ''));
    if (rule.compare === 'gte') return Number(actual) >= Number(rule.value);
    if (rule.compare === 'lte') return Number(actual) <= Number(rule.value);
    return actual === rule.value || String(actual) === String(rule.value);
  }

  function createForMode() {
    if (!editor.design) return;
    if (editor.mode === 'styles') createStyle();
    else if (editor.mode === 'components') showCreateComponent();
    else showAddPlacement();
  }

  function byId(id) { return document.getElementById(id); }
  function h(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function button(label, onClick, className = 'small-button') {
    const element = h('button', className, label);
    element.type = 'button';
    element.addEventListener('click', onClick);
    return element;
  }
  function section(title, body, suffix) {
    const wrap = h('section', 'section');
    const head = h('header');
    head.append(h('strong', null, title));
    if (suffix) head.append(h('small', null, suffix));
    const content = h('div', 'section-body');
    if (body) content.append(body);
    wrap.append(head, content);
    return wrap;
  }
  function flushSection(title, body, suffix) {
    const wrap = section(title, body, suffix);
    wrap.classList.add('resource-section');
    wrap.querySelector('.section-body').classList.add('flush');
    return wrap;
  }
  function field(label, control, note) {
    const wrap = h('div', 'field');
    const labelable = control.matches?.('button, input, meter, output, progress, select, textarea');
    const caption = h(labelable ? 'label' : 'span', 'field-caption', label);
    if (labelable) {
      if (!control.id) control.id = `overlay-field-${++fieldSequence}`;
      caption.htmlFor = control.id;
    }
    wrap.append(caption, control);
    if (!note) return wrap;
    const outer = h('div');
    outer.append(wrap, h('p', 'field-note', note));
    return outer;
  }
  function textInput(value, setter, options = {}) {
    const input = h(options.multiline ? 'textarea' : 'input');
    input.value = value ?? '';
    if (options.placeholder) input.placeholder = options.placeholder;
    if (options.maxLength) input.maxLength = options.maxLength;
    input.addEventListener('input', () => {
      setter(input.value);
      markChanged({ interaction: options.interaction !== false, checkpoint: false });
      if (options.afterInput) options.afterInput(input.value);
    });
    input.addEventListener('change', checkpoint);
    return input;
  }
  function numberInput(value, setter, min, max, step = 1, options = {}) {
    const input = h('input');
    input.type = 'number';
    input.value = value ?? '';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.placeholder = options.placeholder || '';
    input.addEventListener('input', () => {
      if (input.value === '' && options.optional) setter(undefined);
      else if (!Number.isFinite(input.valueAsNumber) || input.valueAsNumber < min || input.valueAsNumber > max) return;
      else setter(input.valueAsNumber);
      markChanged({ interaction: options.interaction !== false, checkpoint: false });
      options.afterInput?.();
    });
    input.addEventListener('change', () => {
      if (input.value !== '' || !options.optional) {
        const value = Number.isFinite(input.valueAsNumber) ? Math.min(max, Math.max(min, input.valueAsNumber)) : min;
        setter(value);
        input.value = String(value);
        markChanged({ interaction: options.interaction !== false, checkpoint: false });
        options.afterInput?.();
      }
      checkpoint();
    });
    return input;
  }
  function selectInput(value, choices, setter, options = {}) {
    const select = h('select');
    for (const choice of choices) {
      const option = h('option', null, choice[1]);
      option.value = choice[0];
      select.append(option);
    }
    select.value = value;
    select.addEventListener('change', () => mutate(() => setter(select.value), { render: options.render !== false }));
    return select;
  }
  function checkInput(label, checked, setter, options = {}) {
    const wrap = h('label', 'check-field');
    const input = h('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => mutate(() => setter(input.checked), { render: Boolean(options.render) }));
    wrap.append(input, h('span', null, label));
    return wrap;
  }
  function divider() { return h('div', 'divider'); }
  function uniqueId(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
  function errorText(error) { return error instanceof Error ? error.message : String(error); }
  function readWallMode() {
    try { return localStorage.getItem(WALL_MODE_KEY) === 'light' ? 'light' : 'dark'; }
    catch { return 'dark'; }
  }
  function applyInheritedTheme() {
    const root = document.documentElement;
    const encoded = new URLSearchParams(location.hash.slice(1)).get(THEME_FRAGMENT_KEY);
    if (encoded) {
      try {
        const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
        const payload = JSON.parse(atob(base64 + '='.repeat((4 - base64.length % 4) % 4)));
        if (payload?.v === 1 && (payload.appearance === 'light' || payload.appearance === 'dark') && payload.palette && typeof payload.palette === 'object') {
          for (const key of THEME_KEYS) {
            const value = payload.palette[key];
            if (/^#[0-9a-f]{6}$/i.test(String(value || ''))) root.style.setProperty(`--${key}`, value);
          }
          root.dataset.colorMode = payload.appearance;
          root.style.colorScheme = payload.appearance;
          return;
        }
      } catch { /* 无效交接数据使用本页内置主题。 */ }
    }
    const system = matchMedia('(prefers-color-scheme: dark)');
    const applySystem = () => {
      root.dataset.colorMode = system.matches ? 'dark' : 'light';
      root.style.colorScheme = system.matches ? 'dark' : 'light';
    };
    applySystem();
    system.addEventListener?.('change', applySystem);
  }
  function applyStaticText() {
    document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';
    document.title = T.pageTitle;
    document.querySelectorAll('[data-i18n]').forEach((element) => { element.textContent = T[element.dataset.i18n]; });
    document.querySelectorAll('[data-i18n-title]').forEach((element) => { element.title = T[element.dataset.i18nTitle]; });
    document.querySelectorAll('[data-i18n-aria-label]').forEach((element) => {
      element.setAttribute('aria-label', T[element.dataset.i18nAriaLabel]);
    });
  }
  function toast(message, bad = false) {
    const item = h('div', `toast${bad ? ' bad' : ''}`, message);
    refs.toasts.append(item);
    setTimeout(() => item.remove(), 3400);
  }

  // ── 样式 ────────────────────────────────────────────────────────────────

  function allStyles() {
    return [...editor.state.builtinStyles, ...editor.design.styles];
  }

  function styleById(id) {
    return allStyles().find((item) => item.id === id) || editor.state.builtinStyles[0];
  }

  function renderStylesWorkspace() {
    const tabs = h('div', 'subtabs');
    const tabDefs = [['appearance', T.tabAppearance], ['text', T.tabText], ['nine', T.tabNine], ['groups', T.tabGroups]];
    tabs.style.gridTemplateColumns = 'repeat(4,1fr)';
    for (const [id, label] of tabDefs) {
      const tab = button(label, () => {
        editor.styleTab = id;
        renderWorkspace();
      }, editor.styleTab === id ? 'active' : '');
      tabs.append(tab);
    }
    if (editor.styleTab === 'groups') {
      refs.inspector.append(tabs);
      renderGroupsEditor();
      return;
    }

    const list = h('div', 'resource-list');
    for (const style of allStyles()) {
      const row = h('button', `resource-row${style.id === editor.selectedStyle ? ' active' : ''}`);
      row.type = 'button';
      const swatch = h('span', 'swatch');
      const fill = h('i');
      fill.style.background = style.background;
      swatch.append(fill);
      const copy = h('span', 'resource-copy');
      copy.append(h('strong', null, style.name), h('span', null, style.id));
      row.append(swatch, copy, h('span', 'row-badge', style.id.startsWith('builtin:') ? T.builtin : T.custom));
      row.addEventListener('click', () => {
        editor.selectedStyle = style.id;
        renderWorkspace();
      });
      list.append(row);
    }
    refs.inspector.append(flushSection(T.styleLibrary, list, T.itemsCount(allStyles().length)));
    refs.inspector.append(tabs);

    const style = styleById(editor.selectedStyle);
    if (!style) return;
    const builtin = style.id.startsWith('builtin:');
    if (builtin) {
      const body = h('div');
      body.append(
        h('p', 'placeholder', T.copyToEdit),
        button(T.duplicateAsCustom, () => createStyle(style), 'small-button accent'),
      );
      refs.inspector.append(section(T.builtinStyle, body));
    }
    if (editor.styleTab === 'appearance') refs.inspector.append(renderAppearance(style, builtin));
    if (editor.styleTab === 'text') refs.inspector.append(renderTextStyleEditor(style, builtin));
    if (editor.styleTab === 'nine') refs.inspector.append(renderNineSliceEditor(style, builtin));

    if (!builtin) {
      const actions = h('div', 'button-row split');
      actions.append(
        button(T.duplicate, () => createStyle(style)),
        button(T.deleteStyle, () => deleteStyle(style), 'small-button danger'),
      );
      refs.inspector.append(section(T.styleActions, actions));
    }
  }

  function createStyle(source) {
    const next = structuredClone(source || editor.state.builtinStyles[0]);
    next.id = uniqueId('style');
    next.name = source ? T.copyName(source.name) : T.newStyle;
    next.radius = source && Number.isFinite(source.radius) ? source.radius : 0;
    mutate(() => {
      editor.design.styles.push(next);
      editor.selectedStyle = next.id;
      editor.styleTab = 'appearance';
    }, { render: true });
  }

  function deleteStyle(style) {
    const used = editor.design.components.find((component) => component.styleId === style.id);
    if (used) return toast(T.styleInUse(used.name), true);
    confirmModal(T.deleteStyle, T.willDelete(style.name), T.delete, () => {
      mutate(() => {
        editor.design.styles = editor.design.styles.filter((item) => item.id !== style.id);
        editor.selectedStyle = editor.state.builtinStyles[0]?.id || '';
      }, { render: true });
    });
  }

  function renderAppearance(style, readonly) {
    const body = h('div');
    const name = textInput(style.name, (value) => { style.name = value; }, { interaction: false });
    name.disabled = readonly;
    body.append(field(T.name, name));
    body.append(field(T.backgroundRgba, colorControl(style.background, (value) => { style.background = value; }, readonly)));
    body.append(field(T.borderRgba, colorControl(style.borderColor, (value) => { style.borderColor = value; }, readonly)));
    const borderWidth = numberInput(style.borderWidth, (value) => { style.borderWidth = value; }, 0, 64, .5);
    const radius = numberInput(style.radius, (value) => { style.radius = value; }, 0, 200, 1);
    const padding = numberInput(style.padding, (value) => { style.padding = value; }, 0, 200, 1);
    borderWidth.disabled = radius.disabled = padding.disabled = readonly;
    body.append(
      field(T.borderWidth, borderWidth),
      field(T.radius, radius),
      field(T.padding, padding),
    );
    const preview = h('div', 'font-preview');
    preview.style.background = style.background;
    preview.style.border = `${style.borderWidth}px solid ${style.borderColor}`;
    preview.style.borderRadius = `${style.radius}px`;
    preview.style.padding = `${Math.min(20, style.padding)}px`;
    const username = h('span', null, T.sampleViewer);
    const line = h('span', null, T.sampleDanmaku);
    applyTextPreview(username, style.username);
    applyTextPreview(line, style.body);
    preview.append(username, line);
    body.append(divider(), preview);
    return section(T.panelAppearance, body);
  }

  function renderTextStyleEditor(style, readonly) {
    const body = h('div');
    body.append(h('div', 'field-label', T.username));
    body.append(textStyleFields(style.username, readonly));
    body.append(divider(), h('div', 'field-label', T.bodyText));
    body.append(textStyleFields(style.body, readonly));
    const preview = h('div', 'font-preview');
    preview.style.background = style.background;
    const username = h('span', null, T.sampleViewer);
    const line = h('span', null, T.textPreview);
    applyTextPreview(username, style.username);
    applyTextPreview(line, style.body);
    preview.append(username, line);
    body.append(divider(), preview);
    return section(T.tabText, body);
  }

  function textStyleFields(textStyle, readonly) {
    const wrap = h('div');
    const family = textInput(textStyle.fontFamily, (value) => { textStyle.fontFamily = value; });
    family.setAttribute('list', 'overlay-fonts');
    family.disabled = readonly;
    if (!document.getElementById('overlay-fonts')) {
      const datalist = h('datalist');
      datalist.id = 'overlay-fonts';
      for (const value of fontChoices) {
        const option = h('option');
        option.value = value;
        datalist.append(option);
      }
      document.body.append(datalist);
    }
    const size = numberInput(textStyle.fontSize, (value) => { textStyle.fontSize = value; }, 8, 240, 1);
    const weight = numberInput(textStyle.fontWeight, (value) => { textStyle.fontWeight = value; }, 100, 900, 100);
    const stroke = numberInput(textStyle.strokeWidth, (value) => { textStyle.strokeWidth = value; }, 0, 12, .5);
    size.disabled = weight.disabled = stroke.disabled = readonly;
    wrap.append(
      field(T.font, family), field(T.fontSize, size), field(T.fontWeight, weight),
      field(T.textRgba, colorControl(textStyle.color, (value) => { textStyle.color = value; }, readonly)),
      field(T.strokeRgba, colorControl(textStyle.strokeColor, (value) => { textStyle.strokeColor = value; }, readonly)),
      field(T.strokeWidth, stroke),
    );
    return wrap;
  }

  function applyTextPreview(element, textStyle) {
    element.style.fontFamily = textStyle.fontFamily;
    element.style.fontSize = `${Math.min(30, textStyle.fontSize)}px`;
    element.style.fontWeight = String(textStyle.fontWeight);
    element.style.color = textStyle.color;
    element.style.webkitTextStroke = `${textStyle.strokeWidth}px ${textStyle.strokeColor}`;
    element.style.paintOrder = 'stroke fill';
  }

  function colorControl(value, setter, disabled = false) {
    let rgba = parseColor(value);
    const wrap = h('div');
    const row = h('div', 'color-control');
    const chip = h('label', 'color-chip');
    const picker = h('input');
    picker.type = 'color';
    const chipFill = h('i');
    chip.append(picker, chipFill);
    const values = h('div', 'color-values');
    const hex = h('input');
    hex.maxLength = 9;
    hex.setAttribute('aria-label', T.hexRgba);
    const alphaWrap = h('div', 'alpha-wrap');
    const alpha = h('input');
    alpha.type = 'number';
    alpha.min = '0'; alpha.max = '100'; alpha.step = '1';
    alpha.setAttribute('aria-label', T.alphaPercent);
    alphaWrap.append(alpha);
    values.append(hex, alphaWrap);
    row.append(chip, values);
    const alphaSlider = h('input', 'alpha-slider');
    alphaSlider.type = 'range';
    alphaSlider.min = '0'; alphaSlider.max = '100'; alphaSlider.step = '1';
    alphaSlider.setAttribute('aria-label', T.alphaSlider);
    const channels = h('div', 'rgba-grid');
    const channelInputs = ['R', 'G', 'B'].map((label) => {
      const line = h('label');
      const input = h('input');
      input.type = 'number';
      input.min = '0'; input.max = '255'; input.step = '1';
      line.append(h('span', null, label), input);
      channels.append(line);
      return input;
    });
    wrap.append(row, alphaSlider, channels);

    function sync(commitValue = false, preserveHex = false) {
      const canonical = composeColor(rgba);
      picker.value = canonical.slice(0, 7);
      chipFill.style.background = canonical;
      if (!preserveHex) hex.value = canonical.toUpperCase();
      alpha.value = String(Math.round(rgba.a / 255 * 100));
      alphaSlider.value = alpha.value;
      channelInputs[0].value = String(rgba.r);
      channelInputs[1].value = String(rgba.g);
      channelInputs[2].value = String(rgba.b);
      if (commitValue) {
        setter(canonical);
        markChanged({ checkpoint: false });
      }
    }
    picker.addEventListener('input', () => {
      const picked = parseColor(picker.value);
      rgba = { ...picked, a: rgba.a };
      sync(true);
    });
    hex.addEventListener('input', () => {
      if (!/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(hex.value)) return;
      rgba = parseColor(hex.value);
      sync(true, true);
    });
    hex.addEventListener('blur', () => sync());
    alpha.addEventListener('input', () => {
      rgba.a = Math.round(clamp(Number(alpha.value), 0, 100) / 100 * 255);
      sync(true);
    });
    alphaSlider.addEventListener('input', () => {
      rgba.a = Math.round(Number(alphaSlider.value) / 100 * 255);
      sync(true);
    });
    channelInputs.forEach((input, index) => input.addEventListener('input', () => {
      rgba[['r', 'g', 'b'][index]] = Math.round(clamp(Number(input.value), 0, 255));
      sync(true);
    }));
    [picker, hex, alpha, alphaSlider, ...channelInputs].forEach((input) => {
      input.disabled = disabled;
      input.addEventListener('change', checkpoint);
    });
    sync();
    return wrap;
  }

  function parseColor(value) {
    const text = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value || '') ? value.slice(1) : '000000ff';
    return {
      r: Number.parseInt(text.slice(0, 2), 16),
      g: Number.parseInt(text.slice(2, 4), 16),
      b: Number.parseInt(text.slice(4, 6), 16),
      a: text.length === 8 ? Number.parseInt(text.slice(6, 8), 16) : 255,
    };
  }

  function composeColor({ r, g, b, a }) {
    return `#${[r, g, b, a].map((part) => Math.round(clamp(part, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
  }

  // ── 九宫格与素材 ────────────────────────────────────────────────────────

  function renderNineSliceEditor(style, readonly) {
    const body = h('div');
    if (readonly) {
      body.append(h('p', 'placeholder', T.nineNeedsCopy));
      return section('Nine-slice', body);
    }
    const assets = editor.state.assets || [];
    const gallery = h('div', 'asset-grid');
    for (const asset of assets) {
      const cell = h('div', 'asset-cell');
      const card = h('button', `asset-card${style.nineSlice?.assetId === asset.id ? ' active' : ''}`);
      card.type = 'button';
      const image = h('img');
      image.src = asset.url;
      image.alt = '';
      card.append(image, h('span', null, asset.id.slice(0, 10)));
      card.addEventListener('click', () => {
        if (style.nineSlice?.assetId === asset.id) return;
        mutate(() => {
          style.nineSlice = {
            assetId: asset.id,
            slice: { top: 20, right: 20, bottom: 20, left: 20 },
            width: { top: 20, right: 20, bottom: 20, left: 20 },
            fill: true,
            repeat: 'stretch',
          };
        }, { render: true });
      });
      const remove = button('×', () => void deleteAsset(asset.id), 'asset-remove');
      remove.title = T.deleteAsset;
      cell.append(card, remove);
      gallery.append(cell);
    }
    body.append(gallery);
    const upload = h('label', 'small-button accent file-button', T.uploadAsset);
    const file = h('input');
    file.type = 'file';
    file.accept = 'image/png,image/jpeg,image/webp,image/gif';
    file.addEventListener('change', () => void uploadAsset(file.files?.[0], style));
    upload.append(file);
    const assetActions = h('div', 'button-row');
    assetActions.append(upload);
    if (style.nineSlice) {
      assetActions.append(button(T.disableNine, () => mutate(() => { delete style.nineSlice; }, { render: true })));
    }
    body.append(assetActions);
    if (!style.nineSlice) {
      body.append(h('p', 'placeholder', assets.length ? T.pickAsset : T.uploadHint));
      return section('Nine-slice', body);
    }
    const asset = assets.find((item) => item.id === style.nineSlice.assetId);
    if (!asset) {
      body.append(h('p', 'placeholder', T.assetMissing));
      return section('Nine-slice', body);
    }
    body.append(divider(), renderSliceSource(style.nineSlice, asset));
    body.append(renderSliceOptions(style.nineSlice, asset));
    return section('Nine-slice', body);
  }

  function renderSliceSource(nine, asset) {
    const wrap = h('div');
    const source = h('div', 'slice-source');
    const imageWrap = h('div', 'slice-image-wrap');
    const image = h('img');
    image.src = asset.url;
    image.alt = T.nineSource;
    imageWrap.append(image);
    source.append(imageWrap);
    wrap.append(source);
    image.addEventListener('load', () => {
      const before = JSON.stringify(nine.slice);
      constrainSlices(nine.slice, image.naturalWidth, image.naturalHeight);
      if (JSON.stringify(nine.slice) !== before) markChanged({ interaction: false });
      drawSliceGuides(imageWrap, image, nine);
      const values = renderInsets(nine.slice, T.sourceSlices, 0, 65535, (side) => {
        constrainSlices(nine.slice, image.naturalWidth, image.naturalHeight, side);
        drawSliceGuides(imageWrap, image, nine);
        redrawNineTarget(nine);
      });
      wrap.append(values);
    }, { once: true });
    return wrap;
  }

  function drawSliceGuides(imageWrap, image, nine) {
    imageWrap.querySelectorAll('.slice-guide').forEach((item) => item.remove());
    const w = image.clientWidth;
    const hgt = image.clientHeight;
    const naturalW = image.naturalWidth;
    const naturalH = image.naturalHeight;
    const defs = [
      ['left', 'vertical', nine.slice.left / naturalW * w],
      ['right', 'vertical', (naturalW - nine.slice.right) / naturalW * w],
      ['top', 'horizontal', nine.slice.top / naturalH * hgt],
      ['bottom', 'horizontal', (naturalH - nine.slice.bottom) / naturalH * hgt],
    ];
    for (const [side, axis, position] of defs) {
      const guide = h('span', `slice-guide ${axis}`);
      guide.dataset.side = side;
      guide.style[axis === 'vertical' ? 'left' : 'top'] = `${position}px`;
      guide.addEventListener('pointerdown', (event) => startSliceDrag(event, guide, imageWrap, image, nine));
      imageWrap.append(guide);
    }
  }

  function positionSliceGuides(imageWrap, image, nine) {
    const w = image.clientWidth;
    const hgt = image.clientHeight;
    const positions = {
      left: nine.slice.left / image.naturalWidth * w,
      right: (image.naturalWidth - nine.slice.right) / image.naturalWidth * w,
      top: nine.slice.top / image.naturalHeight * hgt,
      bottom: (image.naturalHeight - nine.slice.bottom) / image.naturalHeight * hgt,
    };
    imageWrap.querySelectorAll('.slice-guide').forEach((guide) => {
      const side = guide.dataset.side;
      guide.style[side === 'left' || side === 'right' ? 'left' : 'top'] = `${positions[side]}px`;
    });
  }

  function startSliceDrag(event, guide, imageWrap, image, nine) {
    event.preventDefault();
    guide.setPointerCapture(event.pointerId);
    const side = guide.dataset.side;
    const vertical = side === 'left' || side === 'right';
    const original = { ...nine.slice };
    let finished = false;
    const move = (pointer) => {
      const rect = imageWrap.getBoundingClientRect();
      const ratio = vertical
        ? clamp(pointer.clientX - rect.left, 0, rect.width) / rect.width
        : clamp(pointer.clientY - rect.top, 0, rect.height) / rect.height;
      if (side === 'left') nine.slice.left = Math.round(ratio * image.naturalWidth);
      if (side === 'right') nine.slice.right = Math.round((1 - ratio) * image.naturalWidth);
      if (side === 'top') nine.slice.top = Math.round(ratio * image.naturalHeight);
      if (side === 'bottom') nine.slice.bottom = Math.round((1 - ratio) * image.naturalHeight);
      constrainSlices(nine.slice, image.naturalWidth, image.naturalHeight, side);
      markChanged({ interaction: false, checkpoint: false });
      positionSliceGuides(imageWrap, image, nine);
      redrawNineTarget(nine);
    };
    const finish = (cancel = false) => {
      if (finished) return;
      finished = true;
      guide.removeEventListener('pointermove', move);
      guide.removeEventListener('pointerup', commit);
      guide.removeEventListener('pointercancel', rollback);
      removeEventListener('keydown', cancelWithEscape);
      if (guide.hasPointerCapture(event.pointerId)) guide.releasePointerCapture(event.pointerId);
      if (cancel) {
        Object.assign(nine.slice, original);
        markChanged({ interaction: false, checkpoint: false });
      } else {
        checkpoint();
      }
      renderWorkspace();
    };
    const commit = () => finish(false);
    const rollback = () => finish(true);
    const cancelWithEscape = (keyEvent) => {
      if (keyEvent.key !== 'Escape') return;
      keyEvent.preventDefault();
      finish(true);
    };
    guide.addEventListener('pointermove', move);
    guide.addEventListener('pointerup', commit, { once: true });
    guide.addEventListener('pointercancel', rollback, { once: true });
    addEventListener('keydown', cancelWithEscape);
  }

  function constrainSlices(slice, width, height, activeSide = '') {
    const horizontal = constrainSlicePair(slice.left, slice.right, Math.max(0, width - 1), activeSide, 'left', 'right');
    const vertical = constrainSlicePair(slice.top, slice.bottom, Math.max(0, height - 1), activeSide, 'top', 'bottom');
    slice.left = horizontal[0];
    slice.right = horizontal[1];
    slice.top = vertical[0];
    slice.bottom = vertical[1];
  }

  function constrainSlicePair(first, second, limit, activeSide, firstSide, secondSide) {
    let a = Math.round(clamp(first, 0, limit));
    let b = Math.round(clamp(second, 0, limit));
    if (a + b <= limit) return [a, b];
    if (activeSide === firstSide) return [limit - b, b];
    if (activeSide === secondSide) return [a, limit - a];
    const total = a + b;
    a = total > 0 ? Math.round(a / total * limit) : 0;
    b = limit - a;
    return [a, b];
  }

  function renderSliceOptions(nine, asset) {
    const wrap = h('div');
    const preview = h('div', 'nine-preview');
    const redraw = () => applyNinePreview(preview, nine, asset.url);
    wrap.append(renderInsets(nine.width, T.outputWidth, 0, 512, redraw));
    wrap.append(field(T.repeatMode, selectInput(nine.repeat, [['stretch', T.repeatStretch], ['repeat', T.repeatTile], ['round', T.repeatRound]], (value) => { nine.repeat = value; })));
    wrap.append(checkInput(T.fillCenter, nine.fill, (value) => { nine.fill = value; }, { render: true }));
    preview.append(h('span', null, T.dragToResize));
    applyNinePreview(preview, nine, asset.url);
    wrap.append(preview);
    return wrap;
  }

  function renderInsets(insets, label, min, max, afterInput) {
    const outer = h('div');
    outer.append(h('div', 'field-label', label));
    const grid = h('div', 'slice-values');
    for (const [key, text] of [['top', T.insetTop], ['right', T.insetRight], ['bottom', T.insetBottom], ['left', T.insetLeft]]) {
      const line = h('label');
      let input;
      input = numberInput(insets[key], (value) => { insets[key] = value; }, min, max, 1, {
        interaction: false,
        afterInput: () => {
          afterInput?.(key);
          input.value = String(insets[key]);
        },
      });
      line.append(h('span', null, text), input);
      grid.append(line);
    }
    outer.append(grid);
    return outer;
  }

  function applyNinePreview(element, nine, assetUrl) {
    const s = nine.slice;
    const w = nine.width;
    element.style.borderWidth = `${w.top}px ${w.right}px ${w.bottom}px ${w.left}px`;
    element.style.borderImageSource = `url('${assetUrl}')`;
    element.style.borderImageSlice = `${s.top} ${s.right} ${s.bottom} ${s.left}${nine.fill ? ' fill' : ''}`;
    element.style.borderImageWidth = `${w.top}px ${w.right}px ${w.bottom}px ${w.left}px`;
    element.style.borderImageRepeat = nine.repeat;
  }

  function redrawNineTarget(nine) {
    const preview = refs.inspector.querySelector('.nine-preview');
    const asset = editor.state.assets.find((item) => item.id === nine.assetId);
    if (preview && asset) applyNinePreview(preview, nine, asset.url);
  }

  async function uploadAsset(file, style) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) return toast(T.assetTooLarge, true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      const out = await api('/api/editor/assets', 'POST', { base64: btoa(binary) });
      editor.state.assets = out.assets;
      if (style && out.asset) {
        style.nineSlice = {
          assetId: out.asset.id,
          slice: { top: 20, right: 20, bottom: 20, left: 20 },
          width: { top: 20, right: 20, bottom: 20, left: 20 },
          fill: true,
          repeat: 'stretch',
        };
        markChanged();
      }
      toast(T.assetUploaded);
      renderWorkspace();
    } catch (error) {
      toast(errorText(error), true);
    }
  }

  async function deleteAsset(id) {
    const localStyle = editor.design.styles.find((item) => item.nineSlice?.assetId === id);
    const localImage = editor.design.components.find((item) => item.kind === 'image' && item.source === 'upload' && item.assetId === id);
    if (localStyle || localImage) {
      const owner = localStyle ? T.ownerStyle(localStyle.name) : T.ownerComponent(localImage.name);
      return toast(T.assetInUse(owner), true);
    }
    confirmModal(T.deleteAsset, T.deleteAssetConfirm, T.delete, async () => {
      try {
        const out = await api(`/api/editor/assets/${encodeURIComponent(id)}`, 'DELETE');
        editor.state.assets = out.assets;
        if (out.deleted) resetHistory();
        renderWorkspace();
        toast(out.deleted ? T.assetDeleted : T.assetGone);
      } catch (error) { toast(errorText(error), true); }
    });
  }

  // ── 用户组 ──────────────────────────────────────────────────────────────

  function renderGroupsEditor() {
    const list = h('div', 'resource-list');
    for (const group of editor.design.groups) {
      const row = h('button', `resource-row${group.id === editor.selectedGroup ? ' active' : ''}`);
      row.type = 'button';
      const icon = h('span', 'resource-icon', T.groupGlyph);
      const copy = h('span', 'resource-copy');
      copy.append(h('strong', null, group.name), h('span', null, T.priorityValue(group.priority)));
      row.append(icon, copy, h('span', `row-badge${group.enabled ? '' : ' hidden-badge'}`, group.enabled ? T.enabled : T.disabled));
      row.addEventListener('click', () => { editor.selectedGroup = group.id; renderWorkspace(); });
      list.append(row);
    }
    if (!editor.design.groups.length) list.append(h('div', 'placeholder', T.noGroups));
    const add = button(T.newGroup, createGroup, 'small-button accent');
    const note = h('p', 'field-note', T.groupsNote);
    note.style.margin = '0 0 10px';
    refs.inspector.append(
      note,
      flushSection(T.groupRules, list, T.groupsCount(editor.design.groups.length)),
      section(T.groupActions, add),
    );
    const group = editor.design.groups.find((item) => item.id === editor.selectedGroup);
    if (!group) return;
    const basics = h('div');
    basics.append(
      field(T.name, textInput(group.name, (value) => { group.name = value; }, { interaction: false })),
      field(T.priority, numberInput(group.priority, (value) => { group.priority = value; }, -10000, 10000, 1, { interaction: false })),
      checkInput(T.enableGroup, group.enabled, (value) => { group.enabled = value; }, { render: true }),
    );
    refs.inspector.append(section(T.groupDefinition, basics));
    const ruleBody = h('div');
    ruleBody.append(renderRule(group.rule, (next) => { group.rule = next; }));
    refs.inspector.append(section(T.matchConditions, ruleBody));
    const overrides = h('div');
    overrides.append(h('div', 'field-label', T.usernameOverride), textPatchFields(group.username));
    overrides.append(divider(), h('div', 'field-label', T.bodyOverride), textPatchFields(group.body));
    refs.inspector.append(section(T.groupFontOverrides, overrides));
    refs.inspector.append(section(T.groupActions, button(T.deleteGroup, () => {
      mutate(() => {
        editor.design.groups = editor.design.groups.filter((item) => item.id !== group.id);
        editor.selectedGroup = editor.design.groups[0]?.id || '';
      }, { render: true });
    }, 'small-button danger')));
  }

  function createGroup() {
    const group = {
      id: uniqueId('group'), name: T.newGroupName, enabled: true, priority: 10,
      rule: { op: 'all', rules: [{ op: 'leaf', field: 'guardLevel', compare: 'gte', value: 1 }] },
      username: {}, body: {},
    };
    mutate(() => {
      editor.design.groups.push(group);
      editor.selectedGroup = group.id;
      editor.styleTab = 'groups';
    }, { render: true });
  }

  function renderRule(rule, replace, canDelete = false) {
    const card = h('div', 'rule-card');
    const head = h('div', 'button-row');
    const op = selectInput(rule.op, [['all', T.ruleAll], ['any', T.ruleAny], ['leaf', T.ruleLeaf]], (value) => {
      replace(value === 'leaf'
        ? { op: 'leaf', field: 'guardLevel', compare: 'gte', value: 1 }
        : { op: value, rules: [{ op: 'leaf', field: 'guardLevel', compare: 'gte', value: 1 }] });
    });
    head.append(op);
    if (canDelete) head.append(button(T.remove, () => replace(null), 'small-button danger'));
    card.append(head);
    if (rule.op === 'leaf') {
      card.append(renderLeafRule(rule));
      return card;
    }
    const children = h('div', 'rule-children');
    rule.rules.forEach((child, index) => {
      children.append(renderRule(child, (next) => {
        if (next) rule.rules[index] = next;
        else rule.rules.splice(index, 1);
        if (!rule.rules.length) rule.rules.push({ op: 'leaf', field: 'guardLevel', compare: 'gte', value: 1 });
        markChanged({ render: true });
      }, true));
    });
    const actions = h('div', 'button-row');
    actions.append(
      button(T.addCondition, () => mutate(() => rule.rules.push({ op: 'leaf', field: 'guardLevel', compare: 'gte', value: 1 }), { render: true })),
      button(T.addSubgroup, () => mutate(() => rule.rules.push({ op: 'all', rules: [{ op: 'leaf', field: 'guardLevel', compare: 'gte', value: 1 }] }), { render: true })),
    );
    card.append(children, actions);
    return card;
  }

  function renderLeafRule(rule) {
    const line = h('div', 'rule-line');
    const fieldSelect = selectInput(rule.field, audienceFields.map(([id, label]) => [id, label]), (value) => {
      rule.field = value;
      rule.compare = value === 'uid' || value.includes('Name') ? 'eq' : 'eq';
      rule.value = defaultRuleValue(value);
    });
    const compares = compareChoices(rule.field);
    const compare = selectInput(rule.compare, compares, (value) => {
      rule.compare = value;
      if (value === 'exists') delete rule.value;
      else if (rule.value === undefined) rule.value = defaultRuleValue(rule.field);
    });
    let valueControl;
    const kind = audienceFields.find(([id]) => id === rule.field)?.[2] || 'text';
    if (rule.compare === 'exists') valueControl = h('span', 'row-badge', T.existsOnly);
    else if (kind === 'boolean') valueControl = selectInput(String(rule.value), [['true', T.yes], ['false', T.no]], (value) => { rule.value = value === 'true'; }, { render: false });
    else if (kind === 'event') valueControl = selectInput(String(rule.value), [['danmaku', T.eventDanmaku], ['gift', T.eventGift]], (value) => { rule.value = value; }, { render: false });
    else if (kind === 'number') valueControl = numberInput(Number(rule.value), (value) => { rule.value = value; }, -1000000000, 1000000000, 1, { interaction: false });
    else valueControl = textInput(String(rule.value ?? ''), (value) => { rule.value = value; }, { interaction: false });
    line.append(fieldSelect, compare, valueControl);
    return line;
  }

  function compareChoices(fieldName) {
    const kind = audienceFields.find(([id]) => id === fieldName)?.[2];
    if (kind === 'number') return [['eq', T.compareEq], ['gte', T.compareGte], ['lte', T.compareLte], ['exists', T.compareExists]];
    if (kind === 'text') return [['eq', T.compareEq], ['contains', T.compareContains], ['exists', T.compareExists]];
    return [['eq', T.compareEq], ['exists', T.compareExists]];
  }

  function defaultRuleValue(fieldName) {
    const kind = audienceFields.find(([id]) => id === fieldName)?.[2];
    if (kind === 'number') return 1;
    if (kind === 'boolean') return true;
    if (kind === 'event') return 'danmaku';
    return '';
  }

  function textPatchFields(patch) {
    const wrap = h('div');
    wrap.append(
      field(T.font, optionalTextInput(patch, 'fontFamily', T.inheritWhenEmpty)),
      field(T.fontSize, optionalNumberInput(patch, 'fontSize', 8, 240, 1)),
      field(T.fontWeight, optionalNumberInput(patch, 'fontWeight', 100, 900, 100)),
      field(T.textRgba, optionalColorControl(patch, 'color')),
      field(T.strokeRgba, optionalColorControl(patch, 'strokeColor')),
      field(T.strokeWidth, optionalNumberInput(patch, 'strokeWidth', 0, 12, .5)),
    );
    return wrap;
  }

  function optionalTextInput(target, key, placeholder) {
    return textInput(target[key] || '', (value) => {
      if (value) target[key] = value;
      else delete target[key];
    }, { placeholder });
  }

  function optionalNumberInput(target, key, min, max, step) {
    return numberInput(target[key], (value) => {
      if (value === undefined) delete target[key];
      else target[key] = value;
    }, min, max, step, { optional: true, placeholder: T.inherit });
  }

  function optionalColorControl(target, key) {
    const outer = h('div');
    if (target[key]) {
      outer.append(colorControl(target[key], (value) => { target[key] = value; }));
      outer.append(button(T.restoreInherit, () => mutate(() => { delete target[key]; }, { render: true })));
    } else {
      outer.append(button(T.setOverrideColor, () => mutate(() => { target[key] = '#ffffffff'; }, { render: true })));
    }
    return outer;
  }

  // ── 组件 ────────────────────────────────────────────────────────────────

  function renderComponentsWorkspace() {
    const list = h('div', 'resource-list');
    for (const component of editor.design.components) {
      const row = h('button', `resource-row${component.id === editor.selectedComponent ? ' active' : ''}`);
      row.type = 'button';
      const [kind, glyph] = componentKinds[component.kind] || [component.kind, '?'];
      const icon = h('span', 'resource-icon', glyph);
      const copy = h('span', 'resource-copy');
      copy.append(h('strong', null, component.name), h('span', null, kind));
      const count = editor.design.placements.filter((item) => item.componentId === component.id).length;
      row.append(icon, copy, h('span', 'row-badge', T.placedCount(count)));
      row.addEventListener('click', () => {
        selectComponentId(component.id);
        renderWorkspace();
      });
      list.append(row);
    }
    if (!editor.design.components.length) list.append(h('div', 'placeholder', T.noComponents));
    refs.inspector.append(flushSection(T.componentLibrary, list, T.itemsCount(editor.design.components.length)));
    const component = editor.design.components.find((item) => item.id === editor.selectedComponent);
    if (!component) return;

    const basics = h('div');
    const mockActive = editor.mockComponentId === component.id;
    const mock = button(mockActive ? T.stopMock : T.mockTest, () => mockComponent(component), 'small-button accent');
    mock.setAttribute('aria-pressed', String(mockActive));
    const previewActions = h('div', 'button-row');
    previewActions.append(mock);
    basics.append(
      previewActions,
      field(T.name, textInput(component.name, (value) => { component.name = value; }, { interaction: false })),
      field(T.kind, h('span', 'row-badge', componentKinds[component.kind]?.[0] || component.kind)),
      field(T.useStyle, selectInput(component.styleId, allStyles().map((style) => [style.id, style.name]), (value) => { component.styleId = value; }, { render: false })),
    );
    refs.inspector.append(section(T.componentDefinition, basics));
    refs.inspector.append(renderComponentBehavior(component));
    refs.inspector.append(renderComponentTitle(component));
    if (component.kind === 'agent-notice') refs.inspector.append(renderAnnouncementWriter());

    const actions = h('div', 'button-row split');
    actions.append(
      button(T.addToLayout, () => addPlacement(component)),
      h('span'),
      button(T.duplicate, () => duplicateComponent(component)),
      button(T.delete, () => deleteComponent(component), 'small-button danger'),
    );
    refs.inspector.append(section(T.componentActions, actions));
  }

  function renderComponentBehavior(component) {
    const body = h('div');
    if (component.kind === 'danmaku') {
      body.append(
        field(T.scrollDirection, selectInput(component.axis, [['vertical', T.verticalList], ['horizontal', T.horizontalDanmaku]], (value) => { component.axis = value; }, { render: false })),
        field(T.admission, selectInput(component.admission, [['danmaku', T.danmakuOnly], ['gift', T.giftOnly], ['all', T.danmakuAndGift]], (value) => { component.admission = value; }, { render: false })),
        checkInput(T.showAvatar, component.showAvatar, (value) => { component.showAvatar = value; }),
        field(T.speed, numberInput(component.speed, (value) => { component.speed = value; }, 10, 500, 1)),
        field(T.itemGap, numberInput(component.gap, (value) => { component.gap = value; }, 0, 500, 1)),
        field(T.maxItems, numberInput(component.maxItems, (value) => { component.maxItems = value; }, 1, 100, 1)),
        field(T.usernameMax, numberInput(component.usernameMaxChars, (value) => { component.usernameMaxChars = value; }, 0, 5000, 1), T.zeroShowsAll),
        field(T.bodyMax, numberInput(component.bodyMaxChars, (value) => { component.bodyMaxChars = value; }, 0, 5000, 1), T.zeroShowsAll),
        field(T.edgeFade, numberInput(component.edgeFadePx, (value) => { component.edgeFadePx = value; }, 0, 512, 1), T.edgeFadeNote),
      );
    } else if (component.kind === 'scroll-notice') {
      body.append(
        field(T.scrollDirection, selectInput(component.axis, [['horizontal', T.horizontal], ['vertical', T.vertical]], (value) => { component.axis = value; }, { render: false })),
        field(T.noticeText, textInput(component.text, (value) => { component.text = value; }, { multiline: true, maxLength: 5000 }), T.noticeLinesNote),
        field(T.lineHold, numberInput(component.lineHoldMs, (value) => { component.lineHoldMs = value; }, 0, 60000, 1)),
        field(T.lineTransition, numberInput(component.lineTransitionMs, (value) => { component.lineTransitionMs = value; }, 0, 10000, 1), T.lineTransitionNote),
        field(T.lineSpeed, numberInput(component.speed, (value) => { component.speed = value; }, 10, 500, 1)),
        field(T.scrollGap, numberInput(component.gap, (value) => { component.gap = value; }, 0, 500, 1)),
        field(T.edgeFade, numberInput(component.edgeFadePx, (value) => { component.edgeFadePx = value; }, 0, 512, 1), T.edgeFadeNote),
      );
    } else if (component.kind === 'fixed-notice') {
      body.append(field(T.noticeText, textInput(component.text, (value) => { component.text = value; }, { multiline: true, maxLength: 5000 })));
    } else if (component.kind === 'agent-notice') {
      body.append(
        field(T.emptyPlaceholder, textInput(component.emptyText, (value) => { component.emptyText = value; }, { maxLength: 500 })),
        checkInput(T.hideWhenEmpty, component.hideWhenEmpty, (value) => { component.hideWhenEmpty = value; }),
        field(T.typingInterval, numberInput(component.typingMs, (value) => { component.typingMs = value; }, 0, 2000, 1), T.typingNote),
      );
    } else if (component.kind === 'image') {
      body.append(
        field(T.imageSource, selectInput(component.source, [['external', T.externalUrl], ['upload', T.assetLibrary]], (value) => { component.source = value; }, { render: true })),
        field(T.fitMode, selectInput(component.fit, [['contain', T.fitContain], ['cover', T.fitCover], ['fill', T.fitFill]], (value) => { component.fit = value; }, { render: false })),
        field(T.opacity, numberInput(component.opacity, (value) => { component.opacity = value; }, 0, 1, .01)),
      );
      if (component.source === 'external') {
        body.append(field(T.imageUrl, textInput(component.url, (value) => { component.url = value; }, { placeholder: 'https://…' })));
      } else {
        body.append(renderImageAssetPicker(component));
      }
    }
    return section(T.behavior, body);
  }

  function renderComponentTitle(component) {
    const body = h('div');
    body.append(checkInput(T.showTitle, Boolean(component.title), (enabled) => {
      if (enabled) component.title = {
        text: component.name || T.componentTitle,
        position: 'top',
        align: 'left',
        style: defaultTitleStyle(),
      };
      else delete component.title;
    }, { render: true }));
    if (!component.title) return section(T.componentTitle, body, T.notEnabled);
    const title = component.title;
    body.append(
      field(T.titleText, textInput(title.text, (value) => { title.text = value; }, { maxLength: 500 })),
      field(T.titleSide, selectInput(title.position, [
        ['top', T.sideTop], ['right', T.sideRight], ['bottom', T.sideBottom], ['left', T.sideLeft],
      ], (value) => { title.position = value; }, { render: false })),
      field(T.titleAlign, selectInput(title.align, [
        ['left', T.alignStart], ['center', T.alignCenter], ['right', T.alignEnd],
      ], (value) => { title.align = value; }, { render: false })),
      divider(),
      h('div', 'field-label', T.titleFont),
      textStyleFields(title.style, false),
    );
    return section(T.componentTitle, body, T.ownFont);
  }

  function defaultTitleStyle() {
    return {
      fontFamily: 'Microsoft YaHei, sans-serif',
      fontSize: 26,
      fontWeight: 700,
      color: '#ffffffff',
      strokeColor: '#17324dff',
      strokeWidth: 0,
    };
  }

  function mockComponent(component) {
    if (!editor.frameReady) return toast(T.previewLoading, true);
    editor.mockComponentId = editor.mockComponentId === component.id ? '' : component.id;
    renderWorkspace();
    sendPreview();
  }

  function renderImageAssetPicker(component) {
    const outer = h('div');
    const gallery = h('div', 'asset-grid');
    for (const asset of editor.state.assets || []) {
      const cell = h('div', 'asset-cell');
      const card = h('button', `asset-card${component.assetId === asset.id ? ' active' : ''}`);
      card.type = 'button';
      const image = h('img');
      image.src = asset.url;
      image.alt = '';
      card.append(image, h('span', null, asset.id.slice(0, 10)));
      card.addEventListener('click', () => mutate(() => { component.assetId = asset.id; }, { render: true }));
      const remove = button('×', () => void deleteAsset(asset.id), 'asset-remove');
      remove.title = T.deleteAsset;
      cell.append(card, remove);
      gallery.append(cell);
    }
    const upload = h('label', 'small-button accent file-button', T.uploadImage);
    const file = h('input');
    file.type = 'file';
    file.accept = 'image/png,image/jpeg,image/webp,image/gif';
    file.addEventListener('change', async () => {
      const selected = file.files?.[0];
      if (!selected) return;
      try {
        const bytes = new Uint8Array(await selected.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        const out = await api('/api/editor/assets', 'POST', { base64: btoa(binary) });
        editor.state.assets = out.assets;
        component.assetId = out.asset.id;
        markChanged({ render: true });
      } catch (error) { toast(errorText(error), true); }
    });
    upload.append(file);
    outer.append(gallery, upload);
    return outer;
  }

  function renderAnnouncementWriter() {
    const state = editor.state.agentAnnouncement || { text: '', revision: 0 };
    const max = editor.state.maxAnnouncementChars || 200;
    const body = h('div');
    const counter = h('span', 'row-badge', `${Array.from(editor.announcementDraft).length}/${max}`);
    const text = h('textarea');
    text.value = editor.announcementDraft;
    text.addEventListener('input', () => {
      const chars = Array.from(text.value);
      if (chars.length > max) text.value = chars.slice(0, max).join('');
      editor.announcementDraft = text.value;
      const current = editor.state.agentAnnouncement || state;
      editor.announcementDirty = text.value !== (current.text || '');
      if (!editor.announcementDirty) {
        editor.announcementBaseRevision = Number(current.revision) || 0;
        editor.announcementConflict = false;
      }
      counter.textContent = `${Array.from(text.value).length}/${max}`;
      updateSaveState();
    });
    const actions = h('div', 'button-row split');
    const write = button(editor.announcementConflict ? T.keepDraftOverwrite : T.writeNotice, async () => {
      if (editor.announcementSaving) return;
      const submitted = editor.announcementDraft;
      const expectedRevision = editor.announcementConflict
        ? Number(editor.state.agentAnnouncement?.revision) || 0
        : editor.announcementBaseRevision;
      editor.announcementSaving = true;
      write.disabled = true;
      updateSaveState();
      try {
        const next = await api('/api/editor/announcement', 'PUT', { text: submitted, expectedRevision });
        editor.state.agentAnnouncement = next;
        editor.announcementBaseRevision = Number(next.revision) || 0;
        editor.announcementConflict = false;
        if (editor.announcementDraft === submitted) editor.announcementDraft = next.text || '';
        editor.announcementDirty = editor.announcementDraft !== (next.text || '');
        toast(submitted ? T.noticeUpdated : T.noticeCleared);
      } catch (error) {
        if (error.status === 409) {
          try {
            const latest = await api('/api/editor/state');
            editor.state = { ...editor.state, ...latest };
            applyAnnouncementState(latest.agentAnnouncement);
          } catch { /* 下面仍显示原始冲突。 */ }
        }
        toast(errorText(error), true);
      } finally {
        editor.announcementSaving = false;
        updateSaveState();
        renderWorkspace();
      }
    }, 'small-button accent');
    actions.append(counter, write);
    if (editor.announcementConflict) {
      const warning = h('div', 'inline-warning');
      warning.append(
        h('span', null, T.noticeConflict),
        button(T.adoptServer, () => {
          editor.announcementDraft = editor.state.agentAnnouncement?.text || '';
          editor.announcementBaseRevision = Number(editor.state.agentAnnouncement?.revision) || 0;
          editor.announcementDirty = false;
          editor.announcementConflict = false;
          updateSaveState();
          renderWorkspace();
        }, 'small-button'),
      );
      body.append(warning);
    }
    body.append(field(T.plainText, text), actions);
    return section(T.noticeWrite, body, T.charLimit(max));
  }

  function showCreateComponent() {
    const body = h('div', 'modal-body');
    body.append(h('h2', null, T.newComponent));
    const grid = h('div', 'asset-grid');
    for (const [kind, [label, glyph]] of Object.entries(componentKinds)) {
      const choose = button(`${glyph}  ${label}`, () => {
        refs.modal.close();
        createComponent(kind);
      }, 'small-button');
      choose.style.minHeight = '52px';
      grid.append(choose);
    }
    body.append(grid);
    showModal(body);
  }

  function createComponent(kind) {
    const base = { id: uniqueId('component'), name: componentKinds[kind][0], kind, styleId: editor.selectedStyle || editor.state.builtinStyles[0].id };
    let component;
    if (kind === 'danmaku') component = { ...base, axis: 'vertical', admission: 'all', showAvatar: true, speed: 90, gap: 12, maxItems: 12, usernameMaxChars: 24, bodyMaxChars: 80, edgeFadePx: 32 };
    else if (kind === 'scroll-notice') component = { ...base, axis: 'horizontal', text: T.defaultScrollText, speed: 70, gap: 60, lineHoldMs: 1600, lineTransitionMs: 420, edgeFadePx: 32 };
    else if (kind === 'fixed-notice') component = { ...base, text: T.defaultFixedText };
    else if (kind === 'agent-notice') component = { ...base, emptyText: T.defaultEmptyText, hideWhenEmpty: false, typingMs: 42 };
    else component = { ...base, source: 'external', url: '', assetId: '', fit: 'contain', opacity: 1 };
    mutate(() => {
      editor.design.components.push(component);
      selectComponentId(component.id);
    }, { render: true });
  }

  function duplicateComponent(component) {
    const next = structuredClone(component);
    next.id = uniqueId('component');
    next.name = T.copyName(component.name);
    mutate(() => {
      editor.design.components.push(next);
      selectComponentId(next.id);
    }, { render: true });
  }

  function deleteComponent(component) {
    const count = editor.design.placements.filter((item) => item.componentId === component.id).length;
    confirmModal(T.deleteComponent, count ? T.deleteWithPlacements(count) : T.willDelete(component.name), T.delete, () => {
      mutate(() => {
        editor.design.components = editor.design.components.filter((item) => item.id !== component.id);
        editor.design.placements = editor.design.placements.filter((item) => item.componentId !== component.id);
        selectComponentId(editor.design.components[0]?.id || '');
      }, { render: true });
    });
  }

  // ── 布局 ────────────────────────────────────────────────────────────────

  function renderLayoutWorkspace() {
    const canvasBody = h('div');
    canvasBody.append(
      field(T.canvasWidth, numberInput(editor.design.canvas.width, (value) => { editor.design.canvas.width = value; }, 320, 7680, 1, { afterInput: updateCanvasMetrics })),
      field(T.canvasHeight, numberInput(editor.design.canvas.height, (value) => { editor.design.canvas.height = value; }, 180, 4320, 1, { afterInput: updateCanvasMetrics })),
    );
    refs.inspector.append(section(T.liveCanvas, canvasBody));

    const list = h('div', 'resource-list');
    const placements = [...editor.design.placements].sort((a, b) => b.z - a.z);
    for (const placement of placements) {
      const component = componentById(placement.componentId);
      const row = h('button', `resource-row${placement.id === editor.selectedPlacement ? ' active' : ''}`);
      row.type = 'button';
      const icon = h('span', 'resource-icon', componentKinds[component?.kind]?.[1] || '?');
      const copy = h('span', 'resource-copy');
      copy.append(h('strong', null, component?.name || T.missingComponent), h('span', null, `${Math.round(placement.x)}, ${Math.round(placement.y)} · ${Math.round(placement.width)} × ${Math.round(placement.height)}`));
      const label = !placement.visible ? T.hidden : placement.locked ? T.locked : `z ${placement.z}`;
      row.append(icon, copy, h('span', `row-badge${placement.visible ? '' : ' hidden-badge'}`, label));
      row.addEventListener('click', () => selectPlacement(placement.id));
      list.append(row);
    }
    if (!placements.length) list.append(h('div', 'placeholder', T.noPlacements));
    refs.inspector.append(flushSection(T.layers, list, T.itemsCount(placements.length)));
    const placement = editor.design.placements.find((item) => item.id === editor.selectedPlacement);
    if (!placement) return;
    const component = componentById(placement.componentId);
    const geometry = h('div');
    geometry.append(
      field(T.component, h('span', 'row-badge', component?.name || placement.componentId)),
      field('X', placementNumber(placement, 'x', -7680, 7680)),
      field('Y', placementNumber(placement, 'y', -4320, 4320)),
      field(T.width, placementNumber(placement, 'width', 20, 7680)),
      field(T.height, placementNumber(placement, 'height', 20, 4320)),
      field(T.zIndex, placementNumber(placement, 'z', -10000, 10000)),
      checkInput(T.showPlacement, placement.visible, (value) => { placement.visible = value; }, { render: true }),
      checkInput(T.lockPlacement, placement.locked, (value) => { placement.locked = value; }, { render: true }),
    );
    refs.inspector.append(section(T.geometry, geometry));
    const actions = h('div', 'button-row');
    actions.append(
      button(T.bringToFront, () => mutate(() => { placement.z = Math.max(0, ...editor.design.placements.map((item) => item.z)) + 1; }, { render: true })),
      button(T.duplicateInstance, () => duplicatePlacement(placement)),
      button(T.deleteInstance, () => deletePlacement(placement), 'small-button danger'),
    );
    refs.inspector.append(section(T.layoutActions, actions));
  }

  function placementNumber(placement, key, min, max) {
    const input = numberInput(placement[key], (value) => { placement[key] = key === 'z' ? Math.round(value) : value; }, min, max, 1, { afterInput: renderInteraction });
    input.disabled = placement.locked && key !== 'z';
    return input;
  }

  function showAddPlacement() {
    if (!editor.design.components.length) return toast(T.createComponentFirst, true);
    const body = h('div', 'modal-body');
    body.append(h('h2', null, T.addToLayout), h('p', null, T.addToLayoutNote));
    const list = h('div', 'resource-list');
    for (const component of editor.design.components) {
      const row = h('button', 'resource-row');
      row.type = 'button';
      const icon = h('span', 'resource-icon', componentKinds[component.kind]?.[1] || '?');
      const copy = h('span', 'resource-copy');
      copy.append(h('strong', null, component.name), h('span', null, componentKinds[component.kind]?.[0] || component.kind));
      row.append(icon, copy);
      row.addEventListener('click', () => { refs.modal.close(); addPlacement(component); });
      list.append(row);
    }
    body.append(list);
    showModal(body);
  }

  function addPlacement(component) {
    const canvas = editor.design.canvas;
    const width = component.kind === 'agent-notice' || component.kind.includes('notice') ? Math.min(960, canvas.width * .6) : Math.min(600, canvas.width * .35);
    const height = component.kind === 'danmaku' ? Math.min(560, canvas.height * .65) : Math.min(160, canvas.height * .2);
    const placement = {
      id: uniqueId('placement'), componentId: component.id,
      x: Math.round((canvas.width - width) / 2), y: Math.round((canvas.height - height) / 2),
      width: Math.round(width), height: Math.round(height),
      z: Math.max(0, ...editor.design.placements.map((item) => item.z)) + 1,
      visible: true, locked: false,
    };
    mutate(() => {
      editor.design.placements.push(placement);
      editor.selectedPlacement = placement.id;
      selectComponentId(component.id);
      editor.mode = 'layout';
    }, { render: true });
  }

  function duplicatePlacement(placement) {
    const next = structuredClone(placement);
    next.id = uniqueId('placement');
    next.x += 20; next.y += 20; next.z += 1;
    mutate(() => {
      editor.design.placements.push(next);
      editor.selectedPlacement = next.id;
    }, { render: true });
  }

  function deletePlacement(placement) {
    mutate(() => {
      editor.design.placements = editor.design.placements.filter((item) => item.id !== placement.id);
      editor.selectedPlacement = editor.design.placements[0]?.id || '';
    }, { render: true });
  }

  function componentById(id) {
    return editor.design.components.find((item) => item.id === id);
  }

  function selectPlacement(id) {
    editor.selectedPlacement = id;
    renderInteraction();
    if (editor.mode === 'layout') renderWorkspace();
  }

  function renderInteraction() {
    if (!editor.design) return;
    refs.layer.replaceChildren();
    refs.layer.style.pointerEvents = 'auto';
    if (editor.mode !== 'layout') {
      for (const placement of [...editor.design.placements].filter((item) => item.visible).sort((a, b) => a.z - b.z)) {
        const component = componentById(placement.componentId);
        if (!component) continue;
        const selected = editor.mode === 'components'
          ? component.id === editor.selectedComponent
          : component.styleId === editor.selectedStyle;
        const hotspot = h('button', `placement-hotspot${selected ? ' selected' : ''}`);
        hotspot.type = 'button';
        hotspot.title = editor.mode === 'components' ? T.editComponent(component.name) : T.editStyle(styleById(component.styleId)?.name || component.styleId);
        Object.assign(hotspot.style, {
          left: `${placement.x}px`, top: `${placement.y}px`, width: `${placement.width}px`, height: `${placement.height}px`, zIndex: String(10000 + placement.z),
        });
        hotspot.addEventListener('click', (event) => {
          event.stopPropagation();
          if (editor.mode === 'components') selectComponentId(component.id);
          else {
            editor.selectedStyle = component.styleId;
            if (editor.styleTab === 'groups') editor.styleTab = 'appearance';
          }
          renderWorkspace();
          renderInteraction();
        });
        refs.layer.append(hotspot);
      }
      refs.selectionStatus.textContent = T.draftPreview;
      return;
    }
    const sorted = [...editor.design.placements].filter((item) => item.visible).sort((a, b) => a.z - b.z);
    for (const placement of sorted) {
      const component = componentById(placement.componentId);
      const box = h('div', `placement-box${placement.id === editor.selectedPlacement ? ' selected' : ''}${placement.locked ? ' locked' : ''}`);
      box.dataset.placementId = placement.id;
      Object.assign(box.style, {
        left: `${placement.x}px`, top: `${placement.y}px`, width: `${placement.width}px`, height: `${placement.height}px`, zIndex: String(10000 + placement.z),
      });
      box.append(h('span', 'placement-label', `${component?.name || placement.componentId}${placement.locked ? T.lockedSuffix : ''}`));
      for (const dir of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
        const handle = h('span', 'resize-handle');
        handle.dataset.dir = dir;
        box.append(handle);
      }
      box.addEventListener('pointerdown', (event) => startPlacementGesture(event, placement, box));
      refs.layer.append(box);
    }
    const selected = editor.design.placements.find((item) => item.id === editor.selectedPlacement);
    const component = selected ? componentById(selected.componentId) : null;
    refs.selectionStatus.textContent = selected
      ? `${component?.name || selected.componentId} · X ${Math.round(selected.x)} · Y ${Math.round(selected.y)} · ${Math.round(selected.width)} × ${Math.round(selected.height)}`
      : T.selectPlacement;
  }

  function startPlacementGesture(event, placement, box) {
    event.stopPropagation();
    editor.selectedPlacement = placement.id;
    refs.layer.querySelectorAll('.placement-box').forEach((item) => item.classList.toggle('selected', item === box));
    renderWorkspace();
    if (placement.locked || event.button !== 0) return;
    event.preventDefault();
    const handle = event.target.closest('.resize-handle');
    const dir = handle?.dataset.dir || 'move';
    const start = { x: event.clientX, y: event.clientY, rect: structuredClone(placement) };
    let finished = false;
    box.setPointerCapture(event.pointerId);
    const move = (pointer) => {
      const dx = (pointer.clientX - start.x) / editor.displayScale;
      const dy = (pointer.clientY - start.y) / editor.displayScale;
      const next = resizeRect(start.rect, dir, dx, dy);
      Object.assign(placement, snapRect(next, dir, placement.id));
      Object.assign(box.style, {
        left: `${placement.x}px`, top: `${placement.y}px`, width: `${placement.width}px`, height: `${placement.height}px`,
      });
      refs.selectionStatus.textContent = `${componentById(placement.componentId)?.name || placement.componentId} · X ${Math.round(placement.x)} · Y ${Math.round(placement.y)} · ${Math.round(placement.width)} × ${Math.round(placement.height)}`;
      markChanged({ render: false, interaction: false, checkpoint: false });
    };
    const finish = (cancel = false) => {
      if (finished) return;
      finished = true;
      box.removeEventListener('pointermove', move);
      box.removeEventListener('pointerup', commit);
      box.removeEventListener('pointercancel', rollback);
      removeEventListener('keydown', cancelWithEscape);
      if (box.hasPointerCapture(event.pointerId)) box.releasePointerCapture(event.pointerId);
      if (cancel) {
        Object.assign(placement, start.rect);
        markChanged({ render: false, interaction: false, checkpoint: false });
      } else {
        checkpoint();
      }
      clearSnapLines();
      renderWorkspace();
      renderInteraction();
    };
    const commit = () => finish(false);
    const rollback = () => finish(true);
    const cancelWithEscape = (keyEvent) => {
      if (keyEvent.key !== 'Escape') return;
      keyEvent.preventDefault();
      finish(true);
    };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', commit, { once: true });
    box.addEventListener('pointercancel', rollback, { once: true });
    addEventListener('keydown', cancelWithEscape);
  }

  function resizeRect(start, dir, dx, dy) {
    const rect = { x: start.x, y: start.y, width: start.width, height: start.height };
    if (dir === 'move') { rect.x += dx; rect.y += dy; return rect; }
    if (dir.includes('e')) rect.width = start.width + dx;
    if (dir.includes('s')) rect.height = start.height + dy;
    if (dir.includes('w')) { rect.x = start.x + dx; rect.width = start.width - dx; }
    if (dir.includes('n')) { rect.y = start.y + dy; rect.height = start.height - dy; }
    if (rect.width < 20) { if (dir.includes('w')) rect.x -= 20 - rect.width; rect.width = 20; }
    if (rect.height < 20) { if (dir.includes('n')) rect.y -= 20 - rect.height; rect.height = 20; }
    return rect;
  }

  function snapRect(rect, dir, placementId) {
    const grid = Number(refs.snapGrid.value) || 1;
    const canvas = editor.design.canvas;
    const result = { ...rect };
    clearSnapLines();
    const screenThreshold = 7;
    const threshold = screenThreshold / editor.displayScale;
    const verticalTargets = [0, canvas.width / 2, canvas.width];
    const horizontalTargets = [0, canvas.height / 2, canvas.height];
    for (const item of editor.design.placements) {
      if (item.id === placementId || !item.visible) continue;
      verticalTargets.push(item.x, item.x + item.width / 2, item.x + item.width);
      horizontalTargets.push(item.y, item.y + item.height / 2, item.y + item.height);
    }
    const xPoints = dir === 'move' ? [['x', result.x], ['cx', result.x + result.width / 2], ['r', result.x + result.width]] : [];
    const yPoints = dir === 'move' ? [['y', result.y], ['cy', result.y + result.height / 2], ['b', result.y + result.height]] : [];
    if (dir.includes('w')) xPoints.push(['x', result.x]);
    if (dir.includes('e')) xPoints.push(['r', result.x + result.width]);
    if (dir.includes('n')) yPoints.push(['y', result.y]);
    if (dir.includes('s')) yPoints.push(['b', result.y + result.height]);
    const xSnap = nearestSnap(xPoints, verticalTargets, threshold);
    const ySnap = nearestSnap(yPoints, horizontalTargets, threshold);
    if (xSnap) {
      if (dir === 'move') {
        if (xSnap.point === 'x') result.x = xSnap.target;
        if (xSnap.point === 'r') result.x = xSnap.target - result.width;
        if (xSnap.point === 'cx') result.x = xSnap.target - result.width / 2;
      } else {
        if (xSnap.point === 'x') { const right = result.x + result.width; result.x = xSnap.target; result.width = right - result.x; }
        if (xSnap.point === 'r') result.width = xSnap.target - result.x;
      }
      drawSnapLine('vertical', xSnap.target);
    }
    if (ySnap) {
      if (dir === 'move') {
        if (ySnap.point === 'y') result.y = ySnap.target;
        if (ySnap.point === 'b') result.y = ySnap.target - result.height;
        if (ySnap.point === 'cy') result.y = ySnap.target - result.height / 2;
      } else {
        if (ySnap.point === 'y') { const bottom = result.y + result.height; result.y = ySnap.target; result.height = bottom - result.y; }
        if (ySnap.point === 'b') result.height = ySnap.target - result.y;
      }
      drawSnapLine('horizontal', ySnap.target);
    }
    if (!xSnap) {
      if (dir === 'move') result.x = Math.round(result.x / grid) * grid;
      if (dir.includes('w')) {
        const right = result.x + result.width;
        result.x = Math.round(result.x / grid) * grid;
        result.width = right - result.x;
      }
      if (dir.includes('e')) result.width = Math.round((result.x + result.width) / grid) * grid - result.x;
    }
    if (!ySnap) {
      if (dir === 'move') result.y = Math.round(result.y / grid) * grid;
      if (dir.includes('n')) {
        const bottom = result.y + result.height;
        result.y = Math.round(result.y / grid) * grid;
        result.height = bottom - result.y;
      }
      if (dir.includes('s')) result.height = Math.round((result.y + result.height) / grid) * grid - result.y;
    }
    result.width = Math.max(20, result.width);
    result.height = Math.max(20, result.height);
    result.x = clamp(result.x, 0, Math.max(0, canvas.width - result.width));
    result.y = clamp(result.y, 0, Math.max(0, canvas.height - result.height));
    result.width = Math.min(result.width, canvas.width - result.x);
    result.height = Math.min(result.height, canvas.height - result.y);
    return result;
  }

  function nearestSnap(points, targets, threshold) {
    let best = null;
    for (const [point, value] of points) {
      for (const target of targets) {
        const distance = Math.abs(value - target);
        if (distance <= threshold && (!best || distance < best.distance)) best = { point, target, distance };
      }
    }
    return best;
  }

  function drawSnapLine(axis, position) {
    const line = h('span', `snap-line ${axis}`);
    line.style[axis === 'vertical' ? 'left' : 'top'] = `${position}px`;
    refs.layer.append(line);
  }

  function clearSnapLines() {
    refs.layer.querySelectorAll('.snap-line').forEach((line) => line.remove());
  }

  // ── 对话框、快捷键 ──────────────────────────────────────────────────────

  function showModal(content) {
    refs.modalContent.replaceChildren(content);
    if (!refs.modal.open) refs.modal.showModal();
  }

  function confirmModal(title, message, actionLabel, action) {
    const content = h('div');
    const body = h('div', 'modal-body');
    body.append(h('h2', null, title), h('p', null, message));
    const actions = h('div', 'modal-actions');
    actions.append(
      button(T.cancel, () => refs.modal.close()),
      button(actionLabel, () => {
        refs.modal.close();
        void action();
      }, 'small-button danger'),
    );
    content.append(body, actions);
    showModal(content);
  }

  function showHelp() {
    const content = h('div');
    const body = h('div', 'modal-body');
    body.append(
      h('h2', null, T.helpTitle),
      helpLine('Ctrl / ⌘ + S', T.helpSave),
      helpLine('Ctrl / ⌘ + Z', T.helpUndo),
      helpLine(T.helpArrowsKey, T.helpArrows),
      helpLine('Delete / Backspace', T.helpDelete),
      helpLine(T.mockTest, T.helpMock),
      helpLine(T.helpWallKey, T.helpWall),
      helpLine(T.tabNine, T.helpNine),
    );
    const actions = h('div', 'modal-actions');
    actions.append(button(T.gotIt, () => refs.modal.close(), 'small-button accent'));
    content.append(body, actions);
    showModal(content);
  }

  function helpLine(key, text) {
    const line = h('div', 'field');
    line.append(h('span', 'row-badge', key), h('span', null, text));
    return line;
  }

  function onKeyDown(event) {
    const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void saveDesign();
      return;
    }
    if (!typing && command && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
      return;
    }
    if (typing || editor.mode !== 'layout') return;
    const placement = editor.design?.placements.find((item) => item.id === editor.selectedPlacement);
    if (!placement) return;
    if ((event.key === 'Delete' || event.key === 'Backspace') && !placement.locked) {
      event.preventDefault();
      deletePlacement(placement);
      return;
    }
    const delta = event.shiftKey ? 10 : 1;
    const moves = { ArrowLeft: [-delta, 0], ArrowRight: [delta, 0], ArrowUp: [0, -delta], ArrowDown: [0, delta] };
    const move = moves[event.key];
    if (!move || placement.locked) return;
    event.preventDefault();
    mutate(() => {
      placement.x = clamp(placement.x + move[0], 0, Math.max(0, editor.design.canvas.width - placement.width));
      placement.y = clamp(placement.y + move[1], 0, Math.max(0, editor.design.canvas.height - placement.height));
    }, { render: true });
  }
})();
