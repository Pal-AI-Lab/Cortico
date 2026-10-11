/**
 * 面板 `skin` —— 皮肤:她和玩家各穿哪一张。
 *
 * 离线服务器的玩家档案里没有材质这一格,所以这一屏做的事全在客户端一侧:选中的
 * PNG 按账号名铺进两份游戏目录,由 CustomSkinLoader 在渲染时读。两份客户端各渲染
 * 各的,所以两个账号的皮肤在两份目录里都要有——这也是"她的皮肤"与"玩家的皮肤"
 * 在这里是同一屏里的两块,而不是分在两个面板的原因。
 *
 * 一个角色一颗按钮,点开就是文件选择器:图从哪儿来是人当场挑的,World 这边不设需要
 * 人自己往里放文件的目录。
 *
 * 预览是把皮肤图上脸那 8x8 块(与帽子层)放大画进 canvas:选皮肤时要认的是哪张脸,
 * 不是那张摊平的材质图。整张材质点开抽屉看。
 */

import type {
  ConsolePanelContext,
  ConsolePanel,
} from '../../../web/shared/client-panel.ts';
import { toDisposable } from '../../../web/shared/client-panel.ts';
import {
  errText,
  msgLine,
  type MinecraftSkinRole,
  type MinecraftSkinState,
} from './client.ts';
import { text } from './strings.ts';

const FACE_PX = 72;

