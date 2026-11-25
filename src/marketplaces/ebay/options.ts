import { OptionFilter } from '../../types.js';
import { BrowseAspect, BrowseAvailability, BrowsePrice } from './wire.js';

interface AspectOption {
  localizedAspects?: BrowseAspect[];
}

interface StockedOption {
  estimatedAvailabilities?: BrowseAvailability[];
}

interface PricedOption extends StockedOption {
  price?: BrowsePrice;
}

const OUT_OF_STOCK = 'OUT_OF_STOCK';

function valueOf(option: AspectOption, name: string): string | undefined {
  return option.localizedAspects?.find((aspect) => aspect.name === name)?.value;
}

/** eBay lists no axes: every option repeats the item specifics, so the axes are the names whose values differ. */
export function varyingAspectNames(options: AspectOption[]): string[] {
  const names: string[] = [];
  for (const option of options) {
    for (const aspect of option.localizedAspects ?? []) {
      if (!names.includes(aspect.name)) names.push(aspect.name);
    }
  }
  return names.filter((name) => new Set(options.map((option) => valueOf(option, name))).size > 1);
}

/** Out of stock only when eBay says so; an option without an estimate is listed as available. */
export function isAvailable(option: StockedOption): boolean {
  return option.estimatedAvailabilities?.[0]?.estimatedAvailabilityStatus !== OUT_OF_STOCK;
}

export function availableFirst<T extends StockedOption>(options: T[]): T[] {
  return [...options.filter(isAvailable), ...options.filter((option) => !isAvailable(option))];
}

/** The aspects that set one option apart, keyed by axis. */
export function aspectsNamed(option: AspectOption, axes: string[]): Record<string, string> {
  const entries = axes.flatMap((axis) => {
    const value = valueOf(option, axis);
    return value === undefined ? [] : [[axis, value] as const];
  });
  return Object.fromEntries(entries);
}

/** Every value each axis takes, in eBay order: the whole listing at a glance, however many options it has. */
export function optionValues(options: AspectOption[], axes: string[]): Record<string, string[]> {
  const entries = axes.map((axis) => {
    const values: string[] = [];
    for (const option of options) {
      const value = valueOf(option, axis);
      if (value !== undefined && !values.includes(value)) values.push(value);
    }
    return [axis, values] as const;
  });
  return Object.fromEntries(entries);
}

// Sellers name axes freely ("Color-", "colour", "SIZE"), so names and values compare loosely.
function loose(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Matched on every aspect, not only the varying ones: asking for L on a listing that only comes in L gets all of it. */
export function matchesOptionFilter(option: AspectOption, filter: OptionFilter): boolean {
  return Object.entries(filter).every(([name, wanted]) => {
    const aspect = option.localizedAspects?.find((candidate) => loose(candidate.name) === loose(name));
    return aspect !== undefined && wanted.some((value) => loose(value) === loose(aspect.value));
  });
}

function amount(option: PricedOption): number {
  return Number(option.price?.value);
}

/**
 * The cheapest and dearest options a shopper can buy, only when their prices
 * differ; all options when none can be bought, so a sold-out listing still has one.
 */
export function priceSpread<T extends PricedOption>(options: T[]): { low: T; high: T } | undefined {
  const buyable = options.filter(isAvailable);
  const pool = buyable.length > 0 ? buyable : options;
  const priced = pool.filter((option) => Number.isFinite(amount(option)));
  if (priced.length < 2) return undefined;
  const byPrice = [...priced].sort((a, b) => amount(a) - amount(b));
  const low = byPrice[0];
  const high = byPrice[byPrice.length - 1];
  return amount(low) === amount(high) ? undefined : { low, high };
}

export interface OptionSelection<T> {
  listed: T[];
  /** How many options matched the filter; absent when there was no filter. */
  matching?: number;
}

/** A few options when the shopper named nothing, up to `max` that match when they did. */
export function selectOptions<T extends AspectOption>(
  ordered: T[],
  filter: OptionFilter | undefined,
  limits: { shown: number; max: number }
): OptionSelection<T> {
  if (!filter) return { listed: ordered.slice(0, limits.shown) };
  const matching = ordered.filter((option) => matchesOptionFilter(option, filter));
  return { listed: matching.slice(0, limits.max), matching: matching.length };
}

/**
 * Which option the answer's own id and link describe: the first match of a
 * shopper's choice, else the option they asked about, else the listing as a
 * whole through its first option.
 */
export function describedOption<T>(
  chosen: T | undefined,
  selection: OptionSelection<T>,
  ordered: T[]
): { option: T; linksOption: boolean } {
  const firstMatch = selection.matching === undefined ? undefined : selection.listed[0];
  if (firstMatch) return { option: firstMatch, linksOption: true };
  if (chosen) return { option: chosen, linksOption: true };
  return { option: ordered[0], linksOption: false };
}
