// Workers run on Web Crypto, not Node's `crypto` module — these mirror
// lib/cashfree/utils.ts's verifyCashfreeSignature and
// lib/helpers/generate-password.ts's generatePassword from the main app,
// reimplemented on Web Crypto APIs (crypto.subtle, crypto.getRandomValues).

export async function verifyCashfreeSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  if (!secret || !timestamp || !signature) return false

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(timestamp + rawBody))
    const expected = arrayBufferToBase64(sigBuffer)
    return timingSafeEqual(expected, signature)
  } catch {
    return false
  }
}

// PhonePe authenticates its webhook with a static SHA-256 hash of
// "username:password" (configured in the PhonePe Business Dashboard under
// Developer Settings > Webhook) sent as the Authorization header on every
// call — not a per-request signature like Cashfree's HMAC.
export async function verifyPhonePeWebhookAuth(
  authHeader: string,
  username: string,
  password: string,
): Promise<boolean> {
  if (!authHeader || !username || !password) return false
  try {
    const digest   = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${username}:${password}`))
    const expected = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
    return timingSafeEqual(expected, authHeader)
  } catch {
    return false
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Excludes visually ambiguous characters: 0 O 1 l I — same charset as the main app's generator.
const UPPER   = 'ABCDEFGHJKMNPQRSTUVWXYZ'
const LOWER   = 'abcdefghjkmnpqrstuvwxyz'
const DIGITS  = '23456789'
const SPECIAL = '@#$!%'
const ALL     = UPPER + LOWER + DIGITS + SPECIAL

export function generatePassword(length = 14): string {
  if (length < 4) throw new Error('Password length must be at least 4')

  const randomByte = () => crypto.getRandomValues(new Uint8Array(1))[0]
  const pick = (charset: string) => charset[randomByte() % charset.length]

  const required = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SPECIAL)]
  const restBytes = crypto.getRandomValues(new Uint8Array(length - 4))
  const rest = Array.from(restBytes, (b) => ALL[b % ALL.length])

  const chars = [...required, ...rest]
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomByte() % (i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }

  return chars.join('')
}
