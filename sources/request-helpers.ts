import type { ExpectedAsKey, HTTPSRequestOptions } from './type.js'

export function DetermineExpectedAs<E extends ExpectedAsKey>(Url: URL, Options: HTTPSRequestOptions<E>): E {
  return (
    Options.ExpectedAs
    ?? (Url.pathname.endsWith('.json')
      ? 'JSON'
      : Url.pathname.endsWith('.txt')
        ? 'String'
        : 'ArrayBuffer')
  ) as E
}

export function ToError(Value: unknown): Error {
  return Value instanceof Error ? Value : new Error(String(Value))
}
