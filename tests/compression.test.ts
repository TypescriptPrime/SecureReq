import test from 'ava'
import { StartTestServer } from './support/server.js'
import { CreateTestClient } from './support/client.js'

for (const Encoding of ['gzip', 'deflate', 'zstd'] as const) {
  test(`SecureReq decodes ${Encoding} responses`, async T => {
    const TestServer = await StartTestServer()
    const Client = CreateTestClient()

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

test('SecureReq normalizes duplicate supported compressions from constructor options', async T => {
  const TestServer = await StartTestServer()
  const Client = CreateTestClient({
    SupportedCompressions: ['gzip', 'gzip', 'deflate'],
  })

  T.teardown(async () => {
    Client.Close()
    await TestServer.Close()
  })

  const Response = await Client.Request(new URL('/negotiate', TestServer.BaseUrl), { ExpectedAs: 'JSON' })

  T.is(Response.Headers['x-observed-accept-encoding'], 'gzip, deflate')
})
