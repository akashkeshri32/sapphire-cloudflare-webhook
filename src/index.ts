import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { eq } from 'drizzle-orm'
import { createClient } from '@supabase/supabase-js'
import { paymentOrders, users, enrollments, cashfreeWebhookLogs, phonepeWebhookLogs } from './db-schema'
import { verifyCashfreeSignature, verifyPhonePeWebhookAuth, generatePassword } from './crypto'

export interface Env {
  HYPERDRIVE: Hyperdrive
  CASHFREE_SECRET_KEY: string
  PHONEPE_WEBHOOK_USERNAME: string
  PHONEPE_WEBHOOK_PASSWORD: string
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  INTERNAL_WEBHOOK_SECRET: string
  MAIN_APP_URL: string
}

const schema = { paymentOrders, users, enrollments, cashfreeWebhookLogs, phonepeWebhookLogs }
type Db = PostgresJsDatabase<typeof schema>

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'GET') return json({ ok: true })
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

    const sql = postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false })
    const db = drizzle(sql, { schema })

    // Cashfree's webhook is already configured against this Worker's root
    // URL in production — that path must keep working unchanged. PhonePe's
    // webhook is registered against /phonepe instead, so neither gateway's
    // routing can collide or interfere with the other.
    const path = new URL(request.url).pathname

    try {
      return path === '/phonepe'
        ? await handlePhonePeWebhook(request, env, db)
        : await handleCashfreeWebhook(request, env, db)
    } finally {
      // Don't let connection teardown block or slow the response.
      sql.end({ timeout: 0 }).catch(() => {})
    }
  },
}

async function logAttempt(db: Db, data: Omit<typeof cashfreeWebhookLogs.$inferInsert, 'id' | 'createdAt'>) {
  await db.insert(cashfreeWebhookLogs).values(data)
}

async function logPhonePeAttempt(db: Db, data: Omit<typeof phonepeWebhookLogs.$inferInsert, 'id' | 'createdAt'>) {
  await db.insert(phonepeWebhookLogs).values(data)
}

