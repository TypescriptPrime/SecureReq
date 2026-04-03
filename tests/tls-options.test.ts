import test from 'ava'
import { CreateTestClient } from './support/client.js'
import { StartTLS12ECDSATestServer } from './support/server.js'

test('SecureReq explains TLSv1.2 curve mismatches when KeyExchanges is too restrictive', async T => {
  const TestServer = await StartTLS12ECDSATestServer()
  const Client = CreateTestClient()

  T.teardown(async () => {
    Client.Close()
    await TestServer.Close()
  })

  const Error = await T.throwsAsync(async () => {
    await Client.Request(new URL('/plain', TestServer.BaseUrl), {
      ExpectedAs: 'String',
      TLS: {
        RejectUnauthorized: false,
        MinTLSVersion: 'TLSv1.2',
        MaxTLSVersion: 'TLSv1.2',
        Ciphers: ['ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-ECDSA-CHACHA20-POLY1305'],
        KeyExchanges: ['X25519'],
      },
    })
  })

  T.true(Error?.message.includes('KeyExchanges (X25519)'))
  T.true(Error?.message.includes('P-256'))
})

test('SecureReq can connect to TLSv1.2 ECDSA servers when KeyExchanges includes a compatible certificate curve', async T => {
  const TestServer = await StartTLS12ECDSATestServer()
  const Client = CreateTestClient()

  T.teardown(async () => {
    Client.Close()
    await TestServer.Close()
  })

  const Response = await Client.Request(new URL('/plain', TestServer.BaseUrl), {
    ExpectedAs: 'String',
    TLS: {
      RejectUnauthorized: false,
      MinTLSVersion: 'TLSv1.2',
      MaxTLSVersion: 'TLSv1.2',
      Ciphers: ['ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-ECDSA-CHACHA20-POLY1305'],
      KeyExchanges: ['X25519', 'P-256'],
    },
  })

  T.is(Response.Body, 'plain:http/1.1')
  T.is(Response.Protocol, 'http/1.1')
})
