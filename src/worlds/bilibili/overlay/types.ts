export const OVERLAY_SCHEMA_VERSION = 4 as const;

type OverlayAxis = 'horizontal' | 'vertical';
type DanmakuAdmission = 'danmaku' | 'gift' | 'all';
type OverlayEventKind = 'danmaku' | 'gift';
type OverlayTitlePosition = 'top' | 'right' | 'bottom' | 'left';
type OverlayTitleAlign = 'left' | 'center' | 'right';

export interface OverlayTextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
}

export type OverlayTextStylePatch = Partial<OverlayTextStyle>;

export interface OverlayComponentTitle {
  text: string;
  position: OverlayTitlePosition;
  align: OverlayTitleAlign;
  style: OverlayTextStyle;
}

interface OverlayInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

type NineSliceRepeat = 'stretch' | 'repeat' | 'round';

interface NineSliceStyle {
  assetId: string;
  /** Source-image cut lines, in source pixels. */
  slice: OverlayInsets;
  /** Destination border widths, in canvas pixels. */
  width: OverlayInsets;
  fill: boolean;
  repeat: NineSliceRepeat;
}

export interface OverlayStyle {
  id: string;
  name: string;
  background: string;
  borderColor: string;
  borderWidth: number;
  radius: number;
  padding: number;
  username: OverlayTextStyle;
  body: OverlayTextStyle;
  nineSlice?: NineSliceStyle;
}

export type AudienceField =
  | 'uid'
  | 'guardLevel'
  | 'medalLevel'
  | 'medalName'
  | 'medalAnchorName'
  | 'medalRoomId'
  | 'medalColor'
  | 'isAdmin'
  | 'vip'
  | 'svip'
  | 'rank'
  | 'nameColor'
  | 'userLevel'
  | 'eventKind';

export type AudienceCompare = 'eq' | 'gte' | 'lte' | 'exists' | 'contains';

export type AudienceRule =
  | { op: 'all'; rules: AudienceRule[] }
  | { op: 'any'; rules: AudienceRule[] }
  | { op: 'leaf'; field: AudienceField; compare: AudienceCompare; value?: string | number | boolean };

export interface AudienceGroup {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  rule: AudienceRule;
  username: OverlayTextStylePatch;
  body: OverlayTextStylePatch;
}

interface OverlayComponentBase {
  id: string;
  name: string;
  styleId: string;
  title?: OverlayComponentTitle;
}

interface DanmakuComponent extends OverlayComponentBase {
  kind: 'danmaku';
  axis: OverlayAxis;
  admission: DanmakuAdmission;
  showAvatar: boolean;
  speed: number;
  gap: number;
  maxItems: number;
  usernameMaxChars: number;
  bodyMaxChars: number;
  edgeFadePx: number;
}

interface ScrollNoticeComponent extends OverlayComponentBase {
  kind: 'scroll-notice';
  axis: OverlayAxis;
  text: string;
  speed: number;
  gap: number;
  lineHoldMs: number;
  lineTransitionMs: number;
  edgeFadePx: number;
}

interface FixedNoticeComponent extends OverlayComponentBase {
  kind: 'fixed-notice';
  text: string;
}

interface AgentNoticeComponent extends OverlayComponentBase {
  kind: 'agent-notice';
  emptyText: string;
  hideWhenEmpty: boolean;
  typingMs: number;
}

interface ImageComponent extends OverlayComponentBase {
  kind: 'image';
  source: 'external' | 'upload';
  url: string;
  assetId: string;
  fit: 'contain' | 'cover' | 'fill';
  opacity: number;
}

/** 显示 Bot 维护的视频排队列表；队列内容与上限属于 World,所有排队组件显示同一份。 */
interface VideoQueueComponent extends OverlayComponentBase {
  kind: 'video-queue';
  axis: OverlayAxis;
  gap: number;
  showIndex: boolean;
  emptyText: string;
  hideWhenEmpty: boolean;
}

