import { describe, expect, it } from 'vitest';
import {
  aspectsNamed,
  availableFirst,
  describedOption,
  isAvailable,
  matchesOptionFilter,
  optionValues,
  priceSpread,
  selectOptions,
  varyingAspectNames,
} from '../src/marketplaces/ebay/options.js';

const withAspects = (pairs: Record<string, string>, price?: string) => ({
  localizedAspects: Object.entries(pairs).map(([name, value]) => ({ name, value })),
  ...(price ? { price: { value: price } } : {}),
});

const soldOut = <T extends object>(option: T) => ({
  ...option,
  estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'OUT_OF_STOCK' }],
});

describe('varyingAspectNames', () => {
  it('keeps only the aspects whose values differ, in eBay order', () => {
    expect(
      varyingAspectNames([
        withAspects({ Brand: 'Acme', Size: 'M', Color: 'Black' }),
        withAspects({ Brand: 'Acme', Size: 'L', Color: 'Red' }),
        withAspects({ Brand: 'Acme', Size: 'L', Color: 'Black' }),
      ])
    ).toEqual(['Size', 'Color']);
  });

  it('counts an aspect one option lacks as varying', () => {
    expect(varyingAspectNames([withAspects({ Size: 'M', Style: 'Slim' }), withAspects({ Size: 'M' })])).toEqual(['Style']);
  });

  it('finds nothing for options that do not differ or carry no aspects', () => {
    expect(varyingAspectNames([withAspects({ Size: 'M' }), withAspects({ Size: 'M' })])).toEqual([]);
    expect(varyingAspectNames([{}, {}])).toEqual([]);
  });
});

describe('isAvailable', () => {
  it.each([
    [{ estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'IN_STOCK' }] }, true],
    [{ estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'LIMITED_STOCK' }] }, true],
    [{ estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'OUT_OF_STOCK' }] }, false],
    [{}, true],
  ])('%j is %s', (item, available) => {
    expect(isAvailable(item)).toBe(available);
  });
});

describe('availableFirst', () => {
  it('moves sold-out options to the end and keeps eBay order otherwise', () => {
    const inStock = <T extends object>(option: T) => ({ ...option, estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'IN_STOCK' }] });
    const [a, b, c] = [soldOut(withAspects({ Size: 'S' })), inStock(withAspects({ Size: 'M' })), inStock(withAspects({ Size: 'L' }))];
    expect(availableFirst([a, b, c])).toEqual([b, c, a]);
  });
});

describe('aspectsNamed', () => {
  it('keeps only the axes, and leaves out an axis the option lacks', () => {
    expect(aspectsNamed(withAspects({ Brand: 'Acme', Size: 'M' }), ['Size', 'Color'])).toEqual({ Size: 'M' });
  });
});

describe('optionValues', () => {
  it('lists each axis value once, in eBay order, skipping options without it', () => {
    const options = [
      withAspects({ Size: 'M', Color: 'Red' }),
      withAspects({ Size: 'L', Color: 'Red' }),
      withAspects({ Size: 'M' }),
      withAspects({ Size: 'S', Color: 'Blue' }),
    ];
    expect(optionValues(options, ['Size', 'Color'])).toEqual({ Size: ['M', 'L', 'S'], Color: ['Red', 'Blue'] });
  });

  it('is empty for a listing with no axes', () => {
    expect(optionValues([withAspects({ Size: 'M' })], [])).toEqual({});
  });
});

