import { describe, expect, it } from 'vitest';
import { optionsNote } from '../src/tools/format.js';
import type { ListingDetails, ListingOption } from '../src/types.js';

const option = (id: string): ListingOption => ({ id, aspects: { Size: id }, available: true, url: 'u' });
const details = (over: Partial<ListingDetails>): ListingDetails => ({ id: 'x', images: [], url: 'u', ...over });

describe('optionsNote', () => {
  it('says nothing about a listing sold as one item', () => {
    expect(optionsNote(details({}))).toBeUndefined();
  });

  it('says nothing when every option is shown', () => {
    expect(optionsNote(details({ optionAxes: ['Size'], options: [option('S'), option('M')], optionCount: 2 }))).toBeUndefined();
  });

  it('points at the options argument when options were left out', () => {
    const note = optionsNote(details({ optionAxes: ['Size'], options: [option('S')], optionCount: 40 }));
    expect(note).toContain('This listing has 40 options and 1 are shown');
    expect(note).toContain('{"Size": ["<value>"]}');
  });

  it('leaves out the example when the options share every aspect', () => {
    const note = optionsNote(details({ optionAxes: [], options: [option('S')], optionCount: 3 }));
    expect(note).toBe('This listing has 3 options and 1 are shown.');
  });

  it('says a choice matched nothing', () => {
    const note = optionsNote(details({ options: [], optionCount: 5, optionFilter: { Size: ['XXL'] }, matchingOptions: 0 }));
    expect(note).toContain('No option of this listing matches that choice.');
  });

  it('says more options match than are shown', () => {
    const note = optionsNote(details({ options: [option('L')], optionCount: 50, optionFilter: { Size: ['L'] }, matchingOptions: 40 }));
    expect(note).toBe('40 options match and 1 are shown. Narrow the options choice to see the rest.');
  });

  it('says nothing when every match is shown', () => {
    expect(optionsNote(details({ options: [option('L')], optionCount: 50, optionFilter: { Size: ['L'] }, matchingOptions: 1 }))).toBeUndefined();
  });
});
