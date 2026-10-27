/** Permanent management entry; roles use the regular launcher and deployment root. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { acquireInstanceLock } from '../core/instance-lock.ts';
import { deploymentRoot } from '../paths.ts';
import { loadCatalog } from './catalog.ts';
import { makeManager } from './server.ts';
const flag = (name: string, fallback: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const port = Number(flag('port', '7790'));
const host = flag('host', '127.0.0.1');
if (!Number.isInteger(port) || port < 1 || port > 65385) throw new Error('Invalid manager port');
const root = join(deploymentRoot(), '.manager');
mkdirSync(root, {recursive: true});
const lock = acquireInstanceLock(root);
process.once('exit', () => lock.release());
await loadCatalog();
const manager = makeManager(deploymentRoot(), port, host);
const server = manager.app.listen(port, host, () => {
    console.log(`Cortico manager: http://${host}:${port}/`);
    manager.operations.start();
});
let closing = false;
async function shutdown() {
    if (closing) return;
    closing = true;
    await manager.operations.close();
    await manager.jobs.wait();
    await manager.supervisor.close();
    server.close(() => process.exit(0));
    server.closeAllConnections();
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

if (process.send) process.once('disconnect', () => void shutdown());
