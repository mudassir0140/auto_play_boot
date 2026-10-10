import { prisma } from './prisma'
import type { CurrentUser } from './session'
import { parseJsonList } from './session'
import { checkApplicationCooldown, recordApplicationAttempt } from './application-cooldown'
import { verifyApplicationRecipient } from './recipient'
import {
  generateApplicationEmail,
  sendApplicationEmail,
  getGoogleAccount,
  isGmailConnected,
  GmailApiDisabledError,
  GmailScopeError,
  GmailNotConnectedError,
} from './gmail'

/** Set when the application comes from company discovery (Google Maps / Search) instead of a job board. */
export interface CompanyContext {
  companyId: string
  website: string
  source: string
  /** true = no specific opening: a general frontend / internship inquiry. */
  inquiry: boolean
}

export type ApplyFailureCode =
  | 'already_applied'
  | 'cooldown'
  | 'no_recipient'
  | 'unverified_recipient'
  | 'no_cv'
  | 'no_portfolio'
  | 'gmail_not_connected'
  | 'gmail_api_disabled'
  | 'gmail_scope_missing'
  | 'send_failed'
  | 'not_found'

export type ApplyResult =
  | { ok: true; applicationId: string; method: 'auto' | 'manual'; sentTo?: string; sentFrom?: string }
  | { ok: false; code: ApplyFailureCode; message: string; cooldownExpiresAt?: Date; daysRemaining?: number }

export function httpStatusForApplyFailure(code: ApplyFailureCode): number {
  switch (code) {
    case 'cooldown':
      return 429
    case 'not_found':
      return 404
    case 'send_failed':
      return 502
    case 'gmail_api_disabled':
      return 503
    case 'gmail_scope_missing':
      return 403
    default:
      return 400
  }
}

/** Failures that will hit every other job too — the auto-apply loop stops on these. */
export const BLOCKING_APPLY_FAILURES: ApplyFailureCode[] = ['gmail_not_connected', 'gmail_api_disabled', 'gmail_scope_missing', 'no_cv', 'no_portfolio']

