import assert from 'node:assert/strict';
import test from 'node:test';

import { FacebookMarketplace } from '../dist/marketplaces/facebook.js';

const LOCATION_DOC_ID = '5585904654783609';
const SEARCH_DOC_ID = '7111939778879383';

function listingEdge(id, title, price = 'CA$100') {
  return {
    node: {
      __typename: 'MarketplaceFeedListingStoryObject',
      listing: {
        id,
        marketplace_listing_title: title,
        listing_price: { formatted_amount: price },
        primary_listing_photo: { image: { uri: `https://images.example/${id}.jpg` } },
        location: { reverse_geocode: { city_page: { display_name: 'Nanaimo, BC' } } },
        marketplace_listing_seller: { name: 'Seller' },
        is_sold: false,
        is_live: true,
        is_pending: false,
        is_hidden: false,
      },
    },
  };
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('Facebook search follows opaque cursors, converts radius, and deduplicates listings', async () => {
  const originalFetch = globalThis.fetch;
  const searchVariables = [];

  globalThis.fetch = async (_url, options) => {
    const body = new URLSearchParams(options.body);
    const docId = body.get('doc_id');
    const variables = JSON.parse(body.get('variables'));

    if (docId === LOCATION_DOC_ID) {
      return jsonResponse({
        data: {
          city_street_search: {
            street_results: {
              edges: [{
                node: {
                  subtitle: 'City',
                  single_line_address: 'Nanaimo, British Columbia',
                  location: { latitude: 49.16426, longitude: -123.93617 },
                },
              }],
            },
          },
        },
      });
    }

    assert.equal(docId, SEARCH_DOC_ID);
    searchVariables.push(variables);
    if (!variables.cursor) {
      return jsonResponse({
        data: {
          marketplace_search: {
            feed_units: {
              edges: [listingEdge('1', 'First lamp')],
              page_info: { end_cursor: 'opaque-cursor', has_next_page: true },
            },
          },
        },
      });
    }
    return jsonResponse({
      data: {
        marketplace_search: {
          feed_units: {
            edges: [listingEdge('1', 'First lamp'), listingEdge('2', 'Second lamp', 'CA$150')],
            page_info: { end_cursor: null, has_next_page: false },
          },
        },
      },
    });
  };

  try {
    const marketplace = new FacebookMarketplace();
    const result = await marketplace.search({
      query: 'floor lamp',
      location: 'Nanaimo, British Columbia',
      radius: 40,
      limit: 10,
      maxPages: 3,
      pageDelayMs: 0,
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.listings.map((listing) => listing.id), ['1', '2']);
    assert.equal(searchVariables.length, 2);
    assert.equal(searchVariables[0].params.browse_request_params.filter_radius_km, 64);
    assert.equal(searchVariables[0].cursor, undefined);
    assert.equal(searchVariables[1].cursor, 'opaque-cursor');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Facebook search preserves the legacy one-page, 16 km defaults', async () => {
  const originalFetch = globalThis.fetch;
  const searchVariables = [];

  globalThis.fetch = async (_url, options) => {
    const body = new URLSearchParams(options.body);
    const docId = body.get('doc_id');
    const variables = JSON.parse(body.get('variables'));
    if (docId === LOCATION_DOC_ID) {
      return jsonResponse({
        data: {
          city_street_search: {
            street_results: {
              edges: [{
                node: {
                  subtitle: 'City',
                  single_line_address: 'Nanaimo, British Columbia',
                  location: { latitude: 49.16426, longitude: -123.93617 },
                },
              }],
            },
          },
        },
      });
    }

    searchVariables.push(variables);
    return jsonResponse({
      data: {
        marketplace_search: {
          feed_units: {
            edges: [listingEdge('1', 'First lamp')],
            page_info: { end_cursor: 'unused-cursor', has_next_page: true },
          },
        },
      },
    });
  };

  try {
    const marketplace = new FacebookMarketplace();
    const result = await marketplace.search({ query: 'floor lamp', limit: 20 });
    assert.equal(result.success, true);
    assert.equal(searchVariables.length, 1);
    assert.equal(searchVariables[0].params.browse_request_params.filter_radius_km, 16);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
