import { execFile } from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as OS from 'node:os'
import * as Path from 'node:path'
import * as Process from 'node:process'
import { promisify } from 'node:util'

const ExecFileAsync = promisify(execFile)

export interface TestTLSCertificate {
  Cert: string,
  Key: string,
  Cleanup: () => Promise<void>
}

async function RunOpenSSL(Arguments: string[]): Promise<void> {
  const Command = Process.platform === 'win32' ? 'openssl.exe' : 'openssl'

  try {
    await ExecFileAsync(Command, Arguments, {
      env: Process.env,
    })
  } catch (Cause) {
    throw new Error('OpenSSL is required to generate a test TLS certificate', { cause: Cause })
  }
}

export async function CreateTestTLSCertificate(): Promise<TestTLSCertificate> {
  const TemporaryDirectory = await Fs.mkdtemp(Path.join(OS.tmpdir(), 'securereq-test-tls-'))
  const KeyPath = Path.join(TemporaryDirectory, 'key.pem')
  const CertificatePath = Path.join(TemporaryDirectory, 'cert.pem')
  let IsCleanedUp = false

  try {
    await RunOpenSSL([
      'req',
      '-x509',
      '-newkey',
      'ed25519',
      '-nodes',
      '-keyout',
      KeyPath,
      '-out',
      CertificatePath,
      '-subj',
      '/CN=localhost',
      '-days',
      '1',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ])

    const [Key, Cert] = await Promise.all([
      Fs.readFile(KeyPath, 'utf8'),
      Fs.readFile(CertificatePath, 'utf8'),
    ])

    return {
      Key,
      Cert,
      Cleanup: async () => {
        if (IsCleanedUp) {
          return
        }

        IsCleanedUp = true
        await Fs.rm(TemporaryDirectory, { recursive: true, force: true })
      },
    }
  } catch (Error) {
    await Fs.rm(TemporaryDirectory, { recursive: true, force: true })
    throw Error
  }
}
