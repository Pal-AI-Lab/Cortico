/**
 * 地图画面:收服务端推来的地图包,按编号攒成 128×128 的颜色索引,要看时渲成 PNG。
 *
 * 原版服务端每刻给包里每一张地图推增量(只含变了的那个矩形),mineflayer 自己不接这个包。
 * 包里没有地图中心与维度,本机服务端的存档 data/map_<id>.dat 里有,读得到就用它把图标换算成世界坐标。
 */
import { deflateSync, crc32 } from 'node:zlib';
import type { Bot } from 'mineflayer';

/** 原版地图边长(像素) */
export const MAP_SIZE = 128;
/** 渲成 PNG 时每个地图像素放大成几乘几:128 → 512,小图标和一格宽的河也看得清 */
const PNG_SCALE = 4;

/**
 * 原版 1.20.6 MapColor.MATERIAL_COLORS 的底色,下标即颜色编号(从本地 Paper jar 反射读出核对过)。
 * 包里每个像素是「底色编号 × 4 + 明暗档」。
 */
const BASE_COLORS = [
  0x000000, 0x7fb238, 0xf7e9a3, 0xc7c7c7, 0xff0000, 0xa0a0ff, 0xa7a7a7, 0x007c00,
  0xffffff, 0xa4a8b8, 0x976d4d, 0x707070, 0x4040ff, 0x8f7748, 0xfffcf5, 0xd87f33,
  0xb24cd8, 0x6699d8, 0xe5e533, 0x7fcc19, 0xf27fa5, 0x4c4c4c, 0x999999, 0x4c7f99,
  0x7f3fb2, 0x334cb2, 0x664c33, 0x667f33, 0x993333, 0x191919, 0xfaee4d, 0x5cdbd5,
  0x4a80ff, 0x00d93a, 0x815631, 0x700200, 0xd1b1a1, 0x9f5224, 0x95576c, 0x706c8a,
  0xba8524, 0x677535, 0xa04d4e, 0x392923, 0x876b62, 0x575c5c, 0x7a4958, 0x4c3e5c,
  0x4c3223, 0x4c522a, 0x8e3c2e, 0x251610, 0xbd3031, 0x943f61, 0x5c191d, 0x167e86,
  0x3a8e8c, 0x562c3e, 0x14b485, 0x646464, 0xd8af93, 0x7fa796,
];
/** 明暗档 0–3 的乘数(/255):LOW 180、NORMAL 220、HIGH 255、LOWEST 135 */
const BRIGHTNESS = [180, 220, 255, 135];
/** 没探索过的像素(底色 0)画成的颜色:原版地图纸的米色 */
const UNEXPLORED = [0xd6, 0xbe, 0x96];

export interface MapIcon {
  /** mapIcons 表里的名字:player / red_marker / banner_red / ... */
  type: string;
  /** 地图像素坐标 0–128(包里是 -128..127 的半像素) */
  px: number;
  pz: number;
  /** 朝向 0–15,每档 22.5°,0 = 朝南 */
  direction: number;
  label: string | null;
}

export interface MapState {
  id: number;
  scale: number;
  locked: boolean;
  colors: Uint8Array;
  icons: MapIcon[];
  /** 收到过像素数据没有;只收到图标的地图渲不出画面 */
  painted: boolean;
  updatedAtMs: number;
}

const maps = new WeakMap<object, Map<number, MapState>>();

interface MapPacket {
  itemDamage: number;
  scale: number;
  locked: boolean;
  icons?: Array<{ type: number; x: number; z: number; direction: number; displayName?: unknown }> | null;
  columns: number;
  rows?: number;
  x?: number;
  y?: number;
  data?: Buffer;
}

