import { google, gmail_v1 } from 'googleapis'
import { prisma } from './prisma'

// Scopes the OAuth flow requests (src/lib/auth.ts) and Boot needs at runtime.
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'
export const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

export class GmailNotConnectedError extends Error {
  constructor(message = 'Gmail is not connected. Sign in with Google again to reconnect.') {
    super(message)
    this.name = 'GmailNotConnectedError'
  }
}

/** The Google Cloud project has the Gmail API switched off (Google returns 403 accessNotConfigured / SERVICE_DISABLED). */
export class GmailApiDisabledError extends Error {
  code = 'api_disabled' as const
  activationUrl?: string
  constructor(activationUrl?: string) {
    super(
      `The Gmail API is not enabled in your Google Cloud project. Enable it${activationUrl ? ` at ${activationUrl}` : ' (APIs & Services → Library → Gmail API → Enable)'}, wait a minute, then try again.`
    )
    this.name = 'GmailApiDisabledError'
    this.activationUrl = activationUrl
  }
}

/** The user did not grant (or Google did not return) the Gmail permissions Boot needs. */
export class GmailScopeError extends Error {
  code = 'scope_missing' as const
  constructor(missing: string[] = []) {
    super(
      `Boot does not have permission to ${missing.includes(GMAIL_SEND_SCOPE) ? 'send' : 'read'} Gmail. Sign in with Google again and tick every Gmail permission on the consent screen.`
    )
    this.name = 'GmailScopeError'
  }
}

export class GmailTransientError extends Error {
  code = 'transient' as const
  constructor(message: string) {
    super(message)
    this.name = 'GmailTransientError'
  }
}

export type GmailIssueCode = 'api_disabled' | 'scope_missing'

export async function getGoogleAccount(userId: string) {
  return prisma.account.findFirst({ where: { userId, provider: 'google' } })
}

export function isGmailConnected(account: { access_token: string | null; refresh_token: string | null; disconnectedAt: Date | null } | null | undefined) {
  return !!account && !account.disconnectedAt && !!(account.access_token || account.refresh_token)
}

/** Scopes Google actually granted (stored at sign-in) that are missing. Empty scope = unknown, so not flagged. */
export function missingGmailScopes(scope: string | null | undefined): string[] {
  if (!scope) return []
  const granted = scope.split(/\s+/)
  return [GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE].filter((s) => !granted.includes(s))
}

/** The stored reason Gmail is not working, for the UI. null = fine or never used. */
export function gmailIssueFrom(
  account: { gmailStatus: string | null; gmailStatusMessage: string | null; scope: string | null } | null | undefined
): { code: GmailIssueCode; message: string } | null {
  if (!account) return null
  const missing = missingGmailScopes(account.scope)
  if (missing.length) return { code: 'scope_missing', message: new GmailScopeError(missing).message }
  if (account.gmailStatus === 'api_disabled' || account.gmailStatus === 'scope_missing') {
    return { code: account.gmailStatus, message: account.gmailStatusMessage || 'Gmail is not working.' }
  }
  return null
}

