import { Readable } from 'node:stream'
import test from 'ava'
import { SecureReq } from '@/index.js'
import { ReadStreamAsString, StartHTTP1OnlyTestServer, StartTestServer } from './support/server.js'

test('SecureReq probes with http/1.1 then upgrades to http/2 with negotiated compression state', async T => {
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

  T.is(First.Protocol, 'http/1.1')
  T.is(First.ContentEncoding, 'gzip')
  T.true(First.DecodedBody)
  T.is((First.Body as { Protocol: string }).Protocol, 'http/1.1')
  T.is(First.Headers['x-observed-accept-encoding'], 'zstd, gzip, deflate')

  T.is(Second.Protocol, 'http/2')
  T.is((Second.Body as { Protocol: string }).Protocol, 'http/2')
  T.is(Second.Headers['x-observed-accept-encoding'], 'gzip')

  T.truthy(Capabilities)
  T.deepEqual(Capabilities?.SupportedCompressions, ['gzip'])
  T.true(Capabilities?.HTTP3Advertised ?? false)
  T.is(Capabilities?.PreferredProtocol, 'http/2')
})

test('SecureReq keeps origin capabilities conservative until evidence is observed', async T => {
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

  const Response = await Client.Request(new URL('/plain', TestServer.BaseUrl), {
    ExpectedAs: 'String',
  })
  const Capabilities = Client.GetOriginCapabilities(new URL(TestServer.BaseUrl))

  T.is(Response.Protocol, 'http/1.1')
  T.is(Capabilities?.PreferredProtocol, 'http/1.1')
  T.deepEqual(Capabilities?.SupportedCompressions, [])
  T.false(Capabilities?.HTTP3Advertised ?? true)
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

    T.is(Response.Protocol, 'http/1.1')
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
  await Client.Request(new URL('/negotiate', TestServer.BaseUrl), { ExpectedAs: 'JSON' })

  const Response = await Client.Request(new URL('/stream-upload', TestServer.BaseUrl), {
    Payload: Readable.from(['alpha-', 'beta-', 'gamma']),
    ExpectedAs: 'Stream',
    HttpMethod: 'POST',
  })

  T.is(Response.Protocol, 'http/2')
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
    PreferredProtocol: 'http/1.1',
  })

  const HTTP2Response = await Client.Request(new URL('/plain', TestServer.BaseUrl), {
    ExpectedAs: 'String',
    PreferredProtocol: 'http/2',
  })

  T.is(HTTP1Response.Protocol, 'http/1.1')
  T.is(await ReadStreamAsString(HTTP1Response.Body), 'echo:explicit-http1')

  T.is(HTTP2Response.Protocol, 'http/2')
  T.is(HTTP2Response.Body, 'plain:http/2')
})

test('SecureReq auto-detects response parsing when ExpectedAs is omitted', async T => {
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

  const JSONResponse = await Client.Request(new URL('/auto.json', TestServer.BaseUrl))
  const TextResponse = await Client.Request(new URL('/auto.txt', TestServer.BaseUrl))
  const BufferResponse = await Client.Request(new URL('/plain', TestServer.BaseUrl))

  T.deepEqual(JSONResponse.Body, { ok: true })
  T.is(TextResponse.Body, 'auto-text')
  T.true(BufferResponse.Body instanceof ArrayBuffer)
})