/** 一条连接挂一次;重连换新 bot 时重新挂,旧图随旧 bot 一起丢 */
export function trackMaps(bot: Bot): void {
  const byId = new Map<number, MapState>();
  maps.set(bot, byId);
  const iconName = (t: number): string =>
    (bot.registry as unknown as { mapIcons?: Record<number, { name: string }> }).mapIcons?.[t]?.name ?? `icon#${t}`;
  const client = (bot as unknown as { _client: { on(n: string, f: (p: MapPacket) => void): void } })._client;
  client.on('map', (p) => {
    let m = byId.get(p.itemDamage);
    if (!m) {
      m = {
        id: p.itemDamage, scale: p.scale, locked: p.locked,
        colors: new Uint8Array(MAP_SIZE * MAP_SIZE), icons: [], painted: false, updatedAtMs: 0,
      };
      byId.set(p.itemDamage, m);
    }
    m.scale = p.scale;
    m.locked = p.locked;
    if (p.icons) {
      m.icons = p.icons.map((i) => ({
        type: iconName(i.type), px: (i.x + 128) / 2, pz: (i.z + 128) / 2, direction: i.direction,
        label: i.displayName ? textOf(i.displayName) : null,
      }));
    }
    if (p.columns > 0 && p.data && p.rows !== undefined && p.x !== undefined && p.y !== undefined) {
      for (let r = 0; r < p.rows; r++) {
        for (let c = 0; c < p.columns; c++) {
          m.colors[(p.y + r) * MAP_SIZE + p.x + c] = p.data[r * p.columns + c];
        }
      }
      m.painted = true;
    }
    m.updatedAtMs = Date.now();
  });
}

/** 图标上的自定义名(旗帜命名)是 NBT 文本组件;只取纯文字 */
function textOf(nbt: unknown): string | null {
  const v = (nbt as { value?: unknown })?.value ?? nbt;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v) as { text?: string };
      return typeof parsed.text === 'string' ? parsed.text : v;
    } catch {
      return v; // 不是 JSON 就是纯文字本身
    }
  }
  const text = (v as { text?: { value?: unknown } })?.text?.value;
  return typeof text === 'string' ? text : null;
}

export function mapStateOf(bot: Bot, id: number): MapState | null {
  return maps.get(bot)?.get(id) ?? null;
}

function rgbOf(index: number): [number, number, number] {
  const base = index >> 2;
  if (base === 0) return [UNEXPLORED[0], UNEXPLORED[1], UNEXPLORED[2]];
  const col = BASE_COLORS[base] ?? 0xff00ff;
  const k = BRIGHTNESS[index & 3];
  return [((col >> 16) & 0xff) * k / 255 | 0, ((col >> 8) & 0xff) * k / 255 | 0, (col & 0xff) * k / 255 | 0];
}

/** 图标在 PNG 上画成的颜色:自己白、别的玩家蓝、标记红、旗帜按色、其余黄 */
function iconColor(type: string): [number, number, number] {
  if (type === 'player' || type === 'player_off_map' || type === 'player_off_limits') return [255, 255, 255];
  if (type.endsWith('_marker') || type === 'red_x' || type === 'target_x' || type === 'target_point') return [230, 30, 30];
  if (type === 'frame') return [40, 200, 40];
  return [250, 220, 40];
}

/** 地图画面 → PNG:每像素放大 PNG_SCALE 倍,图标画成带黑边的方块 */
export function renderMapPng(m: MapState): Buffer {
  const W = MAP_SIZE * PNG_SCALE;
  const rgb = new Uint8Array(W * W * 3);
  const put = (x: number, y: number, c: [number, number, number]): void => {
    if (x < 0 || y < 0 || x >= W || y >= W) return;
    const o = (y * W + x) * 3;
    rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
  };
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const c = rgbOf(m.colors[y * MAP_SIZE + x]);
      for (let dy = 0; dy < PNG_SCALE; dy++) for (let dx = 0; dx < PNG_SCALE; dx++) put(x * PNG_SCALE + dx, y * PNG_SCALE + dy, c);
    }
  }
  for (const icon of m.icons) {
    const cx = Math.round(icon.px * PNG_SCALE);
    const cy = Math.round(icon.pz * PNG_SCALE);
    for (let dy = -5; dy <= 5; dy++) {
      for (let dx = -5; dx <= 5; dx++) {
        const edge = Math.max(Math.abs(dx), Math.abs(dy)) >= 4;
        put(cx + dx, cy + dy, edge ? [0, 0, 0] : iconColor(icon.type));
      }
    }
    // 朝向:从中心往外画一道黑线,0 = 朝南(+z,图上向下),顺时针每档 22.5°
    const a = icon.direction * (Math.PI / 8);
    for (let r = 5; r <= 12; r++) put(cx - Math.round(Math.sin(a) * r), cy + Math.round(Math.cos(a) * r), [0, 0, 0]);
  }
  return encodePng(W, W, rgb);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/** 8 位 RGB、不隔行的最小 PNG;每行前一个 0 字节(不滤波) */
export function encodePng(w: number, h: number, rgb: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 地图上已探索(不是底色 0)的像素占多少 */
export function exploredShare(m: MapState): number {
  let n = 0;
  for (const c of m.colors) if (c >> 2 !== 0) n++;
  return n / m.colors.length;
}
