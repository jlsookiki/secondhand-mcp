import { describe, expect, it, vi } from 'vitest';
import { FacebookMarketplace } from '../src/marketplaces/facebook/index.js';
import { listingFacts } from '../src/marketplaces/facebook/details.js';
import { listingAvailability } from '../src/marketplaces/facebook/parse.js';

// The Facebook transport builds a ProxyAgent from SMARTPROXY_URL at module evaluation.
vi.mock('undici', () => ({ ProxyAgent: class {} }));

const GRAPHQL_URL = 'https://www.facebook.com/api/graphql/';
const PHOTOS_DOC_ID = '10059604367394414';
const INFO_DOC_ID = '26090240497332612';

interface GraphQLRequest {
  url: string;
  docId: string;
  variables: any;
}

function stubFetch(handler: (req: GraphQLRequest) => Response | Promise<Response>) {
  const calls: GraphQLRequest[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body ?? ''));
    const req: GraphQLRequest = {
      url: String(input),
      docId: body.get('doc_id') ?? '',
      variables: JSON.parse(body.get('variables') ?? 'null'),
    };
    calls.push(req);
    return handler(req);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const detailsBody = (target: unknown) => ({
  data: { viewer: { marketplace_product_details_page: { target } } },
});

const photosTarget = (photos: unknown[]) => ({ listing_photos: photos });

const photo = (uri: string) => ({ image: { uri } });

const infoTarget = (over: Record<string, unknown> = {}) => ({
  redacted_description: { text: 'Barely ridden, garage kept.' },
  location_text: { text: 'Oakland, CA' },
  location: { latitude: 37.8, longitude: -122.27 },
  marketplace_listing_seller: { name: 'Ada L.' },
  delivery_types: ['LOCAL_PICK_UP', 'SHIPPING'],
  is_shipping_offered: true,
  ...over,
});

/** Serves each doc_id its own target, so a field read from the wrong call shows up. */
const stubDetails = (photos: unknown, info: unknown) =>
  stubFetch(({ docId }) => json(detailsBody(docId === PHOTOS_DOC_ID ? photos : info)));

const getDetails = (listingId = '9182736') =>
  new FacebookMarketplace().getListingDetails(listingId);

describe('detail requests', () => {
  it('issues both detail calls, in parallel, before either answers', async () => {
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { mock, calls } = stubFetch(({ docId }) =>
      docId === PHOTOS_DOC_ID ? held : json(detailsBody(infoTarget()))
    );

    const pending = getDetails();
    expect(mock).toHaveBeenCalledTimes(2);

    release(json(detailsBody(photosTarget([photo('https://scontent.fb.com/a.jpg')]))));
    const details = await pending;

    expect(calls.map((c) => c.docId).sort()).toEqual([INFO_DOC_ID, PHOTOS_DOC_ID].sort());
    expect(calls.every((c) => c.url === GRAPHQL_URL)).toBe(true);
    expect(details.images).toEqual(['https://scontent.fb.com/a.jpg']);
  });

  it('sends the listing id as the target of each call', async () => {
    const { calls } = stubDetails(photosTarget([]), infoTarget());

    await getDetails('4455667788');

    const photos = calls.find((c) => c.docId === PHOTOS_DOC_ID)!;
    const info = calls.find((c) => c.docId === INFO_DOC_ID)!;
    expect(photos.variables).toEqual({ targetId: '4455667788' });
    expect(info.variables).toMatchObject({
      targetId: '4455667788',
      scale: 2,
      feedLocation: 'MARKETPLACE_MEGAMALL',
    });
  });
});