async function handleCashfreeWebhook(request: Request, env: Env, db: Db): Promise<Response> {
  const rawBody   = await request.text()
  const signature = request.headers.get('x-webhook-signature') ?? ''
  const timestamp = request.headers.get('x-webhook-timestamp') ?? ''
  const headers   = Object.fromEntries(request.headers.entries())

  const validSignature = await verifyCashfreeSignature(rawBody, timestamp, signature, env.CASHFREE_SECRET_KEY)
  if (!validSignature) {
    await logAttempt(db, {
      outcome:      'signature_invalid',
      headers,
      rawBody,
      errorMessage: `signature=${signature ? 'present' : 'missing'} timestamp=${timestamp ? 'present' : 'missing'}`,
    })
    return json({ error: 'Unauthorized' }, 401)
  }

  let event: Record<string, any>
  try {
    event = JSON.parse(rawBody)
  } catch {
    await logAttempt(db, { outcome: 'invalid_json', headers, rawBody })
    return json({ error: 'Invalid JSON' }, 400)
  }

  const eventType       = typeof event.type === 'string' ? event.type : undefined
  const cashfreeOrderId = event?.data?.order?.order_id as string | undefined

  if (!cashfreeOrderId) {
    await logAttempt(db, { outcome: 'missing_order_id', eventType, headers, rawBody })
    return json({ error: 'Missing order_id' }, 400)
  }

  const [paymentOrder] = await db
    .select()
    .from(paymentOrders)
    .where(eq(paymentOrders.cashfreeOrderId, cashfreeOrderId))
    .limit(1)

  if (!paymentOrder) {
    await logAttempt(db, { outcome: 'unknown_order', eventType, cashfreeOrderId, headers, rawBody })
    return json({ received: true })
  }

  if (eventType === 'PAYMENT_FAILED_WEBHOOK' || eventType === 'PAYMENT_USER_DROPPED_WEBHOOK') {
    await db.update(paymentOrders)
      .set({ status: 'failed', gatewayResponse: event, updatedAt: new Date() })
      .where(eq(paymentOrders.cashfreeOrderId, cashfreeOrderId))
    await logAttempt(db, { outcome: 'processed', eventType, cashfreeOrderId, headers, rawBody })
    return json({ received: true })
  }

  if (eventType !== 'PAYMENT_SUCCESS_WEBHOOK') {
    await logAttempt(db, { outcome: 'ignored_event', eventType, cashfreeOrderId, headers, rawBody })
    return json({ received: true })
  }

  // Already processed — webhook retry, avoid re-enrolling / re-emailing.
  if (paymentOrder.status === 'paid') {
    await logAttempt(db, { outcome: 'processed', eventType, cashfreeOrderId, headers, rawBody })
    return json({ success: true })
  }

  const email    = paymentOrder.email
  const password = generatePassword(14)

  let emailAttempted = false
  let emailSent      = false
  let emailError: string | undefined

  try {
    const { userId, isNewUser } = await createOrEnrollUser(db, env, email, password, paymentOrder.name, paymentOrder.batchTierId)

    await db.update(paymentOrders)
      .set({ status: 'paid', userId, isNewUser, gatewayResponse: event, updatedAt: new Date() })
      .where(eq(paymentOrders.cashfreeOrderId, cashfreeOrderId))

    // Email sending stays on the main app (owns the templates + SMTP config)
    // — this is the one outbound call this Worker makes besides the database.
    emailAttempted = true
    try {
      const res = await fetch(`${env.MAIN_APP_URL}/api/internal/cashfree-webhook-notify`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': env.INTERNAL_WEBHOOK_SECRET },
        body: JSON.stringify({
          email,
          name:       paymentOrder.name,
          isNewUser,
          password:   isNewUser ? password : undefined,
          batchTierId: paymentOrder.batchTierId,
        }),
      })
      if (!res.ok) throw new Error(`notify route responded ${res.status}`)
      emailSent = true
    } catch (err) {
      emailError = err instanceof Error ? err.message : String(err)
      console.error('[cashfree-webhook] Failed to call notify route:', emailError)
    }
  } catch (error: any) {
    console.error('[cashfree-webhook] Error:', error.message)
    await logAttempt(db, {
      outcome: 'error', eventType, cashfreeOrderId, headers, rawBody, errorMessage: error.message,
      emailAttempted, emailSent, emailError,
    })
    return json({ error: error.message }, 500)
  }

  await logAttempt(db, {
    outcome: 'processed', eventType, cashfreeOrderId, headers, rawBody,
    emailAttempted, emailSent, emailError,
  })
  return json({ success: true })
}

