import type { ExpectedAsKey, HTTPMethod, HTTPSRequestOptions } from './type.js'

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

export class HTTP2NegotiationError extends Error {
  public constructor(Message: string, Options?: ErrorOptions) {
    super(Message, Options)
    this.name = 'HTTP2NegotiationError'
  }
}

export function ToError(Value: unknown): Error {
  return Value instanceof Error ? Value : new Error(String(Value))
}

export function IsHTTP2NegotiationError(Value: unknown): Value is HTTP2NegotiationError {
  return Value instanceof HTTP2NegotiationError
}

export function IsAutomaticHTTP2ProbeMethod(Method?: HTTPMethod): boolean {
  return Method === 'GET' || Method === 'HEAD'
}
