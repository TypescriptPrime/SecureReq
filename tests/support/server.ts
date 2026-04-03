import * as HTTP from 'node:http'
import * as HTTP2 from 'node:http2'
import * as HTTPS from 'node:https'
import * as ZLib from 'node:zlib'
import { CreateTestTLSCertificate } from './tls.js'
import type { HTTPCompressionAlgorithm } from '@/index.js'

type TestRequest = HTTP.IncomingMessage | HTTP2.Http2ServerRequest
type TestResponse = HTTP.ServerResponse<HTTP.IncomingMessage> | HTTP2.Http2ServerResponse<HTTP2.Http2ServerRequest>
type TestNodeServer = HTTPS.Server | HTTP2.Http2SecureServer

export interface TestServer {
  BaseUrl: string,
  GetRequestCount: (Path: string) => number,
  GetSecureConnectionCount: () => number,
  Close: () => Promise<void>
}

function SelectCompression(HeaderValue: string): HTTPCompressionAlgorithm | undefined {
  const Normalized = HeaderValue.toLowerCase()

  if (Normalized.includes('gzip')) {
    return 'gzip'
  }

  if (Normalized.includes('deflate')) {
    return 'deflate'
  }

  if (Normalized.includes('zstd')) {
    return 'zstd'
  }

  return undefined
}

function CompressBody(Body: string | Uint8Array, Encoding?: HTTPCompressionAlgorithm): Buffer {
  const Input = Buffer.from(Body)

  switch (Encoding) {
    case 'gzip':
      return ZLib.gzipSync(Input)
    case 'deflate':
      return ZLib.deflateSync(Input)
    case 'zstd':
      return ZLib.zstdCompressSync(Input)
    default:
      return Input
  }
}

function IncrementRequestCount(RequestCounts: Map<string, number>, Path: string): void {
  RequestCounts.set(Path, (RequestCounts.get(Path) ?? 0) + 1)
}

function GetAcceptEncoding(Request: TestRequest): string {
  return Array.isArray(Request.headers['accept-encoding'])
    ? Request.headers['accept-encoding'].join(', ')
    : Request.headers['accept-encoding'] ?? ''
}

function WriteResponse(Response: TestResponse, Chunk: Uint8Array): void {
  ;(Response as HTTP.ServerResponse<HTTP.IncomingMessage>).write(Chunk)
}

function EndResponse(Response: TestResponse, Chunk: Uint8Array): void {
  ;(Response as HTTP.ServerResponse<HTTP.IncomingMessage>).end(Chunk)
}

export async function ReadStreamAsString(Stream: AsyncIterable<string | Uint8Array>): Promise<string> {
  let Result = ''

  for await (const Chunk of Stream) {
    Result += typeof Chunk === 'string' ? Chunk : Buffer.from(Chunk).toString('utf-8')
  }

  return Result
}

async function ReadRequestBody(Request: AsyncIterable<string | Uint8Array>): Promise<string> {
  return await ReadStreamAsString(Request)
}

