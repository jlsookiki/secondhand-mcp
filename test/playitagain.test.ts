import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlayItAgainMarketplace } from '../src/marketplaces/playitagain.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/playitagain/${name}.html`, import.meta.url), 'utf8');
const searchHtml = fixture('search');
const productHtml = fixture('product');
const canadaHtml = fixture('canadian-product');
const context = (html: string) => JSON.parse(JSON.parse(html.match(/stencilBootstrap\([^,]+,\s*("(?:[^"\\]|\\.)*")\)/)![1]));
const document = (data: unknown) => `<script>window.stencilBootstrap("search", ${JSON.stringify(JSON.stringify(data))});</script>`;
const first = context(searchHtml).searchProducts[0];
const canada = context(searchHtml).searchProducts[1];
const single = (p = first) => document({template: 'pages/search', searchProducts: [p], searchProductsPerPage: 1, searchResultsCount: "1 result for 'test'"});
function mockPages(...html: string[]) {
  const mock = vi.fn();
  for (const page of html) mock.mockResolvedValueOnce(new Response(page, {status: 200}));
  vi.stubGlobal('fetch', mock);
  return mock;
}
const marketplace = new PlayItAgainMarketplace();
afterEach(() => vi.unstubAllGlobals());

describe('Play It Again Sports public search', () => {
  it('parses a captured search page with native currency, equipment condition, store, canonical IDs and full-size photos', async () => {
    const fetch = mockPages(searchHtml);
    const result = await marketplace.search({ query: 'bauer 950', limit: 2 });
    expect(result.success).toBe(true);
    expect(result.totalFound).toBe(63);
    expect(result.listings[0]).toMatchObject({id: new URL(first.url).pathname, title: first.name, price: 'USD 39.99', priceNumeric: 39.99, currency: 'USD', seller: 'MA - Leominster', condition: 'Used'});
    expect(result.listings[1]).toMatchObject({currency: 'CAD', price: 'CAD 14.99', seller: 'SK - Saskatoon'});
    expect(result.listings[0].images).toHaveLength(4);
    expect(result.listings[0].images?.every(u => u.includes('/1280x1280/'))).toBe(true);
    expect(result.listings[0].url).not.toContain('?');
    expect(result.note).toContain('additional inventory may remain');
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.searchParams.get('search_query')).toBe('bauer 950');
    expect(fetch.mock.calls[0][1].redirect).toBe('error');
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('uses real page numbers, deduplicates boundary overlap, and applies offset after filtering', async () => {
    const p2 = {...first,id: 2,url: '/locations/boston-ma/product/S0002/Bat'};
    const p3 = {...first,id: 3,url: '/locations/boston-ma/product/S0003/Bat'};
    const mk = (products: unknown[]) => document({template: 'pages/search',searchProducts:products,searchProductsPerPage:2,searchResultsCount:"4 results for 'test'"});
    const fetch = mockPages(mk([first,p2]),mk([p2,p3]));
    const result = await marketplace.search({query:'test',limit:2,offset:1});
    expect(result.success).toBe(true);
    expect(result.listings.map(p => p.id)).toEqual([p2.url,p3.url]);
    expect(fetch.mock.calls.map(([url])=>new URL(String(url)).searchParams.get('page'))).toEqual(['1','2']);
    expect(result.note).toContain('3 unique listings');
  });

  it('applies price bounds only to USD and checks structured equipment fields, not the store brand', async () => {
    mockPages(searchHtml, document({template:'pages/search',searchProducts:[],searchProductsPerPage:12,searchResultsCount:"0 results for 'test'"}));
    const result = await marketplace.search({query:'test', limit:1,minPrice:30,maxPrice:40,brand:' bauer ',condition:'used',colors:['BLACK'], category:'Goalie/Goalie Catchers'});
    expect(result.listings.map(p=>p.url)).toEqual([first.url]);
    expect(result.note).toContain('Canadian listings were excluded');
    mockPages(single(canada));
    expect((await marketplace.search({query:'test',maxPrice:20})).listings).toEqual([]);
  });

  it('does not guess sizes from the title or treat a store as the equipment manufacturer', async () => {
    mockPages(single(first));
    expect((await marketplace.search({query:'test',sizes:['Junior']})).listings).toEqual([]);
    mockPages(single(first));
    expect((await marketplace.search({query:'test',brand:'MA - Leominster'})).listings).toEqual([]);
    const sized = {...first, custom_fields:[...first.custom_fields,{name:'Size',value:'M'}]};
    mockPages(single(sized));
    expect((await marketplace.search({query:'test',sizes:['m']})).listings).toHaveLength(1);
  });

  it('excludes explicit out-of-stock products without assuming a missing stock count is zero', async () => {
    mockPages(single({...first,stock_level:0}));
    expect((await marketplace.search({query:'test'})).listings).toEqual([]);
    mockPages(single({...first,availability:'Out of Stock'}));
    expect((await marketplace.search({query:'test'})).listings).toEqual([]);
    mockPages(single(first));
    expect((await marketplace.search({query:'test'})).listings).toHaveLength(1);
  });

  it('recognizes a genuine zero result response', async () => {
    mockPages(document({template:'pages/search',searchProducts:[],searchProductsPerPage:12,searchResultsCount:"0 results for 'zzz'"}));
    expect(await marketplace.search({query:'zzz'})).toMatchObject({success:true,listings:[],totalFound:0});
  });

  it('stops at ten pages and reports remaining coverage honestly', async () => {
    const pages = Array.from({length:10},(_,i)=>document({template:'pages/search',searchProducts:[{...first,id:i+1}],searchProductsPerPage:1,searchResultsCount:"100 results for 'test'"}));
    const fetch = mockPages(...pages);
    const result = await marketplace.search({query:'test',limit:20});
    expect(result.success).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(10);
    expect(result.listings).toHaveLength(10);
    expect(result.note).toContain('additional inventory may remain');
  });

  it('fails explicitly when pagination repeats or a later page fails', async () => {
    const page = document({template:'pages/search',searchProducts:[first],searchProductsPerPage:1,searchResultsCount:"3 results for 'test'"});
    mockPages(page,page);
    expect(await marketplace.search({query:'test'})).toMatchObject({success:false,listings:[],error:expect.stringContaining('Pagination repeated')});
    mockPages(page,'<html>missing data</html>');
    expect(await marketplace.search({query:'test'})).toMatchObject({success:false,listings:[]});
  });

  it.each([
    ['missing bootstrap','<html></html>'], ['malformed JSON','<script>window.stencilBootstrap("search", "oops");</script>'],
    ['blocked','<title>Just a moment...</title>'],['missing count',document({template:'pages/search',searchProducts:[first],searchProductsPerPage:12})],
    ['inconsistent empty',document({template:'pages/search',searchProducts:[],searchProductsPerPage:12,searchResultsCount:"5 results for 'test'"})],
    ['missing price',single({...first,price:null})],['unknown country',single({...first,custom_fields:[]})],
    ['invalid product URL',single({...first,url:'https://evil.example/item'})],['empty title',single({...first,name:''})],
    ['malformed field',single({...first,custom_fields:[{name:'Country',value:42}]})],
  ])('fails closed on %s',async (_name,html)=>{
    mockPages(html);
    expect(await marketplace.search({query:'test'})).toMatchObject({success:false,listings:[],error:expect.any(String)});
  });

  it('shares an overall deadline across pages and reports aborts instead of claiming partial success',async()=>{
    const overall=new AbortController();
    const timeout=AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>ms===45_000 ? overall.signal : timeout(ms));
    const page=document({template:'pages/search',searchProducts:[first],searchProductsPerPage:1,searchResultsCount:"3 results for 'test'"});
    const fetch=vi.fn().mockResolvedValueOnce(new Response(page)).mockImplementationOnce((_url,options)=>new Promise((_resolve,reject)=>{
      options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});
    }));
    vi.stubGlobal('fetch',fetch);
    try {
      const pending=marketplace.search({query:'test'});
      await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));
      overall.abort(new DOMException('Overall search deadline exceeded','TimeoutError'));
      const result=await pending;
      expect(result).toMatchObject({success:false,listings:[],error:expect.stringContaining('Overall search deadline exceeded')});
      expect(timeoutSpy).toHaveBeenCalledWith(45_000);
    }finally {timeoutSpy.mockRestore();}
  });

  it('reports HTTP and transport failures, and health checks return false', async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('blocked',{status:403})));
    expect((await marketplace.search({query:'test'})).error).toContain('HTTP 403');
    expect(await marketplace.healthCheck()).toBe(false);
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('timeout')));
    expect((await marketplace.search({query:'test'})).error).toContain('timeout');
  });

  it.each([
    {query:''}, {query:'x',limit:121},{query:'x',offset:-1},{query:'x',limit:1.5},
    {query:'x',minPrice:-1},{query:'x',maxPrice:NaN},{query:'x',minPrice:50,maxPrice:10},
    {query:'x',radius:10},{query:'x',department:'Men'},{query:'x',showSold:true},
    {query:'x',condition:'excellent' as const},{query:'x',sort:'most_popular' as const},
  ])('rejects unsupported/invalid parameters before fetching: %j',async params=>{
    const fetch = mockPages();
    expect((await marketplace.search(params)).success).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('returns no listings for limit zero without fetching',async()=>{
    const fetch = mockPages();
    expect((await marketplace.search({query:'test',limit:0})).listings).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('encodes special queries and uses the storefront sorting parameter',async()=>{
    const fetch=mockPages(single());
    await marketplace.search({query:'bat & glove + "32"',sort:'price_low_to_high'});
    const url=new URL(String(fetch.mock.calls[0][0]));
    expect(url.searchParams.get('search_query')).toBe('bat & glove + "32"');
    expect(url.searchParams.get('sort')).toBe('priceasc');
  });
});

describe('Play It Again Sports product details',()=>{
  it('uses JSON-LD description and all gallery images, custom fields, store and explicit fulfillment',async()=>{
    const fetch=mockPages(productHtml);
    const details=await marketplace.getListingDetails(first.url+'?tracking=1');
    expect(details.description).toContain('SKU: 11722-S000152950');
    expect(details.description).toContain('Condition: Used');
    expect(details.description).toContain('Current price: USD 39.99 (before shipping and tax)');
    expect(details.description).toContain('Availability: In stock');
    expect(details.images).toHaveLength(4);
    expect(details.images.every(u=>u.includes('/1280x1280/'))).toBe(true);
    expect(details).toMatchObject({seller:'MA - Leominster',isShippingOffered:true,deliveryTypes:['Pick Up in Store','Standard Shipping']});
    expect(String(fetch.mock.calls[0][0])).toBe(first.url);
  });
  it('corrects a Canadian PDP whose initial JSON-LD misleadingly says USD',async()=>{
    expect(canadaHtml).toContain('"priceCurrency": "USD"');
    mockPages(canadaHtml);
    const details=await marketplace.getListingDetails(canada.url);
    expect(details.description).toContain('Price currency: CAD');
    expect(details.description).toContain('Current price: CAD 14.99');
    expect(details.images).toHaveLength(2);
  });
  it('handles the captured missing-description template bug without inventing description or variant fit',async()=>{
    const html=fixture('variant-product');
    expect(html).toContain('"description": ,');
    mockPages(html);
    const details=await marketplace.getListingDetails(context(html).productUrl);
    expect(details.description).toContain('Seller description: not provided');
    expect(details.description).toContain('Selectable options: verify the desired size and final price');
    expect(details.isShippingOffered).toBe(false);
    expect(details.description).toContain('Current price: CAD 239.99–249.99 (options vary)');
  });
  it('marks option search prices as starting prices',async()=>{
    mockPages(single({...first,has_options:true}));
    const result=await marketplace.search({query:'mask'});
    expect(result.listings[0].price).toBe('USD 39.99 (from; select options)');
    expect(result.listings[0].description).toContain('verify the desired size and final price');
  });
  it('reports removed products as HTTP errors',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('not found',{status:404})));
    await expect(marketplace.getListingDetails(first.url)).rejects.toThrow('HTTP 404');
  });
  it('never promises shipping when the product field is absent or says No',async()=>{
    for(const value of [undefined,'No']) {
      const html=productHtml;
      const data=context(html); data.customFields=data.customFields.filter((f: {name:string})=>f.name!=='Standard Shipping');
      if(value) data.customFields.push({name:'Standard Shipping',value});
      const changed=html.replace(/window\.stencilBootstrap\([^,]+,\s*("(?:[^"\\]|\\.)*")\)/,`window.stencilBootstrap("product", ${JSON.stringify(JSON.stringify(data))})`);
      mockPages(changed);
      expect((await marketplace.getListingDetails(first.url)).isShippingOffered).toBe(value==='No' ? false : undefined);
    }
  });
  it('rejects out of stock, mismatched, removed or malformed pages',async()=>{
    for(const html of [productHtml.replace('\\"isInStock\\": true','\\"isInStock\\": false'),searchHtml,'<html>404</html>',productHtml.replace('"@type": "Product"','"@type": "Unknown"')]) {
      mockPages(html);
      await expect(marketplace.getListingDetails(first.url)).rejects.toThrow();
    }
  });
  it.each(['1234','https://evil.example/locations/a/product/b/c','//evil.example/locations/a/product/b/c','https://playitagainsports.com/search.php','https://playitagainsports.com:444/locations/a/product/b/c'])('rejects invalid IDs before networking: %s',async id=>{
    const fetch=mockPages();
    await expect(marketplace.getListingDetails(id)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Play It Again Sports tool integration',()=>{
  it('routes registered search and detail tools and exposes coverage notes',async()=>{
    const {registerMarketplace}=await import('../src/marketplaces/index.js');
    const {searchMarketplace}=await import('../src/tools/search-marketplace.js');
    const {listingDetails}=await import('../src/tools/listing-details.js');
    registerMarketplace(new PlayItAgainMarketplace());
    mockPages(searchHtml);
    const search=await searchMarketplace({query:'bauer 950',marketplace:'playitagain',limit:1});
    expect(search.content[0]).toMatchObject({type:'text',text:expect.stringContaining('additional inventory may remain')});
    expect(search.content[0]).toMatchObject({text:expect.stringContaining('USD 39.99')});
    mockPages(productHtml);
    const details=await listingDetails({listingId:first.url,marketplace:'playitagain',maxImages:0});
    expect(details.content[0]).toMatchObject({type:'text',text:expect.stringContaining('11722-S000152950')});
    expect(details.content[0]).toMatchObject({text:expect.stringContaining('4 photos')});
  });
});
