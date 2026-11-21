/** The parts of SidelineSwap's storefront JSON this adapter reads. Every field is optional because the API is undocumented. */

export interface Image {
  large_url?: string;
  edge_url?: string;
  small_url?: string;
  thumb_url?: string;
}

export interface Detail {
  name?: string;
  values?: { name?: string }[];
}

export interface Item {
  id?: number | string;
  name?: string;
  state?: string;
  price?: number | string | null;
  url?: string;
  condition_detail?: { name?: string };
  seller?: { username?: string };
  images?: Image[];
  primary_image?: Image;
  description?: string;
  details?: Detail[];
  model?: { name?: string; display_name?: string };
}

export interface Paging {
  page?: number;
  has_next_page?: boolean;
  total_count?: number;
  total_count_truncated?: boolean;
}

export interface SearchResponse {
  data?: Item[];
  meta?: { paging?: Paging };
}

export interface ItemResponse {
  data?: Item;
}