function CreateRequestHandler(RequestCounts: Map<string, number>, AdvertiseHTTP3: boolean): (Request: TestRequest, Response: TestResponse) => void {
  return (Request, Response) => {
    void (async () => {
      const RequestUrl = new URL(Request.url ?? '/', 'https://localhost')
      const AcceptEncoding = GetAcceptEncoding(Request)
      const Protocol = Request.httpVersion === '2.0' ? 'http/2' : 'http/1.1'

      IncrementRequestCount(RequestCounts, RequestUrl.pathname)

      switch (RequestUrl.pathname) {
        case '/negotiate': {
          const ChosenEncoding = SelectCompression(AcceptEncoding)
          const Payload = CompressBody(JSON.stringify({
            Protocol,
            AcceptEncoding,
          }), ChosenEncoding)

          Response.statusCode = 200
          Response.setHeader('content-type', 'application/json')
          Response.setHeader('x-observed-accept-encoding', AcceptEncoding)
          if (AdvertiseHTTP3) {
            Response.setHeader('alt-svc', 'h3=":443"; ma=60')
          }
          if (ChosenEncoding) {
            Response.setHeader('content-encoding', ChosenEncoding)
          }
          Response.end(Payload)
          break
        }

        case '/invalid-json': {
          Response.statusCode = 200
          Response.setHeader('content-type', 'application/json')
          Response.end(Buffer.from('{invalid-json'))
          break
        }

        case '/auto.json': {
          Response.statusCode = 200
          Response.setHeader('content-type', 'application/json')
          Response.end(Buffer.from(JSON.stringify({ ok: true })))
          break
        }

        case '/auto.txt': {
          Response.statusCode = 200
          Response.setHeader('content-type', 'text/plain; charset=utf-8')
          Response.end(Buffer.from('auto-text'))
          break
        }

        case '/encoded/gzip':
        case '/encoded/deflate':
        case '/encoded/zstd': {
          const Encoding = RequestUrl.pathname.split('/').at(-1) as HTTPCompressionAlgorithm
          const Payload = CompressBody(`compressed:${Encoding}`, Encoding)

          Response.statusCode = 200
          Response.setHeader('content-type', 'text/plain; charset=utf-8')
          Response.setHeader('content-encoding', Encoding)
          Response.end(Payload)
          break
        }

        case '/stream-upload': {
          const RequestBody = await ReadRequestBody(Request)
          const ResponseBody = CompressBody(`echo:${RequestBody}`, 'gzip')
          const Half = Math.ceil(ResponseBody.length / 2)

          Response.statusCode = 200
          Response.setHeader('content-type', 'text/plain; charset=utf-8')
          Response.setHeader('content-encoding', 'gzip')

          WriteResponse(Response, ResponseBody.subarray(0, Half))
          setTimeout(() => {
            EndResponse(Response, ResponseBody.subarray(Half))
          }, 10)
          break
        }

        case '/plain': {
          Response.statusCode = 200
          Response.setHeader('content-type', 'text/plain; charset=utf-8')
          Response.end(Buffer.from(`plain:${Protocol}`))
          break
        }

        case '/slow-headers': {
          setTimeout(() => {
            if (Response.writableEnded) {
              return
            }

            Response.statusCode = 200
            Response.setHeader('content-type', 'text/plain; charset=utf-8')
            Response.end(Buffer.from('slow-headers'))
          }, 250)
          break
        }

        case '/slow-stream': {
          Response.statusCode = 200
          Response.setHeader('content-type', 'text/plain; charset=utf-8')
          ;(Response as TestResponse & { flushHeaders?: () => void }).flushHeaders?.()
          WriteResponse(Response, Buffer.from('slow-'))

          setTimeout(() => {
            if (Response.writableEnded) {
              return
            }

            EndResponse(Response, Buffer.from('stream'))
          }, 400)
          break
        }

        default: {
          Response.statusCode = 404
          Response.setHeader('content-type', 'text/plain; charset=utf-8')
          Response.end(Buffer.from('not-found'))
        }
      }
    })().catch(Cause => {
      Response.statusCode = 500
      Response.setHeader('content-type', 'text/plain; charset=utf-8')
      Response.end(Buffer.from(String(Cause)))
    })
  }
}

async function StartServer(
  Server: TestNodeServer,
  RequestCounts: Map<string, number>,
  TLSCleanup: () => Promise<void>,
): Promise<TestServer> {
  let IsClosed = false
  let SecureConnectionCount = 0

  Server.on('secureConnection', () => {
    SecureConnectionCount += 1
  })

  try {
    await new Promise<void>((Resolve, Reject) => {
      const HandleError = (Error: Error) => {
        Server.off('listening', HandleListening)
        Reject(Error)
      }

      const HandleListening = () => {
        Server.off('error', HandleError)
        Resolve()
      }

      Server.once('error', HandleError)
      Server.once('listening', HandleListening)
      Server.listen(0, '127.0.0.1')
    })
  } catch (Cause) {
    await TLSCleanup()
    throw Cause
  }

  const Address = Server.address()
  if (Address === null || typeof Address === 'string') {
    await TLSCleanup()
    throw new Error('Failed to resolve test server address')
  }

  return {
    BaseUrl: `https://localhost:${Address.port}`,
    GetRequestCount: Path => RequestCounts.get(Path) ?? 0,
    GetSecureConnectionCount: () => SecureConnectionCount,
    Close: async () => {
      if (IsClosed) {
        return
      }

      IsClosed = true

      await new Promise<void>((Resolve, Reject) => {
        Server.close(Error => {
          if (Error) {
            Reject(Error)
            return
          }

          Resolve()
        })
      })

      await TLSCleanup()
    },
  }
}

async function CreateTLSServer(AdvertiseHTTP3: boolean, HTTP2Enabled: boolean): Promise<TestServer> {
  const TLSCertificate = await CreateTestTLSCertificate()
  const RequestCounts = new Map<string, number>()
  const Handler = CreateRequestHandler(RequestCounts, AdvertiseHTTP3)

  const Server = HTTP2Enabled
    ? HTTP2.createSecureServer({
      allowHTTP1: true,
      key: TLSCertificate.Key,
      cert: TLSCertificate.Cert,
    })
    : HTTPS.createServer({
      key: TLSCertificate.Key,
      cert: TLSCertificate.Cert,
    })

  Server.on('request', Handler)

  return await StartServer(Server, RequestCounts, TLSCertificate.Cleanup)
}

export async function StartTestServer(): Promise<TestServer> {
  return await CreateTLSServer(true, true)
}

export async function StartHTTP1OnlyTestServer(): Promise<TestServer> {
  return await CreateTLSServer(false, false)
}
