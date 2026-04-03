import { SecureReq } from './secure-req.js'

export { SecureReq }

let GlobalSecureReqInstance: SecureReq | undefined

export function GetGlobalSecureReq(): SecureReq {
  GlobalSecureReqInstance ??= new SecureReq()
  return GlobalSecureReqInstance
}

export const GlobalSecureReq = new Proxy({} as SecureReq, {
  get(Target, Property) {
    void Target

    const Instance = GetGlobalSecureReq()
    const Value = Reflect.get(Instance, Property)
    return typeof Value === 'function' ? Value.bind(Instance) : Value
  },
  set(Target, Property, Value) {
    void Target
    return Reflect.set(GetGlobalSecureReq(), Property, Value)
  },
}) as SecureReq

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
