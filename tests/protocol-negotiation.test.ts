import { Readable } from 'node:stream'
import test from 'ava'
import { ReadStreamAsString, StartHTTP1OnlyTestServer, StartTestServer } from './support/server.js'
import { CreateTestClient } from './support/client.js'

test('SecureReq probes with http/1.1 then upgrades to http/2 with negotiated compression state', async T => {
  const TestServer = await StartTestServer()
  const Client = CreateTestClient()

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

test('SecureReq supports streaming upload and streaming download after HTTP/2 upgrade', async T => {
  const TestServer = await StartTestServer()
  const Client = CreateTestClient()

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
  const Client = CreateTestClient()

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

test('SecureReq safely falls back to http/1.1 after automatic HTTP/2 negotiation failure for GET', async T => {
  const TestServer = await StartHTTP1OnlyTestServer()
  const Client = CreateTestClient()

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
  T.is(TestServer.GetSecureConnectionCount(), 2)
})

test('SecureReq does not auto-retry non-idempotent requests while HTTP/2 support is still unknown', async T => {
  const TestServer = await StartHTTP1OnlyTestServer()
  const Client = CreateTestClient()

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
  const Client = CreateTestClient()

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
  const Client = CreateTestClient()

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
  const Client = CreateTestClient()

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
