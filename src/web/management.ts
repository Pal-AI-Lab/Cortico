import type { Express } from 'express';
import { request } from 'node:http';
export interface ManagedRole { id: string; managerPort: number; managerHost?: string }
/** Managed pages share their manager's authenticated control API; bot APIs stay native. */
export function mountManagementRoutes(app: Express, management?: ManagedRole) {
    app.get('/api/management', (_req, res) => res.json(management ?? null));
    if (!management) return;
    app.get('/api/current', (_req, res) => res.json({kind: 'role', ...management}));
    app.use('/api/manager', (req, res) => {
        const headers = {...req.headers, host: `127.0.0.1:${management.managerPort}`};
        delete headers.origin;
        const upstream = request({hostname: management.managerHost ?? '127.0.0.1', port: management.managerPort,
            path: '/api' + req.url, method: req.method, headers}, reply => {
            res.writeHead(reply.statusCode ?? 502, reply.headers);
            reply.pipe(res);
        });
        upstream.on('error', () => { if (!res.headersSent) res.status(502).json({error: 'Management center unavailable'}); else res.end(); });
        req.on('aborted', () => upstream.destroy());
        req.pipe(upstream);
    });
}
