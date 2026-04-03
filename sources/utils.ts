import { Readable } from 'node:stream'
import * as ZLib from 'node:zlib'
import type { HTTPCompressionAlgorithm, HTTPSRequestPayload, HTTPSRequestPayloadChunk, TLSOptions } from './type.js'

export function ConcatArrayBuffers(Buffers: ArrayBuffer[]): ArrayBuffer {
  const TotalLength = Buffers.reduce((Sum, Block) => Sum + Block.byteLength, 0)
  const Result = new Uint8Array(TotalLength)
  let Offset = 0

  for (const Buffer of Buffers) {
    Result.set(new Uint8Array(Buffer), Offset)
    Offset += Buffer.byteLength
  }

  return Result.buffer
}

export function BufferToArrayBuffer(Value: Uint8Array): ArrayBuffer {
  const Result = new Uint8Array(Value.byteLength)
  Result.set(new Uint8Array(Value.buffer, Value.byteOffset, Value.byteLength))
  return Result.buffer
}

export async function ReadableToArrayBuffer(Stream: Readable): Promise<ArrayBuffer> {
  const Chunks: ArrayBuffer[] = []

  for await (const Chunk of Stream) {
    Chunks.push(BufferToArrayBuffer(PayloadChunkToUint8Array(Chunk)))
  }

  return ConcatArrayBuffers(Chunks)
}

export function NormalizeHeaders(Headers?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(Headers ?? {}).map(([Key, Value]) => [Key.toLowerCase(), Value]),
  )
}

export function NormalizeIncomingHeaders(Headers: Record<string, unknown>): Record<string, string | string[] | undefined> {
  return Object.fromEntries(
    Object.entries(Headers)
      .filter(([Key]) => Key.startsWith(':') === false)
      .map(([Key, Value]) => {
        if (Array.isArray(Value)) {
          return [Key.toLowerCase(), Value.map(Item => Item?.toString())]
        }

        if (Value === undefined || Value === null) {
          return [Key.toLowerCase(), undefined]
        }

        return [Key.toLowerCase(), Value.toString()]
      }),
  )
}

export function GetOriginKey(Url: URL): string {
  const Port = Url.port || GetDefaultPort(Url.protocol)
  return `${Url.protocol}//${Url.hostname}:${Port}`
}

export function GetDefaultPort(Protocol: string): string {
  switch (Protocol) {
    case 'http:':
      return '80'
    case 'https:':
      return '443'
    default:
      return ''
  }
}

export function SerializeTLSOptions(Options?: TLSOptions): string {
  if (Options === undefined) {
    return 'default'
  }

  return JSON.stringify({
    MinTLSVersion: Options.MinTLSVersion,
    MaxTLSVersion: Options.MaxTLSVersion,
    Ciphers: Options.Ciphers ?? [],
    KeyExchanges: Options.KeyExchanges ?? [],
    RejectUnauthorized: Options.RejectUnauthorized,
  })
}

export function GetHeaderValue(Headers: Record<string, string | string[] | undefined>, Name: string): string | undefined {
  const Value = Headers[Name.toLowerCase()]

  if (Array.isArray(Value)) {
    return Value.join(', ')
  }

  return Value
}

export function ParseTokenList(Value?: string): string[] {
  return (Value ?? '')
    .split(',')
    .map(Item => Item.trim().toLowerCase())
    .filter(Boolean)
}

export function ParseCompressionAlgorithms(Value?: string): HTTPCompressionAlgorithm[] {
  return ParseTokenList(Value).filter((Item): Item is HTTPCompressionAlgorithm => {
    return Item === 'zstd' || Item === 'gzip' || Item === 'deflate'
  })
}

export function IntersectCompressionAlgorithms(Primary: HTTPCompressionAlgorithm[], Secondary: HTTPCompressionAlgorithm[]): HTTPCompressionAlgorithm[] {
  const Allowed = new Set(Secondary)
  return Primary.filter((Item, Index) => Allowed.has(Item) && Primary.indexOf(Item) === Index)
}

export function IsReadableStream(Value: unknown): Value is NodeJS.ReadableStream {
  return typeof Value === 'object' && Value !== null && typeof (Value as NodeJS.ReadableStream).pipe === 'function'
}

export function IsAbortSignal(Value: unknown): Value is AbortSignal {
  return typeof Value === 'object'
    && Value !== null
    && typeof (Value as AbortSignal).aborted === 'boolean'
    && typeof (Value as AbortSignal).addEventListener === 'function'
    && typeof (Value as AbortSignal).removeEventListener === 'function'
}

export function IsAsyncIterable(Value: unknown): Value is AsyncIterable<HTTPSRequestPayloadChunk> {
  return typeof Value === 'object' && Value !== null && Symbol.asyncIterator in Value
}

export function IsStreamingPayload(Value: unknown): Value is NodeJS.ReadableStream | AsyncIterable<HTTPSRequestPayloadChunk> {
  return IsReadableStream(Value) || IsAsyncIterable(Value)
}

export function PayloadChunkToUint8Array(Value: unknown): Uint8Array {
  if (typeof Value === 'string') {
    return Buffer.from(Value)
  }

  if (Value instanceof ArrayBuffer) {
    return new Uint8Array(Value)
  }

  if (Value instanceof Uint8Array) {
    return Value
  }

  if (ArrayBuffer.isView(Value)) {
    return new Uint8Array(Value.buffer, Value.byteOffset, Value.byteLength)
  }

  throw new TypeError('Unsupported payload chunk type')
}

export function GetPayloadByteLength(Value: Exclude<HTTPSRequestPayload, NodeJS.ReadableStream | AsyncIterable<HTTPSRequestPayloadChunk>>): number {
  return PayloadChunkToUint8Array(Value).byteLength
}

export function ToReadableStream(Value: NodeJS.ReadableStream | AsyncIterable<HTTPSRequestPayloadChunk>): Readable {
  if (IsReadableStream(Value)) {
    return Value as Readable
  }

  return Readable.from(Value)
}

export function ResolveContentEncoding(Value?: string): HTTPCompressionAlgorithm | 'identity' {
  const Encodings = ParseTokenList(Value).filter(Item => Item !== 'identity')

  if (Encodings.length === 0) {
    return 'identity'
  }

  if (Encodings.length > 1) {
    throw new Error('Multiple content-encoding values are not supported')
  }

  const [Encoding] = Encodings
  if (Encoding === 'zstd' || Encoding === 'gzip' || Encoding === 'deflate') {
    return Encoding
  }

  throw new Error(`Unsupported response content-encoding: ${Encoding}`)
}

export function CreateDecodedBodyStream(Stream: Readable, EncodingHeader?: string): {
  Stream: Readable,
  ContentEncoding: HTTPCompressionAlgorithm | 'identity',
  DecodedBody: boolean
} {
  const ContentEncoding = ResolveContentEncoding(EncodingHeader)

  switch (ContentEncoding) {
    case 'identity':
      return {
        Stream,
        ContentEncoding,
        DecodedBody: false,
      }
    case 'zstd':
      return {
        Stream: Stream.pipe(ZLib.createZstdDecompress()),
        ContentEncoding,
        DecodedBody: true,
      }
    case 'gzip':
      return {
        Stream: Stream.pipe(ZLib.createGunzip()),
        ContentEncoding,
        DecodedBody: true,
      }
    case 'deflate':
      return {
        Stream: Stream.pipe(ZLib.createInflate()),
        ContentEncoding,
        DecodedBody: true,
      }
  }
}
