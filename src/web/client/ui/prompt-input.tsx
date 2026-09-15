/**
 * 对话输入器:表单壳、自适应高度的 textarea、附图钮、发送钮与图片托盘。一个 React 根挂进
 * 控制台面板,`promptInput()` 把它包成 ConsolePromptInput。
 *
 * 图片在进托盘时就归一化成 base64,提交时与文本一并交出。拖入、粘贴、选择三条入口共用
 * addFiles:超出张数整批拒,单张失败只报那一张。
 */
import * as React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import TextareaAutosize from 'react-textarea-autosize';
import type {
  ConsoleImageAttachment,
  ConsolePromptInput,
  ConsolePromptInputOptions,
} from '../../shared/client-panel.ts';
import { IMAGE_DEFAULTS, isImageFile, normalizeImage } from './images.ts';
import { S } from './strings.ts';

interface ComposerHandle {
  focus(): void;
  setDisabled(disabled: boolean): void;
  setPlaceholder(text: string | null): void;
}

/** 托盘里的一张:归一化结果 + 同一份字节的 data URL 缩略图。 */
interface Attached {
  id: number;
  image: ConsoleImageAttachment;
  src: string;
}

function sizeCaption(image: ConsoleImageAttachment): string {
  const kb = image.bytes / 1024;
  const size = kb >= 1024 ? `${(kb / 1024).toFixed(1)}MB` : `${Math.round(kb)}KB`;
  return `${size} · ${image.width}×${image.height}`;
}

const FORM_CLASS =
  'rounded-[var(--radius-composer)] border border-border bg-surface p-2 shadow-[0_2px_14px_color-mix(in_oklab,var(--foreground)_5%,transparent)] transition-[border-color,box-shadow] duration-150 focus-within:border-border-strong focus-within:shadow-[0_4px_20px_color-mix(in_oklab,var(--foreground)_7%,transparent)]';

const TEXTAREA_CLASS =
  'max-h-52 min-h-12 w-full resize-none border-0 bg-transparent px-2.5 py-2 text-[15px] leading-6 text-foreground outline-none placeholder:text-muted-foreground/75';

/** 两枚圆形图标钮共用的底:尺寸、焦点环、禁用态。 */
const ICON_BUTTON =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-full p-0 outline-none transition-[background-color,color,opacity,transform] duration-150 disabled:pointer-events-none disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring/40 [&_svg]:pointer-events-none [&_svg]:size-4';

/** 发送钮:实底,是这一栏唯一的主动作。 */
const SEND_CLASS = `${ICON_BUTTON} self-end bg-foreground text-background hover:bg-foreground/90 active:translate-y-px focus-visible:ring-offset-2 focus-visible:ring-offset-background`;

/** 附图钮:无底色,不与发送钮抢份量。 */
const ATTACH_CLASS = `${ICON_BUTTON} text-muted-foreground hover:bg-surface-hover hover:text-foreground`;

const ICON_PROPS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

function ArrowUpIcon(): React.ReactElement {
  return (
    <svg {...ICON_PROPS} strokeWidth={2.2}>
      <path d="M12 19.5v-15" />
      <path d="M5.5 11 12 4.5 18.5 11" />
    </svg>
  );
}

function PictureIcon(): React.ReactElement {
  return (
    <svg {...ICON_PROPS} strokeWidth={2}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <circle cx="8.5" cy="9" r="1.6" />
      <path d="m4 17.5 5-4.5 3.5 3 3-2.5 4.5 4" />
    </svg>
  );
}

function CrossIcon(): React.ReactElement {
  return (
    <svg {...ICON_PROPS} strokeWidth={2.4}>
      <path d="M7 7l10 10" />
      <path d="M17 7 7 17" />
    </svg>
  );
}

/** 一张缩略图 + 悬停时右上角的移除钮。 */
function Thumbnail({ item, onRemove }: { item: Attached; onRemove(): void }): React.ReactElement {
  const caption = sizeCaption(item.image);
  return (
    <div
      className="group relative size-20 overflow-hidden rounded-[10px] border border-border bg-surface-hover"
      title={`${item.image.name}\n${caption}`}
    >
      <img src={item.src} alt={item.image.name} className="size-full object-cover" draggable={false} />
      <button
        type="button"
        aria-label={S.removeImage(item.image.name)}
        onClick={onRemove}
        className="absolute top-1 right-1 inline-flex size-5 items-center justify-center rounded-full bg-foreground/80 text-background opacity-0 transition-opacity duration-100 hover:bg-foreground group-hover:opacity-100 focus-visible:opacity-100 [&_svg]:size-3"
      >
        <CrossIcon />
      </button>
    </div>
  );
}

