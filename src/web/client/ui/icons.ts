const SVG_NS = 'http://www.w3.org/2000/svg';

export type WebUiIconName =
  | 'console'
  | 'message'
  | 'activity'
  | 'chart'
  | 'boxes'
  | 'bot'
  | 'settings'
  | 'play'
  | 'pause'
  | 'power'
  | 'image'
  | 'shirt'
  | 'folder-open'
  | 'download'
  | 'cpu'
  | 'text'
  | 'eye'
  | 'eye-off'
  | 'pencil'
  | 'refresh'
  | 'trash'
  | 'vote-up'
  | 'vote-down'
  | 'close'
  | 'calendar'
  | 'wrench'
  | 'zap'
  | 'package'
  | 'code'
  | 'home'
  | 'alert'
  | 'monitor'
  | 'cortico'
  | 'square-code'
  | 'copy'
  | 'reply'
  | 'shield-check'
  | 'sparkles'
  | 'github';

type Shape = readonly [tag: 'path' | 'circle' | 'rect' | 'line', attrs: Readonly<Record<string, string>>];

const SHAPES: Readonly<Record<WebUiIconName, readonly Shape[]>> = {
  console: [
    ['path', { d: 'm4 17 6-6-6-6' }],
    ['path', { d: 'M12 19h8' }],
  ],
  message: [['path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z' }]],
  activity: [
    ['path', { d: 'M3 12h4l2-7 4 14 2-7h6' }],
  ],
  chart: [
    ['path', { d: 'M4 19V9' }],
    ['path', { d: 'M10 19V5' }],
    ['path', { d: 'M16 19v-7' }],
    ['path', { d: 'M22 19H2' }],
  ],
  boxes: [
    ['path', { d: 'm12 2 7 4-7 4-7-4 7-4Z' }],
    ['path', { d: 'm5 10 7 4 7-4' }],
    ['path', { d: 'm5 14 7 4 7-4' }],
  ],
  bot: [
    ['rect', { x: '5', y: '7', width: '14', height: '12', rx: '3' }],
    ['path', { d: 'M12 3v4' }],
    ['circle', { cx: '9', cy: '13', r: '1' }],
    ['circle', { cx: '15', cy: '13', r: '1' }],
  ],
  settings: [
    ['circle', { cx: '12', cy: '12', r: '3' }],
    ['path', { d: 'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21h-4v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3v-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.5V3h4v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1.5 1Z' }],
  ],
  play: [['path', { d: 'm8 5 11 7-11 7V5Z' }]],
  power: [
    ['path', { d: 'M12 3v8' }],
    ['path', { d: 'M17.7 6.3a8 8 0 1 1-11.4 0' }],
  ],
  pause: [
    ['rect', { x: '7', y: '5', width: '3', height: '14', rx: '1' }],
    ['rect', { x: '14', y: '5', width: '3', height: '14', rx: '1' }],
  ],
  image: [
    ['rect', { x: '3', y: '4', width: '18', height: '16', rx: '3' }],
    ['circle', { cx: '9', cy: '10', r: '2' }],
    ['path', { d: 'm21 15-4-4L5 20' }],
  ],
  shirt: [['path', { d: 'M8.5 3.5 4 6l-1.5 4.5L6 12v8.5h12V12l3.5-1.5L20 6l-4.5-2.5a3.5 3.5 0 0 1-7 0Z' }]],
  'folder-open': [
    ['path', { d: 'M3 6h6l2 2h10' }],
    ['path', { d: 'M3 6v13h15l3-8H6l-3 8' }],
  ],
  download: [
    ['path', { d: 'M12 3v12' }],
    ['path', { d: 'm7 10 5 5 5-5' }],
    ['path', { d: 'M5 21h14' }],
  ],
  cpu: [
    ['rect', { x: '5', y: '5', width: '14', height: '14', rx: '2' }],
    ['rect', { x: '9', y: '9', width: '6', height: '6', rx: '1' }],
    ['path', { d: 'M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3' }],
  ],
  text: [
    ['path', { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' }],
    ['path', { d: 'M14 2v4a2 2 0 0 0 2 2h4' }],
    ['path', { d: 'M10 9H8M16 13H8M16 17H8' }],
  ],
  eye: [
    ['path', { d: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z' }],
    ['circle', { cx: '12', cy: '12', r: '3' }],
  ],
  'eye-off': [
    ['path', { d: 'M3 3l18 18' }],
    ['path', { d: 'M10.6 5.2A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a17.3 17.3 0 0 1-3.2 4' }],
    ['path', { d: 'M6.6 6.6C3.8 8.5 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1' }],
    ['path', { d: 'M9.9 9.9a3 3 0 0 0 4.2 4.2' }],
  ],
  pencil: [
    ['path', { d: 'M4 20h4.2L19.4 8.8a2.3 2.3 0 0 0-3.2-3.2L5 16.8V20Z' }],
    ['path', { d: 'm12.6 6.5 4.9 4.9' }],
  ],
  refresh: [
    ['path', { d: 'M21 12a9 9 0 1 1-2.6-6.4' }],
    ['path', { d: 'M21 3v6h-6' }],
  ],
  trash: [
    ['path', { d: 'M4 7h16' }],
    ['path', { d: 'M9.5 7V5h5v2' }],
    ['path', { d: 'M6.5 7v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2V7' }],
    ['path', { d: 'M10 11v6' }],
    ['path', { d: 'M14 11v6' }],
  ],
  'vote-up': [['path', { d: 'M12 6.5 19 17.5H5Z' }]],
  'vote-down': [['path', { d: 'M12 17.5 5 6.5h14Z' }]],
  close: [
    ['path', { d: 'M18 6 6 18' }],
    ['path', { d: 'm6 6 12 12' }],
  ],
  wrench: [['path', { d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z' }]],
  zap: [['path', { d: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z' }]],
  package: [
    ['path', { d: 'm7.5 4.3 9 5.1' }],
    ['path', { d: 'M21 8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z' }],
    ['path', { d: 'm3.3 7 8.7 5 8.7-5' }],
    ['path', { d: 'M12 22V12' }],
  ],
  code: [
    ['path', { d: 'm16 18 6-6-6-6' }],
    ['path', { d: 'm8 6-6 6 6 6' }],
  ],
  home: [
    ['path', { d: 'M3 10.5 12 3l9 7.5' }],
    ['path', { d: 'M5 9.5V21h14V9.5' }],
    ['path', { d: 'M10 21v-6h4v6' }],
  ],
  alert: [
    ['circle', { cx: '12', cy: '12', r: '9' }],
    ['path', { d: 'M12 8v4' }],
    ['path', { d: 'M12 16h.01' }],
  ],
  cortico: [
    ['path', { d: 'M17.8 5.1A9 9 0 1 0 17.8 18.9', style: 'stroke-width: 2.6' }],
    ['circle', { cx: '10.4', cy: '10.8', r: '2.1', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '15.8', cy: '10.8', r: '2.1', fill: 'currentColor', stroke: 'none' }],
  ],
  copy: [
    ['rect', { x: '9', y: '9', width: '11', height: '11', rx: '2' }],
    ['path', { d: 'M5 15V5a2 2 0 0 1 2-2h10' }],
  ],
  reply: [
    ['path', { d: 'm9 17-5-5 5-5' }],
    ['path', { d: 'M20 18v-2a4 4 0 0 0-4-4H4' }],
  ],
  'square-code': [
    ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }],
    ['path', { d: 'm10 9-3 3 3 3' }],
    ['path', { d: 'm14 15 3-3-3-3' }],
  ],
  'shield-check': [
    ['path', { d: 'M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6Z' }],
    ['path', { d: 'm8.8 12 2.2 2.2 4.3-4.4' }],
  ],
  sparkles: [
    ['path', { d: 'M11 3.5 12.7 8.3 17.5 10 12.7 11.7 11 16.5 9.3 11.7 4.5 10 9.3 8.3Z', fill: 'currentColor' }],
    ['path', { d: 'M18 14.5 18.8 16.7 21 17.5 18.8 18.3 18 20.5 17.2 18.3 15 17.5 17.2 16.7Z', fill: 'currentColor' }],
  ],
  github: [['path', { d: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12', fill: 'currentColor', stroke: 'none' }]],
  monitor: [
    ['rect', { x: '3', y: '4', width: '18', height: '12', rx: '2' }],
    ['path', { d: 'M8 20h8' }],
    ['path', { d: 'M12 16v4' }],
  ],
  calendar: [
    ['rect', { x: '3.5', y: '5', width: '17', height: '15.5', rx: '2.5' }],
    ['path', { d: 'M8 3v4' }],
    ['path', { d: 'M16 3v4' }],
    ['path', { d: 'M3.5 10h17' }],
  ],
};

/**
 * Cortico 字标。笔画与 README 横幅(assets/cortico-banner.svg)是同一份。
 * 横幅上那四个圈(两只眼睛与两个字母 o)是品牌绿,这里改成跟当前主题的强调色走,
 * 其余笔画取 currentColor。颜色写在样式表里:presentation 属性吃不下 var()。
 */
const WORDMARK_MARK: readonly Shape[] = [
  ['path', { d: 'M182 63.66A84 84 0 1 0 182 192.34', 'stroke-width': '30' }],
  ['circle', { cx: '113', cy: '117', r: '16', 'stroke-width': '11', class: 'accent' }],
  ['circle', { cx: '163', cy: '117', r: '16', 'stroke-width': '11', class: 'accent' }],
];

const WORDMARK_TEXT: readonly Shape[] = [
  ['path', { d: 'M230.97 93.03A24 24 0 1 0 230.97 126.97' }],
  ['circle', { cx: '286', cy: '110', r: '24', class: 'accent' }],
  ['path', { d: 'M341 86V134' }],
  ['path', { d: 'M341 112A24 24 0 0 1 365 88' }],
  ['path', { d: 'M412 70V134' }],
  ['path', { d: 'M396 78H428' }],
  ['path', { d: 'M459 86V134' }],
  ['path', { d: 'M530.97 93.03A24 24 0 1 0 530.97 126.97' }],
  ['circle', { cx: '586', cy: '110', r: '24', class: 'accent' }],
];

function shapesInto(doc: Document, parent: SVGElement, shapes: readonly Shape[]): void {
  for (const [tag, attrs] of shapes) {
    const child = doc.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) child.setAttribute(key, value);
    parent.appendChild(child);
  }
}

export function wordmark(doc: Document, cls = 'wordmark'): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '28 32 614 156');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add(cls);
  // 字母前那个符号自带一套尺度,照横幅原样缩放,不重算坐标。
  const mark = doc.createElementNS(SVG_NS, 'g');
  mark.setAttribute('transform', 'translate(10 14) scale(.75)');
  shapesInto(doc, mark, WORDMARK_MARK);
  const text = doc.createElementNS(SVG_NS, 'g');
  text.setAttribute('stroke-width', '16');
  text.setAttribute('transform', 'translate(20 0)');
  shapesInto(doc, text, WORDMARK_TEXT);
  const dot = doc.createElementNS(SVG_NS, 'circle');
  for (const [key, value] of Object.entries({ cx: '459', cy: '58', r: '9', fill: 'currentColor', stroke: 'none' })) {
    dot.setAttribute(key, value);
  }
  svg.appendChild(mark);
  svg.appendChild(text);
  text.appendChild(dot);
  return svg;
}

/** 字标前那个符号单独用。视框按它自己的坐标取，描边算在内。 */
export function brandMark(doc: Document, cls = 'brandmark'): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '29 29 198 198');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', cls);
  shapesInto(doc, svg, WORDMARK_MARK);
  return svg;
}

export function icon(doc: Document, name: WebUiIconName, cls = 'icon'): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', cls);
  shapesInto(doc, svg, SHAPES[name]);
  return svg;
}
