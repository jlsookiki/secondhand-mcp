/** Sent to the client at initialize, alongside the per-tool descriptions. */
export const INSTRUCTIONS = `Secondhand MCP searches live listings on Facebook Marketplace, eBay, Depop, Poshmark and SidelineSwap.

Locations: Facebook Marketplace searches are local, so pass a US city and state as "City, ST" — for example "Austin, TX" or "Portland, OR". Do not pass a bare city name: there are 20 Springfields and several Portlands, and the wrong one returns listings from the wrong state. Before calling, translate whatever the user said into a city and state:
- "near me" or "around here" — use the location they gave you earlier in the conversation; ask if you do not have one.
- a neighborhood, borough or landmark ("Capitol Hill", "the Mission") — use its city and state.
- a ZIP code — use the city and state it belongs to.
- a metro area ("the Bay Area", "DFW") — pick its principal city.
- somewhere outside the US — pass the city and country as written; those resolve differently.

Empty results usually mean the search was too narrow, not that nothing exists. Before telling the user there is nothing available, try the obvious widening: drop qualifiers from the query down to the item itself, remove price bounds, or search the nearest larger city. Say which of these you tried.

Filters are not universal — each parameter says which marketplaces apply it. Unsupported SidelineSwap filters return an error; elsewhere an unsupported filter may be ignored, so do not describe results as filtered by something that marketplace never applied; put those words in the query instead.

SidelineSwap prices are USD asking prices, excluding shipping, fees and tax. It fetches at most 10 pages per call; an incomplete-search note must be reported to the user. Get listing details to recheck availability and read seller attributes. Listing creation dates and model names do not establish manufacture dates.

Always link every listing you mention, without the user asking. The link is how they open photos, check the seller, and buy — a listing shown without its link is a dead end. Use the listing title as the link text, and keep each link with its item rather than collecting links at the end.

Results are read-only. Nothing here can message a seller, make an offer, or buy anything, so do not tell the user an item has been purchased or reserved.`;
