# SecureReq 🔐

**SecureReq** is a lightweight TypeScript utility for making secure HTTPS requests with strict TLS defaults and typed response parsing.

---

## 🚀 Quick Summary

- **Small, dependency-light** wrapper around Node's `https` for typed responses and safer TLS defaults.
- Defaults to **TLSv1.3**, Post Quantum Cryptography key exchange, a limited set of strongest ciphers, and a `User-Agent` header.
- Supports typed response parsing: `JSON`, `String`, or raw `ArrayBuffer`.

---

## 📦 Installation

```bash
npm install @typescriptprime/securereq
```

**Requirements:** Node.js >= 24

---

## Usage Examples 🔧

Import and call the helper:

```ts
import { HTTPSRequest } from '@typescriptprime/securereq'

// JSON (auto-detected by .json path) or explicit
const url = new URL('https://api64.ipify.org?format=json')
const res = await HTTPSRequest(url)
console.log(res.StatusCode) // number
console.log(res.Body) // ArrayBuffer or parsed JSON depending on `ExpectedAs` and URL

// Force string
const html = await HTTPSRequest(new URL('https://www.example.com/'), { ExpectedAs: 'String' })
console.log(typeof html.Body) // 'string'

// Force ArrayBuffer
const raw = await HTTPSRequest(new URL('https://example.com/'), { ExpectedAs: 'ArrayBuffer' })
console.log(raw.Body instanceof ArrayBuffer)
```

---

## API Reference 📚

### HTTPSRequest(Url, Options?)

- `Url: URL` — Target URL (must be an instance of `URL`).
- `Options?: HTTPSRequestOptions` — Optional configuration object.

Returns: `Promise<HTTPSResponse<T>>` where `T` is determined by `ExpectedAs`.

Throws:
- `TypeError` when `Url` is not a `URL` instance.
- `Error` on request failure or on failed response parsing (e.g., invalid JSON).

### HTTPSRequestOptions

Fields:
- `TLS?: { IsHTTPSEnforced?: boolean, MinTLSVersion?: 'TLSv1.2'|'TLSv1.3', MaxTLSVersion?: 'TLSv1.2'|'TLSv1.3', Ciphers?: string[], KeyExchanges?: string[] }`
  - Defaults: `IsHTTPSEnforced: true`, both Min and Max set to `TLSv1.3`, a small secure cipher list and key exchange choices.
  - When `IsHTTPSEnforced` is `true`, a non-`https:` URL will throw.
- `HttpHeaders?: Record<string,string>` — Custom headers. A `User-Agent` header is provided by default.
- `ExpectedAs?: 'JSON'|'String'|'ArrayBuffer'` — How to parse the response body.

### HTTPSResponse

- `{ StatusCode: number, Headers: Record<string,string|string[]|undefined>, Body: T }`

Notes:
- If `ExpectedAs` is omitted, a heuristic is used: `.json` → `JSON`, `.txt` → `String`, otherwise `ArrayBuffer`.
- When `ExpectedAs` is `JSON`, the body is parsed and an error is thrown if parsing fails.

---

## Security & Behavior Notes 🔐

- Strict TLS defaults lean on **TLSv1.3** and a reduced cipher list to encourage secure transport out of the box.
- TLS options are forwarded to Node's HTTPS layer (`minVersion`, `maxVersion`, `ciphers`, `ecdhCurve`).
- The library uses `zod` for runtime validation of options.

---

## Development & Testing 🧪

- Build: `npm run build` (uses `esbuild` + `tsc` for types)
- Test: `npm test` (uses `ava`)
- Lint: `npm run lint`

---

## Contributing

Contributions, bug reports and PRs are welcome — please follow the repository's contribution guidelines.

---

## License

This project is licensed under the **Apache-2.0** License. See the `LICENSE` file for details.