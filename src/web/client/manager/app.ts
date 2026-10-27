import { t, locale } from './i18n.ts';
import { management } from './management.ts';
import { esc, states, alive, avatar as sharedAvatar, actions, managerIdentity, switcher, notice, compactIdentity } from './role-ui.ts';
import { icon, wordmark } from './icons.ts';
import { copiesRuntime, type Role, type Job, type CopyOptions } from '../../shared/manager.ts';
import { BUILTIN_PALETTES } from '../../shared/theme.ts';
import { nativeSettings, initTheme } from './native-settings.ts';
for (const [key, value] of Object.entries(BUILTIN_PALETTES['crab-daisy'].light))
    document.documentElement.style.setProperty(`--${key}`, value);
document.title = `Cortico · ${t('管理中心')}`;
const app = document.querySelector<HTMLDivElement>('#app')!;
let current: any, roles: Role[] = [], menuOpen = false, poll: ReturnType<typeof setInterval> | undefined;
function manager(path = '') { return current?.kind === 'role' ? `/api/manager${path}` : `/api${path}`; }
function managerURL(hash = '') { return `${location.protocol}//${location.hostname}:${current.managerPort}/${hash}`; }
function roleURL(r: Role, hash = '') { return `${location.protocol}//${location.hostname}:${r.port}/${hash}`; }
async function api<T = any>(url: string, body?: unknown): Promise<T> {
    const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok)
        throw new Error(value.error || t("请求失败"));
    return value;
}
const toast = notice;
function bind(root: ParentNode, selector: string, event: string, fn: (e: Event) => void) { root.querySelectorAll(selector).forEach(el => el.addEventListener(event, fn)); }
function avatarSource(r: Role) { return manager('/roles/' + r.id + '/avatar'); }
function avatar(r: Role) { return sharedAvatar(r, avatarSource(r)); }
async function confirmBox(title: string, body: string): Promise<boolean> {
    const d = document.createElement('dialog');
    d.className = 'dialog modalcard';
    d.innerHTML = `<h2>${esc(title)}</h2><p>${esc(body)}</p><div class="dialog-actions"><button class="btn" value="cancel">${t("取消")}</button><button class="btn primary" value="yes">${t("确定")}</button></div>`;
    document.body.append(d);
    d.showModal();
    return new Promise(resolve => {
        let done = false;
        const end = (ok: boolean) => {
            if (done)
                return;
            done = true;
            d.close();
            d.remove();
            resolve(ok);
        };
        d.addEventListener('cancel', () => end(false));
        bind(d, 'button', 'click', e => end((e.currentTarget as HTMLButtonElement).value === 'yes'));
    });
}
async function perform(action: string, id: string) {
    const r = roles.find(r => r.id === id);
    if (!r)
        return;
    if (action === 'open') {
        if (alive(r))
            location.href = roleURL(r);
        else
            toast(t("角色已停止，点击右侧三角形启动"));
        return;
    }
    if (action === 'settings') {
        location.href = roleURL(r, '#/settings');
        return;
    }
    if (action === 'stop' && !await confirmBox(t("关闭{0}？", r.name), t("角色将正常保存并停止，之后可从管理入口重新启动。")))
        return;
    if (action === 'stop' && id === current.id) {
        location.href = managerURL(`#stop/${id}`);
        return;
    }
    try {
        await api(manager(`/roles/${id}/${action}`), {});
        await refreshRoles();
        toast(action === 'start' ? t("已启动，当前处于暂停状态") : action === 'stop' ? t("角色已关闭") : action === 'resume' ? t("已继续") : t("已暂停"));
    }
    catch (e) {
        toast((e as Error).message);
    }
}
function wireActions(root: ParentNode) {
    bind(root, '[data-action]', 'click', e => {
        const b = e.currentTarget as HTMLButtonElement;
        b.disabled = true;
        void perform(b.dataset.action!, b.dataset.id!).finally(() => {
            if (b.isConnected)
                b.disabled = false;
        });
    });
}
function menu() {
    const box = document.querySelector<HTMLElement>('#role-menu');
    if (!box)
        return;
    box.hidden = !menuOpen;
    document.querySelector('#footer')?.classList.toggle('expanded', menuOpen);
    const toggle = document.querySelector('#footer-toggle');
    toggle?.setAttribute('aria-expanded', String(menuOpen));
    if (!menuOpen)
        return;
    box.innerHTML = switcher(roles, current.id, managerURL(), avatarSource);
    wireActions(box);
}
function footer() {
    const f = document.querySelector('#footer');
    if (!f)
        return;
    f.innerHTML = `<button id="footer-toggle" class="footer-toggle" aria-expanded="${menuOpen}" aria-controls="role-menu" aria-label="${t("切换界面")}">${compactIdentity(t("管理中心"), undefined, true)}</button><div class="rail-who">${managerIdentity()}</div><a class="menu-create footer-create" href="${managerURL('#new')}" title="${t("新建角色")}">${icon('plus')}<span>${t("新建角色")}</span></a>`;
    f.querySelector('#footer-toggle')!.addEventListener('click', () => { menuOpen = !menuOpen; menu(); });
}
async function refreshRoles(force = false) {
    const next = await api<Role[]>(manager('/roles'));
    if (!force && JSON.stringify(next) === JSON.stringify(roles))
        return;
    roles = next;
    footer();
    const currentState = document.querySelector('#current-state');
    if (currentState) {
        const r = roles.find(r => r.id === current.id);
        if (r)
            currentState.textContent = states[r.state];
    }
    if (menuOpen)
        menu();
    const list = document.querySelector('#role-list');
    if (list) {
        list.innerHTML = roles.map(manageCard).join('');
        wireActions(list);
        managementUI.tools(list);
    }
    const count = document.querySelector('#running-count');
    if (count)
        count.textContent = String(roles.filter(alive).length);
    const total = document.querySelector('#total-count');
    if (total) total.textContent = String(roles.length);
}
function shell() {
    app.className = '';
    const nav = (href: string, label: string, mark: string) => `<a class="navitem" href="${href}" title="${label}"><span class="navicon">${icon(mark)}</span><span class="lbl">${label}</span></a>`;
    app.innerHTML = `<aside id="rail"><a class="brand" href="${managerURL()}">${wordmark()}</a><nav class="stack" aria-label="${t("管理导航")}"><div class="navgroup">${nav('#', t("角色管理"), 'home') + nav('#new', t("新建角色"), 'plus') + nav('#schedules', t("定时运行"), 'calendar') + nav('#jobs', t("任务记录"), 'copy') + nav('#trash', t("已删除角色"), 'trash') + nav('#settings', t("界面设置"), 'settings')}</div></nav><div id="role-menu" class="role-menu" hidden></div><footer id="footer" class="railfoot"></footer></aside><main id="main"></main>`;
    footer();
}
const main = () => document.querySelector<HTMLElement>('#main')!;
function header(title: string, desc: string, action = '') { return `<header class="page-head"><div><h1 class="pagetitle">${title}</h1><p class="pagedesc">${desc}</p></div>${action}</header>`; }
let disposeSettings: (()=>void)|undefined;
async function route() {
    disposeSettings?.(); disposeSettings=undefined;
    menuOpen = false;
    menu();
    const hash = location.hash.slice(1);
    document.querySelectorAll<HTMLAnchorElement>('#rail nav a').forEach(a => { const selected = a.getAttribute('href') === '#' + (hash.startsWith('job/') ? 'jobs' : hash.startsWith('new?') ? 'new' : hash); a.classList.toggle('active', selected); if (selected)
        a.setAttribute('aria-current', 'page');
    else
        a.removeAttribute('aria-current'); });
    try {
        if (hash === 'new' || hash.startsWith('new?'))
            await newPage();
        else if (hash === 'access' || hash === 'settings')
            accessPage();
        else if (hash === 'schedules')
            await managementUI.schedules();
        else if (hash === 'trash')
            await managementUI.trash();
        else if (hash.startsWith('job/'))
            await jobPage(hash.slice(4));
        else if (hash === 'jobs')
            await jobsPage();
        else if (hash.startsWith('stop/')) {
            const id = hash.slice(5);
            main().innerHTML = header(t("正在关机"), t("管理服务将保持在线。"));
            await api(`/api/roles/${id}/stop`, {});
            location.hash = '';
        }
        else
            overview();
    }
    catch (e) {
        main().innerHTML = header(t("操作未完成"), esc((e as Error).message)) + `<a class="btn" href="${managerURL()}">${t("返回管理入口")}</a>`;
    }
}
function manageCard(r: Role) { return `<article class="manage-card"><div class="card-top">${avatar(r)}<div class="card-identity"><h2>${esc(r.name)}</h2><small class="rail-runstate ${r.state}">${states[r.state]}</small></div>${actions(r)}</div><dl class="role-details"><div><dt>${t("模板")}</dt><dd>${esc(r.bot)}</dd></div><div><dt>${t("后台端口")}</dt><dd>${r.port || '—'}</dd></div></dl>${r.error ? `<p class="error">${esc(r.error)}</p>` : ''}<div class="card-tools"><button class="btn" data-action="open" data-id="${r.id}">${t("打开后台")}</button><a class="btn" href="#new?source=${r.id}">${t("复制角色")}</a><button class="btn" data-schedule="${r.id}">${t("定时运行")}</button><button class="btn danger-text" data-delete="${r.id}">${t("删除")}</button></div></article>`; }
function overview() { main().innerHTML = header(t("角色管理"), t("管理独立角色、复制设定、安排运行时间，或删除与恢复。"), `<a class="btn primary" href="#new">${icon('plus')}${t("新建角色")}</a>`) + `<div class="summary"><span><b id="running-count">${roles.filter(alive).length}</b>${t(" 个已启动")}</span><span><b id="total-count">${roles.length}</b>${t(" 个角色")}</span></div><section class="role-grid" id="role-list">${roles.map(manageCard).join('')}</section>`; wireActions(main()); managementUI.tools(main()); }
const managementUI = management({ api, roles: () => roles, main, header, toast, confirm: confirmBox, refresh: () => refreshRoles(true) });
const copyFields: [
    keyof CopyOptions,
    string,
    string
][] = [['memory', t("长期记忆与人格状态"), t("笔记、关系、意图、交接笔记和人格状态")], ['session', t("当前会话"), t("保留上下文，并携带关联事件与图片附件")], ['history', t("历史记录与用量"), t("运行记录、事件、工具调用和用量")], ['timers', t("待办与定时任务"), t("自动包含人格记忆；过期任务可能在启动时触发")], ['pending', t("待处理消息"), t("自动包含记忆、会话、历史及 World 本地状态")], ['worldState', t("World 本地状态"), t("复制本地关系、进度等已适配的数据")]];
async function newPage() {
    const templates = await api<any[]>('/api/templates');
    main().innerHTML = header(t("新建角色"), t("全新开始，或从现有角色的一个时间点继续。")) + `<form id="new-form"><section class="manager-sheet form-sheet"><div class="mode-grid"><label class="mode"><input type="radio" name="mode" value="fresh" checked>${icon('plus')}<span><strong>${t("全新创建")}</strong><small>${t("选择模板，从空白记忆开始")}</small></span></label><label class="mode"><input type="radio" name="mode" value="copy" ${roles.length ? '' : 'disabled'}>${icon('copy')}<span><strong>${t("从现有角色复制")}</strong><small>${t("按需保留设定、记忆与会话")}</small></span></label></div><div class="field-grid"><label>${t("角色名称")}<input class="field" name="name" placeholder="${t("给新角色起个名字")}" required maxlength="80"></label><label>${t("部署目录名")}<input class="field" name="id" placeholder="${t("例如：my-character")}" required pattern="[a-z][a-z0-9-]{0,47}" maxlength="48"><small>${t("小写字母、数字、短横线；创建后保持不变")}</small></label></div><label id="template-label">${t("Bot 模板")}<select class="field" name="bot">${templates.map(template => `<option value="${esc(template.id)}">${esc(t(template.label))}</option>`).join('')}</select></label><div id="source-wrap" hidden><label>${t("来源角色")}<select class="field" name="source">${roles.map(r => `<option value="${esc(r.id)}">${esc(r.name)} · ${states[r.state]}</option>`).join('')}</select></label></div></section><section id="copy-section" class="manager-sheet form-sheet" hidden><div class="section-title"><div><h2>${t("复制内容")}</h2><p>${t("设定、提示词和外观始终保留。其余由你选择。")}</p></div><button type="button" class="btn" id="full-copy">${t("完整本地克隆")}</button></div><div class="check-grid">${copyFields.map(([key, label, desc]) => `<label class="check-option"><input type="checkbox" name="${key}"><span><strong>${label}</strong><small>${desc}</small></span></label>`).join('')}</div><div class="connections"><h3>${t("外部账号与连接凭据")}</h3><p>${t("复制后会使用同一个外部账号，不会生成新的外部身份。")}</p><div id="connections"></div></div><div class="clone-note">${t("端口和进程锁会重新生成；复制后的角色保持停止，并共用管理登录。")}</div><div class="copy-stop-notice" id="copy-stop-notice" role="status" hidden>${icon('alert')}<div><strong>${t("创建时将短暂关闭来源角色")}</strong><p>${t("所选内容包含运行中的数据。复制完成后自动恢复来源角色；本页面会保持打开。")}</p></div></div><p class="muted small">${t("任务由常驻管理服务执行，刷新或关闭此页面不会取消任务。")}</p></section><div class="form-bottom"><span id="form-error" class="error" role="alert"></span><a class="btn" href="#">${t("取消")}</a><button class="btn primary" type="submit">${t("创建角色 ")}${icon('arrow')}</button></div></form>`;
    const form = main().querySelector<HTMLFormElement>('#new-form')!, copySection = main().querySelector<HTMLElement>('#copy-section')!, sourceWrap = main().querySelector<HTMLElement>('#source-wrap')!, templateLabel = main().querySelector<HTMLElement>('#template-label')!;
    let info: any = null;
    const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
    async function sourceChanged() {
        try {
            info = await api(`/api/roles/${field('source').value}/clone-info`);
            field('bot').value = info.bot;
            main().querySelector('#connections')!.innerHTML = info.connections.map((c: any) => `<label class="connection-check"><input type="checkbox" name="connection" value="${esc(c.id)}">${esc(t(c.label))}</label>`).join('');
            updateStopNotice();
        }
        catch (e) {
            toast((e as Error).message);
        }
    }
    bind(form, 'input[name=mode]', 'change', () => { const copying = new FormData(form).get('mode') === 'copy'; copySection.hidden = !copying; sourceWrap.hidden = !copying; templateLabel.hidden = copying; if (copying)
        void sourceChanged();
    else
        updateStopNotice(); });
    field('source').addEventListener('change', () => void sourceChanged());
    function updateStopNotice() {
        const source = roles.find(r => r.id === field('source').value);
        const copy = Object.fromEntries(copyFields.map(([key]) => [key, field(key).checked]));
        const required = new FormData(form).get('mode') === 'copy' && !!source && alive(source) && copiesRuntime(copy);
        main().querySelector<HTMLElement>('#copy-stop-notice')!.hidden = !required;
        form.querySelector<HTMLButtonElement>('button[type=submit]')!.textContent = required ? t("创建角色（来源将短暂关机）") : t("创建角色");
    }
    function syncDependencies() {
        const pending = field('pending').checked, timers = field('timers').checked;
        for (const key of ['memory', 'session', 'history', 'worldState']) {
            const required = pending || (key === 'memory' && timers);
            field(key).disabled = required;
            if (required)
                field(key).checked = true;
        }
        updateStopNotice();
    }
    bind(form, '.check-option input', 'change', syncDependencies);
    main().querySelector('#full-copy')!.addEventListener('click', () => { copyFields.forEach(([key]) => field(key).checked = true); form.querySelectorAll<HTMLInputElement>('input[name=connection]').forEach(e => e.checked = true); syncDependencies(); toast(t("已选择全部本地数据及外部连接，请检查后创建")); });
    const query = new URLSearchParams(location.hash.split('?')[1] || '');
    const previous = query.has('retry') ? (await api<Job[]>('/api/jobs')).find(j => j.id === query.get('retry')) : undefined;
    const source = previous?.input.source || query.get('source');
    if (previous) {
        field('name').value = previous.input.name;
        field('id').value = previous.input.id;
        field('bot').value = previous.input.bot;
    }
    if (source && roles.some(r => r.id === source)) {
        (form.querySelector('input[name=mode][value=copy]') as HTMLInputElement).checked = true;
        copySection.hidden = false;
        sourceWrap.hidden = false;
        templateLabel.hidden = true;
        field('source').value = source;
        await sourceChanged();
        if (previous) {
            copyFields.forEach(([key]) => field(key).checked = !!previous.input.copy[key]);
            form.querySelectorAll<HTMLInputElement>('[name=connection]').forEach(e => e.checked = previous.input.copy.connections.includes(e.value));
            syncDependencies();
        }
    }
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!, error = main().querySelector('#form-error')!;
        error.textContent = '';
        submit.disabled = true;
        try {
            const data = new FormData(form), copying = data.get('mode') === 'copy', copy: any = { connections: copying ? data.getAll('connection') : [] };
            copyFields.forEach(([key]) => copy[key] = copying && field(key).checked);
            const job = await api<Job>('/api/jobs', { id: data.get('id'), name: data.get('name'), bot: field('bot').value, source: copying ? data.get('source') : undefined, copy, allowStop: copying && copiesRuntime(copy) });
            location.hash = `job/${job.id}`;
        }
        catch (err) {
            error.textContent = t((err as Error).message);
            submit.disabled = false;
        }
    });
}
function jobHTML(j: Job) { return `<section class="manager-sheet job-sheet"><div class="job-status ${j.status}">${j.status === 'working' ? '<span class="spinner"></span>' : icon(j.status === 'done' ? 'check' : 'close')}<h2>${j.status === 'working' ? t("正在创建") : j.status === 'done' ? t("角色已创建") : t("任务需要处理")}</h2></div><p>${esc(j.input.name)}${j.input.source ? t(" · 从 ") + esc(roles.find(r => r.id === j.input.source)?.name || j.input.source) + t(" 复制") : ''}</p>${j.input.source ? `<p class="small muted">${t("复制范围：设定、提示词和外观")}${copyFields.filter(([k]) => j.input.copy[k]).map(([, label]) => ' · ' + label).join('')}${j.input.copy.connections.length ? t(" · 外部连接：") + j.input.copy.connections.map(esc).join('、') : ''}</p>` : ''}<ol class="steps">${j.steps.map(s => `<li><span>${esc(t(s.label))}</span><time>${new Date(s.at).toLocaleTimeString(locale, { hour12: false })}</time></li>`).join('')}</ol>${j.error ? `<p class="error">${esc(t(j.error))}</p>` : ''}${j.status !== 'working' ? `<div class="job-links"><a class="btn primary" href="#">${t("查看角色列表")}</a>${j.result && roles.some(r => r.id === j.result) ? `<button class="btn" data-action="${alive(roles.find(r => r.id === j.result)!) ? 'open' : 'start'}" data-id="${esc(j.result)}">${alive(roles.find(r => r.id === j.result)!) ? t("打开角色后台") : t("启动新角色")}</button>` : ''}${j.status === 'failed' && !j.result ? `<a class="btn" href="#new?retry=${j.id}">${t("按原参数重新编辑")}</a>` : ''}${j.input.source && roles.some(r => r.id === j.input.source) ? `<button class="btn" data-action="${alive(roles.find(r => r.id === j.input.source)!) ? 'open' : 'start'}" data-id="${esc(j.input.source)}">${alive(roles.find(r => r.id === j.input.source)!) ? t("返回来源角色后台") : t("启动来源角色")}</button>` : ''}</div>` : `<p class="muted">${t("可以刷新或关闭页面，任务会继续执行。")}</p>`}</section>`; }
async function jobPage(id: string) {
    const jobs = await api<Job[]>('/api/jobs'), j = jobs.find(j => j.id === id);
    if (!j)
        throw new Error(t("找不到任务记录"));
    main().innerHTML = header(t("创建进度"), t("新角色会保持停止，来源角色按原状态恢复。")) + `<div id="job-detail" data-job="${esc(id)}">${jobHTML(j)}</div>`;
    wireActions(main());
}
let recordPages = [1, 1];
let recordPageSize = Number(localStorage.getItem('manager-record-page-size')) || 10;
if (![10, 20, 50].includes(recordPageSize)) recordPageSize = 10;
function recordPager(total: number, index: number) {
    const pages = Math.max(1, Math.ceil(total / recordPageSize));
    const page = recordPages[index] = Math.min(recordPages[index], pages);
    const first = total ? (page - 1) * recordPageSize + 1 : 0;
    return `<div class="record-pagination"><span>${t("显示 ")}${first}${t(" 至 ")}${Math.min(page * recordPageSize, total)}${t("，共 ")}${total}${t(" 条")}</span><label>${t("每页 ")}<select class="field" data-page-size>${[10,20,50].map(n => `<option ${n === recordPageSize ? 'selected' : ''}>${n}</option>`).join('')}</select></label><div class="record-pages"><button class="btn" data-page="${index}" data-step="-1" ${page === 1 ? 'disabled' : ''} aria-label="${t("上一页")}">‹</button><span>${page} / ${pages}</span><button class="btn" data-page="${index}" data-step="1" ${page === pages ? 'disabled' : ''} aria-label="${t("下一页")}">›</button></div></div>`;
}
async function jobsPage() {
    const [jobs, records, settings] = await Promise.all([api<Job[]>('/api/jobs'), api('/api/operations'), api('/api/history/settings')]);
    const pagers = [recordPager(jobs.length, 0), recordPager(records.length, 1)];
    const visibleJobs = jobs.slice((recordPages[0] - 1) * recordPageSize, recordPages[0] * recordPageSize);
    const visibleRecords = records.slice((recordPages[1] - 1) * recordPageSize, recordPages[1] * recordPageSize);
    main().innerHTML = header(t("任务记录"), t("查看创建进度、运行操作和定时执行结果；失败记录保留具体原因。"), `<div class="history-actions"><button class="btn" id="refresh-records">${t("刷新记录")}</button><button class="btn" id="clear-records" >${t("清空记录")}</button></div>`) + `<form class="history-settings" id="history-settings"><label>${t("每类最多保留 ")}<input class="field" name="limit" type="number" min="10" max="10000" step="1" required value="${settings.limit}">${t(" 条已结束记录")}</label><button class="btn" >${t("保存")}</button><span class="muted">${t("超出后自动清理最旧记录；进行中的任务保留。")}</span></form><h2 class="section-heading">${t("创建与复制")}</h2><section class="manager-sheet record-list">${jobs.length ? visibleJobs.map(j => `<a class="record-row" href="#job/${j.id}"><div><h3>${esc(j.input.name)}</h3><p class="muted">${j.input.source ? t("复制角色") : t("全新创建")} · ${j.status === 'done' ? t("已完成") : j.status === 'working' ? t("进行中") : t("需处理")} · ${j.steps[0] ? new Date(j.steps[0].at).toLocaleString(locale) : ''}</p>${j.error ? `<p class="error">${esc(t(j.error))}</p>` : ''}</div><span class="record-detail">${t("查看详情 ")}${icon('arrow')}</span></a>`).join('') : `<p class="empty">${t("还没有创建任务。")}</p>`}${pagers[0]}</section><h2 class="section-heading">${t("运行与定时操作")}</h2><section class="manager-sheet record-list">${records.length ? managementUI.records(visibleRecords) : `<p class="empty">${t("还没有运行操作记录。")}</p>`}${pagers[1]}</section>`;
    main().querySelector('#refresh-records')!.addEventListener('click', () => void jobsPage());
    bind(main(), '[data-page]', 'click', e => {
        const b = e.currentTarget as HTMLButtonElement;
        recordPages[Number(b.dataset.page)] += Number(b.dataset.step);
        void jobsPage();
    });
    bind(main(), '[data-page-size]', 'change', e => {
        recordPageSize = Number((e.currentTarget as HTMLSelectElement).value);
        localStorage.setItem('manager-record-page-size', String(recordPageSize));
        recordPages = [1, 1]; void jobsPage();
    });
    main().querySelector('#history-settings')!.addEventListener('submit', async e => {
        e.preventDefault();
        const limit = Number(new FormData(e.currentTarget as HTMLFormElement).get('limit'));
        if (limit < settings.limit && !await confirmBox(t("减少保留条数？"), t("超出新上限的最旧记录会被清理，角色数据与定时计划保持不变。"))) return;
        try { await api('/api/history/settings', {limit}); await jobsPage(); toast(t("保留条数已保存")); } catch(e) { toast((e as Error).message); }
    });
    main().querySelector('#clear-records')!.addEventListener('click', async () => {
        if (!await confirmBox(t("清空任务记录？"), t("清除创建、复制与运行操作的已结束记录，无法恢复。保留进行中的任务，角色数据与定时计划保持不变。"))) return;
        try { await api('/api/history/clear', {}); recordPages = [1, 1]; await jobsPage(); toast(t("记录已清空")); } catch(e) { toast((e as Error).message); }
    });
    managementUI.wireRecords(main(), jobsPage);
}
async function boot() {
    {
        const auth = await api('/api/auth/status');
        if (auth.setupRequired) { setupPage(); return; }
    }
    try {
        current = await api('/api/current');
    }
    catch (e) {
        login((e as Error).message);
        return;
    }
    if (current) initTheme(await api('/api/theme'));
    shell();
    try {
        await refreshRoles();
        await route();
        if (poll)
            clearInterval(poll);
        poll = setInterval(() => void update().catch(() => { }), 1500);
    }
    catch (e) {
        main().innerHTML = header(t("连接角色管理"), esc((e as Error).message)) + `<p class="muted">${t("登录已失效，请重新登录管理中心后继续使用。")}</p><a class="btn primary" href="${managerURL()}">${t("打开管理入口")}</a>`;
    }
}
async function update() {
    if (document.hidden)
        return;
    await refreshRoles();
    const detail = document.querySelector<HTMLElement>('#job-detail');
    if (detail) {
        const jobs = await api<Job[]>('/api/jobs'), j = jobs.find(j => j.id === detail.dataset.job);
        if (j) {
            const revision = JSON.stringify([j, roles.map(r => [r.id, r.state])]);
            if (detail.dataset.revision !== revision) {
                detail.innerHTML = jobHTML(j);
                wireActions(detail);
                detail.dataset.revision = revision;
            }
        }
    }
}
function passwordFields() {
    return `<label>${t("新密码")}<input class="field" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="256" required></label><label>${t("再次输入新密码")}<input class="field" name="confirmPassword" type="password" autocomplete="new-password" minlength="8" maxlength="256" required></label>`;
}
function wirePasswordForm(setup: boolean) {
    app.querySelector<HTMLFormElement>('#password-form')!.addEventListener('submit', async e => {
        e.preventDefault();
        const form=e.currentTarget as HTMLFormElement, button=form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
        button.disabled=true;
        try {
            await api(setup ? '/api/auth/setup' : '/api/auth/password', Object.fromEntries(new FormData(form)));
            form.reset();
            if (setup) await boot();
            else { clearInterval(poll); current=undefined; login(t("密码已修改，请使用新密码登录。")); }
        } catch(error) { form.querySelector('.error')!.textContent=t((error as Error).message); }
        finally { button.disabled=false; }
    });
}
function setupPage() {
    app.innerHTML=`<main class="login"><form id="password-form" class="manager-sheet login-card"><div class="eyebrow">CORTICO</div><h1>${t("设置访问密码")}</h1><p>${t("首次使用管理中心。此密码用于管理中心和它管理的所有角色后台。")}</p>${passwordFields()}<p class="error" role="alert"></p><button type="submit" class="btn primary">${t("设置密码并进入")}</button></form></main>`;
    wirePasswordForm(true);
}
function accessPage() {
    main().innerHTML='';
    disposeSettings=nativeSettings(main(),error=>toast((error as Error).message));
    main().querySelector('.pagetitle')!.textContent=t("界面设置");
    const section=[...main().querySelectorAll('.sheet')].find(el=>el.querySelector('h3 .en')?.textContent==='access')!;
    section.querySelector('.sh-desc')!.textContent=t("登录一次即可切换管理中心与所有角色后台。");
    const logout=section.querySelector('button')!;
    logout.textContent=t("退出所有后台");
    logout.title=t("退出这套管理中心及角色后台，所有设备的登录都会失效");
    const form=document.createElement('form');form.id='password-form';form.className='manager-password-form';
    form.innerHTML=`<div class="password-fields"><label>${t("当前密码")}<input class="field" name="currentPassword" type="password" autocomplete="current-password" required></label>${passwordFields()}</div><p class="muted">${t("修改密码或退出所有后台后，各设备需重新登录；角色继续运行。密码至少 8 个字符。")}</p><p class="error" role="alert"></p><button class="btn primary" type="submit">${t("保存新密码")}</button>`;
    logout.before(form);
    const actions=document.createElement('div'); actions.className='password-actions';
    actions.append(form.querySelector('button[type="submit"]')!, logout);
    form.append(actions);
    wirePasswordForm(false);
}

function login(message = '') {
    disposeSettings?.(); disposeSettings=undefined;
    app.innerHTML = `<main class="login"><form class="manager-sheet login-card"><div class="eyebrow">CORTICO</div><h1>${t("登录管理中心")}</h1><p>${t("管理角色与运行状态。")}</p><label>${t("访问密码")}<input class="field" type="password" name="password" autocomplete="current-password" required autofocus></label><p class="error" id="login-error">${esc(message)}</p><button class="btn primary">${t("登录 ")}${icon('arrow')}</button></form></main>`;
    app.querySelector('form')!.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            await api('/api/auth/login', { password: new FormData(e.currentTarget as HTMLFormElement).get('password') });
            await boot();
        }
        catch (err) {
            document.querySelector('#login-error')!.textContent = t((err as Error).message);
        }
    });
}
window.addEventListener('hashchange', () => { if(current) void route(); });
document.addEventListener('click', e => {
    if (menuOpen && !(e.target as Element).closest('#role-menu,#footer,#open-menu')) {
        menuOpen = false;
        menu();
    }
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && menuOpen) {
        menuOpen = false;
        menu();
        document.querySelector<HTMLButtonElement>('#footer-toggle')?.focus();
    }
});
void boot();