/** Turn a googleapis failure into a typed error. Returns the input unchanged when it is something else. */
export function classifyGoogleError(error: unknown): unknown {
  const e = error as {
    code?: number | string
    status?: number
    message?: string
    errors?: Array<{ reason?: string; message?: string }>
    response?: { status?: number; data?: { error?: { status?: string; message?: string; details?: Array<{ reason?: string; metadata?: Record<string, string> }>; errors?: Array<{ reason?: string }> } } }
  }
  const status = Number(e?.response?.status ?? e?.status ?? e?.code)
  const gerr = e?.response?.data?.error
  const reasons = [
    ...(e?.errors || []).map((x) => x.reason),
    ...(gerr?.errors || []).map((x) => x.reason),
    ...(gerr?.details || []).map((x) => x.reason),
  ].filter(Boolean) as string[]
  const message = `${e?.message ?? ''} ${gerr?.message ?? ''}`

  if (reasons.some((r) => /accessNotConfigured|SERVICE_DISABLED/i.test(r)) || /has not been used in project|API has not been enabled|is disabled\. Enable it/i.test(message)) {
    const meta = (gerr?.details || []).find((d) => d.metadata?.activationUrl)?.metadata?.activationUrl
    const fromText = message.match(/https:\/\/console\.(?:developers|cloud)\.google\.com\/[^\s"')]+/)?.[0]
    return new GmailApiDisabledError(meta || fromText)
  }
  if (
    reasons.some((r) => /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(r)) ||
    /insufficient (authentication scopes|permission)/i.test(message)
  ) {
    return new GmailScopeError()
  }
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || /rateLimitExceeded|userRateLimitExceeded|backendError/i.test(reasons.join(' '))) {
    return new GmailTransientError(`Gmail is temporarily unavailable (${status || 'rate limit'}). Try again shortly.`)
  }
  return error
}

async function recordGmailStatus(accountId: string, status: 'ok' | GmailIssueCode, message: string | null) {
  await prisma.account
    .update({ where: { id: accountId }, data: { gmailStatus: status, gmailStatusMessage: message, gmailCheckedAt: new Date() } })
    .catch((err) => console.error('[gmail] failed to save Gmail status:', err))
}

/**
 * Gmail client for one user, authenticated with THAT user's stored OAuth tokens.
 * Tokens stay server-side; an expired access token is refreshed with the stored
 * refresh token and the new one is written back to MongoDB.
 */
export async function getGmailClient(userId: string) {
  const account = await getGoogleAccount(userId)
  if (!account || !isGmailConnected(account)) throw new GmailNotConnectedError()

  // Fail before calling Google if the consent screen was completed without the Gmail permissions.
  const missing = missingGmailScopes(account.scope)
  if (missing.length) {
    const err = new GmailScopeError(missing)
    if (account.gmailStatus !== 'scope_missing') await recordGmailStatus(account.id, 'scope_missing', err.message)
    throw err
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  )

  oauth2Client.setCredentials({
    access_token: account.access_token ?? undefined,
    refresh_token: account.refresh_token ?? undefined,
    expiry_date: account.expires_at ? account.expires_at * 1000 : undefined,
  })

  oauth2Client.on('tokens', (tokens) => {
    prisma.account
      .update({
        where: { id: account.id },
        data: {
          ...(tokens.access_token ? { access_token: tokens.access_token } : {}),
          ...(tokens.expiry_date ? { expires_at: Math.floor(tokens.expiry_date / 1000) } : {}),
          ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
        },
      })
      .catch((err) => console.error('[gmail] failed to persist refreshed token:', err))
  })

  return { gmail: google.gmail({ version: 'v1', auth: oauth2Client }), oauth2Client, account }
}

/**
 * Run Gmail API calls for a user with uniform error handling:
 *  - "Gmail API disabled" / "missing scope" become typed errors with an actionable
 *    message, and are remembered on the account so the dashboard can explain them;
 *  - a dead/revoked grant marks the account disconnected;
 *  - a rate-limit / 5xx is retried once, then reported honestly;
 *  - the first success after an issue clears the stored issue.
 */
export async function withGmail<T>(userId: string, fn: (gmail: gmail_v1.Gmail) => Promise<T>): Promise<T> {
  const { gmail, account } = await getGmailClient(userId)
  const attempt = async () => {
    try {
      return await fn(gmail)
    } catch (error) {
      throw classifyGoogleError(error)
    }
  }
  try {
    let result: T
    try {
      result = await attempt()
    } catch (error) {
      if (!(error instanceof GmailTransientError)) throw error
      await new Promise((r) => setTimeout(r, 1500))
      result = await attempt()
    }
    if (account.gmailStatus !== 'ok') await recordGmailStatus(account.id, 'ok', null)
    return result
  } catch (error) {
    if (error instanceof GmailApiDisabledError) {
      await recordGmailStatus(account.id, 'api_disabled', error.message)
    } else if (error instanceof GmailScopeError) {
      await recordGmailStatus(account.id, 'scope_missing', error.message)
    } else {
      await handleGoogleAuthFailure(userId, error)
    }
    throw error
  }
}

/** Live check used by the dashboard/settings: does a real Gmail API call work right now? */
export async function checkGmailHealth(userId: string): Promise<{ ok: true; email: string } | { ok: false; code: string; message: string }> {
  try {
    const email = await withGmail(userId, async (gmail) => (await gmail.users.getProfile({ userId: 'me' })).data.emailAddress || '')
    return { ok: true, email }
  } catch (error) {
    if (error instanceof GmailApiDisabledError || error instanceof GmailScopeError) return { ok: false, code: error.code, message: error.message }
    if (error instanceof GmailNotConnectedError) return { ok: false, code: 'not_connected', message: error.message }
    if (error instanceof GmailTransientError) return { ok: false, code: 'transient', message: error.message }
    return { ok: false, code: 'error', message: error instanceof Error ? error.message : 'Gmail check failed' }
  }
}

/** Force a token refresh now if the access token is expired/expiring. */
export async function ensureFreshToken(userId: string): Promise<{ refreshed: boolean }> {
  const { oauth2Client, account } = await getGmailClient(userId)
  const expiresAt = (account.expires_at ?? 0) * 1000
  if (account.access_token && expiresAt - Date.now() > 5 * 60 * 1000) return { refreshed: false }
  try {
    const { credentials } = await oauth2Client.refreshAccessToken()
    await prisma.account.update({
      where: { id: account.id },
      data: {
        access_token: credentials.access_token ?? null,
        expires_at: credentials.expiry_date ? Math.floor(credentials.expiry_date / 1000) : null,
        ...(credentials.refresh_token ? { refresh_token: credentials.refresh_token } : {}),
      },
    })
    return { refreshed: true }
  } catch (error) {
    await handleGoogleAuthFailure(userId, error)
    throw error
  }
}

/** Google revoked the grant / refresh token is dead → mark disconnected so the UI asks to re-login. */
export async function handleGoogleAuthFailure(userId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/invalid_grant|invalid_client|unauthorized_client|Token has been expired or revoked/i.test(message)) {
    await prisma.account.updateMany({
      where: { userId, provider: 'google' },
      data: { access_token: null, refresh_token: null, expires_at: null, disconnectedAt: new Date() },
    })
  }
}

