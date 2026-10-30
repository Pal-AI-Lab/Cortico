/** The variable boxes beside a template: their popup and their sizes, shared by 系统提示词 and a World's template. */
import type { WebUi } from '../../../shared/client-panel.ts';
import { S } from './strings.ts';
import type { PromptVar } from './view.ts';

/** What a variable box opens: the name, what it is, and what it fills in right now. */
export function variablePopup(ui: WebUi, v: PromptVar): HTMLElement {
  const pop = ui.h('div', 'varpop');
  pop.appendChild(ui.h('div', 'varpop-name mono', `{{${v.name}}}`));
  pop.appendChild(ui.h('div', 'varpop-desc', v.description));
  pop.appendChild(ui.h('div', 'varpop-label', v.multiline ? S.fillNowMultiline : S.fillNow));
  const val = ui.h('pre', 'mono varpop-value');
  val.textContent = v.value === undefined ? S.varUnreported : v.value === '' ? S.varEmpty : v.value;
  pop.appendChild(val);
  return pop;
}

/**
 * A name that fits a grid cell keeps one cell; one that fits a whole row on one line takes the row;
 * a longer one takes the row on up to two lines, wrapping after its dots, dashes and underscores,
 * and ends in an ellipsis past them. Measured with every box in a cell, whose width does not depend
 * on the boxes. The wrap points are `<wbr>`s, which Chromium honours even in `nowrap` text, so only
 * a two-line name has them.
 */
export function fitVariableChips(list: HTMLElement, chips: ReadonlyMap<string, HTMLButtonElement>): void {
  const doc = list.ownerDocument;
  const boxes = [...chips.entries()].map(([name, chip]) => ({ name, chip, text: chip.firstElementChild as HTMLElement }));
  for (const { name, chip, text } of boxes) { chip.dataset.size = 'cell'; text.textContent = name; }
  const sizes = boxes.map(({ chip, text }) => {
    const row = list.clientWidth - (chip.offsetWidth - text.clientWidth);
    return text.scrollWidth <= text.clientWidth ? 'cell' : text.scrollWidth <= row ? 'row' : 'lines';
  });
  boxes.forEach(({ name, chip, text }, i) => {
    chip.dataset.size = sizes[i];
    if (sizes[i] === 'lines') text.replaceChildren(...name.split(/(?<=[.\-_])/).flatMap((part, n) => n ? [doc.createElement('wbr'), part] : [part]));
  });
}
