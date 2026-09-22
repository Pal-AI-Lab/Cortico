import { responseRequest } from '../../src/protocol/open-responses/context-helpers.ts';
import { records } from './fixture-protocol.ts';
import type { ChatMessage } from './fixture-types.ts';
import type { ModelSpec, ToolSchema } from '../../src/core/types.ts';
import type { ResponseClient } from '../../src/core/generation.ts';
function respond(client: ResponseClient, spec: ModelSpec, history: ChatMessage[], tools: ToolSchema[] = []) {
  const context = records(history);
  return client.respond(responseRequest(spec, context, tools), { context, nativeSpec: spec });
}
/**
 * 未注入 LLM 时，Core 按当前部署的 activeProvider 选择端点。
 * 验证热切换、各端点地址与鉴权、multimodal 配置和缺失端点错误。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Core } from "./fixture-core.ts";
import { makeCfg, makeFakeIO, makeFakePersona, makeLoaded, makeTmpDir } from './helpers.ts';

function buildHarness() {
  const tmp = makeTmpDir();
  const config = makeCfg();
  config.worlds.qq.enabled = false;
  config.providers = {
    deepseek: {
      kind: 'openai-responses-compat',
      baseUrl: 'https://ds.test',
      secret: 'DEEPSEEK_API_KEY',
      options: { preset: 'deepseek' },
      spec: { model: 'deepseek-flash', thinking: false },
    },
    local: {
      kind: 'openai-responses-compat',
      baseUrl: 'http://127.0.0.1:8090/v1',
      multimodal: true,
      options: { extraBody: { service_tier: 'flex' } },
      spec: { model: 'local', thinking: false },
    },
  };
  config.activeProvider = 'deepseek';
  // 本测试从端点 .env 读取密钥；进程环境优先级另有测试。
  mkdirSync(join(tmp.dir, 'providers', 'deepseek'), { recursive: true });
  writeFileSync(join(tmp.dir, 'providers', 'deepseek', '.env'), 'DEEPSEEK_API_KEY=sk-cloud\n');
  const loaded = makeLoaded({
    config,
    rootDir: tmp.dir,
    memoryDir: `${tmp.dir}/persona`,
    dataDir: `${tmp.dir}/data`,
    secrets: {},
  });
  const persona = makeFakePersona([], { cfg: config });
  const core = new Core(loaded, { persona, worlds: [makeFakeIO('web')] });
  return { core, config, tmp };
}

const okResponse = () =>
  new Response(
    JSON.stringify({
      id: 'resp_ok', model: 'm', status: 'completed',
      output: [{ type: 'message', id: 'msg_ok', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200 },
  );

describe('Core · LLM provider 路由', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup?.();
    cleanup = null;
  });

  it('按 activeProvider 路由;热改后下一次调用走新端点与新方言', async () => {
    const { core, config, tmp } = buildHarness();
    cleanup = tmp.cleanup;
    const fetchMock = vi.fn().mockImplementation(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const spec = { model: 'deepseek-flash', thinking: false } as const;
    await respond(core.llm, spec, [{ role: 'user', content: 'hi' }]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://ds.test/responses');
    const dsInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(dsInit.headers).toMatchObject({ Authorization: 'Bearer sk-cloud' });
    const dsBody = JSON.parse(dsInit.body as string);
    // thinking 关 = reasoning.effort none;无状态回放
    expect(dsBody).toMatchObject({ reasoning: { effort: 'none' }, store: false, include: ['reasoning.encrypted_content'] });
    expect('service_tier' in dsBody).toBe(false);

    config.activeProvider = 'local';
    await respond(core.llm, spec, [{ role: 'user', content: 'hi' }]);
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:8090/v1/responses');
    const localInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect('Authorization' in (localInit.headers as Record<string, string>)).toBe(false);
    expect(JSON.parse(localInit.body as string).service_tier).toBe('flex');
  });

  it('modelFacts.accepts 读活跃 provider 的 multimodal 手动开关', () => {
    const { core, config, tmp } = buildHarness();
    cleanup = tmp.cleanup;
    // 经 makeHost 暴露给 World;直接构造一个 host 读事实
    const facts = (core as unknown as { modelFacts(): { accepts(m: string): boolean } }).modelFacts();
    expect(facts.accepts('image/jpeg')).toBe(false); // deepseek 条目没开
    config.activeProvider = 'local';
    expect(facts.accepts('image/jpeg')).toBe(true);
    expect(facts.accepts('audio/wav')).toBe(false); // 只认 image/*
  });

  it('modelFacts.accepts 在未选端点或端点未选模型时为 false,端点名不存在时抛错', () => {
    const { core, config, tmp } = buildHarness();
    cleanup = tmp.cleanup;
    const facts = (core as unknown as { modelFacts(): { accepts(m: string): boolean } }).modelFacts();
    config.activeProvider = '';
    expect(facts.accepts('image/png')).toBe(false);
    config.activeProvider = 'local';
    delete config.providers.local.spec;
    expect(facts.accepts('image/png')).toBe(false);
    config.activeProvider = 'nope';
    expect(() => facts.accepts('image/png')).toThrow(/没有这个 LLM provider: nope/);
  });

  it("activeProvider 不存在时在调用阶段抛错", async () => {
    const { core, config, tmp } = buildHarness();
    cleanup = tmp.cleanup;
    config.activeProvider = 'nope';
    await expect(
      respond(core.llm, { model: 'm', thinking: false }, [{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow(/没有这个 LLM provider: nope/);
  });
});
