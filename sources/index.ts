import { SecureReq } from './secure-req.js'

export { SecureReq }

export const GlobalSecureReq = new SecureReq()

export type {
  ExpectedAsKey,
  ExpectedAsMap,
  HTTPCompressionAlgorithm,
  HTTPMethod,
  HTTPProtocol,
  HTTPSRequestOptions,
  HTTPSResponse,
  OriginCapabilities,
  SecureReqOptions,
} from './type.js'
