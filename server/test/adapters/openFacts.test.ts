import { describe, expect, it } from 'vitest';
import { OpenFactsAdapter } from '../../src/adapters/openFoodFacts.js';
import type { OutboundResult } from '../../src/adapters/httpClient.js';

function http(res: OutboundResult) {
  const urls: string[] = [];
  return { urls, getJson: async (u: string) => (urls.push(u), res) };
}

describe('OpenFactsAdapter', () => {
  it('builds a fixed-origin URL with only the validated digits (SEC-37)', async () => {
    const h = http({ ok: true, status: 404, body: { status: 0 } });
    const a = new OpenFactsAdapter('open_food_facts', h);
    await a.lookup('8901234012345');
    expect(h.urls[0]).toMatch(/^https:\/\/world\.openfoodfacts\.org\/api\/v2\/product\/8901234012345\.json\?fields=[a-z_,]+$/);
    expect(new OpenFactsAdapter('open_beauty_facts', h).buildUrl('96385074')).toMatch(/^https:\/\/world\.openbeautyfacts\.org\//);
    for (const bad of ['../../admin', '89012340123451?x=1', 'http://127.0.0.1', '', '1234']) {
      expect(() => a.buildUrl(bad)).toThrow();
      expect(await a.lookup(bad)).toMatchObject({ status: 'error', cause: 'bad_code' });
    }
  });

  it('maps a found product, sanitising text and tags', async () => {
    const a = new OpenFactsAdapter('open_food_facts', http({
      ok: true,
      status: 200,
      body: { status: 1, product: { product_name: 'Glucose​ Biscuits‮ 250 g', brands: 'Brand', categories_tags: ['en:snacks', 'en:biscuits', 'EN:Bad Tag!', 42 as unknown as string].slice(0, 3) } },
    }));
    const r = await a.lookup('8901234012345');
    expect(r).toMatchObject({ status: 'found', source: 'open_food_facts', name: 'Glucose Biscuits 250 g', brand: 'Brand', categories: ['en:snacks', 'en:biscuits'] });
    if (r.status === 'found') expect(r.sourceRef).toBe('https://world.openfoodfacts.org/product/8901234012345');
  });

  it('caps product text at 200 chars', async () => {
    const a = new OpenFactsAdapter('open_food_facts', http({ ok: true, status: 200, body: { status: 1, product: { product_name: 'x'.repeat(4000) } } }));
    const r = await a.lookup('8901234012345');
    if (r.status !== 'found') throw new Error('expected found');
    expect(r.name?.length).toBe(200);
  });

  it.each([
    [{ ok: true, status: 404, body: {} }, 'not_found'],
    [{ ok: true, status: 200, body: { status: 0, status_verbose: 'product not found' } }, 'not_found'],
    [{ ok: true, status: 200, body: { status: 1, product: {} } }, 'not_found'],
    [{ ok: true, status: 200, body: { status: 1, product: { product_name: 7 } } }, 'error'],
    [{ ok: true, status: 200, body: { status: 1, product: { categories_tags: 'en:x' } } }, 'error'],
    [{ ok: true, status: 200, body: 'hello' }, 'error'],
    [{ ok: false, error: 'timeout' }, 'error'],
    [{ ok: false, error: 'redirect', status: 302 }, 'error'],
  ] as [OutboundResult, string][])('response %j → %s', async (res, status) => {
    const r = await new OpenFactsAdapter('open_food_facts', http(res)).lookup('8901234012345');
    expect(r.status).toBe(status);
  });
});
