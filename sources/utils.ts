export function ConcatArrayBuffers(Buffers: ArrayBuffer[]): ArrayBuffer {
  const TotalLength = Buffers.reduce((Sum, Block) => Sum + Block.byteLength, 0)

  const Result = new Uint8Array(TotalLength)
  let Offset = 0

  for (const Buffer of Buffers) {
    Result.set(new Uint8Array(Buffer), Offset)
    Offset += Buffer.byteLength
  }

  return Result.buffer
}