export interface FetchedEmail {
  gmailMessageId: string
  gmailThreadId: string | null
  from: string
  subject: string
  body: string
  receivedAt: Date
}

// Job-related keywords plus delivery-failure notices (a bounced application must be noticed).
const JOB_MAIL_QUERY =
  'in:inbox -from:me newer_than:{days}d (interview OR assessment OR application OR applying OR applied OR candidate OR position OR role OR offer OR unfortunately OR "your application" OR recruiter OR hiring OR from:mailer-daemon OR from:postmaster OR subject:"delivery status notification")'

/**
 * Recent inbox messages (not sent by the user) that look job-related.
 * `skipIds` = Gmail message ids already saved for this user: they are not downloaded
 * again. New messages are fetched 8 at a time instead of one after another
 * (50 sequential Gmail calls took ~15 s and could time out the sync request).
 */
export async function fetchJobRelatedEmails(userId: string, days = 30, skipIds: Set<string> = new Set()): Promise<FetchedEmail[]> {
  return withGmail(userId, async (gmail) => {
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: JOB_MAIL_QUERY.replace('{days}', String(days)),
      maxResults: 50,
    })
    const ids = (list.data.messages || []).map((m) => m.id).filter((id): id is string => !!id && !skipIds.has(id))

    const fetchOne = async (id: string): Promise<FetchedEmail> => {
      const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' })
      const headers = msg.data.payload?.headers || []
      const header = (name: string) => headers.find((h) => h.name?.toLowerCase() === name)?.value || ''
      const dateHeader = header('date')
      const received = msg.data.internalDate
        ? new Date(Number(msg.data.internalDate))
        : dateHeader
          ? new Date(dateHeader)
          : new Date()
      return {
        gmailMessageId: id,
        gmailThreadId: msg.data.threadId || null,
        from: header('from'),
        subject: header('subject'),
        body: extractEmailBody(msg.data.payload).slice(0, 20000),
        receivedAt: isNaN(received.getTime()) ? new Date() : received,
      }
    }

    const emails: FetchedEmail[] = []
    for (let i = 0; i < ids.length; i += 8) {
      emails.push(...(await Promise.all(ids.slice(i, i + 8).map(fetchOne))))
    }
    return emails
  })
}

/**
 * Replies to emails Boot sent: reads each sent thread directly from Gmail and returns every
 * message in it that the user did NOT send (SENT label absent). Independent of keywords, so a
 * one-line "thanks, call me" reply is never missed. Unreadable threads (deleted) are skipped.
 */
