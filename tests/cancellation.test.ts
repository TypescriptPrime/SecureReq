import test from 'ava'
import { ReadStreamAsString, StartTestServer } from './support/server.js'
import { CreateTestClient } from './support/client.js'

test('SecureReq enforces per-request timeouts while waiting for response headers', async T => {
  const TestServer = await StartTestServer()
  const Client = CreateTestClient()

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

test('SecureReq keeps request timeouts active for streaming responses', async T => {
  const TestServer = await StartTestServer()
  const Client = CreateTestClient()

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
  const Client = CreateTestClient()

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
