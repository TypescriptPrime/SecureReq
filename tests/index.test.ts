import { Readable } from 'node:stream'
import test from 'ava'
import { SecureReq } from '@/index.js'
import { ReadStreamAsString, StartTestServer } from './support/server.js'

test('SecureReq probes with HTTP/1.1 then upgrades to HTTP/2 with negotiated compression state', async T => {
  const TestServer = await StartTestServer()
  const Client = new SecureReq({
    DefaultOptions: {
      TLS: {
        RejectUnauthorized: false,
      },
    },
  })

  T.teardown(async () => {
    Client.Close()
    await TestServer.Close()
  })

  const First = await Client.Request(new URL('/negotiate', TestServer.BaseUrl), { ExpectedAs: 'JSON' })
  const Second = await Client.Request(new URL('/negotiate', TestServer.BaseUrl), { ExpectedAs: 'JSON' })
  const Capabilities = Client.GetOriginCapabilities(new URL(TestServer.BaseUrl))

  T.is(First.Protocol, 'HTTP/1.1')
  T.is(First.ContentEncoding, 'gzip')
  T.true(First.DecodedBody)
  T.is((First.Body as { Protocol: string }).Protocol, 'HTTP/1.1')
  T.is(First.Headers['x-observed-accept-encoding'], 'zstd, gzip, deflate')

  T.is(Second.Protocol, 'HTTP/2')
  T.is((Second.Body as { Protocol: string }).Protocol, 'HTTP/2')
  T.is(Second.Headers['x-observed-accept-encoding'], 'gzip')

  T.truthy(Capabilities)
  T.deepEqual(Capabilities?.SupportedCompressions, ['gzip'])
  T.true(Capabilities?.HTTP3Advertised ?? false)
  T.is(Capabilities?.PreferredProtocol, 'HTTP/3')
})

for (const Encoding of ['gzip', 'deflate', 'zstd'] as const) {
  test(`SecureReq decodes ${Encoding} responses`, async T => {
    const TestServer = await StartTestServer()
    const Client = new SecureReq({
      DefaultOptions: {
        TLS: {
          RejectUnauthorized: false,
        },
      },
    })

    T.teardown(async () => {
      Client.Close()
      await TestServer.Close()
    })

    const Response = await Client.Request(new URL(`/encoded/${Encoding}`, TestServer.BaseUrl), {
      ExpectedAs: 'String',
      HttpHeaders: {
        'accept-encoding': Encoding,
      },
    })

    T.is(Response.Protocol, 'HTTP/1.1')
    T.is(Response.ContentEncoding, Encoding)
    T.true(Response.DecodedBody)
    T.is(Response.Body, `compressed:${Encoding}`)
  })
}

test('SecureReq supports streaming upload and streaming download after HTTP/2 upgrade', async T => {
  const TestServer = await StartTestServer()
  const Client = new SecureReq({
    DefaultOptions: {
      TLS: {
        RejectUnauthorized: false,
      },
    },
  })

  T.teardown(async () => {
    Client.Close()
    await TestServer.Close()
  })

  await Client.Request(new URL('/negotiate', TestServer.BaseUrl), { ExpectedAs: 'JSON' })

  const Response = await Client.Request(new URL('/stream-upload', TestServer.BaseUrl), {
    Payload: Readable.from(['alpha-', 'beta-', 'gamma']),
    ExpectedAs: 'Stream',
    HttpMethod: 'POST',
  })

  T.is(Response.Protocol, 'HTTP/2')
  T.true(Response.DecodedBody)
  T.is(await ReadStreamAsString(Response.Body), 'echo:alpha-beta-gamma')
})

test('SecureReq supports explicit protocol preferences without legacy wrappers', async T => {
  const TestServer = await StartTestServer()
  const Client = new SecureReq({
    DefaultOptions: {
      TLS: {
        RejectUnauthorized: false,
      },
    },
  })

  T.teardown(async () => {
    Client.Close()
    await TestServer.Close()
  })

  const HTTP1Response = await Client.Request(new URL('/stream-upload', TestServer.BaseUrl), {
    HttpMethod: 'POST',
    Payload: Readable.from(['explicit-', 'http1']),
    ExpectedAs: 'Stream',
    PreferredProtocol: 'HTTP/1.1',
  })

  const HTTP2Response = await Client.Request(new URL('/plain', TestServer.BaseUrl), {
    ExpectedAs: 'String',
    PreferredProtocol: 'HTTP/2',
  })

  T.is(HTTP1Response.Protocol, 'HTTP/1.1')
  T.is(await ReadStreamAsString(HTTP1Response.Body), 'echo:explicit-http1')

  T.is(HTTP2Response.Protocol, 'HTTP/2')
  T.is(HTTP2Response.Body, 'plain:HTTP/2')
})
