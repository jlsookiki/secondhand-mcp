# Secondhand MCP

An MCP server for searching secondary marketplaces. Lets Claude and other AI assistants search for deals on Facebook Marketplace and eBay.

## Features

- Search multiple marketplaces from a single interface
- Price filtering with min/max ranges
- Location-based search by city
- Detailed listing inspection (photos, descriptions, seller info)
- Availability filtering — sold/pending items excluded by default
- Works with Claude Desktop, Claude Code, Cursor, and other MCP clients
- Lightweight — no browser dependencies, native HTTP requests

## Supported Marketplaces

| Marketplace | Status | Auth Required |
|-------------|--------|---------------|
| Facebook Marketplace | Working | No |
| eBay | Working | Yes (API keys) |

## Setup

### From Source

```bash
git clone https://github.com/jlsookiki/secondhand-mcp.git
cd secondhand-mcp
npm install
npm run build
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "secondhand": {
      "command": "node",
      "args": ["/path/to/secondhand-mcp/dist/index.js"],
      "env": {
        "EBAY_CLIENT_ID": "your-ebay-client-id",
        "EBAY_CLIENT_SECRET": "your-ebay-client-secret"
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
      "command": "node",
      "args": ["/path/to/secondhand-mcp/dist/index.js"],
      "env": {
        "EBAY_CLIENT_ID": "your-ebay-client-id",
        "EBAY_CLIENT_SECRET": "your-ebay-client-secret"
      }
    }
  }
}
```

eBay credentials are optional — if omitted, eBay will be disabled and only Facebook Marketplace will be available.

## Configuration

### Choosing Marketplaces

By default all marketplaces are enabled. To limit which marketplaces are active, set the `MARKETPLACES` env var (comma-separated):

```json
{
  "env": {
    "MARKETPLACES": "facebook",
    "EBAY_CLIENT_ID": "...",
    "EBAY_CLIENT_SECRET": "..."
  }
}
```

Valid values: `facebook`, `ebay`

### eBay API Keys

eBay uses the official [Browse API](https://developer.ebay.com/api-docs/buy/browse/overview.html). You need a free eBay developer account:

1. Create an account at [developer.ebay.com](https://developer.ebay.com)
2. Create an application to get a Client ID and Client Secret
3. Add them to your MCP config as `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET`

## Tools

### `search_marketplace`

Search for items across marketplaces.

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `query` | Yes | | Search terms |
| `marketplace` | No | `facebook` | `facebook`, `ebay`, or `all` |
| `location` | No | `san francisco` | City to search in |
| `maxPrice` | No | | Maximum price |
| `minPrice` | No | | Minimum price |
| `limit` | No | `20` | Max results |
| `showSold` | No | `false` | Include sold/unavailable items |
| `includeImages` | No | `false` | Include image URLs in output |

### `get_listing_details`

Get full details for a specific listing — description, all photos, seller info, shipping options.

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `listingId` | Yes | | Listing ID from search results |
| `marketplace` | No | `facebook` | `facebook` or `ebay` |

### `list_marketplaces`

List all enabled marketplaces and their status.

## Example Output

```
Found 15 listings for "stroller" on facebook
Location: san francisco

**$25** - Baby stroller
   San Francisco, CA
   ID: 123456789
   1 photo

**$50** - Thule Urban Glide Jogging Stroller
   San Francisco, CA
   ID: 987654321
   1 photo
```

Use `get_listing_details` with a listing ID to see full photos, description, and seller info.

## How It Works

**Facebook Marketplace** — Uses Facebook's internal GraphQL API to search listings directly. No login, no browser automation. Resolves city names to coordinates, then searches with location/price/query filters. Uses undocumented `doc_id` endpoints that may need updating if Facebook changes their frontend.

**eBay** — Uses the official eBay Browse API with OAuth 2.0 client credentials. Tokens are cached and auto-refreshed.

## Adding New Marketplaces

1. Create a new file in `src/marketplaces/` (e.g., `craigslist.ts`)
2. Extend `BaseMarketplace` and implement `search()` and optionally `getListingDetails()`
3. Add the constructor to the `allMarketplaces` registry in `src/marketplaces/index.ts`

## Development

```bash
npm install
npm run build
```

## Limitations

- **Facebook Marketplace**: Uses undocumented GraphQL API — may break if Facebook changes `doc_id` values (constants in `src/marketplaces/facebook.ts`)
- **Rate limiting**: Don't make too many requests too quickly
- **eBay**: Requires developer API keys (free tier available)

## License

MIT

## Disclaimer

This tool is for personal use. Respect each marketplace's Terms of Service.
