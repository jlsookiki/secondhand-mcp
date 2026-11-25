/**
 * The parts of Facebook's GraphQL responses this adapter reads. Facebook
 * changes these shapes without notice, so fields are optional unless a
 * record is useless without them, and readers decide what a missing one means.
 */

export interface GraphQLResponse<T> {
  data?: T | null;
  errors?: Array<{ message?: string }>;
}

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface PlaceNode {
  subtitle?: string;
  single_line_address?: string;
  location?: Coordinates | null;
  page?: { id?: string } | null;
}

export interface LocationSearchData {
  city_street_search?: {
    street_results?: { edges?: Array<{ node?: PlaceNode | null } | null> | null } | null;
  } | null;
}

export interface FeedListing {
  id: string;
  marketplace_listing_title?: string | null;
  listing_price?: { formatted_amount?: string | null } | null;
  primary_listing_photo?: { image?: { uri?: string | null } | null } | null;
  marketplace_listing_seller?: { name?: string | null } | null;
  is_sold?: boolean | null;
  is_live?: boolean | null;
  is_pending?: boolean | null;
  is_hidden?: boolean | null;
  location?: {
    reverse_geocode?: {
      city?: string | null;
      state?: string | null;
      city_page?: { display_name?: string | null } | null;
    } | null;
  } | null;
}

export interface FeedEdge {
  node?: { __typename?: string; listing?: FeedListing | null } | null;
}

export interface FeedUnits {
  edges?: Array<FeedEdge | null> | null;
  page_info?: { has_next_page?: boolean | null } | null;
}

export interface SearchData {
  marketplace_search?: { feed_units?: FeedUnits | null } | null;
}

export interface DetailTarget {
  listing_photos?: Array<{ image?: { uri?: string | null } | null } | null> | null;
  redacted_description?: { text?: string | null } | null;
  location_text?: { text?: string | null } | null;
  location?: Coordinates | null;
  marketplace_listing_seller?: { name?: string | null } | null;
  delivery_types?: string[] | null;
  is_shipping_offered?: boolean | null;
  // Read through listingFacts, which checks each shape itself.
  marketplace_listing_title?: unknown;
  listing_price?: unknown;
  strikethrough_price?: unknown;
  creation_time?: unknown;
  attribute_data?: unknown;
  is_sold?: unknown;
  is_pending?: unknown;
  is_live?: unknown;
  is_hidden?: unknown;
}

export interface DetailData {
  viewer?: { marketplace_product_details_page?: { target?: DetailTarget | null } | null } | null;
}
