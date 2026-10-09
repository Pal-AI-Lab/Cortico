import type { ConsoleUi } from '../../shared/client-panel.ts';
import { postBlob } from '../core/api.ts';
import { icon } from '../ui/icons.ts';
import { S } from './strings.ts';

const EDITOR_SIZE = 300;
const OUTPUT_SIZE = 512;

export interface AvatarControl {
  readonly el: HTMLDivElement;
  setLabel(label: string): void;
}

export function createAvatarControl(opts: {
  doc: Document;
  ui: ConsoleUi;
  signal: AbortSignal;
  onError(err: unknown): void;
}): AvatarControl {
  const { doc, ui, signal } = opts;
  const el = ui.h('div', 'rail-avatar-wrap');
  const button = ui.h('button', 'rail-avatar');
  button.type = 'button';
  button.setAttribute('aria-label', S.changeAvatar);
  button.title = S.uploadAvatar;

  const image = ui.h('img', 'rail-avatar-image');
  image.alt = '';
  image.src = `/api/avatar?v=${Date.now()}`;
  const fallback = ui.h('span', 'rail-avatar-fallback', 'B');
  const edit = ui.h('span', 'rail-avatar-edit');
  edit.appendChild(icon(doc, 'image'));
  button.append(image, fallback, edit);

  const showImage = (shown: boolean): void => {
    image.hidden = !shown;
    fallback.hidden = shown;
  };
  image.addEventListener('load', () => showImage(true), { signal });
  image.addEventListener('error', () => showImage(false), { signal });

  const picker = ui.h('input');
  picker.type = 'file';
  picker.accept = 'image/png,image/jpeg,image/webp,image/svg+xml';
  picker.className = 'visually-hidden';
  picker.setAttribute('aria-hidden', 'true');
  button.addEventListener('click', () => picker.click(), { signal });
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (file) openEditor(file);
  }, { signal });
  el.append(button, picker);

  function openEditor(file: File): void {
    const source = new Image();
    const sourceUrl = URL.createObjectURL(file);
    source.onload = () => {
      URL.revokeObjectURL(sourceUrl);
      mountEditor(source);
    };
    source.onerror = () => {
      URL.revokeObjectURL(sourceUrl);
      ui.toast(S.unreadable, 'bad');
    };
    source.src = sourceUrl;
  }

  function mountEditor(source: HTMLImageElement): void {
    const body = ui.h('div', 'avatar-editor');
    const canvas = ui.h('canvas', 'avatar-canvas');
    canvas.width = EDITOR_SIZE * 2;
    canvas.height = EDITOR_SIZE * 2;
    canvas.setAttribute('aria-label', S.cropPreview);
    const zoom = ui.h('input', 'avatar-zoom');
    zoom.type = 'range';
    zoom.min = '1';
    zoom.max = '3';
    zoom.step = '0.01';
    zoom.value = '1';
    zoom.setAttribute('aria-label', S.zoomAria);
    const controls = ui.h('label', 'avatar-zoom-row');
    controls.append(ui.h('span', null, S.zoom), zoom);
    const note = ui.h('p', 'avatar-note', S.note);
    const actions = ui.actions();
    const cancel = ui.button(S.cancel);
    const save = ui.button(S.save, { variant: 'primary' });
    actions.append(ui.h('span', 'grow'), cancel, save);
    body.append(canvas, controls, note, actions);
    const drawer = ui.drawer(S.cropTitle, body);

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      drawer.dispose();
      ui.toast(S.noCanvas, 'bad');
      return;
    }
    const cover = Math.max(EDITOR_SIZE / source.naturalWidth, EDITOR_SIZE / source.naturalHeight);
    let factor = 1;
    let offsetX = 0;
    let offsetY = 0;
    let drag: { x: number; y: number; ox: number; oy: number } | null = null;

    const clampOffsets = (): void => {
      const width = source.naturalWidth * cover * factor;
      const height = source.naturalHeight * cover * factor;
      const maxX = Math.max(0, (width - EDITOR_SIZE) / 2);
      const maxY = Math.max(0, (height - EDITOR_SIZE) / 2);
      offsetX = Math.max(-maxX, Math.min(maxX, offsetX));
      offsetY = Math.max(-maxY, Math.min(maxY, offsetY));
    };
    const draw = (): void => {
      clampOffsets();
      const scale = cover * factor;
      const width = source.naturalWidth * scale;
      const height = source.naturalHeight * scale;
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      ctx.clearRect(0, 0, EDITOR_SIZE, EDITOR_SIZE);
      ctx.drawImage(
        source,
        (EDITOR_SIZE - width) / 2 + offsetX,
        (EDITOR_SIZE - height) / 2 + offsetY,
        width,
        height,
      );
    };

    zoom.addEventListener('input', () => {
      factor = Number(zoom.value);
      draw();
    }, { signal });
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const pointX = event.clientX - rect.left - rect.width / 2;
      const pointY = event.clientY - rect.top - rect.height / 2;
      const next = Math.max(1, Math.min(3, factor * Math.exp(-event.deltaY * 0.0015)));
      const ratio = next / factor;
      offsetX = pointX - (pointX - offsetX) * ratio;
      offsetY = pointY - (pointY - offsetY) * ratio;
      factor = next;
      zoom.value = factor.toFixed(2);
      draw();
    }, { passive: false, signal });
    canvas.addEventListener('pointerdown', (event) => {
      drag = { x: event.clientX, y: event.clientY, ox: offsetX, oy: offsetY };
      canvas.setPointerCapture(event.pointerId);
    }, { signal });
    canvas.addEventListener('pointermove', (event) => {
      if (!drag) return;
      offsetX = drag.ox + event.clientX - drag.x;
      offsetY = drag.oy + event.clientY - drag.y;
      draw();
    }, { signal });
    const endDrag = (): void => { drag = null; };
    canvas.addEventListener('pointerup', endDrag, { signal });
    canvas.addEventListener('pointercancel', endDrag, { signal });
    cancel.addEventListener('click', () => drawer.dispose(), { signal });
    save.addEventListener('click', () => {
      const output = doc.createElement('canvas');
      output.width = OUTPUT_SIZE;
      output.height = OUTPUT_SIZE;
      const out = output.getContext('2d');
      if (!out) return;
      const ratio = OUTPUT_SIZE / EDITOR_SIZE;
      const scale = cover * factor * ratio;
      const width = source.naturalWidth * scale;
      const height = source.naturalHeight * scale;
      out.drawImage(
        source,
        (OUTPUT_SIZE - width) / 2 + offsetX * ratio,
        (OUTPUT_SIZE - height) / 2 + offsetY * ratio,
        width,
        height,
      );
      output.toBlob((blob) => {
        if (!blob) return;
        const lock = ui.disable(save);
        void postBlob<{ ok: boolean }>('/api/avatar', blob, { signal }).then(
          () => {
            image.src = `/api/avatar?v=${Date.now()}`;
            showImage(true);
            drawer.dispose();
            ui.toast(S.saved);
          },
          (err) => {
            if ((err as { name?: string } | null)?.name === 'AbortError') return;
            opts.onError(err);
            ui.toast(err instanceof Error ? err.message : String(err), 'bad');
          },
        ).finally(() => lock.dispose());
      }, 'image/png');
    }, { signal });
    draw();
  }

  return {
    el,
    setLabel(label): void {
      fallback.textContent = label.trim().slice(0, 1).toUpperCase() || 'B';
    },
  };
}