test('SecureReq evicts least-recently-used origin capability entries', async T => {
  const TestServers = await Promise.all([StartTestServer(), StartTestServer()])
  const [FirstServer, SecondServer] = TestServers
  const Client = new SecureReq({
    OriginCapabilityCacheLimit: 1,
    DefaultOptions: {
      TLS: {
        RejectUnauthorized: false,
      },
    },
  })

  T.teardown(async () => {
    Client.Close()
    await Promise.all(TestServers.map(async TestServer => {
      await TestServer.Close()
    }))
  })

  await Client.Request(new URL('/negotiate', FirstServer.BaseUrl), { ExpectedAs: 'JSON' })
  T.truthy(Client.GetOriginCapabilities(new URL(FirstServer.BaseUrl)))

  await Client.Request(new URL('/negotiate', SecondServer.BaseUrl), { ExpectedAs: 'JSON' })

  T.is(Client.GetOriginCapabilities(new URL(FirstServer.BaseUrl)), undefined)
  T.truthy(Client.GetOriginCapabilities(new URL(SecondServer.BaseUrl)))
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

test('SecureReq normalizes duplicate supported compressions from constructor options', async T => {
  const TestServer = await StartTestServer()
  const Client = new SecureReq({
    SupportedCompressions: ['gzip', 'gzip', 'deflate'],
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

  const Response = await Client.Request(new URL('/negotiate', TestServer.BaseUrl), { ExpectedAs: 'JSON' })

  T.is(Response.Headers['x-observed-accept-encoding'], 'gzip, deflate')
})

test('SecureReq enforces per-request timeouts while waiting for response headers', async T => {
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

  const Error = await T.throwsAsync(async () => {
    await Client.Request(new URL('/slow-headers', TestServer.BaseUrl), {
      ExpectedAs: 'String',
      TimeoutMs: 75,
    })
  })

  T.is(Error?.name, 'TimeoutError')
  T.is(Error?.message, 'Request timed out after 75ms')
})

test('SecureReq safely falls back to http/1.1 after automatic HTTP/2 negotiation failure for GET', async T => {
  const TestServer = await StartHTTP1OnlyTestServer()
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

  const First = await Client.Request(new URL('/plain', TestServer.BaseUrl), {
    ExpectedAs: 'String',
  })
  const Second = await Client.Request(new URL('/plain', TestServer.BaseUrl), {
    ExpectedAs: 'String',
  })

  T.is(First.Protocol, 'http/1.1')
  T.is(Second.Protocol, 'http/1.1')
  T.is(TestServer.GetRequestCount('/plain'), 2)
})

test('SecureReq keeps request timeouts active for streaming responses', async T => {
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

  const Response = await Client.Request(new URL('/slow-stream', TestServer.BaseUrl), {
    ExpectedAs: 'Stream',
    TimeoutMs: 150,
  })

  const Error = await T.throwsAsync(async () => {
    await ReadStreamAsString(Response.Body)
  })

  T.is(Error?.name, 'TimeoutError')
  T.is(Error?.message, 'Request timed out after 150ms')
})

test('SecureReq supports AbortSignal cancellation', async T => {
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

  const Controller = new AbortController()
  const PendingRequest = Client.Request(new URL('/slow-headers', TestServer.BaseUrl), {
    ExpectedAs: 'String',
    Signal: Controller.signal,
  })

  setTimeout(() => {
    Controller.abort()
  }, 75)

  const Error = await T.throwsAsync(async () => {
    await PendingRequest
  })

  T.is(Error?.name, 'AbortError')
  T.is(Error?.message, 'Request was aborted')
})

test('SecureReq does not auto-retry non-idempotent requests while HTTP/2 support is still unknown', async T => {
  const TestServer = await StartHTTP1OnlyTestServer()
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

  await Client.Request(new URL('/plain', TestServer.BaseUrl), {
    ExpectedAs: 'String',
  })

  const Response = await Client.Request(new URL('/stream-upload', TestServer.BaseUrl), {
    HttpMethod: 'POST',
    Payload: Readable.from(['no-', 'retry']),
    ExpectedAs: 'Stream',
  })

  T.is(Response.Protocol, 'http/1.1')
  T.is(await ReadStreamAsString(Response.Body), 'echo:no-retry')
  T.is(TestServer.GetRequestCount('/stream-upload'), 1)
})

test('SecureReq does not auto-retry HTTP/2 JSON parse failures', async T => {
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

  const Error = await T.throwsAsync(async () => {
    await Client.Request(new URL('/invalid-json', TestServer.BaseUrl), {
      ExpectedAs: 'JSON',
    })
  })

  T.truthy(Error)
  T.is(TestServer.GetRequestCount('/invalid-json'), 1)
})

test('SecureReq does not auto-retry HTTP/2 timeouts', async T => {
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

  const Error = await T.throwsAsync(async () => {
    await Client.Request(new URL('/slow-headers', TestServer.BaseUrl), {
      ExpectedAs: 'String',
      TimeoutMs: 75,
    })
  })

  T.is(Error?.name, 'TimeoutError')
  T.is(TestServer.GetRequestCount('/slow-headers'), 1)
})

test('SecureReq does not auto-retry HTTP/2 aborts', async T => {
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

  const Controller = new AbortController()
  const PendingRequest = Client.Request(new URL('/slow-headers', TestServer.BaseUrl), {
    ExpectedAs: 'String',
    Signal: Controller.signal,
  })

  setTimeout(() => {
    Controller.abort()
  }, 75)

  const Error = await T.throwsAsync(async () => {
    await PendingRequest
  })

  T.is(Error?.name, 'AbortError')
  T.is(TestServer.GetRequestCount('/slow-headers'), 1)
})