const PromptComposer = React.forwardRef<ComposerHandle, { opts: ConsolePromptInputOptions }>(
  ({ opts }, ref) => {
    const [value, setValue] = React.useState('');
    const [disabled, setDisabled] = React.useState(opts.disabled ?? false);
    const [attached, setAttached] = React.useState<Attached[]>([]);
    /** 还在解码/缩放中的张数。>0 时发送钮暂停,免得把半批图发出去。 */
    const [pending, setPending] = React.useState(0);
    /** 最近一次拒收的理由。下一次成功入托盘或用户改动文本时清掉。 */
    const [note, setNote] = React.useState<string | null>(null);
    const [dragging, setDragging] = React.useState(false);
    /** 盖住 `opts.placeholder` 的那一句;`null` 就是不盖。 */
    const [placeholder, setPlaceholder] = React.useState<string | null>(null);
    const textarea = React.useRef<HTMLTextAreaElement>(null);
    const tools = React.useRef<HTMLSpanElement>(null);
    const picker = React.useRef<HTMLInputElement>(null);
    const nextId = React.useRef(1);
    const imagesOpts = opts.images;
    const maxImages = imagesOpts ? (imagesOpts.max ?? IMAGE_DEFAULTS.max) : 0;

    React.useLayoutEffect(() => {
      const node = opts.tools;
      const host = tools.current;
      if (!node || !host) return;
      host.appendChild(node);
      return () => node.remove();
    }, [opts.tools]);

    React.useImperativeHandle(ref, () => ({
      focus: () => textarea.current?.focus(),
      setDisabled,
      setPlaceholder,
    }), []);

    /** 收一批文件。超出张数的整批拒;单张失败只报那一张,其余照收。 */
    const addFiles = (files: Iterable<File>): void => {
      if (!imagesOpts) return;
      const list = [...files].filter(isImageFile);
      if (list.length === 0) return;
      if (attached.length + pending + list.length > maxImages) {
        setNote(S.tooManyImages(maxImages));
        return;
      }
      setNote(null);
      setPending((n) => n + list.length);
      for (const file of list) {
        // 序号先于归一化分配:大图缩得慢,托盘顺序仍按用户选的顺序,不按完成顺序
        const id = nextId.current++;
        normalizeImage(file, imagesOpts).then(
          (image) => {
            const src = `data:${image.mime};base64,${image.base64}`;
            setAttached((now) => [...now, { id, image, src }].sort((a, b) => a.id - b.id));
          },
          (err: unknown) => setNote(err instanceof Error ? err.message : String(err)),
        ).finally(() => setPending((n) => n - 1));
      }
    };

    const remove = (id: number): void => setAttached((now) => now.filter((a) => a.id !== id));

    const canSubmit = !disabled && pending === 0 && (value.trim() !== '' || attached.length > 0);

    const submit = (): void => {
      if (!canSubmit) return;
      const images = attached.map((a) => a.image);
      if (opts.onSubmit(value.trim(), images) !== false) {
        setValue('');
        setAttached([]);
        setNote(null);
      }
    };

    return (
      <form
        aria-label={opts.label ?? S.messageInput}
        data-dragging={dragging || undefined}
        className={dragging ? `${FORM_CLASS} border-dashed border-border-strong` : FORM_CLASS}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onDragOver={imagesOpts ? (event) => {
          if (![...event.dataTransfer.types].includes('Files')) return;
          event.preventDefault();
          setDragging(true);
        } : undefined}
        onDragLeave={imagesOpts ? () => setDragging(false) : undefined}
        onDrop={imagesOpts ? (event) => {
          setDragging(false);
          if (event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          addFiles(event.dataTransfer.files);
        } : undefined}
      >
        {attached.length > 0 && (
          <div className="flex flex-wrap gap-2 px-2 pt-1 pb-2">
            {attached.map((a) => (
              <Thumbnail key={a.id} item={a} onRemove={() => remove(a.id)} />
            ))}
          </div>
        )}
        <div className="flex min-w-0 items-start">
          <TextareaAutosize
            ref={textarea}
            minRows={1}
            maxRows={8}
            rows={1}
            value={value}
            disabled={disabled}
            placeholder={placeholder ?? opts.placeholder ?? S.typeMessage}
            className={TEXTAREA_CLASS}
            onChange={(event) => { setValue(event.currentTarget.value); setNote(null); }}
            onKeyDown={(event) => {
              // Enter 发送;Shift+Enter 换行;输入法组合中的 Enter 是选字,不是发送
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              submit();
            }}
            onPaste={imagesOpts ? (event) => {
              const files = [...event.clipboardData.files].filter(isImageFile);
              if (files.length === 0) return;
              // 粘贴内容包含图片时只处理图片。
              event.preventDefault();
              addFiles(files);
            } : undefined}
          />
        </div>
        <div className="flex min-h-9 items-center justify-between gap-2 px-1">
          <span className="truncate px-2 text-xs text-muted-foreground">
            {note ? <span className="text-danger">{note}</span>
              : pending > 0 ? S.processingImages(pending)
              : opts.hint ?? S.enterToSend}
          </span>
          <div className="flex items-center gap-1">
            {imagesOpts && (
              <>
                <input
                  ref={picker}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(event) => {
                    if (event.currentTarget.files) addFiles(event.currentTarget.files);
                    // 同一个文件再选一次也要触发 change
                    event.currentTarget.value = '';
                  }}
                />
                <button
                  type="button"
                  aria-label={S.addImage}
                  title={S.addImageHint}
                  className={ATTACH_CLASS}
                  disabled={disabled || attached.length >= maxImages}
                  onClick={() => picker.current?.click()}
                >
                  <PictureIcon />
                </button>
              </>
            )}
            <span ref={tools} className="flex items-center" />
            <button
              type="submit"
              aria-label={S.sendMessage}
              title={S.sendMessage}
              className={SEND_CLASS}
              disabled={!canSubmit}
            >
              <ArrowUpIcon />
            </button>
          </div>
        </div>
      </form>
    );
  },
);
PromptComposer.displayName = 'PromptComposer';

export function promptInput(
  doc: Document,
  signal: AbortSignal,
  opts: ConsolePromptInputOptions,
): ConsolePromptInput {
  const el = doc.createElement('div');
  el.className = 'prompt-input-host';
  const handle = React.createRef<ComposerHandle>();
  const root = createRoot(el, { identifierPrefix: 'cortico-' });
  flushSync(() => root.render(<PromptComposer ref={handle} opts={opts} />));

  const dispose = (): void => root.unmount();
  if (signal.aborted) dispose();
  else signal.addEventListener('abort', dispose, { once: true });

  return {
    el,
    focus: () => handle.current?.focus(),
    setDisabled: (disabled) => handle.current?.setDisabled(disabled),
    setPlaceholder: (text) => handle.current?.setPlaceholder(text),
  };
}
