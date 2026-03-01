import * as HTTPS from 'node:https'
import * as HTTP2 from 'node:http2'
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
    HttpMethod: 'GET',
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
    HttpMethod: Zod.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']).optional(),
    Payload: Zod.union([Zod.string(), Zod.instanceof(ArrayBuffer), Zod.instanceof(Uint8Array)]).optional(),
    ExpectedAs: Zod.enum(['JSON', 'String', 'ArrayBuffer']).optional()
  }).parseAsync(Options ?? {})
  
  if (MergedOptions.TLS?.IsHTTPSEnforced && Url.protocol !== 'https:') {
    throw new Error('HTTPS is enforced, but the URL protocol is not HTTPS')
  }

  if (MergedOptions.Payload && !['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS'].includes(MergedOptions.HttpMethod ?? 'GET')) {
    throw new Error('Request payload is only supported for GET, POST, PUT, PATCH, and OPTIONS methods')
  }

  const ExpectedAs = (Options?.ExpectedAs ?? (Url.pathname.endsWith('.json') ? 'JSON' : Url.pathname.endsWith('.txt') ? 'String' : 'ArrayBuffer')) as E

  const HTTPSResponse = await new Promise<HTTPSResponse<ExpectedAsMap[E]>>((Resolve, Reject) => {
    const HTTPSRequestInstance = HTTPS.request({
      protocol: Url.protocol,
      hostname: Url.hostname,
      port: Url.port,
      path: Url.pathname + Url.search,
      headers: MergedOptions.HttpHeaders,
      minVersion: MergedOptions.TLS?.MinTLSVersion,
      maxVersion: MergedOptions.TLS?.MaxTLSVersion,
      ciphers: MergedOptions.TLS?.Ciphers?.join(':'),
      ecdhCurve: MergedOptions.TLS?.KeyExchanges?.join(':'),
      method: MergedOptions.HttpMethod,
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

    if (MergedOptions.Payload !== undefined) {
      if (typeof MergedOptions.Payload === 'string') {
        HTTPSRequestInstance.write(MergedOptions.Payload)
      } else if (MergedOptions.Payload instanceof ArrayBuffer) {
        HTTPSRequestInstance.write(MergedOptions.Payload)
      } else if (MergedOptions.Payload instanceof Uint8Array) {
        HTTPSRequestInstance.write(MergedOptions.Payload)
      }
    }

    HTTPSRequestInstance.end()
  })

  return HTTPSResponse
}

/**
 * Perform an HTTP request over TLS using Node's `http` and `tls` modules.
 *
 * @param {URL} Url - The target URL. Must be an instance of `URL`.
 * @param {HTTPSRequestOptions<E>} [Options] - Request options including TLS settings, headers, and `ExpectedAs`. Defaults to secure TLS v1.3 and a default `User-Agent` header.
 * @returns {Promise<HTTPSResponse<ExpectedAsMap[E]>>} Resolves with `{ StatusCode, Headers, Body }`, where `Body` is parsed according to `ExpectedAs`.
 * @throws {TypeError} If `Url` is not an instance of `URL`.
 * @throws {Error} When the request errors or if parsing the response body (e.g. JSON) fails.
 *
 * Notes:
 * - Uses `node:http` with a custom TLS socket from `node:tls` (HTTP over TLS).
 * - TLS options are forwarded to the underlying TLS connection (minVersion, maxVersion, ciphers, ecdhCurve).
 */
export async function HTTPS2Request<E extends ExpectedAsKey = 'ArrayBuffer'>(Url: URL, Options?: HTTPSRequestOptions<E>): Promise<HTTPSResponse<ExpectedAsMap[E]>> {
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
    HttpMethod: 'GET'
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
    ExpectedAs: Zod.enum(['JSON', 'String', 'ArrayBuffer']).optional(),
    HttpMethod: Zod.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']).optional(),
    Payload: Zod.union([Zod.string(), Zod.instanceof(ArrayBuffer), Zod.instanceof(Uint8Array)]).optional()
  }).parseAsync(Options ?? {})

  if (MergedOptions.TLS?.IsHTTPSEnforced && Url.protocol !== 'https:') {
    throw new Error('HTTPS is enforced, but the URL protocol is not HTTPS')
  }

  if (MergedOptions.Payload && !['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS'].includes(MergedOptions.HttpMethod ?? 'GET')) {
    throw new Error('Request payload is only supported for GET, POST, PUT, PATCH, and OPTIONS methods')
  }

  const ExpectedAs = (Options?.ExpectedAs ?? (Url.pathname.endsWith('.json') ? 'JSON' : Url.pathname.endsWith('.txt') ? 'String' : 'ArrayBuffer')) as E

  const HTTPSResponse = await new Promise<HTTPSResponse<ExpectedAsMap[E]>>((Resolve, Reject) => {
    const NormalizedHeaders = Object.fromEntries(Object.entries(MergedOptions.HttpHeaders ?? {}).map(([Key, Value]) => [Key.toLowerCase(), Value]))
    const HTTP2Session = HTTP2.connect(`https://${Url.hostname}${Url.port ? `:${Url.port}` : ''}`, {
      createConnection: () => TLS.connect({
        host: Url.hostname,
        port: Number(Url.port || 443),
        servername: Url.hostname,
        minVersion: MergedOptions.TLS?.MinTLSVersion,
        maxVersion: MergedOptions.TLS?.MaxTLSVersion,
        ciphers: MergedOptions.TLS?.Ciphers?.join(':'),
        ecdhCurve: MergedOptions.TLS?.KeyExchanges?.join(':'),
        ALPNProtocols: ['h2'],
      })
    })

    HTTP2Session.on('error', (Error) => {
      Reject(Error)
    })

    const RequestHeaders: HTTP2.OutgoingHttpHeaders = {
      ':method': MergedOptions.HttpMethod,
      ':path': Url.pathname + Url.search,
      ':scheme': 'https',
      ':authority': Url.host,
      ...NormalizedHeaders,
    }

    const Request = HTTP2Session.request(RequestHeaders)
    const Chunks: ArrayBuffer[] = []
    let StatusCode = 0
    let ResponseHeaders: Record<string, string | string[] | undefined> = {}

    Request.on('response', (Headers) => {
      StatusCode = Number(Headers[':status'] ?? 0)
      ResponseHeaders = Object.fromEntries(Object.entries(Headers)
        .filter(([Key]) => !Key.startsWith(':'))
        .map(([Key, Value]) => {
          if (Array.isArray(Value)) {
            return [Key, Value.map(Item => Item?.toString())]
          }
          return [Key, Value?.toString()]
        })) as Record<string, string | string[] | undefined>
    })

    Request.on('data', (Chunk) => {
      Chunks.push(Chunk.buffer.slice(Chunk.byteOffset, Chunk.byteOffset + Chunk.byteLength))
    })

    Request.on('end', () => {
      const BodyBuffer = ConcatArrayBuffers(Chunks)
      let Body: unknown
      switch (ExpectedAs) {
        case 'JSON':
          try {
            Body = JSON.parse(new TextDecoder('utf-8').decode(BodyBuffer))
          } catch (Error) {
            HTTP2Session.close()
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
      HTTP2Session.close()
      Resolve({
        StatusCode,
        Headers: ResponseHeaders,
        Body,
      } as HTTPSResponse<ExpectedAsMap[E]>)
    })

    Request.on('error', (Error) => {
      HTTP2Session.close()
      Reject(Error)
    })

    if (MergedOptions.Payload !== undefined) {
      if (typeof MergedOptions.Payload === 'string') {
        Request.write(MergedOptions.Payload)
      } else if (MergedOptions.Payload instanceof ArrayBuffer) {
        Request.write(MergedOptions.Payload)
      } else if (MergedOptions.Payload instanceof Uint8Array) {
        Request.write(MergedOptions.Payload)
      }
    }

    Request.end()
  })

  return HTTPSResponse
}