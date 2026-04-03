import * as HTTP from 'node:http'
import * as HTTP2 from 'node:http2'
import * as HTTPS from 'node:https'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as TLS from 'node:tls'
import {
  ConnectionSpecificHeaders,
  DefaultHTTPHeaders,
  DefaultSupportedCompressions,
  DefaultTLSOptions,
  PayloadEnabledMethods,
} from './constants.js'
import { DetermineExpectedAs, ToError } from './request-helpers.js'
import { RequestOptionsSchema } from './request-schema.js'
import {
  CreateDecodedBodyStream,
  GetHeaderValue,
  GetOriginKey,
  GetPayloadByteLength,
  IntersectCompressionAlgorithms,
  IsStreamingPayload,
  NormalizeHeaders,
  NormalizeIncomingHeaders,
  ParseCompressionAlgorithms,
  PayloadChunkToUint8Array,
  ReadableToArrayBuffer,
  ResolveContentEncoding,
  SerializeTLSOptions,
  ToReadableStream,
} from './utils.js'
import type {
  ExpectedAsKey,
  ExpectedAsMap,
  HTTPCompressionAlgorithm,
  HTTPSRequestOptions,
  HTTPSResponse,
  OriginCapabilities,
  SecureReqOptions,
} from './type.js'

interface FinalizeResponseContext<E extends ExpectedAsKey> {
  Url: URL,
  Options: HTTPSRequestOptions<E>,
  ExpectedAs: E,
  Protocol: 'HTTP/1.1' | 'HTTP/2',
  StatusCode: number,
  Headers: Record<string, string | string[] | undefined>,
  ResponseStream: Readable,
  RequestedCompressions: HTTPCompressionAlgorithm[]
}

export class SecureReq {
  private readonly DefaultOptions: Omit<HTTPSRequestOptions, 'Payload' | 'ExpectedAs'>
  private readonly SupportedCompressions: HTTPCompressionAlgorithm[]
  private readonly HTTP2SessionIdleTimeout: number
  private readonly OriginCapabilityCache = new Map<string, OriginCapabilities>()
  private readonly HTTP2SessionCache = new Map<string, HTTP2.ClientHttp2Session>()

  public constructor(Options: SecureReqOptions = {}) {
    this.DefaultOptions = {
      TLS: {
        ...DefaultTLSOptions,
        ...(Options.DefaultOptions?.TLS ?? {}),
      },
      HttpHeaders: {
        ...DefaultHTTPHeaders,
        ...NormalizeHeaders(Options.DefaultOptions?.HttpHeaders),
      },
      HttpMethod: Options.DefaultOptions?.HttpMethod ?? 'GET',
      PreferredProtocol: Options.DefaultOptions?.PreferredProtocol ?? 'auto',
      EnableCompression: Options.DefaultOptions?.EnableCompression ?? true,
    }

    this.SupportedCompressions = (Options.SupportedCompressions?.length ? Options.SupportedCompressions : DefaultSupportedCompressions)
      .filter((Value, Index, Values) => Values.indexOf(Value) === Index)

    this.HTTP2SessionIdleTimeout = Options.HTTP2SessionIdleTimeout ?? 30_000
  }

  public async Request<E extends ExpectedAsKey = 'ArrayBuffer'>(Url: URL, Options?: HTTPSRequestOptions<E>): Promise<HTTPSResponse<ExpectedAsMap[E]>> {
    if (Url instanceof URL === false) {
      throw new TypeError('Url must be an instance of URL')
    }

    RequestOptionsSchema.parse(Options ?? {})

    const MergedOptions = this.MergeOptions(Options)
    const ExpectedAs = DetermineExpectedAs(Url, MergedOptions)
    this.ValidateRequest(Url, MergedOptions)

    const Protocol = this.ResolveTransportProtocol(Url, MergedOptions)

    try {
      if (Protocol === 'HTTP/2') {
        return await this.RequestWithHTTP2(Url, MergedOptions, ExpectedAs)
      }

      return await this.RequestWithHTTP1(Url, MergedOptions, ExpectedAs)
    } catch (Error) {
      const FallbackAllowed = Protocol === 'HTTP/2'
        && MergedOptions.PreferredProtocol !== 'HTTP/2'
        && MergedOptions.PreferredProtocol !== 'HTTP/3'
        && IsStreamingPayload(MergedOptions.Payload) === false

      if (FallbackAllowed) {
        this.MarkOriginAsHTTP1Only(Url)
        return await this.RequestWithHTTP1(Url, MergedOptions, ExpectedAs)
      }

      throw Error
    }
  }

