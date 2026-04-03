import type { Readable } from 'node:stream'

export type HTTPCompressionAlgorithm = 'zstd' | 'gzip' | 'deflate'
export type HTTPProtocol = 'http/1.1' | 'http/2' | 'http/3'
export type HTTPMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS'
export type HTTPProtocolPreference = 'auto' | HTTPProtocol
export type AutoDetectedResponseBody = unknown

export interface TLSOptions {
  IsHTTPSEnforced?: boolean,
  MinTLSVersion?: 'TLSv1.2' | 'TLSv1.3',
  MaxTLSVersion?: 'TLSv1.2' | 'TLSv1.3',
  Ciphers?: string[],
  KeyExchanges?: string[],
  RejectUnauthorized?: boolean
}

export type HTTPSRequestPayloadChunk = string | ArrayBuffer | Uint8Array
export type HTTPSRequestPayloadStream = NodeJS.ReadableStream | AsyncIterable<HTTPSRequestPayloadChunk>
export type HTTPSRequestPayload = HTTPSRequestPayloadChunk | HTTPSRequestPayloadStream

export interface HTTPSRequestOptions<E extends ExpectedAsKey = ExpectedAsKey> {
  TLS?: TLSOptions,
  HttpHeaders?: Record<string, string>,
  HttpMethod?: HTTPMethod,
  Payload?: HTTPSRequestPayload,
  ExpectedAs?: E,
  PreferredProtocol?: HTTPProtocolPreference,
  EnableCompression?: boolean,
  TimeoutMs?: number,
  Signal?: AbortSignal
}

export interface SecureReqOptions {
  DefaultOptions?: Omit<HTTPSRequestOptions, 'Payload' | 'ExpectedAs' | 'Signal'>,
  SupportedCompressions?: HTTPCompressionAlgorithm[],
  HTTP2SessionIdleTimeout?: number
  OriginCapabilityCacheLimit?: number
}

export interface HTTPSResponse<T = unknown> {
  StatusCode: number,
  Headers: Record<string, string | string[] | undefined>,
  Body: T,
  Protocol: 'http/1.1' | 'http/2',
  ContentEncoding: HTTPCompressionAlgorithm | 'identity',
  DecodedBody: boolean
}

export interface OriginCapabilities {
  Origin: string,
  ProbeCompleted: boolean,
  PreferredProtocol: HTTPProtocol,
  SupportedCompressions: HTTPCompressionAlgorithm[],
  HTTP3Advertised: boolean
}

export type ExpectedAsMap = {
  JSON: unknown,
  String: string,
  ArrayBuffer: ArrayBuffer,
  Stream: Readable
}

export type ExpectedAsKey = keyof ExpectedAsMap
