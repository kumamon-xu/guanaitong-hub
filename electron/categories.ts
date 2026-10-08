/** Official CMS categories are fetched per card session; names are never inferred from titles. */
export type CategoryRequestMethod = 'GET' | 'POST' | 'POST_JSON';
export type CategoryRequest = (path: string, params?: Record<string, any>, method?: CategoryRequestMethod) => Promise<any>;
export interface ProductCategoryResult {
  cardId: string;
  bySourceId: Record<string, string[]>;
  sourceIds: string[];
  warnings: string[];
  complete: boolean;
}
export interface CategoryOptions {
  loadHomeHTML?: (url: string) => Promise<string>;
  pageSize?: number;
}
export interface CMSCategoryConfig { storeId: string; widgets: Record<string, any>[]; }
const UNCATEGORIZED = '未分类';

function id(value: unknown): string | null {
  return (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.trim()) ? String(value) : null;
}

/** JSON literals only. This deliberately does not execute scripts supplied by the website. */
function jsonLiteral(source: string, start: number): any {
  const open = source[start];
  if (open !== '{' && open !== '[') throw new Error('官网首页商品配置格式已变化');
  let depth = 0; let quoted = false; let escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      depth--;
      if (depth === 0) return JSON.parse(source.slice(start, index + 1));
    }
  }
  throw new Error('官网首页商品配置不完整');
}