describe('matchesOptionFilter', () => {
  const option = withAspects({ 'Color-': 'Navy Blue', Size: 'XL', Brand: 'Acme' });

  it.each([
    [{ Size: ['XL'] }, true],
    [{ size: ['xl'] }, true],
    [{ color: ['navy-blue'] }, true],
    [{ Size: ['XL'], Color: ['Navy Blue'] }, true],
    [{ Size: ['M', 'XL'] }, true],
    [{ Brand: ['acme'] }, true],
    [{ Size: ['L'] }, false],
    [{ Size: ['M', 'L'] }, false],
    [{ Size: ['XL'], Color: ['Red'] }, false],
    [{ Material: ['Cotton'] }, false],
    [{}, true],
  ])('%j matches: %s', (filter, matches) => {
    expect(matchesOptionFilter(option, filter)).toBe(matches);
  });

  it.each([
    [{ Size: '10½' }, { Size: ['10'] }, false],
    [{ Colour: 'Crème' }, { Colour: ['Creme'] }, true],
    [{ Color: '白' }, { Color: ['黒'] }, false],
    [{ Color: '黒' }, { Color: ['黒'] }, true],
    [{ Color: '–' }, { Color: ['—'] }, false],
  ])('an option with %j matches %j outside ASCII: %s', (aspects, filter, matches) => {
    expect(matchesOptionFilter(withAspects(aspects), filter)).toBe(matches);
  });

  it('matches nothing on an option without aspects', () => {
    expect(matchesOptionFilter({}, { Size: ['M'] })).toBe(false);
  });
});

describe('priceSpread', () => {
  it('finds the cheapest and dearest options when prices differ', () => {
    const [a, b, c] = [withAspects({}, '12.50'), withAspects({}, '4.99'), withAspects({}, '30')];
    expect(priceSpread([a, b, c])).toEqual({ low: b, high: c });
  });

  it('leaves out options that cannot be bought', () => {
    const cheap = soldOut(withAspects({}, '1.00'));
    const [a, b] = [withAspects({}, '5.00'), withAspects({}, '9.00')];
    expect(priceSpread([cheap, a, b])).toEqual({ low: a, high: b });
  });

  it('prices a listing whose every option is sold out from all of them', () => {
    const [a, b] = [soldOut(withAspects({}, '3.00')), soldOut(withAspects({}, '8.00'))];
    expect(priceSpread([a, b])).toEqual({ low: a, high: b });
  });

  it.each([
    ['all at one price', [withAspects({}, '9.99'), withAspects({}, '9.99')]],
    ['a single priced option', [withAspects({}, '9.99'), withAspects({})]],
    ['no prices', [withAspects({}), withAspects({})]],
  ])('has no spread for %s', (_label, options) => {
    expect(priceSpread(options)).toBeUndefined();
  });
});

describe('selectOptions', () => {
  const options = ['S', 'M', 'L', 'L', 'XL'].map((size) => withAspects({ Size: size }));

  it('lists a few options when the shopper named nothing', () => {
    expect(selectOptions(options, undefined, { shown: 2, max: 3 })).toEqual({ listed: options.slice(0, 2) });
  });

  it('lists up to the larger cap of matching options, with how many matched', () => {
    expect(selectOptions(options, { Size: ['L'] }, { shown: 1, max: 5 })).toEqual({ listed: [options[2], options[3]], matching: 2 });
    expect(selectOptions(options, { Size: ['L'] }, { shown: 1, max: 1 })).toEqual({ listed: [options[2]], matching: 2 });
  });

  it('lists nothing when nothing matches', () => {
    expect(selectOptions(options, { Size: ['XXL'] }, { shown: 2, max: 3 })).toEqual({ listed: [], matching: 0 });
  });
});

describe('describedOption', () => {
  const [a, b, c] = ['a', 'b', 'c'];

  it('describes and links the first match of a choice', () => {
    expect(describedOption('chosen', { listed: [b, c], matching: 2 }, [a, b, c])).toEqual({ option: b, linksOption: true });
  });

  it('falls back to the option asked about when nothing matched', () => {
    expect(describedOption('chosen', { listed: [], matching: 0 }, [a, b])).toEqual({ option: 'chosen', linksOption: true });
  });

  it('describes the option asked about when there is no choice', () => {
    expect(describedOption('chosen', { listed: [a, b] }, [a, b])).toEqual({ option: 'chosen', linksOption: true });
  });

  it('describes the listing through its first option otherwise', () => {
    expect(describedOption(undefined, { listed: [a] }, [a, b])).toEqual({ option: a, linksOption: false });
    expect(describedOption(undefined, { listed: [], matching: 0 }, [a, b])).toEqual({ option: a, linksOption: false });
  });
});
