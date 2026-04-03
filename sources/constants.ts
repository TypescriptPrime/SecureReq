import * as Process from 'node:process'
import * as TLS from 'node:tls'
import type { HTTPCompressionAlgorithm, HTTPMethod, HTTPSRequestOptions } from './type.js'

export const DefaultTLSOptions = {
  IsHTTPSEnforced: true,
  MinTLSVersion: 'TLSv1.3',
  MaxTLSVersion: 'TLSv1.3',
  Ciphers: ['TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256'],
  KeyExchanges: ['X25519MLKEM768', 'X25519'],
  RejectUnauthorized: true,
} as const satisfies NonNullable<HTTPSRequestOptions['TLS']>

export const DefaultHTTPHeaders = {
  'user-agent': `node/${Process.version} ${Process.platform} ${Process.arch} workspace/false`,
} as const

export const DefaultSupportedCompressions: HTTPCompressionAlgorithm[] = ['zstd', 'gzip', 'deflate']
export const ConnectionSpecificHeaders = new Set(['connection', 'host', 'http2-settings', 'keep-alive', 'proxy-connection', 'te', 'transfer-encoding', 'upgrade'])
export const PayloadEnabledMethods = new Set<HTTPMethod>(['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS'])
export const AvailableTLSCiphers = new Set(TLS.getCiphers().map(Cipher => Cipher.toLowerCase()))
