const SVG_NS = 'http://www.w3.org/2000/svg';

export type ConsoleIconName =
  | 'terminal'
  | 'activity'
  | 'chart'
  | 'boxes'
  | 'bot'
  | 'settings'
  | 'play'
  | 'pause'
  | 'power'
  | 'image'
  | 'folder-open'
  | 'download'
  | 'cpu'
  | 'text'
  | 'eye'
  | 'eye-off'
  | 'refresh';

type Shape = readonly [tag: 'path' | 'circle' | 'rect' | 'line', attrs: Readonly<Record<string, string>>];

const SHAPES: Readonly<Record<ConsoleIconName, readonly Shape[]>> = {
  terminal: [
    ['path', { d: 'm4 17 6-6-6-6' }],
    ['path', { d: 'M12 19h8' }],
  ],
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
  refresh: [
    ['path', { d: 'M21 12a9 9 0 1 1-2.6-6.4' }],
    ['path', { d: 'M21 3v6h-6' }],
  ],
};

/**
 * Cortico 字标。笔画与 README 横幅(assets/cortico-banner.svg)是同一份,
 * 差别只在这里全部走 currentColor:左栏顶上要的是一个纯色的名字。
 */
const WORDMARK_MARK: readonly Shape[] = [
  ['path', { d: 'M182 63.66A84 84 0 1 0 182 192.34', 'stroke-width': '30' }],
  ['circle', { cx: '113', cy: '117', r: '16', 'stroke-width': '11' }],
  ['circle', { cx: '163', cy: '117', r: '16', 'stroke-width': '11' }],
];

const WORDMARK_TEXT: readonly Shape[] = [
  ['path', { d: 'M230.97 93.03A24 24 0 1 0 230.97 126.97' }],
  ['circle', { cx: '286', cy: '110', r: '24' }],
  ['path', { d: 'M341 86V134' }],
  ['path', { d: 'M341 112A24 24 0 0 1 365 88' }],
  ['path', { d: 'M412 70V134' }],
  ['path', { d: 'M396 78H428' }],
  ['path', { d: 'M459 86V134' }],
  ['path', { d: 'M530.97 93.03A24 24 0 1 0 530.97 126.97' }],
  ['circle', { cx: '586', cy: '110', r: '24' }],
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
  svg.setAttribute('viewBox', '28 32 594 156');
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
  shapesInto(doc, text, WORDMARK_TEXT);
  const dot = doc.createElementNS(SVG_NS, 'circle');
  for (const [key, value] of Object.entries({ cx: '459', cy: '58', r: '9', fill: 'currentColor', stroke: 'none' })) {
    dot.setAttribute(key, value);
  }
  svg.appendChild(mark);
  svg.appendChild(text);
  svg.appendChild(dot);
  return svg;
}

export function icon(doc: Document, name: ConsoleIconName, cls = 'icon'): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add(cls);
  shapesInto(doc, svg, SHAPES[name]);
  return svg;
}
