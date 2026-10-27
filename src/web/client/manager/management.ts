import { t, locale } from './i18n.ts';
import { esc } from './role-ui.ts';
import type { Role } from '../../shared/manager.ts';
import type { Schedule, Operation, DeletedRole } from '../../shared/manager.ts';
export const actionLabels: Record<string, string> = { start: t("启动后台"), run: t("启动并运行"), pause: t("暂停"), resume: t("继续"), stop: t("关机"), restart: t("重启"), delete: t("删除"), restore: t("恢复"), purge: t("永久删除") };
const date = (s: string) => new Date(s).toLocaleString(locale, { hour12: false });
interface Context {
    api: <T = any>(path: string, body?: unknown) => Promise<T>;
    roles: () => Role[];
    main: () => HTMLElement;
    header: (title: string, desc: string, action?: string) => string;
    toast: (text: string) => void;
    confirm: (title: string, desc: string) => Promise<boolean>;
    refresh: () => Promise<void>;
}
export function management(c: Context) {
    function listen(root: ParentNode, selector: string, fn: (b: HTMLButtonElement) => Promise<void>) { root.querySelectorAll<HTMLButtonElement>(selector).forEach(b => b.onclick = async () => { b.disabled = true; try {
        await fn(b);
    }
    catch (e) {
        c.toast((e as Error).message);
    }
    finally {
        if (b.isConnected)
            b.disabled = false;
    } }); }
    async function trash() {
        const entries = await c.api<DeletedRole[]>('/api/trash');
        c.main().innerHTML = c.header(t("已删除角色"), t("这里保留完整角色数据。恢复后保持停止；永久删除会释放空间，无法恢复。"), entries.length ? `<button class="btn danger-text" id="empty-trash">${t("清空已删除角色")}</button>` : '') + `<section class="manager-sheet record-list">${entries.length ? entries.map(e => `<article class="record-row"><div><h3>${esc(e.name)}</h3><p class="muted">${esc(e.id)} · ${date(e.at)}</p></div><div class="row-controls"><button class="btn" data-restore="${e.key}">${t("恢复角色")}</button><button class="btn danger-text" data-purge="${e.key}">${t("永久删除")}</button></div></article>`).join('') : `<p class="empty">${t("没有已删除角色。")}</p>`}</section>`;
        const purge = async (selected: DeletedRole[]) => {
            if (!await c.confirm(selected.length === 1 ? t("永久删除{0}？", selected[0].name) : t("清空 {0} 个已删除角色？", selected.length), t("将删除所选角色的全部本地数据及关联的停用计划，无法恢复。操作记录仍会保留。"))) return;
            await c.api('/api/trash/purge', { keys: selected.map(e => e.key) });
            await trash(); c.toast(t("已永久删除"));
        };
        listen(c.main(), '[data-purge]', b => purge(entries.filter(e => e.key === b.dataset.purge)));
        listen(c.main(), '#empty-trash', () => purge(entries));
        listen(c.main(), '[data-restore]', async (b) => { await c.api(`/api/trash/${b.dataset.restore}/restore`, {}); await c.refresh(); await trash(); c.toast(t("已恢复，角色保持停止")); });
    }
    async function scheduleForm(roleId?: string, existing?: Schedule) {
        const d = document.createElement('dialog');
        d.className = 'dialog modalcard';
        const value = new Date(existing?.next || Date.now() + 3600000);
        value.setMinutes(value.getMinutes() - value.getTimezoneOffset());
        d.innerHTML = `<form class="dialog-form"><h2>${existing ? t("编辑定时任务") : t("添加定时任务")}</h2><label>${t("角色")}<select class="field" name="role">${c.roles().map(r => `<option value="${esc(r.id)}" ${r.id === (existing?.role || roleId) ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label><div class="field-grid"><label>${t("操作")}<select class="field" name="action">${['run', 'pause', 'stop'].map(a => `<option value="${a}" ${existing?.action === a ? 'selected' : ''}>${actionLabels[a]}</option>`).join('')}</select></label><label>${t("频率")}<select class="field" name="repeat"><option value="once">${t("仅一次")}</option><option value="daily" ${existing?.repeat === 'daily' ? 'selected' : ''}>${t("每天")}</option></select></label></div><label>${t("执行时间")}<input class="field" type="datetime-local" name="next" value="${value.toISOString().slice(0, 16)}" required></label><p class="muted small">${t("使用本机时间。每天运行可分别设置一条运行任务和一条关机任务。管理服务关闭期间错过的任务，恢复后执行一次，不连续补跑。")}</p><p class="error" role="alert"></p><div class="dialog-actions"><button type="button" class="btn">${t("取消")}</button><button class="btn primary" type="submit">${t("保存任务")}</button></div></form>`;
        document.body.append(d);
        d.showModal();
        d.addEventListener('close', () => d.remove());
        d.querySelector('[type=button]')!.addEventListener('click', () => d.close());
        d.querySelector('form')!.onsubmit = async (e) => { e.preventDefault(); const b = d.querySelector<HTMLButtonElement>('[type=submit]')!; b.disabled = true; try {
            const data = Object.fromEntries(new FormData(e.currentTarget as HTMLFormElement));
            await c.api('/api/schedules', { ...data, id: existing?.id, next: new Date(String(data.next)).toISOString() });
            d.close();
            location.hash = 'schedules';
            await schedules();
        }
        catch (e) {
            d.querySelector('.error')!.textContent = (e as Error).message;
        }
        finally {
            b.disabled = false;
        } };
    }
    async function schedules() {
        const items = await c.api<Schedule[]>('/api/schedules');
        c.main().innerHTML = c.header(t("定时运行"), t("独立于角色记忆，在指定时间运行、暂停或关机。"), `<button class="btn primary" id="add-schedule">${t("添加任务")}</button>`) + `<section class="manager-sheet record-list">${items.length ? items.map(s => { const role = c.roles().find(r => r.id === s.role); return `<article class="record-row"><div><h3>${esc(role?.name || s.role)} · ${actionLabels[s.action]}</h3><p>${s.repeat === 'daily' ? t("每天") : t("仅一次")} · ${date(s.next)} <span class="tag ${s.enabled ? '' : 'muted'}">${s.enabled ? t("已启用") : t("已停用")}</span></p>${s.lastResult ? `<p class="muted">${t("上次结果：")}${esc(t(s.lastResult))}</p>` : ''}${!role ? `<p class="error">${t("角色已删除，恢复角色后可重新启用。")}</p>` : ''}</div><div class="row-controls"><button class="btn" data-edit="${s.id}">${t("编辑")}</button><button class="btn" data-toggle="${s.id}">${s.enabled ? t("停用") : t("启用")}</button><button class="btn danger-text" data-remove="${s.id}">${t("移除")}</button></div></article>`; }).join('') : `<p class="empty">${t("还没有定时任务。")}</p>`}</section>`;
        c.main().querySelector('#add-schedule')!.addEventListener('click', () => void scheduleForm());
        listen(c.main(), '[data-edit]', async (b) => scheduleForm(undefined, items.find(s => s.id === b.dataset.edit)));
        listen(c.main(), '[data-toggle]', async (b) => { const s = items.find(s => s.id === b.dataset.toggle)!; await c.api(`/api/schedules/${s.id}/${s.enabled ? 'disable' : 'enable'}`, {}); await schedules(); });
        listen(c.main(), '[data-remove]', async (b) => { if (!await c.confirm(t("移除定时任务？"), t("只移除这条计划，不改变角色当前状态。")))
            return; await c.api(`/api/schedules/${b.dataset.remove}/remove`, {}); await schedules(); });
    }
    function tools(root: ParentNode) {
        listen(root, '[data-delete]', async (b) => { const r = c.roles().find(r => r.id === b.dataset.delete)!; if (!await c.confirm(t("删除{0}？", r.name), t("会先正常关机，再移入“已删除角色”，保留数据供恢复。关联定时任务会停用。")))
            return; await c.api(`/api/roles/${r.id}/delete`, {}); await c.refresh(); c.toast(t("已移入已删除角色，可随时恢复")); });
        listen(root, '[data-schedule]', async (b) => scheduleForm(b.dataset.schedule));
    }
    function records(items: Operation[]) { return items.map(r => `<article class="record-row"><div><h3>${esc(r.name)} · ${actionLabels[r.action] || esc(r.action)}</h3><p class="muted">${date(r.at)} · ${r.schedule ? t("定时执行") : t("手动操作")} · ${r.status === 'done' ? t("已完成") : r.status === 'working' ? t("进行中") : t("失败")}</p>${r.message ? `<p class="error">${esc(t(r.message))}</p>` : ''}</div>${r.status === 'failed' && ['start', 'run', 'pause', 'resume', 'stop', 'restart'].includes(r.action) && c.roles().some(x => x.id === r.role) ? `<button class="btn" data-retry-role="${esc(r.role)}" data-retry-action="${r.action}">${t("重试操作")}</button>` : ''}</article>`).join(''); }
    function wireRecords(root: ParentNode, reload: () => Promise<void>) { listen(root, '[data-retry-role]', async (b) => { if (!await c.confirm(t("重试这项操作？"), t("将对当前角色执行“{0}”。", actionLabels[b.dataset.retryAction!])))
        return; await c.api(`/api/roles/${b.dataset.retryRole}/${b.dataset.retryAction}`, {}); await c.refresh(); await reload(); }); }
    return { trash, schedules, scheduleForm, tools, records, wireRecords };
}
