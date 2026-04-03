import * as HTTP2 from 'node:http2'
import * as ZLib from 'node:zlib'
import { CreateTestTLSCertificate } from './tls.js'
import type { HTTPCompressionAlgorithm } from '@/index.js'

export interface TestServer {
  BaseUrl: string,
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

export async function StartTestServer(): Promise<TestServer> {
  const TLSCertificate = await CreateTestTLSCertificate()
  const Server = HTTP2.createSecureServer({
    allowHTTP1: true,
    key: TLSCertificate.Key,
    cert: TLSCertificate.Cert,
  })

  let IsClosed = false

  Server.on('request', (Request, Response) => {
    void (async () => {
      const RequestUrl = new URL(Request.url ?? '/', 'https://localhost')
      const AcceptEncoding = Array.isArray(Request.headers['accept-encoding'])
        ? Request.headers['accept-encoding'].join(', ')
        : Request.headers['accept-encoding'] ?? ''
      const Protocol = Request.httpVersion === '2.0' ? 'HTTP/2' : 'HTTP/1.1'

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
          Response.setHeader('alt-svc', 'h3=":443"; ma=60')
          if (ChosenEncoding) {
            Response.setHeader('content-encoding', ChosenEncoding)
          }
          Response.end(Payload)
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

          Response.write(ResponseBody.subarray(0, Half))
          setTimeout(() => {
            Response.end(ResponseBody.subarray(Half))
          }, 10)
          break
        }

        case '/plain': {
          Response.statusCode = 200
          Response.setHeader('content-type', 'text/plain; charset=utf-8')
          Response.end(Buffer.from(`plain:${Protocol}`))
          break
        }

        default: {
          Response.statusCode = 404
          Response.setHeader('content-type', 'text/plain; charset=utf-8')
          Response.end(Buffer.from('not-found'))
        }
      }
    })().catch(Error => {
      Response.statusCode = 500
      Response.setHeader('content-type', 'text/plain; charset=utf-8')
      Response.end(Buffer.from(String(Error)))
    })
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
  } catch (Error) {
    await TLSCertificate.Cleanup()
    throw Error
  }

  const Address = Server.address()
  if (Address === null || typeof Address === 'string') {
    await TLSCertificate.Cleanup()
    throw new Error('Failed to resolve test server address')
  }

  return {
    BaseUrl: `https://localhost:${Address.port}`,
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

      await TLSCertificate.Cleanup()
    },
  }
}