export function parseCMSCategoryConfig(html: string): CMSCategoryConfig {
  const settings = html.match(/\b(?:var|let|const)\s+pageSetting\s*=\s*\{([\s\S]*?)\n\s*\}/)?.[1];
  const storeId = settings?.match(/\bstoreId\s*:\s*["'](\d+)["']/)?.[1]
    ?? html.match(/\bstoreProductRequest\.storeId\s*=\s*["'](\d+)["']/)?.[1];
  if (!storeId) throw new Error('官网首页没有可读取的店铺配置');
  const widgets: Record<string, any>[] = [];
  const expressions = [
    /\bstoreProductRequest\s*=\s*(?=\{)/g,
    /\bproductWidgetList\s*=\s*(?=\[)/g,
    /\bproductWidgetList\.push\s*\(\s*(?=\{)/g,
  ];
  for (const expression of expressions) {
    for (const match of html.matchAll(expression)) {
      const literal = jsonLiteral(html, match.index! + match[0].length);
      for (const widget of Array.isArray(literal) ? literal : [literal]) {
        if (!widget || typeof widget !== 'object' || !id(widget.pageWidgetId) || !id(widget.productWidgetId)) continue;
        if (!widgets.some(item => String(item.pageWidgetId) === String(widget.pageWidgetId) && String(item.productWidgetId) === String(widget.productWidgetId))) {
          widgets.push({...widget, storeId});
        }
      }
    }
  }
  if (!widgets.length) throw new Error('官网首页没有可读取的商品组件');
  return {storeId, widgets};
}

function validateHomeURL(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'cms.guanaitong.com' || !/^\/product\/\d+\/\d+\.html$/.test(url.pathname)) {
    throw new Error('这张卡的官网首页暂不支持分类读取');
  }
  return url;
}

async function loadPublicHomeHTML(url: string): Promise<string> {
  const response = await fetch(url, {signal: AbortSignal.timeout(20_000), redirect: 'error'});
  if (!response.ok) throw new Error(`官网首页读取失败（${response.status}）`);
  const html = await response.text();
  if (html.length > 2_000_000) throw new Error('官网首页配置超出读取上限');
  return html;
}

function unwrapCategory(body: any): any {
  if (body?.code === 1134301002) throw new Error('官网分类会话已过期');
  if (body?.code !== 0 || body.data == null) throw new Error('官网分类接口暂时不可用');
  return body.data;
}

/** suitType is the CMS field appended as product_type by official getPdUrl(). */
export function cmsProductSourceId(row: any): string {
  const code = id(row?.productCode); const inventory = id(row?.inventoryId);
  const productType = id(row?.suitType ?? 1);
  if (!code || !inventory || !productType) throw new Error('官网分类商品字段已变化');
  return `${code}:${inventory}:${productType}`;
}

function nonnegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function queryAllProducts(request: CategoryRequest, params: Record<string, any>, pageSize: number): Promise<string[]> {
  const sources = new Set<string>(); let total: number | null = null; let count = 0;
  for (let page = 1; page <= 500; page++) {
    const data = unwrapCategory(await request('product/cmsQueryProduct', {...params, page, limit: pageSize, total: 0}, 'POST_JSON'));
    if (!Array.isArray(data.dataList)) throw new Error('官网分类商品列表格式已变化');
    const currentTotal = nonnegativeInteger(data.totalCount);
    if (total === null) total = currentTotal;
    else if (currentTotal !== null && total !== currentTotal) throw new Error('官网分类商品数量在同步期间发生变化');
    if (data.hasNext != null && typeof data.hasNext !== 'boolean') throw new Error('官网分类分页格式已变化');
    for (const row of data.dataList) {
      const source = cmsProductSourceId(row);
      if (params.inventoryId && String(row.inventoryId) !== String(params.inventoryId)) throw new Error('官网分类接口返回了其他兑换分组的商品');
      if (sources.has(source)) throw new Error('官网分类分页重复，已保留原分类');
      sources.add(source);
    }
    count += data.dataList.length;
    if (data.hasNext === false || (data.hasNext == null && (total !== null ? count >= total : data.dataList.length < pageSize))) {
      if (total !== null && count !== total) throw new Error(`官网分类商品读取不完整（${count}/${total}）`);
      return [...sources];
    }
    if (data.dataList.length === 0) throw new Error('官网分类分页返回空页');
  }
  throw new Error('官网分类商品超过同步上限');
}

interface CategoryFilter { inventoryId: string; categoryId: string; names: string[]; }
function categoryFilters(data: unknown): CategoryFilter[] {
  if (!Array.isArray(data)) throw new Error('官网分类树格式已变化');
  const filters: CategoryFilter[] = [];
  const seen = new Map<string, CategoryFilter>();
  function visit(inventoryId: string, nodes: any[], parents: string[], ancestry: Set<string>) {
    if (parents.length >= 12) throw new Error('官网分类树超过层级上限');
    for (const node of nodes) {
      const categoryId = id(node?.categoryId);
      const name = typeof node?.name === 'string' ? node.name.trim() : '';
      if (!categoryId || !name) throw new Error('官网分类名称或标识缺失');
      if (ancestry.has(categoryId)) throw new Error('官网分类树出现循环');
      const names = [...parents, name];
      const key = `${inventoryId}:${categoryId}`;
      const existing = seen.get(key);
      if (existing) existing.names = [...new Set([...existing.names, ...names])];
      else { const filter = {inventoryId, categoryId, names}; filters.push(filter); seen.set(key, filter); }
      if (node.subCategoryList != null) {
        if (!Array.isArray(node.subCategoryList)) throw new Error('官网子分类格式已变化');
        visit(inventoryId, node.subCategoryList, names, new Set([...ancestry, categoryId]));
      }
    }
  }
  for (const inventory of data) {
    const inventoryId = id(inventory?.inventoryId);
    if (!inventoryId || !Array.isArray(inventory.productCategoryList)) throw new Error('官网兑换分组格式已变化');
    // Inventory names can be price tiers; only productCategoryList is a product taxonomy.
    visit(inventoryId, inventory.productCategoryList, [], new Set());
  }
  return filters;
}

async function boundedMap<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length); let next = 0;
  await Promise.all(Array.from({length: Math.min(3, items.length)}, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  }));
  return results;
}

/**
 * Every API call uses the caller's isolated card session. Classification failures are
 * returned as warnings, so they cannot discard a successful balance/catalog snapshot.
 */
export async function fetchProductCategories(request: CategoryRequest, homeURL: string, cardId: string, options: CategoryOptions = {}): Promise<ProductCategoryResult> {
  const result: ProductCategoryResult = {cardId, bySourceId: {}, sourceIds: [], warnings: [], complete: true};
  const warnings = new Set<string>();
  const categories = new Map<string, Set<string>>();
  const baselineSources = new Set<string>();
  const addWarning = (message: string) => { result.complete = false; warnings.add(message); };
  let config: CMSCategoryConfig;
  let filters: CategoryFilter[];
  const pageSize = options.pageSize ?? 100;
  try {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new Error('分类分页大小无效');
    const home = validateHomeURL(homeURL);
    const html = await (options.loadHomeHTML ?? loadPublicHomeHTML)(home.toString());
    config = parseCMSCategoryConfig(html);
    filters = categoryFilters(unwrapCategory(await request('product/cmsQueryProductCategory', {storeId: config.storeId, isPreview: 2}, 'POST')));
  } catch (error) {
    addWarning(error instanceof Error ? error.message : '官网分类读取失败');
    result.warnings = [...warnings];
    return result;
  }
  const tasks: {params: Record<string, any>; filter?: CategoryFilter}[] = [];
  for (const widget of config.widgets) {
    const base = {...widget, storeId: config.storeId, isPreview: 2, ecappCode: 'card_exchange', sortTypes: [], inventoryId: '', productCategoryId: ''};
    tasks.push({params: base});
    for (const filter of filters) {
      tasks.push({params: {...base, inventoryId: filter.inventoryId, productCategoryId: filter.categoryId}, filter});
    }
  }
  // Bound simultaneous reads to three. Each category's pagination remains sequential.
  const responses = await boundedMap(tasks, async task => {
    try { return {sources: await queryAllProducts(request, task.params, pageSize), error: null}; }
    catch (error) { return {sources: [], error: error instanceof Error ? error.message : '官网分类读取失败'}; }
  });
  for (let index = 0; index < tasks.length; index++) {
    const {filter} = tasks[index]; const {sources, error} = responses[index];
    if (error) { addWarning(`${filter ? filter.names.join(' / ') + '：' : ''}${error}`); continue; }
    if (!filter) { for (const source of sources) baselineSources.add(source); continue; }
    // A failed page never commits a partial category membership.
    for (const source of sources) {
      let names = categories.get(source);
      if (!names) { names = new Set(); categories.set(source, names); }
      for (const name of filter.names) names.add(name);
    }
  }
  // An unmatched source proves "uncategorized" only after every classification
  // query succeeds. Omit uncertain membership so the store can retain old labels.
  if (result.complete) {
    for (const source of baselineSources) if (!categories.has(source)) categories.set(source, new Set([UNCATEGORIZED]));
  }
  result.bySourceId = Object.fromEntries([...categories].map(([source, names]) => [source, [...names]]));
  result.sourceIds = [...baselineSources];
  result.warnings = [...warnings];
  return result;
}
