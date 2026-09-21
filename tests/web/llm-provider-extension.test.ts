import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { buildWeb } from '../../scripts/build-web.ts';
import { discoverProviderModules, ProviderRegistry } from '../../src/providers/registry.ts';
import { ProviderSettings } from '../../src/providers/console/settings.ts';
import { BaseProvider } from '../../src/providers/base.ts';
import { WebApp } from '../../src/web/server.ts';
import { nullLogger } from '../../src/core/util.ts';
import { makeCfg, makeTmpDir } from '../core/helpers.ts';
import { FakeStore } from './fakes.ts';

function hashTree(directory: string): string {
  const hash = createHash('sha256');
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    hash.update(entry.name);
    hash.update(
      entry.isDirectory()
        ? hashTree(join(directory, entry.name))
        : readFileSync(join(directory, entry.name)),
    );
  }
  return hash.digest('hex');
}
describe('LLM Provider directory extension', () => {
  it('discovers native class, builds its client and serves a stateful panel without modifying Web Core', async () => {
    const temp = makeTmpDir();
    const before = hashTree(resolve('src/web'));
    let app: WebApp | undefined;
    try {
      const moduleDir = join(temp.dir, 'src/providers/fixture');
      mkdirSync(join(moduleDir, 'console'), { recursive: true });
      const baseUrl = pathToFileURL(resolve('src/providers/base.ts')).href;
      writeFileSync(
        join(moduleDir, 'index.ts'),
        `import {BaseProvider} from ${JSON.stringify(baseUrl)};
class Fixture extends BaseProvider {async respond(){throw new Error('fixture has no inference transport');}}
export default {id:'fixture',title:'Fixture',reasoningTiers:[{id:'off',label:'Off',thinking:false}],serviceTiers:[],
 create(name,entry,host){return {client:new Fixture(),control:host.resource('counter',()=>({count:0}))};},
 console(host){return {panels:[{id:'counter',title:'Counter',getMethods:['state']}],invoke(panel,method,args){
  const state=host.instance('test').control;if(panel!=='counter')throw new Error('wrong panel');
  if(method==='increment')state.count++;else if(method!=='state')throw new Error('wrong method');return state.count;
 }}}};`,
      );
      writeFileSync(
        join(moduleDir, 'console/client.ts'),
        `export default {panels:{counter:{async mount(ctx){ctx.root.textContent=String(await ctx.invoke('state'));}}}};`,
      );
      const worlds = await discoverProviderModules(join(temp.dir, 'src/providers'));
      const cfg = makeCfg();
      cfg.providers = { test: { kind: 'fixture', baseUrl: 'http://fixture.test' } };
      cfg.activeProvider = 'test';
      const registry = new ProviderRegistry(
        () => cfg.providers,
        {
          stateRoot: join(temp.dir, 'providers'),
          readBlob: () => null,
          keepThinking: () => true,
          log: nullLogger(),
        },
        worlds,
      );
      expect(registry.resolve('test').client).toBeInstanceOf(BaseProvider);
      const settings = new ProviderSettings(
        cfg,
        registry,
        join(temp.dir, 'config.json'),
        join(temp.dir, 'providers'),
        worlds,
      );
      const assets = await buildWeb(temp.dir);
      expect(assets.providers['llm:fixture'].js).toMatch(/^\/assets\/providers\/llm-fixture-/);
      app = new WebApp({
        store: new FakeStore(),
        memoryDir: temp.dir,
        dataDir: temp.dir,
        webDistDir: join(temp.dir, 'dist/web'),
        getStatus: () => ({}),
        log: nullLogger(),
        consolePageSources: () => settings.sources(),
      });
      const base = `http://127.0.0.1:${await app.start(0)}`;
      const manifest = (await (await fetch(base + '/api/console/manifest')).json()) as any;
      const provider = manifest.providers.find((p: any) => p.id === 'llm:fixture');
      // An extension that places none of the editor's blocks gets the default order, its own sections between model and pricing.
      expect(provider.panels.map((p: any) => p.id)).toEqual(['settings', 'endpoint', 'model', 'counter', 'pricing', 'protocol']);
      expect((await fetch(base + assets.providers['llm:fixture'].js)).status).toBe(200);
      async function invoke(method: string) {
        return (
          await fetch(base + '/api/console/providers/llm%3Afixture/panels/counter/' + method, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ args: [] }),
          })
        ).json();
      }
      expect(await invoke('state')).toBe(0);
      expect(await invoke('increment')).toBe(1);
      expect(await invoke('state')).toBe(1);
      expect(hashTree(resolve('src/web'))).toBe(before);
    } finally {
      await app?.stop();
      temp.cleanup();
    }
  });
});
