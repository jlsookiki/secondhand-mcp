/**
 * The parts of the storefront's embedded page data this adapter reads. Every field is optional because none of it is documented.
 * The guards check only the fields this adapter reads, so one wrongly typed product is skipped instead of failing its page.
 */

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
  custom_fields?: unknown[];
  images?: unknown[];
  image?: unknown;
  price?: Price;
  stock_level?: number | null;
  availability?: string;
  has_options?: boolean;
}

export interface SearchPage {
  template: 'pages/search';
  searchProducts: unknown[];
  searchResultsCount?: string;
  searchProductsPerPage?: number;
}

export interface ProductPage {
  template: 'pages/product';
  productUrl: string;
  customFields?: unknown;
  isInStock?: boolean;
  productPrice?: Price;
}

export interface ProductJsonLd {
  '@type': 'Product';
  name?: string;
  url: string;
  description?: string | null;
  image?: unknown;
  brand?: { name?: string };
}

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptional(value: unknown, type: 'string' | 'number' | 'boolean'): boolean {
  return value === undefined || typeof value === type;
}

function isOptionalBrand(value: unknown): boolean {
  return value === undefined || (isRow(value) && isOptional(value.name, 'string'));
}

export function isField(value: unknown): value is Field {
  return isRow(value) && isOptional(value.name, 'string') && isOptional(value.value, 'string');
}

export function isPhoto(value: unknown): value is { data: string } {
  return isRow(value) && typeof value.data === 'string';
}

export function isProduct(value: unknown): value is Product {
  return (
    isRow(value) &&
    isOptional(value.name, 'string') &&
    isOptional(value.url, 'string') &&
    isOptional(value.summary, 'string') &&
    isOptional(value.availability, 'string') &&
    isOptionalBrand(value.brand) &&
    (value.custom_fields === undefined || Array.isArray(value.custom_fields)) &&
    (value.images === undefined || Array.isArray(value.images))
  );
}

export function isSearchPage(value: unknown): value is SearchPage {
  return (
    isRow(value) &&
    value.template === 'pages/search' &&
    Array.isArray(value.searchProducts) &&
    isOptional(value.searchResultsCount, 'string') &&
    isOptional(value.searchProductsPerPage, 'number')
  );
}

export function isProductPage(value: unknown): value is ProductPage {
  return isRow(value) && value.template === 'pages/product' && typeof value.productUrl === 'string' && isOptional(value.isInStock, 'boolean');
}

export function isProductJsonLd(value: unknown): value is ProductJsonLd {
  return (
    isRow(value) &&
    value['@type'] === 'Product' &&
    typeof value.url === 'string' &&
    isOptional(value.name, 'string') &&
    (value.description === null || isOptional(value.description, 'string')) &&
    isOptionalBrand(value.brand)
  );
}
