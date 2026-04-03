import type { Readable } from 'node:stream'
import { SecureReq } from '@/index.js'

type IsEqual<Left, Right> = (
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false
)

type Assert<Condition extends true> = Condition

const Client = new SecureReq()

const AutoDetectedRequest = Client.Request(new URL('https://example.com/auto.json'))
const ExplicitStringRequest = Client.Request(new URL('https://example.com/value.txt'), {
  ExpectedAs: 'String',
})
const ExplicitStreamRequest = Client.Request(new URL('https://example.com/value.bin'), {
  ExpectedAs: 'Stream',
})

type AutoDetectedBody = Awaited<typeof AutoDetectedRequest>['Body']
type ExplicitStringBody = Awaited<typeof ExplicitStringRequest>['Body']
type ExplicitStreamBody = Awaited<typeof ExplicitStreamRequest>['Body']

type _AutoDetectedShouldBeUnknown = Assert<IsEqual<AutoDetectedBody, unknown>>
type _ExplicitStringShouldBeString = Assert<IsEqual<ExplicitStringBody, string>>
type _ExplicitStreamShouldBeStream = Assert<IsEqual<ExplicitStreamBody, Readable>>
