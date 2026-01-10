import test from 'ava'
import { HTTPSRequest } from '@/index.js'

test('www.example.com HTML request', async T => {
  let Url = new URL('https://www.example.com/')
  let HTTPSRes = await HTTPSRequest(Url, { ExpectedAs: 'String' })
  T.is(HTTPSRes.StatusCode, 200)
  T.true(typeof HTTPSRes.Body === 'string')
})

test('JSON request without ExpectedAs', async T => {
  let Url = new URL('https://api64.ipify.org?format=json')
  let HTTPSRes = await HTTPSRequest(Url)
  T.is(HTTPSRes.StatusCode, 200)
  T.true(typeof HTTPSRes.Body === 'object' && HTTPSRes.Body instanceof ArrayBuffer)
})