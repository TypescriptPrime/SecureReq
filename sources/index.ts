import * as HTTPS from 'node:https'
import * as TLS from 'node:tls'
import * as Process from 'node:process'
import * as Zod from 'zod'
import { ConcatArrayBuffers } from './utils.js'
import type { HTTPSRequestOptions, HTTPSResponse, ExpectedAsMap, ExpectedAsKey } from './type.js'


/**
 * Perform an HTTPS GET request with strict TLS defaults and typed response parsing.
 *
 * @param {URL} Url - The target URL. Must be an instance of `URL`.
 * @param {HTTPSRequestOptions<E>} [Options] - Request options including TLS settings, headers, and `ExpectedAs`. Defaults to secure TLS v1.3 and a default `User-Agent` header.
 * @returns {Promise<HTTPSResponse<ExpectedAsMap[E]>>} Resolves with `{ StatusCode, Headers, Body }`, where `Body` is parsed according to `ExpectedAs`.
 * @throws {TypeError} If `Url` is not an instance of `URL`.
 * @throws {Error} When the request errors or if parsing the response body (e.g. JSON) fails.
 *
 * Notes:
 * - TLS options are forwarded to the underlying Node.js HTTPS request (minVersion, maxVersion, ciphers, ecdhCurve).
 */
export async function HTTPSRequest<E extends ExpectedAsKey = 'ArrayBuffer'>(Url: URL, Options?: HTTPSRequestOptions<E>): Promise<HTTPSResponse<ExpectedAsMap[E]>> {
  const DefaultOptions = {
    TLS: {
      IsHTTPSEnforced: true,
      MinTLSVersion: 'TLSv1.3',
      MaxTLSVersion: 'TLSv1.3',
      Ciphers: ['TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256'],
      KeyExchanges: ['X25519MLKEM768', 'X25519'],
    },
    HttpHeaders: {
      'User-Agent': `node/${Process.version} ${Process.platform} ${Process.arch} workspace/false`,
    },
  } as const

  const MergedOptions = { ...DefaultOptions, ...(Options ?? {}) } as HTTPSRequestOptions<E>
  if (Url instanceof URL === false) {
    throw new TypeError('Url must be an instance of URL')
  }

  await Zod.strictObject({
    TLS: Zod.strictObject({
      IsHTTPSEnforced: Zod.boolean().optional(),
      MinTLSVersion: Zod.enum(['TLSv1.2', 'TLSv1.3']).optional(),
      MaxTLSVersion: Zod.enum(['TLSv1.2', 'TLSv1.3']).optional(),
      Ciphers: Zod.array(Zod.string().refine(Cipher => TLS.getCiphers().map(C => C.toLowerCase()).includes(Cipher.toLowerCase()))).optional(),
      KeyExchanges: Zod.array(Zod.string()).optional()
    }).partial().optional(),
    HttpHeaders: Zod.record(Zod.string(), Zod.string()).optional(),
    ExpectedAs: Zod.enum(['JSON', 'String', 'ArrayBuffer']).optional()
  }).parseAsync(Options ?? {})
  
  if (MergedOptions.TLS?.IsHTTPSEnforced && Url.protocol !== 'https:') {
    throw new Error('HTTPS is enforced, but the URL protocol is not HTTPS')
  }

  const ExpectedAs = (Options?.ExpectedAs ?? (Url.pathname.endsWith('.json') ? 'JSON' : Url.pathname.endsWith('.txt') ? 'String' : 'ArrayBuffer')) as E

  const HTTPSResponse = await new Promise<HTTPSResponse<ExpectedAsMap[E]>>((Resolve, Reject) => {
    const HTTPSRequestInstance = HTTPS.get({
      protocol: Url.protocol,
      hostname: Url.hostname,
      port: Url.port,
      path: Url.pathname + Url.search,
      headers: MergedOptions.HttpHeaders,
      minVersion: MergedOptions.TLS?.MinTLSVersion,
      maxVersion: MergedOptions.TLS?.MaxTLSVersion,
      ciphers: MergedOptions.TLS?.Ciphers?.join(':'),
      ecdhCurve: MergedOptions.TLS?.KeyExchanges?.join(':'),
    }, (Res) => {
      const Chunks: ArrayBuffer[] = []
      Res.on('data', (Chunk) => {
        Chunks.push(Chunk.buffer.slice(Chunk.byteOffset, Chunk.byteOffset + Chunk.byteLength))
      })
      Res.on('end', () => {
        const BodyBuffer = ConcatArrayBuffers(Chunks)
        let Body: unknown
        switch (ExpectedAs) {
          case 'JSON':
            try {
              Body = JSON.parse(new TextDecoder('utf-8').decode(BodyBuffer))
            } catch (Error) {
              return Reject(new Error('Failed to parse JSON response body'))
            }
            break
          case 'String':
            Body = new TextDecoder('utf-8').decode(BodyBuffer)
            break
          case 'ArrayBuffer':
            Body = BodyBuffer
            break
        }
        Resolve({
          StatusCode: Res.statusCode ?? 0,
          Headers: Res.headers as Record<string, string | string[] | undefined>,
          Body,
        } as HTTPSResponse<ExpectedAsMap[E]>)
      })
    })

    HTTPSRequestInstance.on('error', (Error) => {
      Reject(Error)
    })
  })

  return HTTPSResponse
}