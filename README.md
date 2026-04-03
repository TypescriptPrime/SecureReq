# SecureReq 🔐

**SecureReq** is a lightweight TypeScript utility for secure HTTP requests with strict TLS defaults, automatic http/1.1 to http/2 negotiation, streaming I/O, and typed response parsing.

---

## 🚀 Quick Summary

- **Class-first** API that probes each origin with `http/1.1` first, then upgrades future requests to `http/2` when appropriate.
- Automatic HTTP/2 probing is conservative: only safe body-less auto requests are retried from negotiation failure to `http/1.1`.
- Supports **response compression** with `zstd`, `gzip`, and `deflate`.
- Supports **streaming uploads and streaming downloads**.
- Defaults to **TLSv1.3**, Post Quantum Cryptography key exchange, a limited set of strongest ciphers, and a `User-Agent` header.

---

## 📦 Installation

```bash
npm install @typescriptprime/securereq
```

**Requirements:** Node.js >= 24

---

## Usage Examples 🔧

Create a client and reuse it per origin:

```ts
import { Readable } from 'node:stream'
import { SecureReq } from '@typescriptprime/securereq'

const client = new SecureReq()

// First request to an origin uses http/1.1 probing.
const first = await client.Request(new URL('https://api64.ipify.org?format=json'), {
  ExpectedAs: 'JSON',
})

// Later safe requests to the same origin can probe and establish http/2 automatically.
const second = await client.Request(new URL('https://api64.ipify.org?format=json'), {
  ExpectedAs: 'JSON',
})

console.log(first.Protocol) // 'http/1.1'
console.log(second.Protocol) // 'http/2' when available after the safe probe

// Stream upload + stream download
const streamed = await client.Request(new URL('https://example.com/upload'), {
  HttpMethod: 'POST',
  Payload: Readable.from(['chunk-1', 'chunk-2']),
  ExpectedAs: 'Stream',
})

for await (const chunk of streamed.Body) {
  console.log(chunk)
}
```

---

## API Reference 📚

### `new SecureReq(Options?)`

- Recommended entry point.
- Keeps per-origin capability state:
  - first request is sent with `http/1.1`
  - `Accept-Encoding: zstd, gzip, deflate`
  - later safe requests can probe `http/2`, and capability updates only reflect observed protocol/compression evidence
- `Close()` closes cached http/2 sessions.
- `OriginCapabilityCacheLimit` bounds remembered origin capability entries with LRU-style eviction.
- Invalid constructor options fail fast during initialization.

### `client.Request(Url, Options?)`

- `Url: URL` — Target URL (must be an instance of `URL`).
- `Options?: HTTPSRequestOptions` — Optional configuration object.

Returns:
- `ExpectedAs`를 명시하면 `Promise<HTTPSResponse<T>>`
- `ExpectedAs`를 생략하면 `Promise<HTTPSResponse<unknown>>`

Throws:
- `TypeError` when `Url` is not a `URL` instance.
- `Error` on request failure or on failed response parsing (e.g., invalid JSON).

### HTTPSRequestOptions

Fields:
- `TLS?: { IsHTTPSEnforced?: boolean, MinTLSVersion?: 'TLSv1.2'|'TLSv1.3', MaxTLSVersion?: 'TLSv1.2'|'TLSv1.3', Ciphers?: string[], KeyExchanges?: string[], RejectUnauthorized?: boolean }`
  - Defaults: `IsHTTPSEnforced: true`, both Min and Max set to `TLSv1.3`, a small secure cipher list and key exchange choices.
  - When `IsHTTPSEnforced` is `true`, a non-`https:` URL will throw.
- `HttpHeaders?: Record<string,string>` — Custom headers. A `User-Agent` header is provided by default.
- `HttpMethod?: 'GET'|'POST'|'PUT'|'DELETE'|'PATCH'|'HEAD'|'OPTIONS'`
- `Payload?: string | ArrayBuffer | Uint8Array | Readable | AsyncIterable`
- `ExpectedAs?: 'JSON'|'String'|'ArrayBuffer'|'Stream'` — How to parse the response body.
  - Omitting `ExpectedAs` keeps the runtime extension heuristic (`.json`, `.txt`, fallback `ArrayBuffer`) but the body type is intentionally `unknown`.
- `PreferredProtocol?: 'auto'|'http/1.1'|'http/2'|'http/3'`
  - `http/3` is currently a placeholder branch and falls back to `http/2`.
- `EnableCompression?: boolean` — Enables automatic `Accept-Encoding` negotiation and transparent response decompression.
- `TimeoutMs?: number` — Aborts the request if headers or body transfer exceed the given number of milliseconds.
- `Signal?: AbortSignal` — Cancels the request using a standard abort signal.

### HTTPSResponse

- `{ StatusCode: number, Headers: Record<string,string|string[]|undefined>, Body: T, Protocol: 'http/1.1'|'http/2', ContentEncoding: 'identity'|'zstd'|'gzip'|'deflate', DecodedBody: boolean }`

Notes:
- If `ExpectedAs` is omitted, a heuristic is still used at runtime: `.json` → `JSON`, `.txt` → `String`, otherwise `ArrayBuffer`.
- Because omitted `ExpectedAs` may produce different runtime body shapes, the TypeScript return type is `unknown`. Prefer explicit `ExpectedAs` in application code.
- When `ExpectedAs` is `JSON`, the body is parsed and an error is thrown if parsing fails.
- When `ExpectedAs` is `Stream`, the body is returned as a Node.js readable stream.
- Redirects are not followed automatically; `3xx` responses are returned as-is.

---

## Security & Behavior Notes 🔐

- Strict TLS defaults lean on **TLSv1.3** and a reduced cipher list to encourage secure transport out of the box.
- TLS options are forwarded to Node's HTTPS or http/2 TLS layer (`minVersion`, `maxVersion`, `ciphers`, `ecdhCurve`).
- The library uses `zod` for runtime validation of options.
- Compression negotiation is origin-scoped. Subdomains are tracked independently.
- `GetOriginCapabilities().PreferredProtocol` is updated from actual observed transport, and automatic fallback only occurs for safe negotiation failures before request bytes are sent.
- `GetOriginCapabilities().SupportedCompressions` is only narrowed when the response provided actual compression evidence.
- `GetOriginCapabilities().PreferredProtocol` reflects the currently usable transport (`http/1.1` or `http/2`), while `HTTP3Advertised` records whether the origin advertised `h3`.
- http/3 advertisement points are recorded from response headers, but Node.js built-in http/3 transport is not yet used.

---

## Development & Testing 🧪

- Build: `npm run build` (uses `tsc -p sources/tsconfig.json`)
- Test: `npm test` (uses `ava`)
- Lint: `npm run lint`

---

## Contributing

Contributions, bug reports and PRs are welcome — please follow the repository's contribution guidelines.

---

## License

This project is licensed under the **Apache-2.0** License. See the `LICENSE` file for details.
