import { expect, it } from 'vitest';
import { hfEndpoint, listGguf, quantTag, searchGguf } from '../../../src/providers/llamacpp/huggingface.ts';

const fake = (routes: Record<string, unknown>): typeof fetch => (async (input: string | URL | Request) => {
  const url = String(input);
  const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
  return hit ? new Response(JSON.stringify(hit[1])) : new Response('missing', { status: 404 });
}) as typeof fetch;

it('the host follows the variables llama-server pulls from, MODEL_ENDPOINT before HF_ENDPOINT, trailing slash dropped', () => {
  expect(hfEndpoint({})).toBe('https://huggingface.co');
  expect(hfEndpoint({ HF_ENDPOINT: 'https://hf-mirror.com/' })).toBe('https://hf-mirror.com');
  expect(hfEndpoint({ HF_ENDPOINT: 'https://hf-mirror.com', MODEL_ENDPOINT: 'http://cache.local' })).toBe('http://cache.local');
});

it('search asks for gguf repositories by downloads and projects id, counts and update time', async () => {
  const seen: string[] = [];
  const fetchImpl: typeof fetch = (async (input: string | URL | Request) => {
    seen.push(String(input));
    return new Response(JSON.stringify([
      { id: 'org/Model-GGUF', downloads: 1200, likes: 7, lastModified: '2026-09-01T00:00:00.000Z' },
      { modelId: 'other/Legacy-GGUF' },
      { downloads: 1 },
    ]));
  }) as typeof fetch;
  const repos = await searchGguf('model', 12, { fetchImpl, env: { HF_ENDPOINT: 'https://hf-mirror.com' } });
  expect(repos).toEqual([
    { id: 'org/Model-GGUF', downloads: 1200, likes: 7, updatedAt: '2026-09-01T00:00:00.000Z' },
    { id: 'other/Legacy-GGUF', downloads: 0, likes: 0, updatedAt: null },
  ]);
  const url = new URL(seen[0]);
  expect(url.origin + url.pathname).toBe('https://hf-mirror.com/api/models');
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ search: 'model', filter: 'gguf', sort: 'downloads', direction: '-1', limit: '12' });
  expect(url.searchParams.getAll('expand[]')).toEqual(['downloads', 'likes', 'lastModified']);
});

it('the quantization tag is the last naming token, case kept, UD- prefix kept, shards ignored', () => {
  expect(quantTag('Qwen3-8B-Q4_K_M.gguf')).toBe('Q4_K_M');
  expect(quantTag('qwen3-8b.q8_0.gguf')).toBe('q8_0');
  expect(quantTag('Llama-70B-UD-Q4_K_XL.gguf')).toBe('UD-Q4_K_XL');
  expect(quantTag('Big-IQ2_XXS-00001-of-00003.gguf')).toBe('IQ2_XXS');
  expect(quantTag('model-bf16.gguf')).toBe('bf16');
  expect(quantTag('mystery.gguf')).toBeNull();
});

it('repository files fold shards into one pull target, skip projectors and sum sizes', async () => {
  const fetchImpl = fake({
    'https://huggingface.co/api/models/org/Model-GGUF': { siblings: [
      { rfilename: 'README.md', size: 10 },
      { rfilename: 'Model-Q4_K_M.gguf', size: 100 },
      { rfilename: 'Model-Q8_0-00001-of-00002.gguf', lfs: { size: 300 } },
      { rfilename: 'Model-Q8_0-00002-of-00002.gguf', lfs: { size: 200 } },
      { rfilename: 'mmproj-Model-F16.gguf', size: 50 },
      { rfilename: 'Model-plain.gguf' },
    ] },
  });
  expect(await listGguf('org/Model-GGUF', { fetchImpl, env: {} })).toEqual([
    { name: 'Model-Q4_K_M.gguf', bytes: 100, tag: 'Q4_K_M', pull: 'org/Model-GGUF:Q4_K_M' },
    { name: 'Model-Q8_0.gguf', bytes: 500, tag: 'Q8_0', pull: 'org/Model-GGUF:Q8_0' },
    { name: 'Model-plain.gguf', bytes: null, tag: null, pull: 'org/Model-GGUF' },
  ]);
  await expect(listGguf('org/Missing', { fetchImpl, env: {} })).rejects.toThrow('404');
});
