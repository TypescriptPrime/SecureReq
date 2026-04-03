import * as Zod from 'zod'
import { AvailableTLSCiphers, DefaultSupportedCompressions } from './constants.js'
import { IsAbortSignal, IsStreamingPayload } from './utils.js'
import type { HTTPSRequestOptions, SecureReqOptions } from './type.js'

const HTTPCompressionAlgorithmSchema = Zod.enum(DefaultSupportedCompressions)

const TLSOptionsSchema = Zod.strictObject({
  IsHTTPSEnforced: Zod.boolean(),
  MinTLSVersion: Zod.enum(['TLSv1.2', 'TLSv1.3']),
  MaxTLSVersion: Zod.enum(['TLSv1.2', 'TLSv1.3']),
  Ciphers: Zod.array(
    Zod.string().refine(Cipher => AvailableTLSCiphers.has(Cipher.toLowerCase()), 'Unsupported TLS cipher'),
  ),
  KeyExchanges: Zod.array(Zod.string()),
  RejectUnauthorized: Zod.boolean(),
}).partial()

export const RequestOptionsSchema = Zod.strictObject({
  TLS: TLSOptionsSchema.optional(),
  HttpHeaders: Zod.record(Zod.string(), Zod.string()).optional(),
  HttpMethod: Zod.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']).optional(),
  Payload: Zod.union([
    Zod.string(),
    Zod.instanceof(ArrayBuffer),
    Zod.instanceof(Uint8Array),
    Zod.custom<NonNullable<HTTPSRequestOptions['Payload']>>(Value => IsStreamingPayload(Value), {
      message: 'Payload must be a string, ArrayBuffer, Uint8Array, Readable stream, or AsyncIterable',
    }),
  ]).optional(),
  ExpectedAs: Zod.enum(['JSON', 'String', 'ArrayBuffer', 'Stream']).optional(),
  PreferredProtocol: Zod.enum(['auto', 'http/1.1', 'http/2', 'http/3']).optional(),
  EnableCompression: Zod.boolean().optional(),
  TimeoutMs: Zod.number().finite().positive().optional(),
  Signal: Zod.custom<AbortSignal>(Value => IsAbortSignal(Value), {
    message: 'Signal must be an AbortSignal',
  }).optional(),
})

export const SecureReqDefaultOptionsSchema = RequestOptionsSchema.omit({
  Payload: true,
  ExpectedAs: true,
  Signal: true,
})

export const SecureReqOptionsSchema = Zod.strictObject({
  DefaultOptions: SecureReqDefaultOptionsSchema.optional(),
  SupportedCompressions: Zod.array(HTTPCompressionAlgorithmSchema).optional(),
  HTTP2SessionIdleTimeout: Zod.number().finite().positive().optional(),
  OriginCapabilityCacheLimit: Zod.number().finite().int().positive().optional(),
}) satisfies Zod.ZodType<SecureReqOptions>
