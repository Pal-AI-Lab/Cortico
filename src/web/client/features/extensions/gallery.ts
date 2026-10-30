/**
 * 扩展信息页的图片区:简介后面一排图片,放不下时两侧有按钮左右翻;点一张在灯箱里看大图,
 * 灯箱里也能左右翻(方向键亦可),Esc、关闭按钮或点空白处关上。
 * 图片来自市场条目的 screenshots,以及简介里的 Markdown 图片(只认 https)。
 */
import { icon, type WebUiIconName } from '../../ui/icons.ts';
import { prefersStill } from '../../core/motion.ts';
import { S } from './strings.ts';

export interface GalleryImage { src: string; alt: string }

const MARKDOWN_IMAGE = /!\[([^\]]*)\]\((https:\/\/[^)\s]+)\)/g;

/** Takes the `![说明](https://…)` pictures out of a description: they go to the gallery, the text keeps the rest. */
export function takeImages(text: string): { text: string; images: GalleryImage[] } {
  const images: GalleryImage[] = [];
  const rest = text.replace(MARKDOWN_IMAGE, (_, alt: string, src: string) => { images.push({ src, alt }); return ''; });
  return { text: images.length ? rest.replace(/\n{3,}/g, '\n\n').trim() : text, images };
}

function roundButton(doc: Document, cls: string, name: WebUiIconName, label: string, onClick: () => void, signal: AbortSignal): HTMLButtonElement {
  const button = doc.createElement('button');
  button.type = 'button'; button.className = cls;
  button.setAttribute('aria-label', label);
  button.append(icon(doc, name));
  button.addEventListener('click', onClick, { signal });
  return button;
}

function picture(doc: Document, image: GalleryImage): HTMLImageElement {
  const img = doc.createElement('img');
  img.alt = image.alt; img.decoding = 'async'; img.referrerPolicy = 'no-referrer'; img.src = image.src;
  return img;
}

/**
 * The 图片 section: its heading and the row of pictures, following the page's signal. A picture that
 * fails to load leaves the row (and the lightbox); when none is left the section goes too.
 */
export function gallery(doc: Document, images: readonly GalleryImage[], signal: AbortSignal): HTMLElement {
  const win = doc.defaultView;
  const section = doc.createElement('div');
  section.className = 'extension-gallery-section';
  const heading = doc.createElement('h4');
  heading.textContent = S.gallery;
  const el = doc.createElement('div');
  el.className = 'extension-gallery';
  const track = doc.createElement('div');
  track.className = 'extension-gallery-track';
  /** The pictures still in the row, in order. */
  const shown = () => [...track.children].map(shot => images[Number((shot as HTMLElement).dataset.index)]);
  images.forEach((image, index) => {
    const shot = doc.createElement('button');
    shot.type = 'button'; shot.className = 'extension-gallery-shot'; shot.dataset.index = String(index);
    shot.setAttribute('aria-label', image.alt || S.galleryOpen(index + 1, images.length));
    const img = picture(doc, image); img.loading = 'lazy';
    img.addEventListener('error', () => { shot.remove(); if (!track.childElementCount) section.remove(); else update(); }, { signal });
    shot.append(img);
    shot.addEventListener('click', () => { const live = shown(); openLightbox(doc, live, live.indexOf(image), signal); }, { signal });
    track.append(shot);
  });
  const page = (direction: -1 | 1) => () => track.scrollBy({ left: direction * track.clientWidth * 0.8, behavior: prefersStill(win) ? 'auto' : 'smooth' });
  const prev = roundButton(doc, 'extension-gallery-nav is-prev', 'chevron-left', S.galleryPrev, page(-1), signal);
  const next = roundButton(doc, 'extension-gallery-nav is-next', 'chevron-right', S.galleryNext, page(1), signal);
  // The buttons show only while there is more to one side.
  const update = () => {
    const max = track.scrollWidth - track.clientWidth;
    prev.disabled = track.scrollLeft <= 1;
    next.disabled = track.scrollLeft >= max - 1;
  };
  track.addEventListener('scroll', update, { passive: true, signal });
  for (const img of track.querySelectorAll('img')) img.addEventListener('load', update, { signal });
  if (typeof win?.ResizeObserver === 'function') {
    const observer = new win.ResizeObserver(update);
    observer.observe(track);
    signal.addEventListener('abort', () => observer.disconnect(), { once: true });
  }
  update();
  el.append(track, prev, next);
  section.append(heading, el);
  return section;
}

function openLightbox(doc: Document, images: readonly GalleryImage[], start: number, signal: AbortSignal): void {
  const dialog = doc.createElement('dialog');
  dialog.className = 'extension-lightbox';
  dialog.setAttribute('aria-label', S.gallery);
  const figure = doc.createElement('figure');
  figure.className = 'extension-lightbox-figure';
  const img = picture(doc, images[start]);
  const count = doc.createElement('figcaption');
  count.className = 'extension-lightbox-count';
  figure.append(img, count);
  let index = start;
  const show = (to: number) => {
    index = (to + images.length) % images.length;
    img.src = images[index].src; img.alt = images[index].alt;
    count.textContent = images.length > 1 ? `${index + 1} / ${images.length}` : '';
  };
  const close = roundButton(doc, 'extension-lightbox-button extension-lightbox-close', 'close', S.galleryClose, () => dialog.close(), signal);
  dialog.append(figure, close);
  if (images.length > 1) dialog.append(
    roundButton(doc, 'extension-lightbox-button extension-lightbox-nav is-prev', 'chevron-left', S.galleryPrev, () => show(index - 1), signal),
    roundButton(doc, 'extension-lightbox-button extension-lightbox-nav is-next', 'chevron-right', S.galleryNext, () => show(index + 1), signal),
  );
  dialog.addEventListener('keydown', (event) => {
    // Esc closes the lightbox only, not the extension window it opened over.
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dialog.close(); return; }
    if (images.length < 2 || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault(); event.stopPropagation();
    show(index + (event.key === 'ArrowLeft' ? -1 : 1));
  });
  // A click on the dark around the picture closes it.
  dialog.addEventListener('click', (event) => { if (event.target === dialog || event.target === figure) dialog.close(); });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  signal.addEventListener('abort', () => dialog.close(), { once: true });
  doc.body.append(dialog);
  show(start);
  dialog.showModal();
  close.focus();
}
