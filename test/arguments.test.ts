import { describe, expect, it } from 'vitest';
import {
  ArgumentError,
  booleanArg,
  choiceArg,
  countArg,
  exactListingId,
  listingIdArg,
  numberArg,
  optionFilterArg,
  stringArg,
  stringListArg,
} from '../src/tools/arguments.js';

describe('numberArg', () => {
  it.each([
    [50, 50],
    ['50', 50],
    [' 12.5 ', 12.5],
    ['', undefined],
    [null, undefined],
    [undefined, undefined],
  ])('reads %j as %j', (value, expected) => {
    expect(numberArg({ maxPrice: value }, 'maxPrice')).toBe(expected);
  });

  it.each(['abc', '5 dollars', true, [5], Number.NaN, Infinity])('rejects %j', (value) => {
    expect(() => numberArg({ maxPrice: value }, 'maxPrice')).toThrow(new ArgumentError('maxPrice must be a number'));
  });
});

describe('countArg', () => {
  it.each([
    [0, 0],
    ['3', 3],
    ['', undefined],
  ])('reads %j as %j', (value, expected) => {
    expect(countArg({ maxImages: value }, 'maxImages')).toBe(expected);
  });

  it.each([-1, 2.5, '-3'])('rejects %j', (value) => {
    expect(() => countArg({ maxImages: value }, 'maxImages')).toThrow('maxImages must be a whole number, 0 or more');
  });
});

describe('booleanArg', () => {
  it.each([
    [true, true],
    [false, false],
    ['true', true],
    ['FALSE', false],
    [' false ', false],
    ['', undefined],
    [undefined, undefined],
  ])('reads %j as %j', (value, expected) => {
    expect(booleanArg({ showSold: value }, 'showSold')).toBe(expected);
  });

  it.each(['yes', 1, 'no'])('rejects %j', (value) => {
    expect(() => booleanArg({ showSold: value }, 'showSold')).toThrow('showSold must be true or false');
  });
});

describe('stringArg', () => {
  it.each([
    ['chair', 'chair'],
    [123456, '123456'],
    ['', undefined],
    [undefined, undefined],
  ])('reads %j as %j', (value, expected) => {
    expect(stringArg({ listingId: value }, 'listingId')).toBe(expected);
  });

  it.each([{}, ['a'], true])('rejects %j', (value) => {
    expect(() => stringArg({ listingId: value }, 'listingId')).toThrow('listingId must be a string');
  });
});

describe('stringListArg', () => {
  it.each([
    [['S', 'M'], ['S', 'M']],
    ['M', ['M']],
    [[9, 10.5], ['9', '10.5']],
    [9, ['9']],
    [[], undefined],
    [undefined, undefined],
  ])('reads %j as %j', (value, expected) => {
    expect(stringListArg({ sizes: value }, 'sizes')).toEqual(expected);
  });

  it.each([[[true]], [{}], [[{}]]])('rejects %j', (value) => {
    expect(() => stringListArg({ sizes: value }, 'sizes')).toThrow('sizes must be a list of strings');
  });
});

describe('choiceArg', () => {
  const MODES = ['urls', 'inline'] as const;

  it('accepts a listed value and leaves a missing one unset', () => {
    expect(choiceArg({ imageMode: 'inline' }, 'imageMode', MODES)).toBe('inline');
    expect(choiceArg({}, 'imageMode', MODES)).toBeUndefined();
  });

  it.each(['Inline', ' INLINE '])('reads %j the way it is listed', (value) => {
    expect(choiceArg({ imageMode: value }, 'imageMode', MODES)).toBe('inline');
  });

  it.each(['Like New', 'like-new', 'LIKE_NEW'])('reads %j as like_new', (value) => {
    expect(choiceArg({ condition: value }, 'condition', ['new', 'like_new'] as const)).toBe('like_new');
  });

  it('names the allowed values when one is not listed', () => {
    expect(() => choiceArg({ imageMode: 'base64' }, 'imageMode', MODES)).toThrow('imageMode must be one of: urls, inline');
  });
});

describe('listingIdArg', () => {
  it.each([
    ['v1|123|0', 'v1|123|0'],
    [123456, '123456'],
    [Number.MAX_SAFE_INTEGER, '9007199254740991'],
    ['29077057795219417', '29077057795219417'],
    ['', undefined],
    [null, undefined],
  ])('reads %j as %j', (value, expected) => {
    expect(listingIdArg({ listingId: value }, 'listingId')).toBe(expected);
  });

  it.each([29077057795219417, Number.MAX_SAFE_INTEGER + 1, 1.5])('refuses %j, whose digits may already be wrong', (value) => {
    expect(() => listingIdArg({ listingId: value }, 'listingId')).toThrow('Pass listingId as text');
  });

  it('refuses a value that is neither text nor a number', () => {
    expect(() => listingIdArg({ listingId: true }, 'listingId')).toThrow('listingId must be a string');
  });
});

describe('exactListingId', () => {
  it('names the argument it refuses', () => {
    expect(() => exactListingId(2 ** 60, 'id')).toThrow(/^Pass id as text/);
  });
});

describe('optionFilterArg', () => {
  it.each([
    [{ Size: ['L'] }, { Size: ['L'] }],
    [{ Size: 'L' }, { Size: ['L'] }],
    ['{"Size":"L"}', { Size: ['L'] }],
    [{ ' Size ': [' L ', 10] }, { Size: ['L', '10'] }],
    [{ Size: ['L'], Color: [] }, { Size: ['L'] }],
    [{}, undefined],
    ['{}', undefined],
    [{ ' ': ['L'] }, undefined],
    [null, undefined],
    ['', undefined],
  ])('reads %j as %j', (value, expected) => {
    expect(optionFilterArg({ options: value }, 'options')).toEqual(expected);
  });

  it.each(['L', 'null', '["L"]', ['L'], 5])('rejects %j, which names no option', (value) => {
    expect(() => optionFilterArg({ options: value }, 'options')).toThrow(
      'options must map option names to lists of values, like {"Size": ["L"]}'
    );
  });

  it.each([{ Size: null }, { Size: true }, '{"Size":[{"v":"L"}]}'])('rejects values that are not text in %j', (value) => {
    expect(() => optionFilterArg({ options: value }, 'options')).toThrow('options values must be text');
  });
});

describe('reading from arguments that are not an object', () => {
  it('treats missing arguments as empty', () => {
    expect(stringArg(undefined, 'query')).toBeUndefined();
  });
});