/** 游戏战况:死亡次数与当前目标(数据来自 Minecraft World 的事件,见 LiveStatusState)。 */
interface GameStatusComponent extends OverlayComponentBase {
  kind: 'game-status';
  showDeaths: boolean;
  showGoals: boolean;
  /** 最多显示几条目标 */
  maxGoals: number;
  emptyText: string;
}

/** 临时弹窗:死亡、投票结果这类一闪而过的提示。只收 toast 包,不常驻。 */
interface ToastComponent extends OverlayComponentBase {
  kind: 'toast';
  /** 每条停留时长 */
  holdMs: number;
}

/** 弹幕投票:题目、选项、实时票数与倒计时。没有进行中的投票时隐藏。 */
interface PollComponent extends OverlayComponentBase {
  kind: 'poll';
  /** 投票结束后结果再留多久 */
  resultHoldMs: number;
}

export type OverlayComponent =
  | DanmakuComponent
  | ScrollNoticeComponent
  | FixedNoticeComponent
  | AgentNoticeComponent
  | ImageComponent
  | VideoQueueComponent
  | GameStatusComponent
  | ToastComponent
  | PollComponent;

export interface OverlayPlacement {
  id: string;
  componentId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  visible: boolean;
  locked: boolean;
}

export interface BilibiliOverlayDesign {
  schemaVersion: typeof OVERLAY_SCHEMA_VERSION;
  canvas: { width: number; height: number };
  styles: OverlayStyle[];
  groups: AudienceGroup[];
  components: OverlayComponent[];
  placements: OverlayPlacement[];
}

export interface BilibiliOverlayConfig {
  enabled: boolean;
  port: number;
  agentNoticeMaxChars: number;
  maxQueuedVideos: number;
  design: BilibiliOverlayDesign;
}

export interface OverlayAudienceFacts {
  uid?: string;
  guardLevel?: number;
  medalLevel?: number;
  medalName?: string;
  medalAnchorName?: string;
  medalRoomId?: number;
  medalColor?: number;
  isAdmin?: boolean;
  vip?: boolean;
  svip?: boolean;
  rank?: number;
  nameColor?: string;
  userLevel?: number;
  eventKind: OverlayEventKind;
}

export interface OverlayAudienceEvent {
  eventKind: OverlayEventKind;
  username: string;
  body: string;
  avatarUrl: string;
  facts: OverlayAudienceFacts;
  groupId?: string;
}

export interface AgentAnnouncementState {
  schemaVersion: 1;
  text: string;
  revision: number;
  updatedAt: string | null;
}

export interface VideoQueueItem {
  bvid: string;
  /** Bot 写在 BV 号后面的短文本，可为空。 */
  note: string;
  addedAt: string;
}

export interface VideoQueueState {
  schemaVersion: 1;
  items: VideoQueueItem[];
  revision: number;
  updatedAt: string | null;
}

export interface LiveStatusGoal {
  slot: number;
  text: string;
  progress: { current: number; total: number | null; unit: string | null } | null;
  milestones: { done: number; total: number };
  next: string | null;
}

export interface LivePollState {
  id: number;
  question: string;
  options: Array<{ key: string; label: string; votes: number }>;
  /** 投票截止的毫秒戳 */
  endsAt: number;
  /** 已结束时为结束刻,进行中为 null */
  closedAt: number | null;
  voters: number;
}

/** 叠加层的实时战况。只在内存里,重启从空开始(死亡数下一次死亡时补齐)。 */
export interface LiveStatusState {
  deaths: { today: number; total: number; lastCause: string | null } | null;
  goals: LiveStatusGoal[];
  poll: LivePollState | null;
}

export interface OverlayToast {
  kind: 'death' | 'poll' | 'info';
  title: string;
  body: string;
}

export interface OverlayAssetInfo {
  id: string;
  mime: string;
  size: number;
  url: string;
}
