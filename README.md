# 🛒 Secondhand MCP

An MCP (Model Context Protocol) server for searching secondary marketplaces. Lets Claude and other AI assistants search for deals on Facebook Marketplace, eBay, Craigslist, and more.

## Features

- 🔍 **Search multiple marketplaces** from a single interface
- 💰 **Price filtering** - set min/max price ranges
- 📍 **Location-based search** - search by city
- 🤖 **MCP-compatible** - works with Claude Desktop, Cursor, and other MCP clients
- 🔓 **No login required** - works without authentication
- ⚡ **Lightweight** - no browser dependencies, uses native HTTP requests
- 🧩 **Extensible** - easy to add new marketplaces

## Supported Marketplaces

| Marketplace | Status | Notes |
|-------------|--------|-------|
| Facebook Marketplace | ✅ Working | No login required |
| eBay | 🚧 Coming Soon | Contributions welcome! |
| Craigslist | 📋 Planned | |
| OfferUp | 📋 Planned | |
| Mercari | 📋 Planned | |

## Installation

### For Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "secondhand": {
      "command": "npx",
      "args": ["-y", "secondhand-mcp"]
    }
  }
}
```

### From Source

```bash
git clone https://github.com/YOUR_USERNAME/secondhand-mcp.git
cd secondhand-mcp
npm install
npm run build
```

Then add to your MCP config:

```json
{
  "mcpServers": {
    "secondhand": {
      "command": "node",
      "args": ["/path/to/secondhand-mcp/dist/index.js"]
    }
  }
}
```

## Usage

Once installed, you can ask Claude things like:

- "Search Facebook Marketplace for strollers in San Francisco under $100"
- "Find me a used iPhone 14 in NYC"
- "Look for vintage furniture in Los Angeles"
- "Search all marketplaces for a road bike in Seattle"

### Available Tools

#### `search_marketplace`

Search for items on secondary marketplaces.

**Parameters:**
- `query` (required): Search terms (e.g., "stroller", "iPhone 14")
- `marketplace`: Which marketplace to search (`facebook`, `ebay`, or `all`)
- `location`: City to search in (e.g., "san francisco", "nyc")
- `maxPrice`: Maximum price filter
- `minPrice`: Minimum price filter  
- `limit`: Max results to return (default: 20)

#### `list_marketplaces`

List all available marketplaces and their status.

## Example Output

```
🔍 Found 15 listings for "stroller" on facebook
📍 Location: san francisco

**$25** - Baby stroller
   📍 San Francisco, CA
   🔗 https://www.facebook.com/marketplace/item/123456789

**$50** - Thule Urban Glide Jogging Stroller
   📍 San Francisco, CA
   🔗 https://www.facebook.com/marketplace/item/987654321

...
```

## Adding New Marketplaces

1. Create a new file in `src/marketplaces/` (e.g., `craigslist.ts`)
2. Extend `BaseMarketplace` and implement the `search` method
3. Register it in `src/marketplaces/index.ts`

```typescript
import { BaseMarketplace } from './base';
import { SearchParams, SearchResult } from '../types';

export class CraigslistMarketplace extends BaseMarketplace {
  readonly name = 'craigslist';
  readonly displayName = 'Craigslist';
  readonly requiresAuth = false;
  
  async search(params: SearchParams): Promise<SearchResult> {
    // Your implementation here
  }
}
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run in development
npm run dev
```

## How It Works

The server uses Facebook's internal GraphQL API to search Marketplace listings directly — no browser automation, no Playwright, no headless Chrome.

For Facebook Marketplace:

1. Resolves your location string (e.g., "san francisco") to coordinates via GraphQL
2. Searches listings using those coordinates, your query, and any price filters
3. Parses the structured JSON response into listings
4. Caches location lookups so repeated searches for the same city are instant

This approach:
- ✅ Works without API keys or login
- ✅ Gets real-time data
- ✅ Fast — plain HTTP requests, no browser overhead
- ✅ Lightweight — zero heavy dependencies
- ⚠️ Uses undocumented Facebook GraphQL endpoints (`doc_id` values may need updating if Facebook changes their frontend)

## Limitations

- **Facebook Marketplace**: Uses undocumented API — may break if Facebook changes GraphQL `doc_id` values
- **Rate limiting**: Don't make too many requests too quickly
- **Maintenance**: If searches stop working, the `doc_id` constants in `src/marketplaces/facebook.ts` may need updating

## Contributing

Contributions welcome! Especially:

- New marketplace integrations
- Better error handling
- Performance improvements
- Documentation

## License

MIT

## Disclaimer

This tool is for personal use. Respect each marketplace's Terms of Service. The authors are not responsible for any misuse or account restrictions.
