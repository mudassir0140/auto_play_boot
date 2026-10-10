import { normalizeWebsite } from './company-discovery'

// Recipient checks run BEFORE anything is sent. An application goes only to an address that
// plausibly belongs to the employer: on the company's own website domain (company outreach),
// or on a domain that carries the company's name (job-board postings).

const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'outlook.com', 'hotmail.com', 'live.com',
  'msn.com', 'aol.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net',
  'yandex.com', 'mail.com', 'zoho.com', 'hey.com',
])

const NO_REPLY_LOCAL = /^(no-?reply|donotreply|do-not-reply|mailer-daemon|postmaster|abuse|bounces?)$/i

export type RecipientCheck = { ok: true; email: string; domain: string } | { ok: false; message: string }

/** The label of a company name used to match its email domain: "Acme Labs Ltd." -> "acmelabs". */
export function companyNameToken(company: string): string {
  return company
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|gmbh|corp|co|limited|the|pvt|private)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '')
}

/** A domain label is the company: equal to the name, or a clear prefix/suffix of it ("acme" for "acmelabs"). */
function labelMatchesToken(label: string, token: string): boolean {
  if (label === token) return true
  if (label.length >= 4 && token.startsWith(label)) return true
  return token.length >= 5 && label.startsWith(token)
}

export function verifyApplicationRecipient(
  raw: string | null | undefined,
  opts: { userEmail: string; companyName: string; companyWebsite?: string | null }
): RecipientCheck {
  const fail = (message: string): RecipientCheck => ({ ok: false, message: `Recipient ${raw || '(none)'} ${message}` })
  const email = (raw || '').trim().toLowerCase()

  if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(email)) return fail('is not a valid email address.')
  const [local, domain] = email.split('@')

  if (email === opts.userEmail.trim().toLowerCase()) return fail('is your own address. Applications are never sent to your own Gmail.')
  if (NO_REPLY_LOCAL.test(local)) return fail('is a no-reply address and cannot receive applications.')
  if (FREE_MAIL_DOMAINS.has(domain)) return fail(`is a personal free-mail address (${domain}), not a company address.`)

  if (opts.companyWebsite) {
    const site = normalizeWebsite(opts.companyWebsite)
    if (site) {
      if (domain === site.domain || domain.endsWith(`.${site.domain}`)) return { ok: true, email, domain }
      return fail(`is not on the company website domain (${site.domain}).`)
    }
  }

  const token = companyNameToken(opts.companyName)
  if (token.length >= 3) {
    const labels = domain.split('.').slice(0, -1).map((l) => l.replace(/[^a-z0-9]/g, ''))
    if (labels.some((l) => labelMatchesToken(l, token))) return { ok: true, email, domain }
  }
  return fail(`does not match the company "${opts.companyName}": its domain (${domain}) does not carry the company name.`)
}
