import { t } from './i18n.ts';
/** Shared presentation for the manager and the original Cortico WebUI. */
import { icon, managementMark } from './icons.ts';
import type { Role } from '../../shared/manager.ts';
export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const states: Record<string, string> = { running: t("运行中"), paused: t("已暂停"), stopped: t("已停止"), starting: t("启动中"), stopping: t("停止中"), error: t("异常") };
export const alive = (r: Role) => r.state === 'running' || r.state === 'paused';
export function avatar(r: Role, src: string) { return `<span class="rail-avatar-wrap"><span class="rail-avatar">${r.avatar ? `<img class="rail-avatar-image" src="${esc(src)}" alt="">` : `<span class="rail-avatar-fallback">${esc(r.name.slice(0, 1))}</span>`}</span></span>`; }
export function status(r: Role) { return `<small class="rail-runstate ${r.state}">${states[r.state]}</small>`; }
export function button(action: string, label: string, mark: string, id: string, disabled = false) { return `<button class="rail-action" data-action="${action}" data-id="${esc(id)}" aria-label="${label}" title="${label}" ${disabled ? 'disabled' : ''}>${icon(mark)}</button>`; }
export function actions(r: Role) { return `<div class="rail-actions">${button(alive(r) ? r.state === 'running' ? 'pause' : 'resume' : 'start', alive(r) ? r.state === 'running' ? t("暂停") : t("继续") : t("启动"), r.state === 'running' ? 'pause' : 'play', r.id, ['starting', 'stopping'].includes(r.state))}${button('settings', t("设置"), 'settings', r.id, !alive(r))}${button('stop', t("关机"), 'power', r.id, !alive(r))}</div>`; }
export function managerIdentity() { return `<span class="rail-avatar-wrap"><span class="rail-avatar manager-avatar">${managementMark()}</span></span><span class="rail-ident"><strong>${t("管理中心")}</strong><small class="rail-runstate running">${t("常驻服务")}</small></span>`; }
export function createLink(url: string) { return `<a class="menu-create" href="${url}" title="${t("新建角色")}">${icon('plus')}<span>${t("新建角色")}</span></a>`; }
export function switcher(roles: Role[], current: string | undefined, manager: string, src: (r: Role) => string) { return `<div class="menu-roles">${current ? `<div class="role-row manager-row"><a class="role-main" href="${manager}">${managerIdentity()}</a>${createLink(manager + '#new')}</div>` : ''}${roles.filter(r => r.id !== current).map(r => `<div class="role-row"><button class="role-main" title="${esc(r.name)} · ${states[r.state]}" data-action="open" data-id="${esc(r.id)}">${avatar(r, src(r))}<span class="rail-ident"><strong>${esc(r.name)}</strong>${status(r)}</span></button>${actions(r)}</div>`).join('')}</div>`; }
let noticeTimer: ReturnType<typeof setTimeout>;
export function notice(text: string) {
    clearTimeout(noticeTimer);
    document.querySelector('#manager-notice')?.remove();
    const el = document.createElement('div');
    el.id = 'manager-notice';
    el.setAttribute('role', 'status');
    el.textContent = t(text);
    document.body.append(el);
    requestAnimationFrame(() => el.classList.add('show'));
    noticeTimer = setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 150); }, 4000);
}

/** Mobile entry shares the same menu as the desktop footer. */
export function compactIdentity(name: string, image?: string, manager = false) {
    return `<span class="switcher-compact" aria-hidden="true">${manager ? managementMark() : image ? `<img src="${esc(image)}" alt="">` : esc(name.slice(0, 1))}</span>`;
}
