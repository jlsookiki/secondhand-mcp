/** The parts of Geartrade's Shopify storefront this adapter reads. Every field is optional because none of it is a documented API. */

/** The `var meta` analytics object on a search page. Prices are integer cents. */
export interface SearchMeta {
  products?: MetaProduct[];
}

export interface MetaProduct {
  handle?: string;
  variants?: MetaVariant[];
}

export interface MetaVariant {
  id?: number;
  price?: number;
  public_title?: string;
}

/** `/products/<handle>.js`. Prices are integer cents. */
export interface Product {
  handle?: string;
  title?: string;
  description?: string;
  available?: boolean;
  images?: string[];
  options?: { name?: string }[];
  variants?: Variant[];
}

export interface Variant {
  id?: number;
  title?: string;
  options?: string[];
  price?: number;
  available?: boolean;
}
