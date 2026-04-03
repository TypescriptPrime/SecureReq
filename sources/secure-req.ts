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
  Protocol: 'http/1.1' | 'http/2',
  StatusCode: number,
  Headers: Record<string, string | string[] | undefined>,
  ResponseStream: Readable,
  RequestedCompressions: HTTPCompressionAlgorithm[]
}

export class SecureReq {
  private readonly DefaultOptions: Omit<HTTPSRequestOptions, 'Payload' | 'ExpectedAs' | 'Signal'>
  private readonly SupportedCompressions: HTTPCompressionAlgorithm[]
  private readonly HTTP2SessionIdleTimeout: number
  private readonly OriginCapabilityCacheLimit: number
  private readonly OriginCapabilityCache = new Map<string, OriginCapabilities>()
  private readonly HTTP2SessionCache = new Map<string, HTTP2.ClientHttp2Session>()
  private readonly PendingHTTP2SessionCache = new Map<string, Promise<HTTP2.ClientHttp2Session>>()

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
      TimeoutMs: Options.DefaultOptions?.TimeoutMs,
    }

    this.SupportedCompressions = (Options.SupportedCompressions?.length ? Options.SupportedCompressions : DefaultSupportedCompressions)
      .filter((Value, Index, Values) => Values.indexOf(Value) === Index)

    this.HTTP2SessionIdleTimeout = Options.HTTP2SessionIdleTimeout ?? 30_000
    this.OriginCapabilityCacheLimit = Number.isFinite(Options.OriginCapabilityCacheLimit)
      && (Options.OriginCapabilityCacheLimit ?? 0) > 0
      ? Math.floor(Options.OriginCapabilityCacheLimit ?? 0)
      : 256
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
      if (Protocol === 'http/2') {
        return await this.RequestWithHTTP2(Url, MergedOptions, ExpectedAs)
      }

      return await this.RequestWithHTTP1(Url, MergedOptions, ExpectedAs)
    } catch (Cause) {
      const FallbackAllowed = Protocol === 'http/2'
        && MergedOptions.PreferredProtocol !== 'http/2'
        && MergedOptions.PreferredProtocol !== 'http/3'
        && IsStreamingPayload(MergedOptions.Payload) === false

      if (FallbackAllowed) {
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
      ...Capabilities,
      SupportedCompressions: [...Capabilities.SupportedCompressions],
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

    if (OriginCapabilities.PreferredProtocol === 'http/1.1') {
      return 'http/1.1'
    }

    return 'http/2'
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
    const Request = Session.request({
      ':method': Options.HttpMethod,
      ':path': Url.pathname + Url.search,
      ':scheme': 'https',
      ':authority': Headers.host ?? Url.host,
      ...this.FilterHTTP2Headers(Headers),
    })

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
        ALPNProtocols: ['h2', 'http/1.1'],
      }),
    })

    this.ConfigureHTTP2Session(SessionKey, Session)
    this.HTTP2SessionCache.set(SessionKey, Session)

    const SessionPromise = new Promise<HTTP2.ClientHttp2Session>((Resolve, Reject) => {
      const Cleanup = () => {
        Session.off('connect', HandleConnect)
        Session.off('error', HandleError)
        Session.off('close', HandleClose)
      }

      const HandleConnect = () => {
        Cleanup()
        this.PendingHTTP2SessionCache.delete(SessionKey)
        Resolve(Session)
      }

      const HandleError = (Cause: unknown) => {
        Cleanup()
        this.PendingHTTP2SessionCache.delete(SessionKey)
        this.InvalidateHTTP2Session(Url, Options, Session)
        Reject(ToError(Cause))
      }

      const HandleClose = () => {
        Cleanup()
        this.PendingHTTP2SessionCache.delete(SessionKey)
        Reject(new Error('HTTP/2 session closed before it became ready'))
      }

      Session.once('connect', HandleConnect)
      Session.once('error', HandleError)
      Session.once('close', HandleClose)
    })

    this.PendingHTTP2SessionCache.set(SessionKey, SessionPromise)
    return await SessionPromise
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
    const ExistingCapabilities = this.GetCachedOriginCapabilities(Origin)
    const NegotiatedCompressions = this.ResolveNegotiatedCompressions(Headers, RequestedCompressions)
    const HTTP3Advertised = this.IsHTTP3Advertised(Headers)

    this.SetOriginCapabilities({
      Origin,
      ProbeCompleted: true,
      PreferredProtocol: Url.protocol === 'https:' ? 'http/2' : 'http/1.1',
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
    const ExistingCapabilities = this.GetCachedOriginCapabilities(Origin)

    this.SetOriginCapabilities({
      Origin,
      ProbeCompleted: true,
      PreferredProtocol: 'http/1.1',
      SupportedCompressions: [...(ExistingCapabilities?.SupportedCompressions ?? this.SupportedCompressions)],
      HTTP3Advertised: ExistingCapabilities?.HTTP3Advertised ?? false,
    })
  }

  private GetCachedOriginCapabilities(UrlOrOrigin: URL | string): OriginCapabilities | undefined {
    const Origin = typeof UrlOrOrigin === 'string' ? UrlOrOrigin : GetOriginKey(UrlOrOrigin)
    const Capabilities = this.OriginCapabilityCache.get(Origin)

    if (Capabilities === undefined) {
      return undefined
    }

    this.OriginCapabilityCache.delete(Origin)
    this.OriginCapabilityCache.set(Origin, Capabilities)
    return Capabilities
  }

  private SetOriginCapabilities(Capabilities: OriginCapabilities): void {
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