describe('detail parsing', () => {
  it('maps a full response onto the public shape', async () => {
    stubDetails(
      photosTarget([
        photo('https://scontent.fb.com/1.jpg'),
        photo('https://scontent.fb.com/2.jpg'),
      ]),
      infoTarget()
    );

    const details = await getDetails('9182736');

    expect(details).toEqual({
      id: '9182736',
      description: 'Barely ridden, garage kept.',
      images: ['https://scontent.fb.com/1.jpg', 'https://scontent.fb.com/2.jpg'],
      location: 'Oakland, CA',
      locationCoords: { latitude: 37.8, longitude: -122.27 },
      seller: 'Ada L.',
      deliveryTypes: ['LOCAL_PICK_UP', 'SHIPPING'],
      isShippingOffered: true,
      url: 'https://www.facebook.com/marketplace/item/9182736',
    });
  });

  it('keeps photo order and takes them from the photos call alone', async () => {
    stubDetails(
      photosTarget([photo('https://scontent.fb.com/1.jpg'), photo('https://scontent.fb.com/2.jpg')]),
      infoTarget({ listing_photos: [photo('https://scontent.fb.com/wrong.jpg')] })
    );

    const details = await getDetails();

    expect(details.images).toEqual([
      'https://scontent.fb.com/1.jpg',
      'https://scontent.fb.com/2.jpg',
    ]);
  });

  it('skips photo entries with no usable uri', async () => {
    stubDetails(
      photosTarget([
        photo('https://scontent.fb.com/1.jpg'),
        { image: null },
        { image: {} },
        {},
        null,
        photo('https://scontent.fb.com/2.jpg'),
      ]),
      infoTarget()
    );

    const details = await getDetails();

    expect(details.images).toEqual([
      'https://scontent.fb.com/1.jpg',
      'https://scontent.fb.com/2.jpg',
    ]);
  });

  it.each([
    ['an empty photo list', photosTarget([])],
    ['a target with no listing_photos', {}],
    ['listing_photos that is not an array', { listing_photos: { edges: [] } }],
    ['a null target', null],
  ])('returns an empty image list for %s', async (_label, photos) => {
    stubDetails(photos, infoTarget());

    const details = await getDetails();

    expect(details.images).toEqual([]);
    expect(details.description).toBe('Barely ridden, garage kept.');
  });

  it('fills in only the fields the info target carries', async () => {
    stubDetails(
      photosTarget([photo('https://scontent.fb.com/1.jpg')]),
      { redacted_description: { text: 'No frills.' }, is_shipping_offered: false }
    );

    const details = await getDetails();

    expect(details.description).toBe('No frills.');
    expect(details.isShippingOffered).toBe(false);
    expect(details.location).toBeUndefined();
    expect(details.locationCoords).toBeUndefined();
    expect(details.seller).toBeUndefined();
    expect(details.deliveryTypes).toBeUndefined();
    expect(details.images).toEqual(['https://scontent.fb.com/1.jpg']);
  });

  it('turns null leaf fields into undefined rather than null', async () => {
    stubDetails(
      photosTarget([]),
      infoTarget({
        redacted_description: null,
        location_text: null,
        location: null,
        marketplace_listing_seller: null,
        delivery_types: null,
        is_shipping_offered: null,
      })
    );

    const details = await getDetails();

    expect(details).toEqual({
      id: '9182736',
      images: [],
      url: 'https://www.facebook.com/marketplace/item/9182736',
    });
  });

  it.each([
    ['a null target', detailsBody(null)],
    ['no details page', { data: { viewer: {} } }],
    ['no viewer', { data: {} }],
    ['no data', {}],
  ])('fails rather than answer with an empty listing when the response has %s', async (_label, body) => {
    stubFetch(() => json(body));

    await expect(getDetails('123')).rejects.toThrow('Facebook returned no listing 123');
  });
});

describe('detail failures', () => {
  it('fails for a listing Facebook no longer returns', async () => {
    stubFetch(() => json({ ...detailsBody(null), errors: [{ message: 'not found' }] }));

    await expect(getDetails()).rejects.toThrow('Facebook returned no listing 9182736');
  });

  it('marks the photos unavailable when only the photos call fails', async () => {
    stubFetch(({ docId }) =>
      docId === PHOTOS_DOC_ID ? new Response(null, { status: 404 }) : json(detailsBody(infoTarget()))
    );

    await expect(getDetails()).resolves.toMatchObject({ unavailable: ['photos'] });
  });

  it('marks the description unavailable when the info call returns no listing', async () => {
    stubDetails(photosTarget([photo('https://cdn/a.jpg')]), null);

    await expect(getDetails()).resolves.toMatchObject({ images: ['https://cdn/a.jpg'], unavailable: ['description'] });
  });

  it('marks nothing unavailable when both parts arrive', async () => {
    stubDetails(photosTarget([]), infoTarget());

    expect((await getDetails()).unavailable).toBeUndefined();
  });

  it('keeps the description and seller when the photos call fails', async () => {
    stubFetch(({ docId }) =>
      docId === PHOTOS_DOC_ID
        ? new Response(null, { status: 404 })
        : json(detailsBody(infoTarget()))
    );

    const details = await getDetails();

    expect(details.images).toEqual([]);
    expect(details.description).toBe('Barely ridden, garage kept.');
    expect(details.seller).toBe('Ada L.');
  });

  it('keeps the photos when the info call fails', async () => {
    stubFetch(({ docId }) =>
      docId === INFO_DOC_ID
        ? new Response(null, { status: 403 })
        : json(detailsBody(photosTarget([photo('https://cdn/a.jpg')])))
    );

    const details = await getDetails();

    expect(details.images).toEqual(['https://cdn/a.jpg']);
    expect(details.description).toBeUndefined();
  });

  it('fails with the photos error when both calls fail', async () => {
    stubFetch(({ docId }) =>
      docId === PHOTOS_DOC_ID
        ? new Response(null, { status: 404 })
        : json({ errors: [{ message: 'Please try again later' }] })
    );

    await expect(getDetails()).rejects.toThrow('404');
  });

  it('reads the data that arrives alongside a partial GraphQL error', async () => {
    stubFetch(({ docId }) =>
      docId === INFO_DOC_ID
        ? json({ ...detailsBody(infoTarget()), errors: [{ message: 'field failed' }] })
        : json(detailsBody(photosTarget([])))
    );

    await expect(getDetails()).resolves.toMatchObject({ description: 'Barely ridden, garage kept.' });
  });
});