  public GetOriginCapabilities(Url: URL): OriginCapabilities | undefined {
    const Capabilities = this.OriginCapabilityCache.get(GetOriginKey(Url))

    if (Capabilities === undefined) {
      return undefined
    }

    return {
      ...Capabilities,
      SupportedCompressions: [...Capabilities.SupportedCompressions],
    }
  }

  public Close(): void {
    for (const Session of this.HTTP2SessionCache.values()) {
      Session.close()
    }

    this.HTTP2SessionCache.clear()
  }

  private MergeOptions<E extends ExpectedAsKey>(Options?: HTTPSRequestOptions<E>): HTTPSRequestOptions<E> {
    return {
      ...this.DefaultOptions,
      ...Options,
      TLS: {
        ...this.DefaultOptions.TLS,
        ...(Options?.TLS ?? {}),
      },
      HttpHeaders: {
        ...this.DefaultOptions.HttpHeaders,
        ...NormalizeHeaders(Options?.HttpHeaders),
      },
      HttpMethod: Options?.HttpMethod ?? this.DefaultOptions.HttpMethod,
      PreferredProtocol: Options?.PreferredProtocol ?? this.DefaultOptions.PreferredProtocol,
      EnableCompression: Options?.EnableCompression ?? this.DefaultOptions.EnableCompression,
      Payload: Options?.Payload,
      ExpectedAs: Options?.ExpectedAs,
    }
  }

  private ValidateRequest(Url: URL, Options: HTTPSRequestOptions): void {
    if (Url.protocol !== 'http:' && Url.protocol !== 'https:') {
      throw new Error(`Unsupported URL protocol: ${Url.protocol}`)
    }

    if (Options.TLS?.IsHTTPSEnforced !== false && Url.protocol !== 'https:') {
      throw new Error('HTTPS is enforced, but the URL protocol is not HTTPS')
    }

    if ((Options.PreferredProtocol === 'HTTP/2' || Options.PreferredProtocol === 'HTTP/3') && Url.protocol !== 'https:') {
      throw new Error('HTTP/2 and HTTP/3 negotiation require an HTTPS URL')
    }

    if (Options.Payload !== undefined && PayloadEnabledMethods.has(Options.HttpMethod ?? 'GET') === false) {
      throw new Error('Request payload is only supported for GET, POST, PUT, PATCH, and OPTIONS methods')
    }
  }

  private ResolveTransportProtocol(Url: URL, Options: HTTPSRequestOptions): 'HTTP/1.1' | 'HTTP/2' {
    if (Url.protocol !== 'https:') {
      return 'HTTP/1.1'
    }

    switch (Options.PreferredProtocol) {
      case 'HTTP/1.1':
        return 'HTTP/1.1'
      case 'HTTP/2':
        return 'HTTP/2'
      case 'HTTP/3':
        return 'HTTP/2'
      default:
        break
    }

    const OriginCapabilities = this.OriginCapabilityCache.get(GetOriginKey(Url))
    if (OriginCapabilities?.ProbeCompleted !== true) {
      return 'HTTP/1.1'
    }

    if (OriginCapabilities.PreferredProtocol === 'HTTP/1.1') {
      return 'HTTP/1.1'
    }

    return 'HTTP/2'
  }

  private BuildRequestHeaders(Url: URL, Options: HTTPSRequestOptions): {
    Headers: Record<string, string>,
    RequestedCompressions: HTTPCompressionAlgorithm[]
  } {
    const Headers = NormalizeHeaders(Options.HttpHeaders)

    if (Options.EnableCompression !== false && Headers['accept-encoding'] === undefined) {
      const AcceptedCompressions = this.GetPreferredCompressions(Url)
      if (AcceptedCompressions.length > 0) {
        Headers['accept-encoding'] = AcceptedCompressions.join(', ')
      }
    }

    if (Options.Payload !== undefined && IsStreamingPayload(Options.Payload) === false && Headers['content-length'] === undefined) {
      Headers['content-length'] = String(GetPayloadByteLength(Options.Payload))
    }

    return {
      Headers,
      RequestedCompressions: ParseCompressionAlgorithms(Headers['accept-encoding']),
    }
  }

