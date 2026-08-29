import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import test from 'ava'
import { StartTestProxy, CreateHTTPConnectTunnel } from './support/proxy.js'
import { StartTestServer } from './support/server.js'
import { CreateTestClient } from './support/client.js'

test('SecureReq routes HTTP proxy Agents through HTTP/1.1', async T => {
  const TestServer = await StartTestServer()
  const Proxy = await StartTestProxy()
  const Agent = new HttpsProxyAgent(Proxy.HttpUrl)
  const Client = CreateTestClient({
    DefaultOptions: { Agent },
  })

  T.teardown(async () => {
    Client.Close()
    Agent.destroy()
    await Proxy.Close()
    await TestServer.Close()
  })

  const First = await Client.Request(new URL('/plain', TestServer.BaseUrl), { ExpectedAs: 'String' })
  const Second = await Client.Request(new URL('/plain', TestServer.BaseUrl), { ExpectedAs: 'String' })

  T.is(First.Protocol, 'http/1.1')
  T.is(First.Body, 'plain:http/1.1')
  T.is(Second.Protocol, 'http/1.1')
  T.is(Second.Body, 'plain:http/1.1')
  T.is(Proxy.GetTunnelCount(), 2)
})

test('SecureReq routes SOCKS proxy Agents through HTTP/1.1', async T => {
  const TestServer = await StartTestServer()
  const Proxy = await StartTestProxy()
  const Agent = new SocksProxyAgent(Proxy.SocksUrl)
  const Client = CreateTestClient({
    DefaultOptions: { Agent },
  })

  T.teardown(async () => {
    Client.Close()
    Agent.destroy()
    await Proxy.Close()
    await TestServer.Close()
  })

  const Response = await Client.Request(new URL('/plain', TestServer.BaseUrl), { ExpectedAs: 'String' })

  T.is(Response.Protocol, 'http/1.1')
  T.is(Response.Body, 'plain:http/1.1')
  T.is(Proxy.GetTunnelCount(), 1)
})

test('SecureReq uses CreateConnection proxy tunnels for HTTP/2', async T => {
  const TestServer = await StartTestServer()
  const Proxy = await StartTestProxy()
  const Client = CreateTestClient({
    DefaultOptions: {
      CreateConnection: CreateHTTPConnectTunnel(Proxy.HttpUrl),
    },
  })

  T.teardown(async () => {
    Client.Close()
    await Proxy.Close()
    await TestServer.Close()
  })

  const First = await Client.Request(new URL('/plain', TestServer.BaseUrl), { ExpectedAs: 'String' })
  const Second = await Client.Request(new URL('/plain', TestServer.BaseUrl), { ExpectedAs: 'String' })

  T.is(First.Protocol, 'http/1.1')
  T.is(Second.Protocol, 'http/2')
  T.is(Second.Body, 'plain:http/2')
  T.is(Proxy.GetTunnelCount(), 2)
})

test('SecureReq rejects HTTP/2 Agent requests without a tunnel callback', async T => {
  const Agent = new HttpsProxyAgent('http://127.0.0.1:1')
  const Client = CreateTestClient()

  T.teardown(() => {
    Client.Close()
    Agent.destroy()
  })

  const Error = await T.throwsAsync(async () => {
    await Client.Request(new URL('https://example.test'), {
      Agent,
      ExpectedAs: 'String',
      PreferredProtocol: 'http/2',
    })
  })

  T.is(Error?.message, 'http/2 and http/3 requests with Agent require CreateConnection to establish a proxy tunnel')
})