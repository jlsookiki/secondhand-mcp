/** The parts of the storefront's embedded page data this adapter reads. Every field is optional because none of it is documented. */

export interface Field {
  name?: string;
  value?: string;
}

export interface Money {
  value?: number;
}

export interface Price {
  without_tax?: Money;
  price_range?: { min?: { without_tax?: Money }; max?: { without_tax?: Money } };
}

export interface Product {
  id?: number;
  name?: string;
  url?: string;
  summary?: string;
  brand?: { name?: string };
  custom_fields?: Field[];
  images?: { data?: string }[];
  image?: { data?: string };
  price?: Price;
  stock_level?: number | null;
  availability?: string;
  has_options?: boolean;
}

export interface SearchPage {
  template?: string;
  searchProducts?: Product[];
  searchResultsCount?: string;
  searchProductsPerPage?: number;
}

export interface ProductPage {
  template?: string;
  productUrl?: string;
  customFields?: Field[];
  isInStock?: boolean;
  productPrice?: Price;
}

export interface ProductJsonLd {
  '@type'?: string;
  url?: string;
  description?: string | null;
  image?: string | string[];
  brand?: { name?: string };
}
