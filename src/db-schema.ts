import { sql } from 'drizzle-orm'
import { pgTable, text, integer, timestamp, pgEnum, jsonb, boolean, unique } from 'drizzle-orm/pg-core'

// Deliberately NOT the full app schema — only the 4 tables this webhook
// touches, kept as plain column definitions (no relations/FKs) since this
// Worker only ever does flat selects/inserts/updates, never relational
// `with` queries. Column names/types must stay in sync with the source of
// truth in the main app: lib/drizzle/schema/{payment-order,user,batch,cashfree-webhook-log}.ts

export const paymentOrderStatusEnum = pgEnum('payment_order_status', ['created', 'paid', 'failed'])
export const roleEnum              = pgEnum('role', ['admin', 'instructor', 'student', 'marketing'])
export const statusEnum            = pgEnum('status', ['pending', 'enrolled'])
export const enrollmentStatusEnum  = pgEnum('enrollment_status', ['active', 'completed', 'dropped'])

export const paymentOrders = pgTable('payment_orders', {
  id:               text('id').primaryKey().default(sql`gen_random_uuid()`),
  cashfreeOrderId:  text('cashfree_order_id').notNull().unique(),
  batchTierId:      text('batch_tier_id').notNull(),
  userId:           text('user_id'),
  isNewUser:        boolean('is_new_user'),
  name:             text('name'),
  email:            text('email').notNull(),
  phone:            text('phone').notNull(),
  amount:           integer('amount').notNull(),
  status:           paymentOrderStatusEnum().notNull().default('created'),
  paymentSessionId: text('payment_session_id'),
  gatewayResponse:  jsonb('gateway_response'),
  createdAt:        timestamp('created_at').notNull().defaultNow(),
  updatedAt:        timestamp('updated_at').notNull().defaultNow(),
})

export const users = pgTable('users', {
  id:        text('id').primaryKey().default(sql`gen_random_uuid()`),
  name:      text('name'),
  email:     text('email').unique(),
  imageUrl:  text('image_url'),
  role:      roleEnum().notNull().default('student'),
  status:    statusEnum().notNull().default('pending'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const enrollments = pgTable('enrollments', {
  id:          text('id').primaryKey().default(sql`gen_random_uuid()`),
  userId:      text('user_id').notNull(),
  batchTierId: text('batch_tier_id').notNull(),
  status:      enrollmentStatusEnum().notNull().default('active'),
  enrolledAt:  timestamp('enrolled_at').notNull().defaultNow(),
}, (t) => [unique('enrollments_uniq').on(t.userId, t.batchTierId)])

export const cashfreeWebhookLogs = pgTable('cashfree_webhook_logs', {
  id:              text('id').primaryKey().default(sql`gen_random_uuid()`),
  outcome:         text('outcome').notNull(),
  eventType:       text('event_type'),
  cashfreeOrderId: text('cashfree_order_id'),
  headers:         jsonb('headers'),
  rawBody:         text('raw_body'),
  errorMessage:    text('error_message'),
  emailAttempted:  boolean('email_attempted'),
  emailSent:       boolean('email_sent'),
  emailError:      text('email_error'),
  createdAt:       timestamp('created_at').notNull().defaultNow(),
})