export async function fetchThreadReplies(userId: string, threadIds: string[], skipIds: Set<string> = new Set()): Promise<FetchedEmail[]> {
  return withGmail(userId, async (gmail) => {
    const replies: FetchedEmail[] = []
    const fetchThread = async (threadId: string) => {
      let thread
      try {
        thread = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' })
      } catch (error) {
        const status = Number((error as { code?: number; response?: { status?: number } })?.response?.status ?? (error as { code?: number })?.code)
        if (status === 404) return
        throw error
      }
      for (const msg of thread.data.messages || []) {
        if (!msg.id || skipIds.has(msg.id) || msg.labelIds?.includes('SENT') || msg.labelIds?.includes('DRAFT')) continue
        const headers = msg.payload?.headers || []
        const header = (name: string) => headers.find((h) => h.name?.toLowerCase() === name)?.value || ''
        const received = msg.internalDate ? new Date(Number(msg.internalDate)) : new Date(header('date') || Date.now())
        replies.push({
          gmailMessageId: msg.id,
          gmailThreadId: msg.threadId || threadId,
          from: header('from'),
          subject: header('subject'),
          body: extractEmailBody(msg.payload).slice(0, 20000),
          receivedAt: isNaN(received.getTime()) ? new Date() : received,
        })
      }
    }
    for (let i = 0; i < threadIds.length; i += 8) {
      await Promise.all(threadIds.slice(i, i + 8).map(fetchThread))
    }
    return replies
  })
}

function decode(data: string) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
}

function extractEmailBody(payload: any): string {
  if (!payload) return ''
  if (payload.mimeType === 'text/plain' && payload.body?.data) return decode(payload.body.data)
  for (const part of payload.parts || []) {
    const found = extractEmailBody(part)
    if (found) return found
  }
  if (payload.body?.data) {
    const text = decode(payload.body.data)
    return payload.mimeType === 'text/html' ? text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') : text
  }
  return ''
}

/** True for automatic "your message could not be delivered" notices. */
export function isBounceNotice(from: string, subject: string): boolean {
  return (
    /(mailer-daemon|postmaster)@/i.test(from) ||
    /delivery status notification|undeliverable|mail delivery (subsystem|failed)|delivery (has )?failed|returned mail|address not found/i.test(subject)
  )
}