  private GetPreferredCompressions(Url: URL): HTTPCompressionAlgorithm[] {
    const OriginCapabilities = this.OriginCapabilityCache.get(GetOriginKey(Url))
    if (OriginCapabilities?.SupportedCompressions.length) {
      return [...OriginCapabilities.SupportedCompressions]
    }

    return [...this.SupportedCompressions]
  }

  private async RequestWithHTTP1<E extends ExpectedAsKey>(Url: URL, Options: HTTPSRequestOptions<E>, ExpectedAs: E): Promise<HTTPSResponse<ExpectedAsMap[E]>> {
    const { Headers, RequestedCompressions } = this.BuildRequestHeaders(Url, Options)

    return await new Promise<HTTPSResponse<ExpectedAsMap[E]>>((Resolve, Reject) => {
      let Settled = false

      const ResolveOnce = (Value: HTTPSResponse<ExpectedAsMap[E]>) => {
        if (Settled === false) {
          Settled = true
          Resolve(Value)
        }
      }

      const RejectOnce = (Error: unknown) => {
        if (Settled === false) {
          Settled = true
          Reject(ToError(Error))
        }
      }

      const Request = this.CreateHTTP1Request(Url, Options, Headers, Response => {
        void this.FinalizeResponse({
          Url,
          Options,
          ExpectedAs,
          Protocol: 'HTTP/1.1',
          StatusCode: Response.statusCode ?? 0,
          Headers: NormalizeIncomingHeaders(Response.headers as Record<string, unknown>),
          ResponseStream: Response,
          RequestedCompressions,
        }).then(ResolveOnce, RejectOnce)
      })

      Request.once('error', RejectOnce)

      void this.WritePayload(Request, Options.Payload).catch(Error => {
        Request.destroy(ToError(Error))
        RejectOnce(Error)
      })
    })
  }

  private CreateHTTP1Request(
    Url: URL,
    Options: HTTPSRequestOptions,
    Headers: Record<string, string>,
    OnResponse: (Response: HTTP.IncomingMessage) => void,
  ): HTTP.ClientRequest {
    const BaseOptions = {
      protocol: Url.protocol,
      hostname: Url.hostname,
      port: Url.port || undefined,
      path: Url.pathname + Url.search,
      headers: Headers,
      method: Options.HttpMethod,
    }

    if (Url.protocol === 'https:') {
      return HTTPS.request({
        ...BaseOptions,
        servername: Url.hostname,
        minVersion: Options.TLS?.MinTLSVersion,
        maxVersion: Options.TLS?.MaxTLSVersion,
        ciphers: Options.TLS?.Ciphers?.join(':'),
        ecdhCurve: Options.TLS?.KeyExchanges?.join(':'),
        rejectUnauthorized: Options.TLS?.RejectUnauthorized,
      }, OnResponse)
    }

    return HTTP.request(BaseOptions, OnResponse)
  }

  private async RequestWithHTTP2<E extends ExpectedAsKey>(Url: URL, Options: HTTPSRequestOptions<E>, ExpectedAs: E): Promise<HTTPSResponse<ExpectedAsMap[E]>> {
    const { Headers, RequestedCompressions } = this.BuildRequestHeaders(Url, Options)
    const Session = this.GetOrCreateHTTP2Session(Url, Options)
    const Request = Session.request({
      ':method': Options.HttpMethod,
      ':path': Url.pathname + Url.search,
      ':scheme': 'https',
      ':authority': Headers.host ?? Url.host,
      ...this.FilterHTTP2Headers(Headers),
    })

    return await new Promise<HTTPSResponse<ExpectedAsMap[E]>>((Resolve, Reject) => {
      let Settled = false

      const ResolveOnce = (Value: HTTPSResponse<ExpectedAsMap[E]>) => {
        if (Settled === false) {
          Settled = true
          Resolve(Value)
        }
      }

      const RejectOnce = (Error: unknown) => {
        if (Settled === false) {
          Settled = true
          this.InvalidateHTTP2Session(Url, Options, Session)
          Reject(ToError(Error))
        }
      }

      Request.once('response', ResponseHeaders => {
        void this.FinalizeResponse({
          Url,
          Options,
          ExpectedAs,
          Protocol: 'HTTP/2',
          StatusCode: Number(ResponseHeaders[':status'] ?? 0),
          Headers: NormalizeIncomingHeaders(ResponseHeaders as Record<string, unknown>),
          ResponseStream: Request,
          RequestedCompressions,
        }).then(ResolveOnce, RejectOnce)
      })

      Request.once('error', RejectOnce)

      void this.WritePayload(Request, Options.Payload).catch(Error => {
        Request.destroy(ToError(Error))
        RejectOnce(Error)
      })
    })
  }

