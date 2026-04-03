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
import {
  DetermineExpectedAs,
  HTTP2NegotiationError,
  IsAutomaticHTTP2ProbeMethod,
  IsHTTP2NegotiationError,
  ToError,
} from './request-helpers.js'
import { RequestOptionsSchema, SecureReqOptionsSchema } from './request-schema.js'
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
  AutoDetectedResponseBody,
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
  Protocol: 'http/1.1' | 'http/2',
  StatusCode: number,
  Headers: Record<string, string | string[] | undefined>,
  ResponseStream: Readable,
  RequestedCompressions: HTTPCompressionAlgorithm[]
}

interface CachedOriginCapabilities extends OriginCapabilities {
  HTTP2Support: 'unknown' | 'supported' | 'unsupported'
}

export class SecureReq {
  private readonly DefaultOptions: Omit<HTTPSRequestOptions, 'Payload' | 'ExpectedAs' | 'Signal'>
  private readonly SupportedCompressions: HTTPCompressionAlgorithm[]
  private readonly HTTP2SessionIdleTimeout: number
  private readonly OriginCapabilityCacheLimit: number
  private readonly OriginCapabilityCache = new Map<string, CachedOriginCapabilities>()
  private readonly HTTP2SessionCache = new Map<string, HTTP2.ClientHttp2Session>()
  private readonly PendingHTTP2SessionCache = new Map<string, Promise<HTTP2.ClientHttp2Session>>()

  public constructor(Options: SecureReqOptions = {}) {
    const ParsedOptions = SecureReqOptionsSchema.parse(Options)

    this.DefaultOptions = {
      TLS: {
        ...DefaultTLSOptions,
        ...(ParsedOptions.DefaultOptions?.TLS ?? {}),
      },
      HttpHeaders: {
        ...DefaultHTTPHeaders,
        ...NormalizeHeaders(ParsedOptions.DefaultOptions?.HttpHeaders),
      },
      HttpMethod: ParsedOptions.DefaultOptions?.HttpMethod ?? 'GET',
      PreferredProtocol: ParsedOptions.DefaultOptions?.PreferredProtocol ?? 'auto',
      EnableCompression: ParsedOptions.DefaultOptions?.EnableCompression ?? true,
      TimeoutMs: ParsedOptions.DefaultOptions?.TimeoutMs,
    }

    this.SupportedCompressions = (ParsedOptions.SupportedCompressions?.length ? ParsedOptions.SupportedCompressions : DefaultSupportedCompressions)
      .filter((Value, Index, Values) => Values.indexOf(Value) === Index)

    this.HTTP2SessionIdleTimeout = ParsedOptions.HTTP2SessionIdleTimeout ?? 30_000
    this.OriginCapabilityCacheLimit = ParsedOptions.OriginCapabilityCacheLimit ?? 256
  }

  public async Request(Url: URL): Promise<HTTPSResponse<AutoDetectedResponseBody>>
  public async Request(Url: URL, Options: Omit<HTTPSRequestOptions, 'ExpectedAs'> & { ExpectedAs?: undefined }): Promise<HTTPSResponse<AutoDetectedResponseBody>>
  public async Request<E extends ExpectedAsKey>(Url: URL, Options: HTTPSRequestOptions<E> & { ExpectedAs: E }): Promise<HTTPSResponse<ExpectedAsMap[E]>>
  public async Request<E extends ExpectedAsKey>(Url: URL, Options?: HTTPSRequestOptions<E>): Promise<HTTPSResponse<AutoDetectedResponseBody | ExpectedAsMap[E]>> {
    if (Url instanceof URL === false) {
      throw new TypeError('Url must be an instance of URL')
    }

    RequestOptionsSchema.parse(Options ?? {})

    const MergedOptions = this.MergeOptions(Options)
    const ExpectedAs = DetermineExpectedAs(Url, MergedOptions)
    this.ValidateRequest(Url, MergedOptions)

    const Protocol = this.ResolveTransportProtocol(Url, MergedOptions)

    if (Protocol !== 'http/2') {
      return await this.RequestWithHTTP1(Url, MergedOptions, ExpectedAs)
    }

    try {
      return await this.RequestWithHTTP2(Url, MergedOptions, ExpectedAs)
    } catch (Cause) {
      if (this.ShouldAutomaticallyFallbackToHTTP1(MergedOptions, Cause)) {
        this.MarkOriginAsHTTP1Only(Url)
        return await this.RequestWithHTTP1(Url, MergedOptions, ExpectedAs)
      }

      throw Cause
    }
  }

