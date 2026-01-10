# @typescriptprime/parsing

Lightweight helper utilities for parsing CLI-style arguments, implemented in TypeScript.

This package provides two small helpers:

- `PreProcessing` — trims `process.argv` to remove the node executable and optional script filename, returning the array of option tokens.
- `PostProcessing` — parses the token list that looks like `--Name Value` into a typed options object and an array of positional arguments (everything after `--`).

---

## 📦 Install

```bash
npm install @typescriptprime/parsing
```

> [!NOTE]
> This repo is authored as an ES module and fully typed with TypeScript.

---

## Usage

Import the helpers from the package and combine them to parse `process.argv`:

```typescript
import { PreProcessing, PostProcessing } from '@typescriptprime/parsing'

async function Main(Argv: string[]) {
  // Step 1: Trim the node executable and optional script path
  const Filtered = PreProcessing(Argv)

  // Step 2: Parse CLI-style parameters into an options object and positional arguments
  const { Options, Positional } = await PostProcessing(Filtered)

  console.log('Options:', Options)
  console.log('Positional args:', Positional)
}

Main(process.argv)
```

### Naming Convention

By default, `PostProcessing` converts parameter names into PascalCase using `es-toolkit` (so `--parameter-name` becomes `ParameterName`). You can supply a custom `NamingConvention` function via `IParsingOptions`:

```typescript
import * as ESToolkit from 'es-toolkit'

await PostProcessing(argv, { NamingConvention: ESToolkit.camelCase })
// or custom:
await PostProcessing(argv, { NamingConvention: (s) => s.replace(/^--/, '') })
```

---

## ⚡ Quick Examples

From `process.argv` in Node.js:

```typescript
const Argv = ['/usr/local/bin/node', '/path/to/script.js', '--enable-feature', '--parameter', 'value', '--', 'positional1', 'positional2']

const Tokens = PreProcessing(Argv)
// tokens === ['--enable-feature', '--parameter', 'value', '--', 'positional1', 'positional2']

const { Options, Positional } = await PostProcessing(Tokens)
// Options === { EnableFeature: true, Parameter: 'value' }
// Positional === ['positional1', 'positional2']
```

Boolean flags example:

```ts
const Tokens = PreProcessing(['/usr/bin/node', '/script.js', '--flag', '--other', 'value'])
// tokens === ['--flag', '--other', 'value']
const { Options } = await PostProcessing(Tokens)
// Options === { Flag: true, Other: 'value' }
```

---

## API

- `PreProcessing(argv: typeof process.argv): string[]`
  - Removes the node executable and optional file argument and returns the tokens starting at the first option.

- `PostProcessing<I extends JSONValue>(Args: string[], FuncOptions?: IParsingOptions): Promise<{ Options: I, Positional: string[] }>`
  - Converts `--key value` pairs into a typed `Options` object; flags without values are treated as `true`.
  - Stops parsing options when it hits `--` and returns the rest as `Positional` arguments.

### Types

- `JSONValue`, `JSONObject`, `JSONArray`, `JSONPrimitive` — standard JSON type helpers
- `IParsingOptions` — currently supports:
  - `NamingConvention?: (PropertyName: string) => string | Promise<string>`

---

## Scripts

- `npm run build` — runs: `esbuild` to bundle the compiled JS and TypeScript compiler to emit declarations.
- `npm test` — runs AVA tests.
- `npm run lint` — runs ESLint checks.

This project is published as an ES module. If you are developing locally, the following commands are useful:

- `npm run build:esbuild` — bundle with esbuild (JS output)
- `npm run build:tsc` — emit TypeScript declarations only

The package `exports` are configured in `package.json` so importing the default entry works with ESM loaders.

---

## Tests

The `tests/` directory contains unit tests for both `PreProcessing` and `PostProcessing` with AVA. They include:

- PreProcessing: removes node executable and file name using different `process.argv` shapes
- PostProcessing: parsing single/two parameters, boolean flags, and the `--` positional argument separator.

Run tests with:

```bash
npm test
```

---

## Project Layout

- `sources/` — TypeScript source files for the package
  - `index.ts` — entry exports
  - `preprocessing/index.ts` — `PreProcessing` implementation
  - `postprocessing/index.ts` — `PostProcessing` implementation
  - `types.ts` — JSON types and `IParsingOptions`
- `dist/` — build output (ignored in source control)
- `tests/` — unit tests using AVA

---

## License

Licensed under the Apache-2.0 license — see `LICENSE` for details.
