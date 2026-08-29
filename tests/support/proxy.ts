import * as HTTP from 'node:http'
import * as Net from 'node:net'
import type { Duplex } from 'node:stream'
import type { HTTPSRequestOptions } from '@/index.js'

export interface TestProxy {
  HttpUrl: URL,
  SocksUrl: URL,
  GetTunnelCount: () => number,
  Close: () => Promise<void>
}

function Listen(Server: HTTP.Server | Net.Server): Promise<void> {
  return new Promise<void>((Resolve, Reject) => {
    Server.once('error', Reject)
    Server.listen(0, '127.0.0.1', () => {
      Server.off('error', Reject)
      Resolve()
    })
  })
}

function CloseServer(Server: HTTP.Server | Net.Server): Promise<void> {
  return new Promise<void>((Resolve, Reject) => {
    Server.close(Error => {
      if (Error) {
        Reject(Error)
        return
      }

      Resolve()
    })
  })
}

function GetServerPort(Server: HTTP.Server | Net.Server): number {
  const Address = Server.address()

  if (Address === null || typeof Address === 'string') {
    throw new Error('Failed to resolve proxy server address')
  }

  return Address.port
}

function ConnectTunnel(ClientSocket: Duplex, Hostname: string, Port: number, Head: Buffer): void {
  const Upstream = Net.connect({
    host: Hostname === 'localhost' || Hostname === '::1' ? '127.0.0.1' : Hostname,
    port: Port,
  })

  Upstream.once('connect', () => {
    if (Head.length > 0) {
      Upstream.write(Head)
    }

    ClientSocket.pipe(Upstream).pipe(ClientSocket)
  })

  Upstream.once('error', () => {
    ClientSocket.destroy()
  })
}

export async function StartTestProxy(): Promise<TestProxy> {
  let TunnelCount = 0
  const Sockets = new Set<Net.Socket>()
  const TrackSocket = (Socket: Net.Socket) => {
    Sockets.add(Socket)
    Socket.once('close', () => Sockets.delete(Socket))
  }

  const HttpProxy = HTTP.createServer()
  HttpProxy.on('connection', TrackSocket)
  HttpProxy.on('connect', (Request, ClientSocket, Head) => {
    const [Hostname, PortValue] = (Request.url ?? '').split(':')
    const Port = Number(PortValue)

    if (!Hostname || Number.isInteger(Port) === false || Port <= 0) {
      ClientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }

    TunnelCount += 1
    ClientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    ConnectTunnel(ClientSocket, Hostname, Port, Head)
  })

  const SocksProxy = Net.createServer(Socket => {
    TrackSocket(Socket)
    let ReceivedBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let State: 'greeting' | 'request' | 'connected' = 'greeting'

    const HandleData = (Chunk: Buffer) => {
      ReceivedBuffer = ReceivedBuffer.length === 0 ? Chunk : Buffer.concat([ReceivedBuffer, Chunk])

      while (State !== 'connected') {
        if (State === 'greeting') {
          if (ReceivedBuffer.length < 2) return

          const MethodCount = ReceivedBuffer[1]
          if (ReceivedBuffer.length < 2 + MethodCount) return

          ReceivedBuffer = ReceivedBuffer.subarray(2 + MethodCount)
          Socket.write(Buffer.from([0x05, 0x00]))
          State = 'request'
          continue
        }

        if (ReceivedBuffer.length < 4) return

        if (ReceivedBuffer[0] !== 0x05 || ReceivedBuffer[1] !== 0x01) {
          Socket.destroy()
          return
        }

        const AddressType = ReceivedBuffer[3]
        if (AddressType === 0x03 && ReceivedBuffer.length < 5) return

        const AddressLength = AddressType === 0x03 ? ReceivedBuffer[4] + 1 : AddressType === 0x01 ? 4 : 16
        const RequestLength = 4 + AddressLength + 2
        if (ReceivedBuffer.length < RequestLength) return

        const Address = ReceivedBuffer.subarray(4, 4 + AddressLength)
        const Hostname = AddressType === 0x03
          ? Address.subarray(1).toString('utf8')
          : (AddressType === 0x01
            ? Array.from(Address).join('.')
            : Array.from({ length: 8 }, (_, Index) => Address.readUInt16BE(Index * 2).toString(16)).join(':'))
        const Port = ReceivedBuffer.readUInt16BE(RequestLength - 2)
        const Remaining = ReceivedBuffer.subarray(RequestLength)
        ReceivedBuffer = Buffer.alloc(0)
        State = 'connected'
        TunnelCount += 1
        Socket.removeListener('data', HandleData)
        Socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))
        ConnectTunnel(Socket, Hostname, Port, Remaining)
      }
    }

    Socket.on('data', HandleData)
  })

  await Promise.all([Listen(HttpProxy), Listen(SocksProxy)])

  return {
    HttpUrl: new URL(`http://127.0.0.1:${GetServerPort(HttpProxy)}`),
    SocksUrl: new URL(`socks5h://127.0.0.1:${GetServerPort(SocksProxy)}`),
    GetTunnelCount: () => TunnelCount,
    Close: async () => {
      for (const Socket of Sockets) {
        Socket.destroy()
      }

      HttpProxy.closeAllConnections()
      await Promise.all([CloseServer(HttpProxy), CloseServer(SocksProxy)])
    },
  }
}

export function CreateHTTPConnectTunnel(ProxyUrl: URL): NonNullable<HTTPSRequestOptions['CreateConnection']> {
  return async ({ Hostname, Port }) => await new Promise<Net.Socket>((Resolve, Reject) => {
    const Socket = Net.connect({ host: ProxyUrl.hostname, port: Number(ProxyUrl.port) })
    let Response = Buffer.alloc(0)

    const Cleanup = () => {
      Socket.off('connect', HandleConnect)
      Socket.off('data', HandleData)
      Socket.off('error', HandleError)
    }

    const HandleConnect = () => {
      Socket.write(`CONNECT ${Hostname}:${Port} HTTP/1.1\r\nHost: ${Hostname}:${Port}\r\n\r\n`)
    }

    const HandleData = (Chunk: Buffer) => {
      Response = Buffer.concat([Response, Chunk])
      const HeaderEnd = Response.indexOf('\r\n\r\n')
      if (HeaderEnd === -1) return

      Cleanup()
      const Header = Response.subarray(0, HeaderEnd).toString('ascii')
      if (!Header.startsWith('HTTP/1.1 200')) {
        Socket.destroy()
        Reject(new Error(`Proxy CONNECT failed: ${Header.split('\r\n')[0]}`))
        return
      }

      const Remaining = Response.subarray(HeaderEnd + 4)
      if (Remaining.length > 0) {
        Socket.unshift(Remaining)
      }

      Resolve(Socket)
    }

    const HandleError = (Cause: Error) => {
      Cleanup()
      Reject(Cause)
    }

    Socket.once('connect', HandleConnect)
    Socket.on('data', HandleData)
    Socket.once('error', HandleError)
  })
}