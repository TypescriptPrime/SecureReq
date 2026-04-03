import { SecureReq } from '@/index.js'
import type { SecureReqOptions } from '@/index.js'

export function CreateTestClient(Options: SecureReqOptions = {}): SecureReq {
  return new SecureReq({
    ...Options,
    DefaultOptions: {
      ...Options.DefaultOptions,
      TLS: {
        RejectUnauthorized: false,
        ...(Options.DefaultOptions?.TLS ?? {}),
      },
    },
  })
}
