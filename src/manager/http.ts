import express from 'express';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { repoRoot } from '../paths.ts';
import { Auth, sameOrigin } from './auth.ts';
export const PUBLIC = join(repoRoot(), 'src/web/public');
export function baseApp(auth: Auth) {
    const app = express();
    app.disable('x-powered-by');
    app.use(sameOrigin);
    app.use(express.json({ limit: '3mb' }));
    app.post('/api/auth/login', (req, res) => auth.loginRequest(req, res));
    app.get('/api/auth/status', (req, res) => res.json({ required: true, authenticated: auth.logged(req), setupRequired: !auth.configured }));
    app.post('/api/auth/setup', (req, res) => auth.setup(req, res));
    app.post('/api/auth/logout', (req, res) => auth.logoutRequest(req, res));
    app.use('/api', auth.guard);
    app.post('/api/auth/password', (req, res) => auth.change(req, res));
    app.use('/assets', express.static(join(repoRoot(), 'dist/web')));
    app.use(express.static(PUBLIC, { index: false }));
    app.get('/', (_req, res) => {
        const manifest = JSON.parse(readFileSync(join(repoRoot(), 'dist/web/asset-manifest.json'), 'utf8'));
        res.type('html').send(readFileSync(join(PUBLIC, 'manager/index.html'), 'utf8').replace('{{entry}}', manifest.manager));
    });
    return app;
}
export const asyncRoute = (fn: (req: express.Request, res: express.Response) => Promise<unknown> | unknown): express.RequestHandler => (req, res, next) => { Promise.resolve().then(() => fn(req, res)).catch(next); };
export const errors: express.ErrorRequestHandler = (err, _req, res, _next) => { res.status(400).json({ error: err instanceof Error ? err.message : '操作失败' }); };
