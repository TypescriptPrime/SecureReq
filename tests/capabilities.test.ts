import test from 'ava'
import { StartTestServer } from './support/server.js'
import { CreateTestClient } from './support/client.js'

test('SecureReq keeps origin capabilities conservative until evidence is observed', async T => {
  const TestServer = await StartTestServer()
  const Client = CreateTestClient()

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

test('SecureReq evicts least-recently-used origin capability entries', async T => {
  const TestServers = await Promise.all([StartTestServer(), StartTestServer()])
  const [FirstServer, SecondServer] = TestServers
  const Client = CreateTestClient({
    OriginCapabilityCacheLimit: 1,
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
