/**
 * Open Food Facts / Open Beauty Facts product lookup adapters (research/sources.md §4).
 * Both are OFF by default and are only constructed when config enables them; requests go
 * through OutboundHttpClient (allow-list, HTTPS, no redirects, DNS/IP check, 3 s, 256 KiB).
 *
 * The URL is built from a fixed origin + the validated digit string (SEC-37). The response is
 * parsed with zod; anything unexpected is treated as an error (no partial trust).
 * These databases do not return HSN codes: only name, brand and category tags are used.
 */
import { z } from 'zod';
import type { OutboundHttpClient } from './httpClient.js';
import { cleanTags, cleanText, type LookupResult, type ProductLookup, type ProductSource } from './productLookup.js';

const FIELDS = 'product_name,product_name_en,generic_name,generic_name_en,brands,categories_tags';

const ProductSchema = z
  .object({
    product_name: z.string().max(5000).nullish(),
    product_name_en: z.string().max(5000).nullish(),
    generic_name: z.string().max(5000).nullish(),
    generic_name_en: z.string().max(5000).nullish(),
    brands: z.string().max(5000).nullish(),
    categories_tags: z.array(z.string().max(300)).max(500).nullish(),
  })
  .passthrough();

const ResponseSchema = z
  .object({
    status: z.union([z.number(), z.string()]).optional(),
    product: ProductSchema.nullish(),
  })
  .passthrough();

const SITES: Record<ProductSource, string> = {
  open_food_facts: 'world.openfoodfacts.org',
  open_beauty_facts: 'world.openbeautyfacts.org',
};

export class OpenFactsAdapter implements ProductLookup {
  readonly source: ProductSource;
  private readonly host: string;

  constructor(
    source: ProductSource,
    private readonly http: Pick<OutboundHttpClient, 'getJson'>,
    /** test seam: alternative host (must still be allow-listed in the client) */
    host?: string,
  ) {
    this.source = source;
    this.host = host ?? SITES[source];
  }

  /** Exposed for the SEC-37 test: only digits from the validated GTIN reach the path. */
  buildUrl(code: string): string {
    if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(code)) throw new Error('lookup code must be a validated GTIN digit string');
    return `https://${this.host}/api/v2/product/${encodeURIComponent(code)}.json?fields=${FIELDS}`;
  }

  async lookup(code: string, partition?: string): Promise<LookupResult> {
    let url: string;
    try {
      url = this.buildUrl(code);
    } catch {
      return { status: 'error', source: this.source, cause: 'bad_code' };
    }
    const res = await this.http.getJson(url, partition);
    if (!res.ok) return { status: 'error', source: this.source, cause: res.error };
    if (res.status === 404) return { status: 'not_found', source: this.source };
    const parsed = ResponseSchema.safeParse(res.body);
    if (!parsed.success) return { status: 'error', source: this.source, cause: 'schema' };
    const { status, product } = parsed.data;
    const notFound = status === 0 || status === '0' || status === 'failure' || product === null || product === undefined;
    if (notFound) return { status: 'not_found', source: this.source };
    const name =
      cleanText(product.product_name_en, 200) ??
      cleanText(product.product_name, 200) ??
      cleanText(product.generic_name_en, 200) ??
      cleanText(product.generic_name, 200);
    const brand = cleanText(product.brands, 100);
    const categories = cleanTags(product.categories_tags);
    if (name === null && categories.length === 0) return { status: 'not_found', source: this.source };
    return {
      status: 'found',
      source: this.source,
      name,
      brand,
      categories,
      sourceRef: `https://${SITES[this.source]}/product/${code}`,
    };
  }
}
