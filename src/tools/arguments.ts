/**
 * Tool arguments as assistants actually send them. Models often quote
 * numbers and booleans ("50", "false"), and a quoted "false" is truthy, so
 * every argument is read through one of these instead of being cast.
 * A blank value counts as not given; anything unreadable is an ArgumentError.
 */

export class ArgumentError extends Error {}

type Args = unknown;

function raw(args: Args, name: string): unknown {
  if (typeof args !== 'object' || args === null) return undefined;
  const value = (args as Record<string, unknown>)[name];
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

export function stringArg(args: Args, name: string): string | undefined {
  const value = raw(args, name);
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  throw new ArgumentError(`${name} must be a string`);
}

export function numberArg(args: Args, name: string): number | undefined {
  const value = raw(args, name);
  if (value === undefined) return undefined;
  const number = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) {
    throw new ArgumentError(`${name} must be a number`);
  }
  return number;
}

export function countArg(args: Args, name: string): number | undefined {
  const number = numberArg(args, name);
  if (number !== undefined && (!Number.isInteger(number) || number < 0)) {
    throw new ArgumentError(`${name} must be a whole number, 0 or more`);
  }
  return number;
}

export function booleanArg(args: Args, name: string): boolean | undefined {
  const value = raw(args, name);
  if (value === undefined || typeof value === 'boolean') return value;
  const word = typeof value === 'string' ? value.trim().toLowerCase() : undefined;
  if (word === 'true') return true;
  if (word === 'false') return false;
  throw new ArgumentError(`${name} must be true or false`);
}

/** A list, or a single value standing in for a one-item list. */
export function stringListArg(args: Args, name: string): string[] | undefined {
  const value = raw(args, name);
  if (value === undefined) return undefined;
  const list = (Array.isArray(value) ? value : [value]).map((item) =>
    typeof item === 'number' ? String(item) : item
  );
  if (!list.every((item): item is string => typeof item === 'string')) {
    throw new ArgumentError(`${name} must be a list of strings`);
  }
  return list.length > 0 ? list : undefined;
}

const OPTION_FILTER_EXAMPLE = '{"Size": ["L"]}';

function optionFilterError(name: string): ArgumentError {
  return new ArgumentError(`${name} must map option names to lists of values, like ${OPTION_FILTER_EXAMPLE}`);
}

/**
 * Option names to the values wanted, e.g. {"Size": ["L"]}. A single value
 * stands in for a one-item list, and clients that cannot send objects send
 * the same thing as JSON text.
 */
export function optionFilterArg(args: Args, name: string): Record<string, string[]> | undefined {
  const value = raw(args, name);
  if (value === undefined) return undefined;
  const choice = typeof value === 'string' ? parsedChoice(value, name) : value;
  if (typeof choice !== 'object' || choice === null || Array.isArray(choice)) {
    throw optionFilterError(name);
  }
  const entries = Object.entries(choice).flatMap(([option, wanted]) => {
    const values = optionValues(wanted, name);
    return option.trim() && values.length > 0 ? [[option.trim(), values] as const] : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parsedChoice(text: string, name: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw optionFilterError(name);
  }
}

function optionValues(wanted: unknown, name: string): string[] {
  const list = Array.isArray(wanted) ? wanted : [wanted];
  if (!list.every((item) => typeof item === 'string' || typeof item === 'number')) {
    throw new ArgumentError(`${name} values must be text, like ${OPTION_FILTER_EXAMPLE}`);
  }
  return list.map((item) => String(item).trim()).filter(Boolean);
}

/** One of a fixed set of keywords, however it was cased or spaced ("Like New" is like_new). */
export function choiceArg<T extends string>(args: Args, name: string, choices: readonly T[]): T | undefined {
  const value = stringArg(args, name);
  if (value === undefined) return undefined;
  const keyword = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const choice = choices.find((c) => c === keyword);
  if (!choice) throw new ArgumentError(`${name} must be one of: ${choices.join(', ')}`);
  return choice;
}
