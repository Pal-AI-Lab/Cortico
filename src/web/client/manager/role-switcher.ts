import { t } from './i18n.ts';
import { switcher, alive, notice, compactIdentity } from './role-ui.ts';
import type { Role } from '../../shared/manager.ts';
let roles: Role[] = [], open = false, info: {
    id: string;
    managerPort: number;
}, foot: HTMLElement, menu: HTMLElement;
const url = (port: number, hash = '') => `${location.protocol}//${location.hostname}:${port}/${hash}`;
async function api(path: string, body?: unknown) {
    const r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok)
        throw Error(r.status === 401 ? t("请先登录管理中心，再返回角色后台。") : await r.text());
    return r.json();
}
function accessLink() {
    if (!info) return;
    const section=[...document.querySelectorAll('.sheet')].find(el=>el.querySelector('h3 .en')?.textContent==='access');
    const logout=section?.querySelector('button');
    if (!logout || document.querySelector('#manager-password-link')) return;
    logout.textContent=t("退出所有后台");
    logout.setAttribute('title',t("退出这套管理中心及角色后台，所有设备的登录都会失效"));
    const description=section?.querySelector('.sh-desc');
    if(description) description.textContent=t("与管理中心共用登录，切换角色无需再次登录。");
    const link=document.createElement('a');
    link.id='manager-password-link'; link.className='btn';
    link.href=url(info.managerPort,'#settings'); link.textContent=t("修改访问密码");
    logout.after(link);
}
function syncCompact() {
    if (!foot) return;
    const name = foot.querySelector('.rail-name-text')?.textContent || t("角色");
    const original = foot.querySelector<HTMLImageElement>('.rail-avatar-image');
    const image = original && !original.hidden ? original.src : undefined;
    const toggle = foot.querySelector('#footer-toggle');
    const content = compactIdentity(name, image);
    if (toggle && toggle.innerHTML !== content) toggle.innerHTML = content;
}
function draw() {
    foot.classList.toggle('expanded', open);
    menu.hidden = !open;
    foot.querySelector('#footer-toggle')!.setAttribute('aria-expanded', String(open));
    if (!open)
        return;
    menu.innerHTML = switcher(roles, info.id, url(info.managerPort), r => `/api/manager/roles/${r.id}/avatar`);
}
async function refresh() { const next = await api('/api/manager/roles'); if (JSON.stringify(next) !== JSON.stringify(roles)) {
    roles = next;
    draw();
} }
async function operate(b: HTMLButtonElement) {
    const r = roles.find(r => r.id === b.dataset.id);
    if (!r)
        return;
    const action = b.dataset.action;
    if (action === 'open') {
        if (alive(r))
            location.href = url(r.port);
        else
            notice(t("角色已停止，点击右侧三角形启动"));
        return;
    }
    if (action === 'settings') {
        location.href = url(r.port, '#/settings');
        return;
    }
    if (action === 'stop' && !confirm(t("关闭{0}？", r.name)))
        return;
    b.disabled = true;
    try {
        await api(`/api/manager/roles/${r.id}/${action}`, {});
        await refresh();
    }
    catch (e) {
        notice((e as Error).message);
    }
    finally {
        if (b.isConnected)
            b.disabled = false;
    }
}
async function mount() {
    const found = document.querySelector<HTMLElement>('.railfoot');
    if (!found || found.dataset.managerAttached)
        return;
    found.dataset.managerAttached = 'loading';
    try {
        info = await api('/api/current');
    }
    catch {
        delete found.dataset.managerAttached;
        return;
    }
    foot = found;
    foot.id = 'footer';
    foot.dataset.managerAttached = 'true';
    foot.classList.add('managed-footer');
    const toggle = document.createElement('button');
    toggle.id = 'footer-toggle';
    toggle.className = 'footer-toggle';
    toggle.setAttribute('aria-label', t("切换管理中心与角色"));
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'role-menu');
    toggle.onclick = async () => { open = !open; draw(); if (open)
        try {
            await refresh();
        }
        catch (e) {
            notice((e as Error).message);
            menu.innerHTML = `<a class="manager-login" href="${url(info.managerPort)}">${t("打开管理中心登录")}</a>`;
        } };
    foot.prepend(toggle);
    syncCompact();
    accessLink();
    menu = document.createElement('div');
    menu.id = 'role-menu';
    menu.className = 'role-menu';
    menu.hidden = true;
    foot.before(menu);
    menu.addEventListener('click', e => { const b = (e.target as Element).closest<HTMLButtonElement>('[data-action]'); if (b)
        void operate(b); });
    foot.querySelector('.rail-shutdown')?.addEventListener('click', e => { e.stopImmediatePropagation(); if (confirm(t("关闭当前角色？管理中心将保持在线。")))
        location.href = url(info.managerPort, `#stop/${info.id}`); }, true);
    document.addEventListener('click', e => { if (open && !foot.contains(e.target as Node) && !menu.contains(e.target as Node)) {
        open = false;
        draw();
    } });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && open) {
        open = false;
        draw();
        toggle.focus();
    } });
    setInterval(() => { if (open && !document.hidden)
        void refresh().catch(() => { }); }, 2000);
}
export async function mountManagerSwitcher() {
    const response = await fetch('/api/management');
    if (!response.ok || !(await response.json())) return;
    for (const file of ['manager-shared.css', 'role-switcher.css']) {
        const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/manager/' + file;
        document.head.append(link);
    }
    new MutationObserver(() => { syncCompact(); accessLink(); void mount(); }).observe(document.body, {childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'hidden']});
    await mount();
}