export const skinPanel: ConsolePanel = {
  mount(ctx: ConsolePanelContext) {
    const { ui, root } = ctx;
    const T = text(ctx.language);
    const K = T.skin;

    const card = ui.sheet({ title: K.title, en: 'skins', desc: K.desc });
    const s = card.body;
    root.appendChild(card.el);

    const msg = msgLine(ctx);
    s.appendChild(msg.el);

    const roleBox = ui.h('div', 'mc-skins');
    s.append(
      ui.section(K.whoWears, K.whoWearsNote),
      roleBox,
    );

    const premise = ui.h('div');
    s.append(ui.section(K.premise, K.premiseNote), premise);

    /** 一个角色一个隐藏的 file input:点的是卡里那颗钮 */
    const pickers = new Map<MinecraftSkinRole['role'], HTMLInputElement>();
    for (const role of ['bot', 'player'] as const) {
      const input = ui.h('input', 'mc-hidden');
      input.type = 'file';
      input.accept = 'image/png';
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        void act(async () => {
          const base64 = await toBase64(file);
          return ctx.invoke<MinecraftSkinState>('set', [role, base64]);
        }, K.reading(file.name));
      }, { signal: ctx.signal });
      pickers.set(role, input);
      s.appendChild(input);
    }

    // -----------------------------------------------------------------------
    // 材质:每换一张重取一次,面板活着期间同一张只取一次
    // -----------------------------------------------------------------------

    const urls = new Map<string, Promise<string>>();

    /** key 带上选中时刻:换了图就是另一个 key,不会拿旧的 ObjectURL 画新皮肤 */
    function skinUrl(role: MinecraftSkinRole['role'], key: string): Promise<string> {
      let pending = urls.get(key);
      if (!pending) {
        pending = ctx.invokeBinary('file', [role]).then((blob) => {
          const url = URL.createObjectURL(blob);
          ctx.own(toDisposable(() => URL.revokeObjectURL(url)));
          return url;
        });
        urls.set(key, pending);
      }
      return pending;
    }

    /** 脸那 8x8 块放大,帽子层叠上去;点一下进抽屉看整张材质 */
    function face(role: MinecraftSkinRole['role'], key: string): HTMLCanvasElement {
      const cv = ui.h('canvas', 'mc-face');
      cv.width = FACE_PX;
      cv.height = FACE_PX;
      void skinUrl(role, key).then((url) => {
        if (ctx.signal.aborted) return;
        const img = ui.h('img');
        img.addEventListener('load', () => {
          const cx = cv.getContext('2d');
          if (!cx) return;
          cx.imageSmoothingEnabled = false;
          cx.drawImage(img, 8, 8, 8, 8, 0, 0, FACE_PX, FACE_PX);
          cx.drawImage(img, 40, 8, 8, 8, 0, 0, FACE_PX, FACE_PX);
        }, { signal: ctx.signal });
        img.src = url;
        cv.addEventListener('click', () => {
          const big = ui.h('img', 'mc-shot-big');
          big.src = url;
          big.alt = K.skinOf(K.roles[role].label);
          ui.drawer(K.skinOf(K.roles[role].label), big);
        }, { signal: ctx.signal });
      }, () => { /* 取不到就留一块空 canvas */ });
      return cv;
    }

    // -----------------------------------------------------------------------

    let cur: MinecraftSkinState | null = null;

    function roleCard(role: MinecraftSkinRole, st: MinecraftSkinState): HTMLDivElement {
      const who = K.roles[role.role];
      const el = ui.h('div', 'mc-skin');
      if (role.skin) el.classList.add('cur');

      const head = ui.h('div', 'mc-skinhead');
      head.appendChild(role.skin
        ? face(role.role, `${role.role}:${role.skin.at}`)
        : ui.h('div', 'mc-face mc-facenone'));

      const meta = ui.h('div');
      const title = ui.h('div', 'mc-worldname', who.label);
      title.title = who.note;
      meta.appendChild(title);
      meta.appendChild(ui.h('div', 'mc-worldmeta', role.username || K.noUsername));
      if (role.skin) {
        const shared = st.dirs.camera === st.dirs.player;
        const laid = role.installed.camera && (shared || role.installed.player);
        const line = ui.h('div', 'mc-worldmeta');
        line.append(
          ui.h('span', null, `${role.skin.width}×${role.skin.height} · ${ui.fmt.bytes(role.skin.bytes)}`),
          ui.h('span', null, K.chosenAt(ui.fmt.clock(role.skin.at))),
          laid ? ui.pill(K.installed, 'on') : ui.pill(K.notInstalled, 'off'),
        );
        meta.appendChild(line);
      } else {
        meta.appendChild(ui.h('div', 'mc-worldmeta', K.noneChosen));
      }
      head.appendChild(meta);
      el.appendChild(head);

      const acts = ui.actions();
      const btnPick = ui.button(role.skin ? K.change : K.choose, {
        size: 'sm',
        variant: role.skin ? 'plain' : 'primary',
      });
      btnPick.addEventListener(
        'click',
        () => pickers.get(role.role)?.click(),
        { signal: ctx.signal },
      );
      acts.append(btnPick, ui.h('span', 'grow'));
      if (role.skin) {
        const btnClear = ui.button(K.remove, { size: 'sm', variant: 'danger' });
        btnClear.addEventListener('click', () => {
          void (async () => {
            const ok = await ui.confirm({
              title: K.removeTitle(who.label),
              body: K.removeBody,
              danger: true,
            });
            if (!ok) return;
            await act(() => ctx.invoke<MinecraftSkinState>('clear', [role.role]), K.removing);
          })();
        }, { signal: ctx.signal });
        acts.appendChild(btnClear);
      }
      el.appendChild(acts);
      return el;
    }

    function renderPremise(st: MinecraftSkinState): void {
      const shared = st.dirs.camera === st.dirs.player;
      const modPill = (ok: boolean): HTMLSpanElement =>
        ok ? ui.pill(K.modInstalled, 'on') : ui.pill(K.modMissing, 'off');
      const rows = [
        { k: shared ? K.clientDir : K.cameraDir, v: ui.h('span', null, st.dirs.camera) },
        { k: 'CustomSkinLoader', v: modPill(st.mod.camera) },
      ];
      if (!shared) {
        rows.push(
          { k: K.playerDir, v: ui.h('span', null, st.dirs.player) },
          { k: K.playerMod, v: modPill(st.mod.player) },
        );
      }
      premise.replaceChildren(ui.kv(rows));
      if (!st.mod.camera || (!shared && !st.mod.player)) {
        premise.appendChild(ui.h(
          'div',
          'pagedesc',
          K.modNote,
        ));
      }
    }

    function render(st: MinecraftSkinState | null): void {
      if (ctx.signal.aborted) return;
      cur = st;
      if (!st) {
        msg.say(K.unavailable, true);
        roleBox.replaceChildren(ui.placeholder(K.unreadable));
        premise.replaceChildren();
        return;
      }
      roleBox.replaceChildren(...st.roles.map((role) => roleCard(role, st)));
      renderPremise(st);
      msg.say(st.detail ?? '');
    }

    const refresh = (): Promise<void> =>
      ctx.invoke<MinecraftSkinState>('state').then(render, () => render(null));

    /** 一次动作:调服务端 → 拿回来的新状态重画。失败时重画旧状态,错误话留在最后一行 */
    async function act(fn: () => Promise<MinecraftSkinState>, working: string): Promise<void> {
      msg.say(working);
      try {
        render(await fn());
      } catch (err) {
        if (ctx.signal.aborted) return;
        if (cur) render(cur);
        msg.say(T.opFailed(errText(err)), true);
      }
    }

    /** 原样上传:皮肤材质一个像素都不能重编码,浏览器这一侧只做搬运 */
    function toBase64(file: File): Promise<string> {
      return file.arrayBuffer().then((buf) => {
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (const b of bytes) bin += String.fromCharCode(b);
        return btoa(bin);
      });
    }

    void refresh();
  },
};
