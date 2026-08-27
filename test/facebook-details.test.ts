import { describe, expect, it, vi } from 'vitest';
import { FacebookMarketplace } from '../src/marketplaces/facebook.js';

// facebook.ts builds a ProxyAgent from SMARTPROXY_URL at module evaluation.
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
  ])('still returns an identified listing when the response has %s', async (_label, body) => {
    stubFetch(() => json(body));

    const details = await getDetails('123');

    expect(details).toEqual({
      id: '123',
      images: [],
      url: 'https://www.facebook.com/marketplace/item/123',
    });
  });
});

describe('detail failures', () => {
  it('fails when the photos call fails', async () => {
    stubFetch(({ docId }) =>
      docId === PHOTOS_DOC_ID
        ? new Response(null, { status: 404 })
        : json(detailsBody(infoTarget()))
    );

    await expect(getDetails()).rejects.toThrow('404');
  });

  it('fails when the info call fails', async () => {
    stubFetch(({ docId }) =>
      docId === INFO_DOC_ID
        ? new Response(null, { status: 403 })
        : json(detailsBody(photosTarget([])))
    );

    await expect(getDetails()).rejects.toThrow('403');
  });

  it('surfaces a GraphQL error body from either call', async () => {
    stubFetch(({ docId }) =>
      docId === INFO_DOC_ID
        ? json({ errors: [{ message: 'Please try again later' }] })
        : json(detailsBody(photosTarget([])))
    );

    await expect(getDetails()).rejects.toThrow(
      'Facebook GraphQL error: Please try again later'
    );
  });
});