  private GetOrCreateHTTP2Session(Url: URL, Options: HTTPSRequestOptions): HTTP2.ClientHttp2Session {
    const SessionKey = this.GetHTTP2SessionKey(Url, Options)
    const ExistingSession = this.HTTP2SessionCache.get(SessionKey)

    if (ExistingSession && ExistingSession.closed === false && ExistingSession.destroyed === false) {
      return ExistingSession
    }

    const Session = HTTP2.connect(GetOriginKey(Url), {
      createConnection: () => TLS.connect({
        host: Url.hostname,
        port: Number(Url.port || 443),
        servername: Url.hostname,
        minVersion: Options.TLS?.MinTLSVersion,
        maxVersion: Options.TLS?.MaxTLSVersion,
        ciphers: Options.TLS?.Ciphers?.join(':'),
        ecdhCurve: Options.TLS?.KeyExchanges?.join(':'),
        rejectUnauthorized: Options.TLS?.RejectUnauthorized,
        ALPNProtocols: ['h2', 'HTTP/1.1'],
      }),
    })

    Session.setTimeout(this.HTTP2SessionIdleTimeout, () => {
      Session.close()
    })

    if (typeof Session.unref === 'function') {
      Session.unref()
    }

    Session.on('close', () => {
      if (this.HTTP2SessionCache.get(SessionKey) === Session) {
        this.HTTP2SessionCache.delete(SessionKey)
      }
    })

    Session.on('error', () => {
      if (Session.closed || Session.destroyed) {
        this.HTTP2SessionCache.delete(SessionKey)
      }
    })

    Session.on('goaway', () => {
      this.HTTP2SessionCache.delete(SessionKey)
    })

    this.HTTP2SessionCache.set(SessionKey, Session)
    return Session
  }

  private GetHTTP2SessionKey(Url: URL, Options: HTTPSRequestOptions): string {
    return `${GetOriginKey(Url)}|${SerializeTLSOptions(Options.TLS)}`
  }

  private InvalidateHTTP2Session(Url: URL, Options: HTTPSRequestOptions, Session?: HTTP2.ClientHttp2Session): void {
    const SessionKey = this.GetHTTP2SessionKey(Url, Options)
    const SessionToClose = Session ?? this.HTTP2SessionCache.get(SessionKey)

    this.HTTP2SessionCache.delete(SessionKey)

    if (SessionToClose && SessionToClose.closed === false && SessionToClose.destroyed === false) {
      SessionToClose.close()
    }
  }

  private FilterHTTP2Headers(Headers: Record<string, string>): HTTP2.OutgoingHttpHeaders {
    return Object.fromEntries(
      Object.entries(Headers).filter(([Key]) => ConnectionSpecificHeaders.has(Key) === false),
    )
  }

  private async WritePayload(Request: NodeJS.WritableStream, Payload?: HTTPSRequestOptions['Payload']): Promise<void> {
    if (Payload === undefined) {
      Request.end()
      return
    }

    if (IsStreamingPayload(Payload)) {
      await pipeline(ToReadableStream(Payload), Request)
      return
    }

    Request.end(Buffer.from(PayloadChunkToUint8Array(Payload)))
  }

