[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/jlsookiki-secondhand-mcp-badge.png)](https://mseep.ai/app/jlsookiki-secondhand-mcp)
[![Verified on MseeP](https://mseep.ai/badge.svg)](https://mseep.ai/app/3c5664f0-af0e-47f3-8027-de49f25cad5c)

# Secondhand MCP

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that lets AI assistants search secondhand marketplaces. Search Facebook Marketplace, eBay, Depop, Poshmark, and Geartrade for used and secondhand items — filter by price, category, condition, size, and color, then get full listing details with photos, descriptions, and seller info.

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
| Price | free, forever | free tier, then $4.99 |

## Supported Marketplaces

| Marketplace | Auth Required | Notes |
|-------------|---------------|-------|
| Facebook Marketplace | No | Location-based search |
| eBay | Yes (API keys) | Official Browse API |
| Depop | No | Requires Chrome installed |
| Poshmark | No | Requires Chrome installed |

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

Valid values: `facebook`, `ebay`, `depop`, `poshmark`, `geartrade`

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
| `marketplace` | No | `facebook` | `facebook`, `ebay`, `depop`, `poshmark`, `geartrade`, or `all` |
| `location` | No | `san francisco` | City to search in (Facebook only) |
| `radiusMiles` | No | `25` | Search radius in miles, up to 500 (Facebook only) |
| `maxPrice` | No | | Maximum price |
| `minPrice` | No | | Minimum price |
| `limit` | No | `20` | Max results; Geartrade 0–50 within its bounded scan |
| `offset` | No | `0` | eBay result offset; Geartrade matching-variant offset within its bounded scan |
| `showSold` | No | `false` | Include sold/unavailable items; Geartrade includes unavailable variants returned by its storefront, not guaranteed sold history |
| `includeImages` | No | `false` | Include image URLs in output |
| `sort` | No | `relevance` | Sort order (Depop, Poshmark; Geartrade supports relevance and price sorts): `relevance`, `newest`, `most_popular`, `price_low_to_high`, `price_high_to_low` |
| `condition` | No | | Item condition. eBay: `new`, `like_new`, `good`, `fair`. Depop: `new`, `like_new`, `excellent`, `good`, `fair`, `used`. Poshmark: `new` (NWT), `like_new` (NWOT), `good`, `fair`. Geartrade: `new`, `good`, `excellent`, `fair`, `used`, `any` |
| `category` | No | | Product category. Depop: `tops`, `bottoms`, `dresses`, `coats-jackets`, `footwear`, `accessories`, `bags`, `jewellery`, `activewear`, `swimwear`. Poshmark: `Jackets_&_Coats`, `Dresses`, `Shoes`, `Accessories`, etc. Geartrade: exact product type, e.g. `Alpine Skis w/ Bindings` |
| `brand` | No | | Brand filter (Poshmark, Geartrade): e.g. `"Nike"`, `"Levi's"`, `"Gucci"` |
| `department` | No | | Department filter (Poshmark only): `Women`, `Men`, `Kids` |
| `sizes` | No | | Size filter (Depop, Poshmark, Geartrade exact size labels): e.g. `["S", "M", "L"]` or `["US 9", "US 10"]` |
| `colors` | No | | Color filter (Depop, Poshmark): `black`, `white`, `red`, `blue`, `green`, `yellow`, `orange`, `pink`, `purple`, `brown`, `grey`, `cream`, `multi`, `silver`, `gold` |

**Data returned per marketplace:**

| Field | Facebook | eBay | Depop | Poshmark | Geartrade |
|-------|----------|------|-------|----------|-----------|
| Title | Yes | Yes | Yes | Yes | Yes |
| Price | Yes | Yes | Yes | Yes | USD asking price |
| Location | City | City, State | — | — | — |
| Condition | — | Yes | — | — | Explicit source description, when present |
| Photo count | 1 thumbnail | 1 thumbnail | 1 thumbnail | 1 thumbnail | Product photos |
| Seller | Yes | Yes | — | — | — |

### `get_listing_details`

Get full details for a specific listing using an ID from search results.

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `listingId` | Yes | | Listing ID from search results |
| `marketplace` | No | `facebook` | `facebook`, `ebay`, `depop`, `poshmark`, or `geartrade` |

**Data returned per marketplace:**

| Field | Facebook | eBay | Depop | Poshmark | Geartrade |
|-------|----------|------|-------|----------|-----------|
| Description | Yes | Yes | Yes | Yes | Yes, with variant price/stock |
| All photos | Yes | Yes | Yes | Yes | Product photos |
| Location | City | City, State, Country | — | — | — |
| Seller | Name | Username | Username | Username | — |
| Delivery types | Yes | — | — | — | — |
| Shipping | Yes/No | Service codes | Yes/No | Always included | Requirement shown in description; delivery availability not verified |

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

**Poshmark** — Uses a headless browser to search listings with support for condition, size, color, sort, and price filters. Poshmark is not location-based — all items ship nationally.

**Geartrade** — Reads public, paginated Shopify search pages and enriches candidates with product JSON. No login, API key, or browser required. The storefront currency is checked as USD on both searches and detail pages. Each call scans at most three search pages/48 products, with at most three concurrent product requests and a 45-second deadline. Relevance searches stop earlier when enough matching variants are found; price sorts scan the full bounded window before sorting and slicing. The returned coverage note is significant: results are bounded, not exhaustive, and `totalFound` is intentionally omitted.

Geartrade supports keyword search, USD asking-price bounds, exact storefront brand, product type (`category`), size labels, and conditions `new`, `good`, `excellent`, `fair`, `used`, or `any`. `used` includes Good/Excellent/Fair only; Sample and UnNew With Tags are not assumed used. Brand, category, size, stock, condition, and price are rechecked against product data. Supported sorts are `relevance`, `price_low_to_high`, and `price_high_to_low` (prices sorted within the fetched candidates). `limit` is 0–50; `offset` is 0–47 and skips matching variants within the same bounded scan, so large offsets can exhaust its budget. Location/radius are not applied; unsupported department/color filters and sort/condition values return explicit errors.

Each result identifies one variant as `product-handle:variantId`; details accept that ID or a bare product handle. Default searches exclude unavailable variants. `showSold` includes unavailable variants that the storefront search actually returns; unavailability does not prove a completed sale, and historical sold inventory is not guaranteed. Descriptions include the current variant price and stock state. The source shipping requirement is shown in details; delivery availability and costs must be checked on the site. Prices exclude shipping and tax; Shopify's `vendor` is not exposed as a seller. Geartrade contains both new and used outdoor equipment, and its keyword search may return loosely related items (for example, `goalie` can match clothing with “Goals” in its name). Inspect relevance and do not assume it has hockey or baseball inventory.

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
