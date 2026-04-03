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

export interface TestTLSCertificateOptions {
  Algorithm?: 'ed25519' | 'prime256v1'
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

export async function CreateTestTLSCertificate(Options: TestTLSCertificateOptions = {}): Promise<TestTLSCertificate> {
  const TemporaryDirectory = await Fs.mkdtemp(Path.join(OS.tmpdir(), 'securereq-test-tls-'))
  const KeyPath = Path.join(TemporaryDirectory, 'key.pem')
  const CertificatePath = Path.join(TemporaryDirectory, 'cert.pem')
  let IsCleanedUp = false
  const Algorithm = Options.Algorithm ?? 'ed25519'

  try {
    await RunOpenSSL(
      Algorithm === 'prime256v1'
        ? [
          'req',
          '-x509',
          '-newkey',
          'ec',
          '-pkeyopt',
          'ec_paramgen_curve:prime256v1',
          '-pkeyopt',
          'ec_param_enc:named_curve',
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
        ]
        : [
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
        ],
    )

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
  } catch (Cause) {
    await Fs.rm(TemporaryDirectory, { recursive: true, force: true })
    throw Cause
  }
}