const isHttpUrl = (value: string | null | undefined): value is string => {
  if (!value) return false
  try {
    const u = new URL(value)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * Apply to one of the user's tracked jobs.
 *  - method "email": send from THIS user's Gmail to a VERIFIED company address (the one found in
 *    the posting, or `recipientEmail` supplied by the user), with the user's CV file attached and
 *    their portfolio linked in the body. Recorded as applied ONLY after Gmail confirms the message
 *    was sent; any failure is saved on the job (status apply_failed + the reason) and in the history.
 *    An address that cannot be verified as the company's sends nothing: the job is marked manual_review.
 *  - method "manual": the user applied on the employer's site/ATS themselves; Boot records
 *    that (there is no legitimate way for Boot to submit those forms for them).
 * Both paths enforce the 7-day cooldown and write Application + History rows.
 */
export async function applyToJob(
  user: CurrentUser,
  jobId: string,
  opts: { method: 'email' | 'manual'; recipientEmail?: string | null; company?: CompanyContext }
): Promise<ApplyResult> {
  const job = await prisma.job.findFirst({ where: { id: jobId, userId: user.id } })
  if (!job) return { ok: false, code: 'not_found', message: 'Job not found' }

  const existing = await prisma.jobApplication.findUnique({ where: { userId_jobId: { userId: user.id, jobId: job.id } } })
  if (existing) return { ok: false, code: 'already_applied', message: 'You already applied to this job.' }

  const recipient = opts.method === 'email' ? (opts.recipientEmail || job.applyEmail || null) : null
  if (opts.method === 'email' && !recipient) {
    return { ok: false, code: 'no_recipient', message: 'This posting has no application email. Apply on the employer site, then mark it as applied.' }
  }

  if (opts.method === 'email') {
    const account = await getGoogleAccount(user.id)
    if (!isGmailConnected(account)) {
      return { ok: false, code: 'gmail_not_connected', message: 'Gmail is not connected. Sign in with Google again.' }
    }
    // The CV must be a real stored file: a link alone is not attached to the email.
    const cv = await prisma.resumeFile.findFirst({ where: { userId: user.id }, select: { id: true } })
    if (!cv) {
      return { ok: false, code: 'no_cv', message: 'Upload your CV file (PDF, DOCX or TXT) on the Profile page. Boot attaches it to every application email.' }
    }
    if (!isHttpUrl(user.portfolioUrl)) {
      return { ok: false, code: 'no_portfolio', message: 'Add your portfolio URL (https://…) on the Profile page. Every application email links to it.' }
    }
    const verdict = verifyApplicationRecipient(recipient, {
      userEmail: user.email,
      companyName: job.company,
      companyWebsite: opts.company?.website,
    })
    if (!verdict.ok) {
      // Nothing is sent. The posting is kept for the user to review by hand.
      await prisma.job
        .update({ where: { id: job.id }, data: { status: 'manual_review', applyError: verdict.message, applyAttemptedAt: new Date() } })
        .catch(() => {})
      return { ok: false, code: 'unverified_recipient', message: `${verdict.message} Marked for manual review; nothing was sent.` }
    }
  }

  const cooldown = await checkApplicationCooldown(user.id, job.url, job.company, job.title, recipient)
  if (cooldown.isDuplicate) {
    return {
      ok: false,
      code: 'cooldown',
      message: `Already applied recently. You can apply again in ${cooldown.daysRemaining} day(s).`,
      cooldownExpiresAt: cooldown.cooldownExpiresAt,
      daysRemaining: cooldown.daysRemaining,
    }
  }

  // Claim the slot first: the unique (userId, jobId) index stops a double-click or
  // a concurrent cron run from sending the same application twice.
  let application
  try {
    application = await prisma.jobApplication.create({
      data: {
        userId: user.id,
        jobId: job.id,
        status: 'applied',
        applicationUrl: job.applyUrl || job.url,
        notes: opts.method === 'email' ? `Emailed ${recipient}` : 'Applied manually on employer site',
      },
    })
  } catch {
    return { ok: false, code: 'already_applied', message: 'You already applied to this job.' }
  }

  let senderEmail: string | undefined
  if (opts.method === 'email' && recipient) {
    try {
      const cv = await prisma.resumeFile.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } })
      if (!cv || !isHttpUrl(user.portfolioUrl)) throw new Error('CV or portfolio link is missing. Check your Profile page and try again.')

      const content = generateApplicationEmail({
        jobTitle: job.title,
        company: job.company,
        userName: user.name || user.email,
        userEmail: user.email,
        skills: parseJsonList(user.skills),
        portfolioUrl: user.portfolioUrl,
        inquiry: opts.company?.inquiry,
      })
      content.to = recipient
      content.attachment = { fileName: cv.fileName, contentType: cv.contentType, data: Buffer.from(cv.data) }

      // The sender is checked inside sendApplicationEmail, BEFORE Gmail is called.
      const sent = await sendApplicationEmail(user.id, content, user.name, user.email)
      senderEmail = sent.from

      // The email IS sent at this point. If saving the record fails we must NOT roll the
      // application back (it would be re-sent later); log it and carry on.
      await prisma.sentEmail
        .create({
          data: {
            userId: user.id,
            jobId: job.id,
            applicationId: application.id,
            gmailMessageId: sent.messageId,
            gmailThreadId: sent.threadId,
            to: recipient,
            subject: content.subject,
            body: content.bodyPlain,
            company: job.company,
            jobTitle: job.title,
            fromEmail: sent.from,
            cvFileName: cv.fileName,
            cvUrl: user.cvUrl,
            portfolioUrl: user.portfolioUrl,
            status: 'sent',
            ...(opts.company
              ? { companyId: opts.company.companyId, website: opts.company.website, source: opts.company.source, emailKind: opts.company.inquiry ? 'inquiry' : 'application' }
              : { source: job.source, emailKind: 'application' }),
          },
        })
        .catch((err) => console.error('[apply] email was sent but saving SentEmail failed:', err))
    } catch (error) {
      // Not sent → not applied. Undo the claim, keep the reason visible on the job and in the history.
      await prisma.jobApplication.delete({ where: { id: application.id } }).catch(() => {})
      const message = error instanceof Error ? error.message : 'Failed to send email'
      const code: ApplyFailureCode =
        error instanceof GmailApiDisabledError
          ? 'gmail_api_disabled'
          : error instanceof GmailScopeError
            ? 'gmail_scope_missing'
            : error instanceof GmailNotConnectedError
              ? 'gmail_not_connected'
              : 'send_failed'
      await recordApplicationAttempt(user.id, job.id, job.url, job.company, job.title, recipient, 'auto', 'failed', message).catch(() => {})
      // A problem with THIS job's send (bad address, rejected) marks it apply_failed so it is not
      // retried blindly. A Gmail-wide problem (API disabled, permission missing, not connected)
      // keeps the job as-is — only the reason is recorded — so it is retried automatically once fixed.
      const gmailWide = BLOCKING_APPLY_FAILURES.includes(code)
      await prisma.job
        .update({
          where: { id: job.id },
          data: { ...(gmailWide ? {} : { status: 'apply_failed' }), applyError: message, applyAttemptedAt: new Date() },
        })
        .catch(() => {})
      await prisma.notification
        .create({
          data: { userId: user.id, type: 'application_failed', title: `Application NOT sent: ${job.title} at ${job.company}`, message },
        })
        .catch(() => {})
      return { ok: false, code, message }
    }
  }

  const method = opts.method === 'email' ? 'auto' : 'manual'
  await recordApplicationAttempt(user.id, job.id, job.url, job.company, job.title, recipient, method, 'success', application.notes ?? undefined)
  await prisma.job.update({ where: { id: job.id }, data: { applied: true, status: 'applied', applyError: null, applyAttemptedAt: new Date() } })
  await prisma.notification.create({
    data: {
      userId: user.id,
      type: 'application',
      title: 'Application recorded',
      message: `${opts.method === 'email' ? `Emailed ${recipient} for` : 'Marked as applied:'} ${job.title} at ${job.company}`,
    },
  })

  return { ok: true, applicationId: application.id, method, sentTo: recipient ?? undefined, sentFrom: senderEmail }
}
