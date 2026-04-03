import { Readable } from 'node:stream'
import test from 'ava'
import { StartTestServer } from './support/server.js'
import { CreateTestClient } from './support/client.js'

test('SecureReq returns redirect responses as-is by default', async T => {
  const TestServer = await StartTestServer()
  const Client = CreateTestClient()

  T.teardown(async () => {
    Client.Close()
    await TestServer.Close()
  })

  const Response = await Client.Request(new URL('/redirect/plain', TestServer.BaseUrl), {
    ExpectedAs: 'String',
  })

  T.is(Response.StatusCode, 302)
  T.is(Response.Headers.location, '/plain')
  T.is(TestServer.GetRequestCount('/redirect/plain'), 1)
  T.is(TestServer.GetRequestCount('/plain'), 0)
})

test('SecureReq follows redirects when FollowRedirects is enabled', async T => {
  const TestServer = await StartTestServer()
  const Client = CreateTestClient()

  T.teardown(async () => {
    Client.Close()
    await TestServer.Close()
  })

  const Response = await Client.Request(new URL('/redirect/plain', TestServer.BaseUrl), {
    ExpectedAs: 'String',
    FollowRedirects: true,
  })

  T.is(Response.StatusCode, 200)
  T.true(Response.Body === 'plain:http/1.1' || Response.Body === 'plain:http/2')
  T.is(TestServer.GetRequestCount('/redirect/plain'), 1)
  T.is(TestServer.GetRequestCount('/plain'), 1)
})

test('SecureReq enforces MaxRedirects while following redirects', async T => {
  const TestServer = await StartTestServer()
  const Client = CreateTestClient()

  T.teardown(async () => {
    Client.Close()
    await TestServer.Close()
  })

  const Error = await T.throwsAsync(async () => {
    await Client.Request(new URL('/redirect/chain/1', TestServer.BaseUrl), {
      ExpectedAs: 'String',
      FollowRedirects: true,
      MaxRedirects: 1,
    })
  })

  T.is(Error?.message, 'Maximum redirect limit exceeded (1)')
})

test('SecureReq converts POST to GET for 302 redirects', async T => {
  const TestServer = await StartTestServer()
  const Client = CreateTestClient()

  T.teardown(async () => {
    Client.Close()
    await TestServer.Close()
  })

  const Response = await Client.Request(new URL('/redirect/post-302', TestServer.BaseUrl), {
    ExpectedAs: 'JSON',
    FollowRedirects: true,
    HttpMethod: 'POST',
    Payload: 'alpha-beta',
  })

  T.is((Response.Body as { Method: string }).Method, 'GET')
  T.is((Response.Body as { Body: string }).Body, '')
  T.true(['http/1.1', 'http/2'].includes((Response.Body as { Protocol: string }).Protocol))
})

test('SecureReq preserves method and payload for 307 redirects with replayable payloads', async T => {
  const TestServer = await StartTestServer()
  const Client = CreateTestClient()

  T.teardown(async () => {
    Client.Close()
    await TestServer.Close()
  })

  const Response = await Client.Request(new URL('/redirect/post-307', TestServer.BaseUrl), {
    ExpectedAs: 'JSON',
    FollowRedirects: true,
    HttpMethod: 'POST',
    Payload: 'alpha-beta',
  })

  T.deepEqual(Response.Body, {
    Method: 'POST',
    Body: 'alpha-beta',
    Protocol: 'http/1.1',
  })
})

test('SecureReq rejects redirect replay for streaming payloads', async T => {
  const TestServer = await StartTestServer()
  const Client = CreateTestClient()

  T.teardown(async () => {
    Client.Close()
    await TestServer.Close()
  })

  const Error = await T.throwsAsync(async () => {
    await Client.Request(new URL('/redirect/post-307', TestServer.BaseUrl), {
      ExpectedAs: 'JSON',
      FollowRedirects: true,
      HttpMethod: 'POST',
      Payload: Readable.from(['alpha-', 'beta']),
    })
  })

  T.is(Error?.message, 'Cannot automatically follow redirects that require replaying a streaming payload')
  T.is(TestServer.GetRequestCount('/inspect-request'), 0)
})