// PhonePe webhook payload shape (v2 / Standard Checkout):
// { event: "checkout.order.completed" | "checkout.order.failed" | ...,
//   payload: { merchantOrderId, orderId, state, amount, ... } }
// merchantOrderId is *our* generated orderId (see phonepe-payment-actions.ts)
// — that's what paymentOrders.phonepeOrderId is keyed on, not PhonePe's own orderId.
async function handlePhonePeWebhook(request: Request, env: Env, db: Db): Promise<Response> {
  const rawBody   = await request.text()
  const authHeader = request.headers.get('authorization') ?? ''
  const headers    = Object.fromEntries(request.headers.entries())

  const validAuth = await verifyPhonePeWebhookAuth(authHeader, env.PHONEPE_WEBHOOK_USERNAME, env.PHONEPE_WEBHOOK_PASSWORD)
  if (!validAuth) {
    await logPhonePeAttempt(db, {
      outcome: 'signature_invalid', headers, rawBody,
      errorMessage: authHeader ? 'authorization header present but did not match' : 'authorization header missing',
    })
    return json({ error: 'Unauthorized' }, 401)
  }

  let event: Record<string, any>
  try {
    event = JSON.parse(rawBody)
  } catch {
    await logPhonePeAttempt(db, { outcome: 'invalid_json', headers, rawBody })
    return json({ error: 'Invalid JSON' }, 400)
  }

  const eventType      = typeof event.event === 'string' ? event.event : undefined
  const payload         = event.payload ?? {}
  const phonepeOrderId  = payload.merchantOrderId as string | undefined
  const state            = payload.state as string | undefined

  if (!phonepeOrderId) {
    await logPhonePeAttempt(db, { outcome: 'missing_order_id', eventType, headers, rawBody })
    return json({ error: 'Missing merchantOrderId' }, 400)
  }

  const [paymentOrder] = await db
    .select()
    .from(paymentOrders)
    .where(eq(paymentOrders.phonepeOrderId, phonepeOrderId))
    .limit(1)

  if (!paymentOrder) {
    await logPhonePeAttempt(db, { outcome: 'unknown_order', eventType, phonepeOrderId, headers, rawBody })
    return json({ received: true })
  }

  if (eventType === 'checkout.order.failed' || state === 'FAILED') {
    await db.update(paymentOrders)
      .set({ status: 'failed', gatewayResponse: event, updatedAt: new Date() })
      .where(eq(paymentOrders.phonepeOrderId, phonepeOrderId))
    await logPhonePeAttempt(db, { outcome: 'processed', eventType, phonepeOrderId, headers, rawBody })
    return json({ received: true })
  }

  if (eventType !== 'checkout.order.completed' && state !== 'COMPLETED') {
    await logPhonePeAttempt(db, { outcome: 'ignored_event', eventType, phonepeOrderId, headers, rawBody })
    return json({ received: true })
  }

  // Already processed — webhook retry, avoid re-enrolling / re-emailing.
  if (paymentOrder.status === 'paid') {
    await logPhonePeAttempt(db, { outcome: 'processed', eventType, phonepeOrderId, headers, rawBody })
    return json({ success: true })
  }

  const email    = paymentOrder.email
  const password = generatePassword(14)

  let emailAttempted = false
  let emailSent      = false
  let emailError: string | undefined

  try {
    const { userId, isNewUser } = await createOrEnrollUser(db, env, email, password, paymentOrder.name, paymentOrder.batchTierId)

    await db.update(paymentOrders)
      .set({ status: 'paid', userId, isNewUser, gatewayResponse: event, updatedAt: new Date() })
      .where(eq(paymentOrders.phonepeOrderId, phonepeOrderId))

    emailAttempted = true
    try {
      const res = await fetch(`${env.MAIN_APP_URL}/api/internal/phonepe-webhook-notify`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': env.INTERNAL_WEBHOOK_SECRET },
        body: JSON.stringify({
          email,
          name:       paymentOrder.name,
          isNewUser,
          password:   isNewUser ? password : undefined,
          batchTierId: paymentOrder.batchTierId,
        }),
      })
      if (!res.ok) throw new Error(`notify route responded ${res.status}`)
      emailSent = true
    } catch (err) {
      emailError = err instanceof Error ? err.message : String(err)
      console.error('[phonepe-webhook] Failed to call notify route:', emailError)
    }
  } catch (error: any) {
    console.error('[phonepe-webhook] Error:', error.message)
    await logPhonePeAttempt(db, {
      outcome: 'error', eventType, phonepeOrderId, headers, rawBody, errorMessage: error.message,
      emailAttempted, emailSent, emailError,
    })
    return json({ error: error.message }, 500)
  }

  await logPhonePeAttempt(db, {
    outcome: 'processed', eventType, phonepeOrderId, headers, rawBody,
    emailAttempted, emailSent, emailError,
  })
  return json({ success: true })
}

// Mirrors handleUserCreationAfterPayment in app/api/webhooks/cashfree/_utils.ts.
async function createOrEnrollUser(
  db: Db, env: Env, email: string, password: string, name: string | null, batchTierId: string,
): Promise<{ userId: string; isNewUser: boolean }> {
  const [existingUser] = await db.select().from(users).where(eq(users.email, email)).limit(1)
  if (existingUser) {
    await db.insert(enrollments).values({ userId: existingUser.id, batchTierId }).onConflictDoNothing()
    return { userId: existingUser.id, isNewUser: false }
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role: 'student' },
  })

  if (error) {
    // Supabase said the user already exists (race condition) — look it up and enroll.
    const [raced] = await db.select().from(users).where(eq(users.email, email)).limit(1)
    if (!raced) throw new Error(`Supabase createUser failed and no matching users row: ${error.message}`)
    await db.insert(enrollments).values({ userId: raced.id, batchTierId }).onConflictDoNothing()
    return { userId: raced.id, isNewUser: false }
  }

  const userId = data.user.id
  await db.insert(users).values({ id: userId, name: name ?? data.user.email!, email: data.user.email!, role: 'student' })
  await db.insert(enrollments).values({ userId, batchTierId }).onConflictDoNothing()
  return { userId, isNewUser: true }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
