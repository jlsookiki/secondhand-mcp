[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/jlsookiki-secondhand-mcp-badge.png)](https://mseep.ai/app/jlsookiki-secondhand-mcp)
[![Verified on MseeP](https://mseep.ai/badge.svg)](https://mseep.ai/app/3c5664f0-af0e-47f3-8027-de49f25cad5c)

# Secondhand MCP

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that lets AI assistants search secondhand marketplaces. Search Facebook Marketplace, eBay, Depop, Poshmark, and Play It Again Sports for used and secondhand items — filter by price, category, condition, size, and color, then get full listing details with photos, descriptions, and seller info.

Works with Claude Desktop, Claude Code, Cursor, and other clients that run MCP servers locally.

> [!TIP]
> **Using ChatGPT? This one won't work there.**
>
> It runs on your computer, so it only works where your computer is — Claude Desktop, Claude Code, Cursor. [Secondhand MCP Cloud](https://secondhandmcp.com) is the same search, always on, so whichever assistant you actually use can reach it. Free tier, no card.

| | This repo | [Cloud](https://secondhandmcp.com) |
|---|---|---|
| Claude Desktop, Code, Cursor | ✅ | ✅ |
| ChatGPT, Claude, and other assistants | — | ✅ |
| Searching from your phone | — | ✅ |
| Chrome running in the background | needed | not needed |
| Price | free, forever | free tier, then $4.99 | USD/CAD; starting price if options |

## Supported Marketplaces

| Marketplace | Auth Required | Notes |
|-------------|---------------|-------|
| Facebook Marketplace | No | Location-based search |
| eBay | Yes (API keys) | Official Browse API |
| Depop | No | Requires Chrome installed |
| Poshmark | No | Requires Chrome installed |
| Play It Again Sports | No | Public online sporting-goods inventory; no Chrome required |

### Play It Again Sports

Use `marketplace: "playitagain"` for public online inventory from participating stores. No account, API key, or browser is required. Search results include both new and used equipment; use `condition: "used"` to restrict to listings explicitly marked used.

```json
{
  "marketplace": "playitagain",
  "query": "bauer goalie mask",
  "condition": "used",
  "maxPrice": 500,
  "limit": 20
}
```

Search follows actual storefront pages (at most ten pages per call, with a 45-second overall deadline and 20-second per-request timeout). `limit` and `offset` range from 0 to 120; offset counts matched listings after filtering. Overlapping page listings are deduplicated. Coverage notes report pages inspected and remaining inventory; `totalFound` is the site's unfiltered query count, not a count of verified matches. Filters can leave fewer than `limit` results when the page budget is reached.

- Price bounds are **USD-only** and exclude Canadian-store listings. Without bounds, both USD and CAD listings are returned with explicit currency prefixes. The site initially labels some Canadian products USD in its server HTML, then switches currency in the browser; this adapter uses the product's `Country` custom field for store-native USD/CAD. No currency conversion is performed. Prices exclude tax and shipping. Listings with selectable options show starting prices and require checking the desired option and final price. Price sorting uses nominal amounts rather than exchange rates.
- Supported sorts: relevance, newest, price ascending, and price descending. Condition filters: new, used, or any. Brand, size, color, and category filters match structured fields case-insensitively; use site field values (for example `Size: M`). The equipment brand is `Product Brand`; the site's `brand` field identifies the store. Missing fields do not qualify for a requested filter.
- Location does not restrict the search geographically. Radius, department, sold-inventory, popularity sorting, and finer condition grades are unsupported and produce explicit errors.
- Pass the returned product-path **ID** (such as `/locations/leominster-ma/product/S000152950/Bauer-SUPREME-Jr`) or its full product URL to `get_listing_details`. Numeric storefront IDs alone are insufficient. Details include SKU, available custom fields, store, full-size gallery images, and fulfillment options only when explicitly listed. Out-of-stock, removed, blocked, or malformed product pages return errors.
- Stock is checked at detail-fetch time, not guaranteed by a search result. Online inventory does not cover every store's physical stock. Listed dates and age-group fields are not evidence of equipment manufacture dates. Store-specific shipping and cross-border eligibility still need confirmation.

## Setup

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "secondhand": {
      "command": "npx",
      "args": ["-y", "secondhand-mcp"],
      "env": {
        "EBAY_CLIENT_ID": "your-ebay-client-id",
        "EBAY_CLIENT_SECRET": "your-ebay-client-secret",
        "EBAY_MARKETPLACE_ID": "EBAY_US"
      }
    }
  }
}
```

### Claude Code

Add to `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "secondhand": {
      "command": "npx",
      "args": ["-y", "secondhand-mcp"],
      "env": {
        "EBAY_CLIENT_ID": "your-ebay-client-id",
        "EBAY_CLIENT_SECRET": "your-ebay-client-secret",
        "EBAY_MARKETPLACE_ID": "EBAY_US"
      }
    }
  }
}
```

eBay, Depop, and Poshmark are all optional — if eBay API keys are missing or Chrome isn't installed, those marketplaces are automatically disabled and the rest still work.

### Depop & Poshmark / Chrome Requirement

Depop and Poshmark require a headless browser. If **Google Chrome or Chromium** is installed on your system, both are automatically enabled — no config needed. If Chrome isn't found, they are silently skipped.

On macOS, the first time you search Depop or Poshmark, you may see a system prompt asking to allow Node.js to control Chrome. This is expected — puppeteer needs to launch Chrome in headless mode. Allow it once and it won't ask again.

The browser runs invisibly in the background and only launches when you actually search Depop or Poshmark.

## Configuration

### Choosing Marketplaces

By default all marketplaces are enabled. To limit which are active, set the `MARKETPLACES` env var (comma-separated):

```json
{
  "env": {
    "MARKETPLACES": "facebook,ebay"
  }
}
```

Valid values: `facebook`, `ebay`, `depop`, `poshmark`, `playitagain`

### eBay API Keys

eBay uses the official [Browse API](https://developer.ebay.com/api-docs/buy/browse/overview.html). You need a free eBay developer account:

1. Create an account at [developer.ebay.com](https://developer.ebay.com)
2. Create an application to get a Client ID and Client Secret
3. Add them to your MCP config as `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET`

### eBay Marketplace / Region

By default the server targets the **US** eBay site. To search a different regional marketplace, set the `EBAY_MARKETPLACE_ID` environment variable:

```json
{
  "env": {
    "EBAY_MARKETPLACE_ID": "EBAY_DE"
  }
}
```

Common values:

| Value | Site |
|-------|------|
| `EBAY_US` | ebay.com (default) |
| `EBAY_DE` | ebay.de |
| `EBAY_GB` | ebay.co.uk |
| `EBAY_AU` | ebay.com.au |
| `EBAY_FR` | ebay.fr |
| `EBAY_IT` | ebay.it |
| `EBAY_ES` | ebay.es |
| `EBAY_CA` | ebay.ca |

The full list is available in the [eBay API docs](https://developer.ebay.com/api-docs/static/rest-request-components.html#marketpl).

## Tools

### `search_marketplace`

Search for items across marketplaces.

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `query` | Yes | | Search terms |
| `marketplace` | No | `facebook` | `facebook`, `ebay`, `depop`, `poshmark`, `playitagain`, or `all` |
| `location` | No | `san francisco` | City to search in (Facebook only) |
| `radiusMiles` | No | `25` | Search radius in miles, up to 500 (Facebook only) |
| `maxPrice` | No | | Maximum price |
| `minPrice` | No | | Minimum price |
| `limit` | No | `20` | Max results |
| `showSold` | No | `false` | Include sold items (Facebook only) |
| `includeImages` | No | `false` | Include image URLs in output |
| `sort` | No | `relevance` | Sort order (Depop, Poshmark): `relevance`, `newest`, `most_popular`, `price_low_to_high`, `price_high_to_low` |
| `condition` | No | | Item condition. eBay: `new`, `like_new`, `good`, `fair`. Depop: `new`, `like_new`, `excellent`, `good`, `fair`, `used`. Poshmark: `new` (NWT), `like_new` (NWOT), `good`, `fair` |
| `category` | No | | Product category. Depop: `tops`, `bottoms`, `dresses`, `coats-jackets`, `footwear`, `accessories`, `bags`, `jewellery`, `activewear`, `swimwear`. Poshmark: `Jackets_&_Coats`, `Dresses`, `Shoes`, `Accessories`, etc. |
| `brand` | No | | Brand filter (Poshmark only): e.g. `"Nike"`, `"Levi's"`, `"Gucci"` |
| `department` | No | | Department filter (Poshmark only): `Women`, `Men`, `Kids` |
| `sizes` | No | | Size filter (Depop, Poshmark): e.g. `["S", "M", "L"]` or `["US 9", "US 10"]` |
| `colors` | No | | Color filter (Depop, Poshmark): `black`, `white`, `red`, `blue`, `green`, `yellow`, `orange`, `pink`, `purple`, `brown`, `grey`, `cream`, `multi`, `silver`, `gold` |

**Data returned per marketplace:**

| Field | Facebook | eBay | Depop | Poshmark | Play It Again Sports |
|-------|----------|------|-------|----------|----------------------|
| Title | Yes | Yes | Yes | Yes | Yes |
| Price | Yes | Yes | Yes | Yes | USD/CAD; starting price if options |
| Location | City | City, State | — | — | Store name/location |
| Condition | — | Yes | — | — | When listed |
| Photo count | 1 thumbnail | 1 thumbnail | 1 thumbnail | 1 thumbnail | Full gallery |
| Seller | Yes | Yes | — | — | Store |

### `get_listing_details`

Get full details for a specific listing using an ID from search results.

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `listingId` | Yes | | Listing ID from search results |
| `marketplace` | No | `facebook` | `facebook`, `ebay`, `depop`, `poshmark`, or `playitagain` |

**Data returned per marketplace:**

| Field | Facebook | eBay | Depop | Poshmark | Play It Again Sports |
|-------|----------|------|-------|----------|----------------------|
| Description | Yes | Yes | Yes | Yes | When listed; custom fields/SKU/current price |
| All photos | Yes | Yes | Yes | Yes | When listed |
| Location | City | City, State, Country | — | — | Store name/location |
| Seller | Name | Username | Username | Username | Store |
| Delivery types | Yes | — | — | — | Explicit store fulfillment options |
| Shipping | Yes/No | Service codes | Yes/No | Always included | When explicitly listed |

### `list_marketplaces`

List all enabled marketplaces and their status.

### `search` / `fetch` (deep research)

Convenience pair following the [ChatGPT Deep Research tool contract](https://developers.openai.com/api/docs/guides/deep-research) — exact names, a single string argument each:

- `search(query)` — searches every enabled marketplace at once and returns `{ results: [{ id, title, text, url }] }`, where `id` is `marketplace:listingId`
- `fetch(id)` — returns full listing details for a `search` result ID as `{ id, title, text, url, metadata }`

Useful for research-style clients that expect these standard tool names; for filtered searches use `search_marketplace`.

## How It Works

**Facebook Marketplace** — Searches listings by location, radius, price, and query. Resolves city names to coordinates. No login or browser needed. Facebook serves non-browser callers a gated version of its search API from time to time (a single result with more pages behind it, or stubs with no listing inside); when that happens the server reads the logged-out search page instead, which still carries a full first page of results.

**eBay** — Uses the official eBay Browse API with OAuth 2.0 client credentials. Tokens are cached and auto-refreshed. The target regional marketplace is controlled by `EBAY_MARKETPLACE_ID` (default: `EBAY_US`).

**Depop** — Uses a headless browser to search listings with support for category, condition, size, and color filters. The browser instance is shared across requests.

**Play It Again Sports** — Reads public server-rendered storefront data and product JSON-LD over HTTP. Reports bounded search coverage and store-native currency; details recheck stock, current price and explicit fulfillment options. See the source-specific limits above.

**Poshmark** — Uses a headless browser to search listings with support for condition, size, color, sort, and price filters. Poshmark is not location-based — all items ship nationally.

## Development

```bash
git clone https://github.com/jlsookiki/secondhand-mcp.git
cd secondhand-mcp
npm install
npm run build
```

### Adding a Marketplace

1. Create a new file in `src/marketplaces/`
2. Extend `BaseMarketplace` and implement `search()` and optionally `getListingDetails()`
3. Add the constructor to `allMarketplaces` in `src/marketplaces/index.ts`

## Limitations

- **Facebook**: May break if Facebook changes their frontend
- **eBay**: Requires developer API keys (free tier available)
- **Depop**: Requires Chrome/Chromium installed; slower than Facebook/eBay (~5s per search)
- **Poshmark**: Requires Chrome/Chromium installed; no official API so relies on page scraping
- **Rate limiting**: Don't make too many requests too quickly

## License

MIT