export function classifyJobEmail(subject: string, body: string, from = ''): string {
  if (isBounceNotice(from, subject)) return 'bounce'
  const content = `${subject} ${body}`.toLowerCase()
  const has = (re: RegExp) => re.test(content)

  if (has(/\b(unfortunately|not (be )?moving forward|not selected|regret to inform|other candidates|decided not to (proceed|move)|rejected)\b/)) return 'rejection'
  if (has(/\b(job offer|offer letter|pleased to offer|offer of employment|extend (you )?an offer)\b/)) return 'offer'
  if (has(/\b(interview|schedule a (call|chat|meeting)|phone screen|video call)\b/)) return 'interview'
  if (has(/\b(assessment|coding (test|challenge)|take-home|technical test|hackerrank|codility|skills test)\b/)) return 'assessment'
  if (has(/\b(thank you for applying|we('| ha)ve received your application|application (has been )?received|successfully (applied|submitted))\b/)) return 'confirmation'
  return 'other'
}

export interface EmailContent {
  to: string
  subject: string
  bodyPlain: string
  bodyHtml?: string
  attachment?: { fileName: string; contentType: string; data: Buffer }
}

function encodeHeader(value: string) {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`
}

function wrap76(b64: string) {
  return b64.replace(/(.{76})/g, '$1\r\n')
}

export function buildMime(from: string, email: EmailContent): string {
  const boundary = `boot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
  const altBoundary = `${boundary}_alt`
  const headers = [
    `From: ${from}`,
    `To: ${email.to}`,
    `Subject: ${encodeHeader(email.subject)}`,
    'MIME-Version: 1.0',
  ]
  const bodyPart = (ctype: string, content: string) =>
    `Content-Type: ${ctype}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(Buffer.from(content, 'utf-8').toString('base64'))}`

  const alternative = email.bodyHtml
    ? `Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n` +
      `--${altBoundary}\r\n${bodyPart('text/plain', email.bodyPlain)}\r\n` +
      `--${altBoundary}\r\n${bodyPart('text/html', email.bodyHtml)}\r\n` +
      `--${altBoundary}--`
    : bodyPart('text/plain', email.bodyPlain)

  if (!email.attachment) {
    return `${headers.join('\r\n')}\r\n${alternative}`
  }

  const { fileName, contentType, data } = email.attachment
  const safeName = fileName.replace(/["\r\n]/g, '')
  return (
    `${headers.join('\r\n')}\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
    `--${boundary}\r\n${alternative}\r\n` +
    `--${boundary}\r\nContent-Type: ${contentType}; name="${safeName}"\r\n` +
    `Content-Disposition: attachment; filename="${safeName}"\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
    `${wrap76(data.toString('base64'))}\r\n--${boundary}--`
  )
}

/**
 * Sends through the user's own Gmail; the message appears in their Sent folder.
 * Only reports success when Gmail returns a message id (and, if it reports labels,
 * the SENT label) — an application is never recorded as sent on a guess.
 * `expectedFrom` is checked against the connected Gmail address BEFORE sending, so a
 * wrong account never sends anything (checking after the send would leave a sent email
 * with no record, and a retry would send it again).
 */
export async function sendApplicationEmail(
  userId: string,
  email: EmailContent,
  fromName: string | null | undefined,
  expectedFrom: string
): Promise<{ messageId: string; threadId: string | null; from: string }> {
  return withGmail(userId, async (gmail) => {
    const profile = await gmail.users.getProfile({ userId: 'me' })
    const address = profile.data.emailAddress || ''
    if (address.toLowerCase() !== expectedFrom.trim().toLowerCase()) {
      throw new Error(`The connected Gmail is ${address}, not your registered email ${expectedFrom}. Nothing was sent. Sign in with Google using ${expectedFrom}.`)
    }
    const from = fromName ? `${encodeHeader(fromName)} <${address}>` : address
    const raw = Buffer.from(buildMime(from, email))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    const response = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
    const labels = response.data.labelIds
    if (!response.data.id || (labels && !labels.includes('SENT'))) {
      throw new Error('Gmail did not confirm that the message was sent.')
    }
    return { messageId: response.data.id, threadId: response.data.threadId || null, from: address }
  })
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * The application email. Plain, short and tailored: job title and company, the CV as a real
 * attachment, and the user's portfolio as a clickable link. Callers must only send when the
 * CV file and a valid portfolio URL exist (see applyToJob).
 */
export function generateApplicationEmail(opts: {
  jobTitle: string
  company: string
  userName: string
  userEmail: string
  skills: string[]
  portfolioUrl: string
  /** No specific opening: ask whether a junior frontend / internship position is available. */
  inquiry?: boolean
}): EmailContent {
  const { jobTitle, company, userName, userEmail, skills, portfolioUrl, inquiry } = opts
  const topSkills = skills.slice(0, 5).join(', ')
  const skillSentence = topSkills ? ` My core skills include ${topSkills}.` : ''

  type Para = { text: string; html?: string }
  const link = `<a href="${escapeHtml(portfolioUrl)}" style="color:#1a73e8">${escapeHtml(portfolioUrl)}</a>`
  const paras: Para[] = [
    { text: 'Dear Hiring Team,' },
    { text: '' },
    inquiry
      ? { text: `I am a frontend developer and I am writing to ask whether ${company} has, or expects to have, an opening for a Junior Frontend / React / Next.js Developer or an internship.${skillSentence}` }
      : { text: `I am writing to apply for the ${jobTitle} position at ${company}. I would welcome the opportunity to contribute to your team.${skillSentence}` },
    { text: '' },
    { text: `Please find my CV attached. My portfolio is available here: ${portfolioUrl}`, html: `Please find my CV attached. My portfolio is available here: ${link}` },
    { text: '' },
    {
      text: inquiry
        ? 'If there is a suitable opportunity now or in the future, I would be glad to share more about my work. Thank you for your time.'
        : 'Thank you for your time and consideration.',
    },
    { text: '' },
    { text: 'Kind regards,' },
    { text: userName },
    { text: userEmail },
  ]

  const bodyPlain = paras.map((p) => p.text).join('\n')
  const bodyHtml = `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#222">${paras
    .filter((p) => p.text)
    .map((p) => `<p style="margin:0 0 12px">${p.html ?? escapeHtml(p.text)}</p>`)
    .join('')}</div>`

  const subject = inquiry ? `Frontend Developer / Internship Inquiry – ${userName}` : `Application for ${jobTitle}`
  return { to: '', subject, bodyPlain, bodyHtml }
}
