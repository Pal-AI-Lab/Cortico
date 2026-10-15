/** World 面板示例；浏览器扩展通过 client-panel.ts 使用共享接口。 */

import type {
  WebUiClientBundle,
  WebUiPanelContext,
} from '../../../web/shared/client-panel.ts';

const bundle: WebUiClientBundle = {
  panels: {
    // 局部面板 id 须与服务端 webUi().panels 对应。
    hello: {
      mount(ctx: WebUiPanelContext) {
        const { ui } = ctx;
        const card = ui.sheet({ title: '握手', en: 'hello' });
        const bar = ui.rowbar();
        const msg = ui.msgline('还没握过手。');

        bar.appendChild(ui.button('ping', {
          variant: 'primary',
          size: 'sm',
          onClick: () => {
            void ctx.invoke<{ pings: number; at: string }>('ping')
              .then((r) => {
                msg.textContent = `第 ${r.pings} 次握手,服务端时间 ${ui.fmt.clock(r.at)}`;
                // 刷新服务端声明的徽标。
                void ctx.refresh();
              })
              .catch((err: unknown) => {
                msg.textContent = String(err);
                msg.classList.add('bad');
              });
          },
        }));
        bar.appendChild(ui.h('span', 'grow'));
        card.body.append(bar, msg);

        // 用定时器验证面板卸载时的资源释放。
        let ticks = 0;
        const beat = ui.msgline('');
        ctx.interval(() => {
          ticks++;
          beat.textContent = `面板已打开 ${ticks} 秒`;
        }, 1000);
        card.body.appendChild(beat);

        ctx.root.appendChild(card.el);
      },
    },

    echo: {
      mount(ctx: WebUiPanelContext) {
        const { ui } = ctx;
        const card = ui.sheet({ title: '回声', en: 'echo' });
        const field = ui.input({ placeholder: '输入文本' });
        const out = ui.msgline('');
        const bar = ui.rowbar();
        bar.append(field, ui.button('发送', {
          size: 'sm',
          onClick: () => {
            void ctx.invoke<{ echoed: unknown[] }>('echo', [field.value])
              .then((r) => { out.textContent = JSON.stringify(r.echoed); })
              .catch((err: unknown) => { out.textContent = String(err); });
          },
        }));
        card.body.append(bar, out);
        ctx.root.appendChild(card.el);
      },
    },
  },
};

export default bundle;