describe('listing facts', () => {
  const info = (over: Record<string, unknown> = {}) => ({
    marketplace_listing_title: 'Trek road bike',
    listing_price: { formatted_amount: '$400', amount: '400.00', currency: 'USD' },
    strikethrough_price: { formatted_amount: '$500' },
    creation_time: 1790000000,
    attribute_data: [
      { attribute_name: 'Brand', value: 'trek', label: 'Trek' },
      { attribute_name: 'Condition', value: 'used_like_new', label: 'Used - like new' },
    ],
    is_sold: false,
    is_pending: false,
    is_live: true,
    ...over,
  });

  it('reads title, price, the price before a drop, condition, listing date and availability', () => {
    expect(listingFacts(info())).toEqual({
      title: 'Trek road bike',
      price: '$400',
      priceNumeric: 400,
      originalPrice: '$500',
      condition: 'Used - like new',
      listedAt: '2026-09-21T14:13:20.000Z',
      availability: 'available',
    });
  });

  it.each([
    [{ is_sold: true }, 'sold'],
    [{ is_pending: true }, 'pending'],
    [{ is_live: false }, 'unavailable'],
    [{ is_hidden: true }, 'unavailable'],
    [{ is_sold: true, is_pending: true }, 'sold'],
    [{ marketplace_listing_title: 'SOLD - Trek road bike' }, 'sold'],
    [{ marketplace_listing_title: '[sold] Trek road bike' }, 'sold'],
    [{ marketplace_listing_title: ' Sold ' }, 'sold'],
    [{ marketplace_listing_title: 'Soldering iron' }, 'available'],
    [{ is_live: null }, 'available'],
    [{ is_sold: null }, 'available'],
  ])('reads %j as %s, the same as search does', (over, availability) => {
    expect(listingFacts(info(over)).availability).toBe(availability);
    expect(listingAvailability(info(over))).toBe(availability);
  });

  it('says nothing about availability when Facebook sends none of its signals', () => {
    expect(listingAvailability({ marketplace_listing_title: 'Trek road bike' })).toBeUndefined();
  });

  it.each([
    [{ marketplace_listing_title: { text: 'Trek road bike' } }, 'title'],
    [{ marketplace_listing_title: '   ' }, 'title'],
    [{ listing_price: { formatted_amount: 400 } }, 'price'],
    [{ listing_price: { currency: 'USD' } }, 'price'],
    [{ listing_price: { formatted_amount: 'Free' } }, 'priceNumeric'],
    [{ creation_time: '1790000000' }, 'listedAt'],
    [{ attribute_data: [{ attribute_name: 'Condition', label: { text: 'New' } }] }, 'condition'],
    [{ attribute_data: { attribute_name: 'Condition', label: 'New' } }, 'condition'],
  ])('leaves out a field Facebook sends in an unexpected shape: %j', (over, field) => {
    expect(listingFacts(info(over))).not.toHaveProperty(field);
  });

  it('leaves out what the listing does not say', () => {
    expect(listingFacts({})).toEqual({});
    expect(listingFacts(null)).toEqual({});
    const sparse = listingFacts(
      info({ strikethrough_price: null, attribute_data: [], creation_time: null, is_sold: null, is_pending: null, is_live: null })
    );
    expect(sparse).toEqual({ title: 'Trek road bike', price: '$400', priceNumeric: 400 });
  });

  it.each([
    [{ formatted_amount: '$400' }],
    [{ amount: '400.00', currency: 'USD' }],
  ])('drops a price before a drop of %j, which matches the price', (strikethrough) => {
    expect(listingFacts(info({ strikethrough_price: strikethrough }))).not.toHaveProperty('originalPrice');
  });

  it('names a price from its amount and currency when Facebook sends no formatted price', () => {
    expect(listingFacts(info({ listing_price: { amount: '75.00', currency: 'CAD' } }))).toMatchObject({
      price: '75.00 CAD',
      priceNumeric: 75,
    });
  });

  it('names a price from its amount alone when Facebook sends no currency', () => {
    expect(listingFacts(info({ listing_price: { amount: '75.00' } })).price).toBe('75.00');
  });

  it('takes the condition value when the entry has no label', () => {
    expect(listingFacts(info({ attribute_data: [{ attribute_name: 'condition', value: 'new' }] })).condition).toBe('new');
  });

  it('carries the facts on a listing view', async () => {
    stubDetails(photosTarget([]), infoTarget(info()));

    const details = await getDetails();

    expect(details).toMatchObject({
      title: 'Trek road bike',
      price: '$400',
      condition: 'Used - like new',
      listedAt: '2026-09-21T14:13:20.000Z',
      availability: 'available',
      description: 'Barely ridden, garage kept.',
    });
  });
});
