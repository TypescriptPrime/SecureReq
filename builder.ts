import * as ESBuild from 'esbuild'

await ESBuild.build({
  entryPoints: ['sources/index.ts'],
  platform: 'node',
  target: ['node24'],
  outdir: 'dist',
  sourcemap: 'linked',
  format: 'esm',
  external: []
})