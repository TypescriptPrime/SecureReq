import { SecureReq } from './secure-req.js'

export { SecureReq }

export const SimpleSecureReq = new SecureReq()

export type {
  AutoDetectedResponseBody,
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