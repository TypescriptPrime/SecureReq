import * as Zod from 'zod'
import { AvailableTLSCiphers } from './constants.js'
import { IsStreamingPayload } from './utils.js'
import type { HTTPSRequestOptions } from './type.js'

export const RequestOptionsSchema = Zod.strictObject({
  TLS: Zod.strictObject({
    IsHTTPSEnforced: Zod.boolean().optional(),
    MinTLSVersion: Zod.enum(['TLSv1.2', 'TLSv1.3']).optional(),
    MaxTLSVersion: Zod.enum(['TLSv1.2', 'TLSv1.3']).optional(),
    Ciphers: Zod.array(
      Zod.string().refine(Cipher => AvailableTLSCiphers.has(Cipher.toLowerCase()), 'Unsupported TLS cipher'),
    ).optional(),
    KeyExchanges: Zod.array(Zod.string()).optional(),
    RejectUnauthorized: Zod.boolean().optional(),
  }).partial().optional(),
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
  PreferredProtocol: Zod.enum(['auto', 'HTTP/1.1', 'HTTP/2', 'HTTP/3']).optional(),
  EnableCompression: Zod.boolean().optional(),
})
