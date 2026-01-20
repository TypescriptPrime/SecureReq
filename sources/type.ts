interface TLSOptions {
  IsHTTPSEnforced?: boolean,
  MinTLSVersion?: 'TLSv1.2' | 'TLSv1.3',
  MaxTLSVersion?: 'TLSv1.2' | 'TLSv1.3',
  Ciphers?: string[],
  KeyExchanges?: string[]
} 

export interface HTTPSRequestOptions<E extends ExpectedAsKey = ExpectedAsKey> {
  TLS?: TLSOptions,
  HttpHeaders?: Record<string, string>,
  HttpMethod?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS',
  Payload?: string | ArrayBuffer | Uint8Array,
  ExpectedAs?: E
}

export interface HTTPSResponse<T extends unknown | string | ArrayBuffer> {
  StatusCode: number,
  Headers: Record<string, string | string[] | undefined>,
  Body: T
}

export type ExpectedAsMap = {
  'JSON': unknown,
  'String': string,
  'ArrayBuffer': ArrayBuffer
}
export type ExpectedAsKey = keyof ExpectedAsMap