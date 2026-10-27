import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { managementAuth } from './auth.ts';
import { baseApp, asyncRoute, errors } from './http.ts';
import { writeJson, inspectClone } from './clone.ts';
import { json, PROFILES, validId } from './catalog.ts';
import { Supervisor } from './supervisor.ts';
import { Operations, type Action } from './operations.ts';
import { normalizeStoredTheme } from '../web/shared/theme.ts';
import { Jobs } from './jobs.ts';
import type { CreateInput } from './types.ts';
export function makeManager(home: string, port: number, host = '127.0.0.1') {
    const root = join(home, '.manager');
    mkdirSync(root, {recursive: true});
    const supervisor = new Supervisor(home, port, host);
    const jobs = new Jobs(join(root, 'jobs'), supervisor);
    const operations = new Operations(root, supervisor);
    const historyFile = join(root, 'history-settings.json');
    let historyLimit = json<{limit: number}>(historyFile, {limit: 200}).limit;
    jobs.setLimit(historyLimit);
    operations.setLimit(historyLimit);
    const auth = managementAuth(root);
    const app = baseApp(auth);
    app.get('/api/theme', (_req,res)=>res.json({defaultScheme:'crab-daisy',theme:json(join(root,'theme.json'),null)}));
    app.post('/api/theme',asyncRoute((req,res)=>{const theme=normalizeStoredTheme(req.body);writeJson(join(root,'theme.json'),theme);res.json({ok:true});}));
    app.get('/api/current', (_req, res) => res.json({ kind: 'manager', managerPort: port, runtime: 'cortico' }));
    app.get('/api/roles', (_req, res) => res.json(supervisor.roles()));
    app.get('/api/templates', (_req, res) => res.json(PROFILES.map(p => ({ id: p.id, label: p.label }))));
    app.get('/api/history/settings', (_req, res) => res.json({limit: historyLimit}));
    app.post('/api/history/settings', asyncRoute((req, res) => {
        const limit = req.body.limit;
        if (!Number.isInteger(limit) || limit < 10 || limit > 10000) throw Error('保留条数须为 10–10000 的整数');
        writeJson(historyFile, {limit});
        historyLimit = limit;
        jobs.setLimit(limit); operations.setLimit(limit);
        res.json({limit});
    }));
    app.post('/api/history/clear', asyncRoute((_req, res) => {
        jobs.clear(); operations.clear(); res.json({ok: true});
    }));
    app.get('/api/jobs', (_req, res) => res.json(jobs.list()));
    app.get('/api/roles/:id/clone-info', asyncRoute((req, res) => res.json(inspectClone(home, req.params.id))));
    app.get('/api/roles/:id/avatar', asyncRoute((req, res) => {
        const role = supervisor.role(req.params.id);
        if (!role.avatar) {
            res.sendStatus(404);
            return;
        }
        res.sendFile(join(home, role.id, 'avatar.png'));
    }));
    app.post('/api/jobs', asyncRoute((req, res) => { const input = req.body as CreateInput; const job = jobs.create(input); res.status(202).json(job); }));
    app.get('/api/operations', (_req, res) => res.json(operations.records()));
    app.get('/api/schedules', (_req, res) => res.json(operations.schedules()));
    app.post('/api/schedules', asyncRoute((req, res) => res.json(operations.setSchedule(req.body))));
    app.post('/api/schedules/:id/:action', asyncRoute((req, res) => { operations.changeSchedule(req.params.id, req.params.action as 'enable' | 'disable' | 'remove'); res.json({ ok: true }); }));
    app.post('/api/trash/purge', asyncRoute((req, res) => { operations.purge(req.body.keys); res.json({ ok: true }); }));
    app.get('/api/trash', (_req, res) => res.json(operations.deleted()));
    app.post('/api/trash/:key/restore', asyncRoute(async (req, res) => res.json(await operations.restore(req.params.key))));
    app.post('/api/roles/:id/delete', asyncRoute(async (req, res) => { await operations.archive(req.params.id); res.json({ ok: true }); }));
    app.post('/api/roles/:id/:action', asyncRoute(async (req, res) => {
        const id = req.params.id, action = req.params.action;
        if (!validId(id))
            throw new Error('无效角色');
        res.json(await operations.action(id, action as Action));
    }));
    app.use(errors);
    return { app, supervisor, jobs, operations };
}