  public GetOriginCapabilities(Url: URL): OriginCapabilities | undefined {
    const Capabilities = this.GetCachedOriginCapabilities(Url)

    if (Capabilities === undefined) {
      return undefined
    }

    return {
      Origin: Capabilities.Origin,
      ProbeCompleted: Capabilities.ProbeCompleted,
      PreferredProtocol: Capabilities.PreferredProtocol,
      SupportedCompressions: [...Capabilities.SupportedCompressions],
      HTTP3Advertised: Capabilities.HTTP3Advertised,
    }
  }

  public Close(): void {
    for (const Session of this.HTTP2SessionCache.values()) {
      Session.close()
    }

    this.PendingHTTP2SessionCache.clear()
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
      TimeoutMs: Options?.TimeoutMs ?? this.DefaultOptions.TimeoutMs,
      Payload: Options?.Payload,
      ExpectedAs: Options?.ExpectedAs,
      Signal: Options?.Signal,
    }
  }

  private ValidateRequest(Url: URL, Options: HTTPSRequestOptions): void {
    if (Url.protocol !== 'http:' && Url.protocol !== 'https:') {
      throw new Error(`Unsupported URL protocol: ${Url.protocol}`)
    }

    if (Options.TLS?.IsHTTPSEnforced !== false && Url.protocol !== 'https:') {
      throw new Error('HTTPS is enforced, but the URL protocol is not HTTPS')
    }

    if ((Options.PreferredProtocol === 'http/2' || Options.PreferredProtocol === 'http/3') && Url.protocol !== 'https:') {
      throw new Error('http/2 and http/3 negotiation require an HTTPS URL')
    }

    if (Options.Payload !== undefined && PayloadEnabledMethods.has(Options.HttpMethod ?? 'GET') === false) {
      throw new Error('Request payload is only supported for GET, POST, PUT, PATCH, and OPTIONS methods')
    }
  }

  private ResolveTransportProtocol(Url: URL, Options: HTTPSRequestOptions): 'http/1.1' | 'http/2' {
    if (Url.protocol !== 'https:') {
      return 'http/1.1'
    }

    switch (Options.PreferredProtocol) {
      case 'http/1.1':
        return 'http/1.1'
      case 'http/2':
        return 'http/2'
      case 'http/3':
        return 'http/2'
      default:
        break
    }

    const OriginCapabilities = this.GetCachedOriginCapabilities(Url)
    if (OriginCapabilities?.ProbeCompleted !== true) {
      return 'http/1.1'
    }

    if (OriginCapabilities.HTTP2Support === 'supported') {
      return 'http/2'
    }

    if (OriginCapabilities.HTTP2Support === 'unsupported') {
      return 'http/1.1'
    }

    if (this.CanAttemptAutomaticHTTP2Probe(Options)) {
      return 'http/2'
    }

    return 'http/1.1'
  }

  private BuildRequestHeaders(Url: URL, Options: HTTPSRequestOptions): {
    Headers: Record<string, string>,
    RequestedCompressions: HTTPCompressionAlgorithm[]
  } {
    const Headers = {
      ...(Options.HttpHeaders ?? {}),
    }

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
    const OriginCapabilities = this.GetCachedOriginCapabilities(Url)
    if (OriginCapabilities?.SupportedCompressions.length) {
      return [...OriginCapabilities.SupportedCompressions]
    }

    return [...this.SupportedCompressions]
  }

  private async RequestWithHTTP1<E extends ExpectedAsKey>(Url: URL, Options: HTTPSRequestOptions<E>, ExpectedAs: E): Promise<HTTPSResponse<ExpectedAsMap[E]>> {
    const { Headers, RequestedCompressions } = this.BuildRequestHeaders(Url, Options)

    return await new Promise<HTTPSResponse<ExpectedAsMap[E]>>((Resolve, Reject) => {
      let Settled = false
      let CleanupCancellation = () => {}
      const CancellationTarget: { Cancel: (Cause: Error) => void } = {
        Cancel: Cause => {
          void Cause
        },
      }

      const ResolveOnce = (Value: HTTPSResponse<ExpectedAsMap[E]>) => {
        if (Settled === false) {
          Settled = true
          Resolve(Value)
        }
      }

      const RejectOnce = (Error: unknown) => {
        if (Settled === false) {
          Settled = true
          CleanupCancellation()
          Reject(ToError(Error))
        }
      }

      const Request = this.CreateHTTP1Request(Url, Options, Headers, Response => {
        void this.FinalizeResponse({
          Url,
          Options,
          ExpectedAs,
          Protocol: 'http/1.1',
          StatusCode: Response.statusCode ?? 0,
          Headers: NormalizeIncomingHeaders(Response.headers as Record<string, unknown>),
          ResponseStream: Response,
          RequestedCompressions,
        }).then(ResponseValue => {
          if (ExpectedAs === 'Stream') {
            const ResponseBody = ResponseValue.Body as ExpectedAsMap['Stream']

            CancellationTarget.Cancel = Cause => {
              ResponseBody.destroy(Cause)
              Request.destroy(Cause)
              RejectOnce(Cause)
            }

            this.BindRequestCleanupToResponseStream(ResponseBody, CleanupCancellation)
            ResolveOnce(ResponseValue)
            return
          }

          CleanupCancellation()
          ResolveOnce(ResponseValue)
        }, RejectOnce)
      })

      const CancelRequest = (Cause: Error) => {
        Request.destroy(Cause)
        RejectOnce(Cause)
      }

      CancellationTarget.Cancel = CancelRequest
      CleanupCancellation = this.AttachRequestCancellation(Options, Cause => {
        CancellationTarget.Cancel(Cause)
      })

      Request.once('error', RejectOnce)

      void this.WritePayload(Request, Options.Payload).catch(Cause => {
        Request.destroy(ToError(Cause))
        RejectOnce(Cause)
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
    const Session = await this.GetOrCreateHTTP2Session(Url, Options)
    let Request: HTTP2.ClientHttp2Stream

    try {
      Request = Session.request({
        ':method': Options.HttpMethod,
        ':path': Url.pathname + Url.search,
        ':scheme': 'https',
        ':authority': Headers.host ?? Url.host,
        ...this.FilterHTTP2Headers(Headers),
      })
    } catch (Cause) {
      throw new HTTP2NegotiationError('Failed to start HTTP/2 request', { cause: Cause })
    }

    return await new Promise<HTTPSResponse<ExpectedAsMap[E]>>((Resolve, Reject) => {
      let Settled = false
      let CleanupCancellation = () => {}
      const CancellationTarget: { Cancel: (Cause: Error) => void } = {
        Cancel: Cause => {
          void Cause
        },
      }

      const ResolveOnce = (Value: HTTPSResponse<ExpectedAsMap[E]>) => {
        if (Settled === false) {
          Settled = true
          Resolve(Value)
        }
      }

      const RejectOnce = (Error: unknown) => {
        if (Settled === false) {
          Settled = true
          CleanupCancellation()
          this.InvalidateHTTP2Session(Url, Options, Session)
          Reject(ToError(Error))
        }
      }

      Request.once('response', ResponseHeaders => {
        void this.FinalizeResponse({
          Url,
          Options,
          ExpectedAs,
          Protocol: 'http/2',
          StatusCode: Number(ResponseHeaders[':status'] ?? 0),
          Headers: NormalizeIncomingHeaders(ResponseHeaders as Record<string, unknown>),
          ResponseStream: Request,
          RequestedCompressions,
        }).then(ResponseValue => {
          if (ExpectedAs === 'Stream') {
            const ResponseBody = ResponseValue.Body as ExpectedAsMap['Stream']

            CancellationTarget.Cancel = Cause => {
              ResponseBody.destroy(Cause)

              if (ResponseBody !== Request) {
                Request.destroy(Cause)
              }

              RejectOnce(Cause)
            }

            this.BindRequestCleanupToResponseStream(ResponseBody, CleanupCancellation)
            ResolveOnce(ResponseValue)
            return
          }

          CleanupCancellation()
          ResolveOnce(ResponseValue)
        }, RejectOnce)
      })

      const CancelRequest = (Cause: Error) => {
        Request.destroy(Cause)
        RejectOnce(Cause)
      }

      CancellationTarget.Cancel = CancelRequest
      CleanupCancellation = this.AttachRequestCancellation(Options, Cause => {
        CancellationTarget.Cancel(Cause)
      })

      Request.once('error', RejectOnce)

      void this.WritePayload(Request, Options.Payload).catch(Cause => {
        Request.destroy(ToError(Cause))
        RejectOnce(Cause)
      })
    })
  }

  private async GetOrCreateHTTP2Session(Url: URL, Options: HTTPSRequestOptions): Promise<HTTP2.ClientHttp2Session> {
    const SessionKey = this.GetHTTP2SessionKey(Url, Options)
    const PendingSession = this.PendingHTTP2SessionCache.get(SessionKey)

    if (PendingSession) {
      return await PendingSession
    }

    const ExistingSession = this.HTTP2SessionCache.get(SessionKey)

    if (ExistingSession && ExistingSession.closed === false && ExistingSession.destroyed === false) {
      return ExistingSession
    }

    const SessionPromise = (async () => {
      const Socket = await this.CreateNegotiatedHTTP2Socket(Url, Options)
      const Session = HTTP2.connect(GetOriginKey(Url), {
        createConnection: () => Socket,
      })

      this.ConfigureHTTP2Session(SessionKey, Session)
      this.HTTP2SessionCache.set(SessionKey, Session)

      return await new Promise<HTTP2.ClientHttp2Session>((Resolve, Reject) => {
        let Connected = false

        const Cleanup = () => {
          Session.off('connect', HandleConnect)
          Session.off('error', HandleError)
          Session.off('close', HandleClose)
        }

        const HandleConnect = () => {
          Connected = true
          Cleanup()
          Resolve(Session)
        }

        const HandleError = (Cause: unknown) => {
          Cleanup()
          this.InvalidateHTTP2Session(Url, Options, Session)
          Reject(
            Connected
              ? ToError(Cause)
              : (Cause instanceof HTTP2NegotiationError
                ? Cause
                : new HTTP2NegotiationError('Failed to establish HTTP/2 session', { cause: Cause })),
          )
        }

        const HandleClose = () => {
          Cleanup()
          Reject(
            Connected
              ? new Error('HTTP/2 session closed before it became ready')
              : new HTTP2NegotiationError('HTTP/2 session negotiation closed before it became ready'),
          )
        }

        Session.once('connect', HandleConnect)
        Session.once('error', HandleError)
        Session.once('close', HandleClose)
      })
    })()

    this.PendingHTTP2SessionCache.set(SessionKey, SessionPromise)

    try {
      return await SessionPromise
    } finally {
      if (this.PendingHTTP2SessionCache.get(SessionKey) === SessionPromise) {
        this.PendingHTTP2SessionCache.delete(SessionKey)
      }
    }
  }

  private GetHTTP2SessionKey(Url: URL, Options: HTTPSRequestOptions): string {
    return `${GetOriginKey(Url)}|${SerializeTLSOptions(Options.TLS)}`
  }

  private InvalidateHTTP2Session(Url: URL, Options: HTTPSRequestOptions, Session?: HTTP2.ClientHttp2Session): void {
    const SessionKey = this.GetHTTP2SessionKey(Url, Options)
    const SessionToClose = Session ?? this.HTTP2SessionCache.get(SessionKey)

    this.PendingHTTP2SessionCache.delete(SessionKey)
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
    this.UpdateOriginCapabilities(Context.Url, Context.Protocol, Context.Headers, Context.RequestedCompressions)

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
    Protocol: 'http/1.1' | 'http/2',
    Headers: Record<string, string | string[] | undefined>,
    RequestedCompressions: HTTPCompressionAlgorithm[],
  ): void {
    const Origin = GetOriginKey(Url)
    const ExistingCapabilities = this.GetCachedOriginCapabilities(Origin)
    const NegotiatedCompressions = this.ResolveNegotiatedCompressions(Headers, RequestedCompressions)
    const HTTP2Support = Protocol === 'http/2'
      ? 'supported'
      : (ExistingCapabilities?.HTTP2Support ?? 'unknown')
    const HTTP3Advertised = this.IsHTTP3Advertised(Headers) || (ExistingCapabilities?.HTTP3Advertised ?? false)

    this.SetOriginCapabilities({
      Origin,
      ProbeCompleted: true,
      PreferredProtocol: Url.protocol === 'https:' && HTTP2Support === 'supported' ? 'http/2' : 'http/1.1',
      SupportedCompressions: NegotiatedCompressions !== undefined
        ? NegotiatedCompressions
        : [...(ExistingCapabilities?.SupportedCompressions ?? [])],
      HTTP3Advertised,
      HTTP2Support,
    })
  }

  private ResolveNegotiatedCompressions(
    Headers: Record<string, string | string[] | undefined>,
    RequestedCompressions: HTTPCompressionAlgorithm[],
  ): HTTPCompressionAlgorithm[] | undefined {
    const ServerAcceptEncoding = ParseCompressionAlgorithms(GetHeaderValue(Headers, 'accept-encoding'))
    if (ServerAcceptEncoding.length > 0) {
      return IntersectCompressionAlgorithms(RequestedCompressions, ServerAcceptEncoding)
    }

    const ContentEncoding = ParseCompressionAlgorithms(GetHeaderValue(Headers, 'content-encoding'))
    if (ContentEncoding.length > 0) {
      return IntersectCompressionAlgorithms(RequestedCompressions, ContentEncoding)
    }

    return undefined
  }

  private IsHTTP3Advertised(Headers: Record<string, string | string[] | undefined>): boolean {
    const AltSvcHeader = GetHeaderValue(Headers, 'alt-svc')
    return /\bh3(?:-\d+)?\s*=/.test(AltSvcHeader ?? '')
  }

  private MarkOriginAsHTTP1Only(Url: URL): void {
    const Origin = GetOriginKey(Url)
    const ExistingCapabilities = this.GetCachedOriginCapabilities(Origin)

    this.SetOriginCapabilities({
      Origin,
      ProbeCompleted: true,
      PreferredProtocol: 'http/1.1',
      SupportedCompressions: [...(ExistingCapabilities?.SupportedCompressions ?? [])],
      HTTP3Advertised: ExistingCapabilities?.HTTP3Advertised ?? false,
      HTTP2Support: 'unsupported',
    })
  }

  private GetCachedOriginCapabilities(UrlOrOrigin: URL | string): CachedOriginCapabilities | undefined {
    const Origin = typeof UrlOrOrigin === 'string' ? UrlOrOrigin : GetOriginKey(UrlOrOrigin)
    const Capabilities = this.OriginCapabilityCache.get(Origin)

    if (Capabilities === undefined) {
      return undefined
    }

    this.OriginCapabilityCache.delete(Origin)
    this.OriginCapabilityCache.set(Origin, Capabilities)
    return Capabilities
  }

  private SetOriginCapabilities(Capabilities: CachedOriginCapabilities): void {
    if (this.OriginCapabilityCache.has(Capabilities.Origin)) {
      this.OriginCapabilityCache.delete(Capabilities.Origin)
    }

    this.OriginCapabilityCache.set(Capabilities.Origin, Capabilities)

    while (this.OriginCapabilityCache.size > this.OriginCapabilityCacheLimit) {
      const OldestOrigin = this.OriginCapabilityCache.keys().next().value

      if (OldestOrigin === undefined) {
        break
      }

      this.OriginCapabilityCache.delete(OldestOrigin)
    }
  }

  private ConfigureHTTP2Session(SessionKey: string, Session: HTTP2.ClientHttp2Session): void {
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

      this.PendingHTTP2SessionCache.delete(SessionKey)
    })

    Session.on('error', () => {
      if (Session.closed || Session.destroyed) {
        this.HTTP2SessionCache.delete(SessionKey)
        this.PendingHTTP2SessionCache.delete(SessionKey)
      }
    })

    Session.on('goaway', () => {
      this.HTTP2SessionCache.delete(SessionKey)
      this.PendingHTTP2SessionCache.delete(SessionKey)
    })
  }

  private async CreateNegotiatedHTTP2Socket(Url: URL, Options: HTTPSRequestOptions): Promise<TLS.TLSSocket> {
    return await new Promise<TLS.TLSSocket>((Resolve, Reject) => {
      const Socket = TLS.connect({
        host: Url.hostname,
        port: Number(Url.port || 443),
        servername: Url.hostname,
        minVersion: Options.TLS?.MinTLSVersion,
        maxVersion: Options.TLS?.MaxTLSVersion,
        ciphers: Options.TLS?.Ciphers?.join(':'),
        ecdhCurve: Options.TLS?.KeyExchanges?.join(':'),
        rejectUnauthorized: Options.TLS?.RejectUnauthorized,
        ALPNProtocols: ['h2', 'http/1.1'],
      })

      const Cleanup = () => {
        Socket.off('secureConnect', HandleSecureConnect)
        Socket.off('error', HandleError)
        Socket.off('close', HandleClose)
      }

      const RejectWithNegotiationError = (Message: string, Cause?: unknown) => {
        Cleanup()

        if (Socket.destroyed === false) {
          Socket.destroy()
        }

        Reject(new HTTP2NegotiationError(Message, Cause === undefined ? undefined : { cause: Cause }))
      }

      const HandleSecureConnect = () => {
        if (Socket.alpnProtocol !== 'h2') {
          RejectWithNegotiationError('Origin did not negotiate HTTP/2 via ALPN')
          return
        }

        Cleanup()
        Resolve(Socket)
      }

      const HandleError = (Cause: unknown) => {
        RejectWithNegotiationError('Failed to negotiate HTTP/2 session', Cause)
      }

      const HandleClose = () => {
        RejectWithNegotiationError('HTTP/2 session negotiation closed before it became ready')
      }

      Socket.once('secureConnect', HandleSecureConnect)
      Socket.once('error', HandleError)
      Socket.once('close', HandleClose)
    })
  }

  private CanAttemptAutomaticHTTP2Probe(Options: HTTPSRequestOptions): boolean {
    return IsAutomaticHTTP2ProbeMethod(Options.HttpMethod)
      && Options.Payload === undefined
      && Options.PreferredProtocol === 'auto'
  }

  private ShouldAutomaticallyFallbackToHTTP1(Options: HTTPSRequestOptions, Cause: unknown): boolean {
    return IsHTTP2NegotiationError(Cause)
      && Options.PreferredProtocol === 'auto'
      && this.CanAttemptAutomaticHTTP2Probe(Options)
  }

  private AttachRequestCancellation(
    Options: HTTPSRequestOptions,
    Cancel: (Cause: Error) => void,
  ): () => void {
    const CleanupCallbacks: Array<() => void> = []

    if (Options.TimeoutMs !== undefined) {
      const Timer = setTimeout(() => {
        Cancel(this.CreateTimeoutError(Options.TimeoutMs ?? 0))
      }, Options.TimeoutMs)

      if (typeof Timer.unref === 'function') {
        Timer.unref()
      }

      CleanupCallbacks.push(() => {
        clearTimeout(Timer)
      })
    }

    if (Options.Signal) {
      const Signal = Options.Signal
      const HandleAbort = () => {
        Cancel(this.CreateAbortError(Signal.reason))
      }

      if (Signal.aborted) {
        queueMicrotask(HandleAbort)
      } else {
        Signal.addEventListener('abort', HandleAbort, { once: true })
        CleanupCallbacks.push(() => {
          Signal.removeEventListener('abort', HandleAbort)
        })
      }
    }

    return () => {
      for (const Cleanup of CleanupCallbacks.splice(0)) {
        Cleanup()
      }
    }
  }

  private BindRequestCleanupToResponseStream(Stream: ExpectedAsMap['Stream'], Cleanup: () => void): void {
    if (Stream.destroyed || Stream.readableEnded) {
      Cleanup()
      return
    }

    let CleanedUp = false

    const CleanupOnce = () => {
      if (CleanedUp) {
        return
      }

      CleanedUp = true
      Stream.off('close', CleanupOnce)
      Stream.off('end', CleanupOnce)
      Stream.off('error', CleanupOnce)
      Cleanup()
    }

    Stream.once('close', CleanupOnce)
    Stream.once('end', CleanupOnce)
    Stream.once('error', CleanupOnce)
  }

  private CreateAbortError(Cause?: unknown): Error {
    const RequestError = Cause === undefined
      ? new Error('Request was aborted')
      : new Error('Request was aborted', { cause: Cause })

    RequestError.name = 'AbortError'
    return RequestError
  }

  private CreateTimeoutError(TimeoutMs: number): Error {
    const RequestError = new Error(`Request timed out after ${TimeoutMs}ms`)
    RequestError.name = 'TimeoutError'
    return RequestError
  }
}
