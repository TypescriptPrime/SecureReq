import test from 'ava'
import { SecureReq } from '@/index.js'
import { StartTestServer } from './support/server.js'
import { CreateTestClient } from './support/client.js'

test('SecureReq auto-detects response parsing when ExpectedAs is omitted', async T => {
  const TestServer = await StartTestServer()
  const Client = CreateTestClient()

  T.teardown(async () => {
    Client.Close()
    await TestServer.Close()
  })

  const JSONResponse = await Client.Request(new URL('/auto.json', TestServer.BaseUrl))
  const TextResponse = await Client.Request(new URL('/auto.txt', TestServer.BaseUrl))
  const BufferResponse = await Client.Request(new URL('/plain', TestServer.BaseUrl))

  T.deepEqual(JSONResponse.Body, { ok: true })
  T.is(TextResponse.Body, 'auto-text')
  T.true(BufferResponse.Body instanceof ArrayBuffer)
})

test('SecureReq validates constructor options at initialization time', async T => {
  const InvalidCompression = 'brotli' as unknown as 'gzip'

  T.throws(() => {
    return new SecureReq({
      HTTP2SessionIdleTimeout: 0,
    })
  })

  T.throws(() => {
    return new SecureReq({
      OriginCapabilityCacheLimit: 0,
    })
  })

  T.throws(() => {
    return new SecureReq({
      SupportedCompressions: [InvalidCompression],
    })
  })

  T.throws(() => {
    return new SecureReq({
      DefaultOptions: {
        HttpMethod: 'TRACE' as unknown as 'GET',
      },
    })
  })
})