  private async FinalizeResponse<E extends ExpectedAsKey>(Context: FinalizeResponseContext<E>): Promise<HTTPSResponse<ExpectedAsMap[E]>> {
    this.UpdateOriginCapabilities(Context.Url, Context.Headers, Context.RequestedCompressions)

    let ResponseStream = Context.ResponseStream
    let ContentEncoding: HTTPCompressionAlgorithm | 'identity' = 'identity'
    let DecodedBody = false

    if (Context.Options.EnableCompression !== false) {
      const DecodedResponse = CreateDecodedBodyStream(ResponseStream, GetHeaderValue(Context.Headers, 'content-encoding'))
      ResponseStream = DecodedResponse.Stream
      ContentEncoding = DecodedResponse.ContentEncoding
      DecodedBody = DecodedResponse.DecodedBody
    } else {
      ContentEncoding = ResolveContentEncoding(GetHeaderValue(Context.Headers, 'content-encoding'))
    }

    const Headers = DecodedBody
      ? {
        ...Context.Headers,
        'content-encoding': undefined,
        'content-length': undefined,
      }
      : Context.Headers

    if (Context.ExpectedAs === 'Stream') {
      return {
        StatusCode: Context.StatusCode,
        Headers,
        Body: ResponseStream as ExpectedAsMap[E],
        Protocol: Context.Protocol,
        ContentEncoding,
        DecodedBody,
      }
    }

    const BodyBuffer = await ReadableToArrayBuffer(ResponseStream)
    let Body: ExpectedAsMap[E]

    switch (Context.ExpectedAs) {
      case 'JSON':
        try {
          Body = JSON.parse(new TextDecoder('utf-8').decode(BodyBuffer)) as ExpectedAsMap[E]
        } catch (Cause) {
          throw new Error('Failed to parse JSON response body', { cause: Cause })
        }
        break
      case 'String':
        Body = new TextDecoder('utf-8').decode(BodyBuffer) as ExpectedAsMap[E]
        break
      case 'ArrayBuffer':
      default:
        Body = BodyBuffer as ExpectedAsMap[E]
        break
    }

    return {
      StatusCode: Context.StatusCode,
      Headers,
      Body,
      Protocol: Context.Protocol,
      ContentEncoding,
      DecodedBody,
    }
  }

  private UpdateOriginCapabilities(
    Url: URL,
    Headers: Record<string, string | string[] | undefined>,
    RequestedCompressions: HTTPCompressionAlgorithm[],
  ): void {
    const Origin = GetOriginKey(Url)
    const ExistingCapabilities = this.OriginCapabilityCache.get(Origin)
    const NegotiatedCompressions = this.ResolveNegotiatedCompressions(Headers, RequestedCompressions)
    const HTTP3Advertised = this.IsHTTP3Advertised(Headers)

    this.OriginCapabilityCache.set(Origin, {
      Origin,
      ProbeCompleted: true,
      PreferredProtocol: Url.protocol === 'https:' ? (HTTP3Advertised ? 'HTTP/3' : 'HTTP/2') : 'HTTP/1.1',
      SupportedCompressions: NegotiatedCompressions.length > 0
        ? NegotiatedCompressions
        : [...(ExistingCapabilities?.SupportedCompressions ?? RequestedCompressions)],
      HTTP3Advertised,
    })
  }

  private ResolveNegotiatedCompressions(
    Headers: Record<string, string | string[] | undefined>,
    RequestedCompressions: HTTPCompressionAlgorithm[],
  ): HTTPCompressionAlgorithm[] {
    const ServerAcceptEncoding = ParseCompressionAlgorithms(GetHeaderValue(Headers, 'accept-encoding'))
    if (ServerAcceptEncoding.length > 0) {
      return IntersectCompressionAlgorithms(RequestedCompressions, ServerAcceptEncoding)
    }

    const ContentEncoding = ParseCompressionAlgorithms(GetHeaderValue(Headers, 'content-encoding'))
    if (ContentEncoding.length > 0) {
      return IntersectCompressionAlgorithms(RequestedCompressions, ContentEncoding)
    }

    return [...RequestedCompressions]
  }

  private IsHTTP3Advertised(Headers: Record<string, string | string[] | undefined>): boolean {
    const AltSvcHeader = GetHeaderValue(Headers, 'alt-svc')
    return /\bh3(?:-\d+)?\s*=/.test(AltSvcHeader ?? '')
  }

  private MarkOriginAsHTTP1Only(Url: URL): void {
    const Origin = GetOriginKey(Url)
    const ExistingCapabilities = this.OriginCapabilityCache.get(Origin)

    this.OriginCapabilityCache.set(Origin, {
      Origin,
      ProbeCompleted: true,
      PreferredProtocol: 'HTTP/1.1',
      SupportedCompressions: [...(ExistingCapabilities?.SupportedCompressions ?? this.SupportedCompressions)],
      HTTP3Advertised: ExistingCapabilities?.HTTP3Advertised ?? false,
    })
  }
}
