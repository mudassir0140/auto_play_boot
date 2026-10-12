import '@/lib/normalize-env'
import type { NextAuthOptions } from 'next-auth'
import type { JWT } from 'next-auth/jwt'
import GoogleProvider from 'next-auth/providers/google'
import { prisma } from './prisma'

const clientId = process.env.GOOGLE_CLIENT_ID
const clientSecret = process.env.GOOGLE_CLIENT_SECRET
let secret = process.env.NEXTAUTH_SECRET
const nextAuthUrl = process.env.NEXTAUTH_URL

// Logged, never thrown: this module is imported by the root layout AND by every API
// route (directly or via src/lib/session.ts), so throwing here took the ENTIRE site
// down — every page and every route, including ones needing no auth at all — on one
// missing env var, instead of just failing sign-in.
//
// NextAuth requires a secret to be set. In development, use a fallback. In production,
// this must be set via environment variables or the auth endpoints will return 500.

// Diagnostic logging in production to help debug "Configuration" errors
if (process.env.NODE_ENV === 'production') {
  const hasSecret = !!secret
  const hasClientId = !!clientId && clientId !== 'your-google-client-id-here'
  const hasClientSecret = !!clientSecret && clientSecret !== 'your-google-client-secret-here'
  const hasUrl = !!nextAuthUrl
  console.log(`[auth] Production config check: secret=${hasSecret} clientId=${hasClientId} clientSecret=${hasClientSecret} url=${hasUrl}`)
}

if (!secret) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[auth] NEXTAUTH_SECRET is not set in production — /api/auth/* endpoints will return 500. Set NEXTAUTH_SECRET in Vercel project environment variables (Production environment)')
  } else {
    // Development fallback: use a temporary secret. Never do this in production.
    secret = 'dev-fallback-secret-do-not-use-in-production-32chars'
    console.warn('[auth] Using development fallback NEXTAUTH_SECRET. Set NEXTAUTH_SECRET in .env.local for a real secret.')
  }
}

if (!clientId || clientId === 'your-google-client-id-here') {
  console.error('[auth] GOOGLE_CLIENT_ID is missing or still a placeholder — sign-in will fail with 401: invalid_client')
}
if (!clientSecret || clientSecret === 'your-google-client-secret-here') {
  console.error('[auth] GOOGLE_CLIENT_SECRET is missing or still a placeholder — sign-in will fail')
}
if (!nextAuthUrl) {
  console.error('[auth] NEXTAUTH_URL is not set — OAuth callbacks will fail')
} else {
  // Google rejects sign-in with "Error 400: redirect_uri_mismatch" unless this exact value is an
  // Authorized redirect URI on the OAuth client. Built the same way next-auth v4 builds it
  // (origin + path, default /api/auth, then /callback/google), so the log matches what is sent.
  const authUrl = new URL(nextAuthUrl)
  const authPath = authUrl.pathname === '/' ? '/api/auth' : authUrl.pathname.replace(/\/$/, '')
  console.log(`[auth] Google redirect_uri sent to Google: ${authUrl.origin}${authPath}/callback/google`)
}

if (process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_APP_URL && process.env.NEXTAUTH_URL && process.env.NEXTAUTH_URL !== process.env.NEXT_PUBLIC_APP_URL) {
  console.error(`[auth] NEXTAUTH_URL (${process.env.NEXTAUTH_URL}) differs from NEXT_PUBLIC_APP_URL (${process.env.NEXT_PUBLIC_APP_URL}); the OAuth state cookie will not match.`)
}

// gmail.send = send applications from the user's own mailbox; gmail.readonly = read job-related
// replies. Both are needed, and the Gmail API must also be ENABLED in the Google Cloud project
// (APIs & Services -> Library -> Gmail API). Boot detects and reports when it is not.
export const GOOGLE_SCOPE = 'openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send'

/**
 * Exchange the refresh token for a new access token. Google does not rotate
 * refresh tokens, so the existing one is kept. Returns the token with an
 * `error` flag instead of throwing, so a dead grant shows up as "reconnect".
 */
export async function refreshGoogleAccessToken(token: JWT): Promise<JWT> {
  if (!token.refresh_token) return { ...token, error: 'RefreshTokenMissing' }
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId || '',
        client_secret: clientSecret || '',
        grant_type: 'refresh_token',
        refresh_token: token.refresh_token,
      }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    return {
      ...token,
      access_token: data.access_token,
      expires_at: Math.floor(Date.now() / 1000) + Number(data.expires_in ?? 3600),
      refresh_token: data.refresh_token ?? token.refresh_token,
      error: undefined,
    }
  } catch (error) {
    console.error('[auth] failed to refresh Google access token:', error)
    return { ...token, error: 'RefreshAccessTokenError' }
  }
}

// Refresh a minute early so a token never expires mid-request.
export const tokenIsExpired = (token: Pick<JWT, 'expires_at'>) =>
  !!token.expires_at && Date.now() >= token.expires_at * 1000 - 60_000

/**
 * Save the Google account + tokens in MongoDB so Gmail keeps working after a
 * restart, from the cron job, and for a returning user. Google only returns a
 * refresh token on consent, so a stored one is never overwritten with nothing.
 * Failures are logged, not thrown: the JWT session still logs the user in.
 */
export async function persistGoogleAccount(
  profile: { email?: string | null; name?: string | null; picture?: string | null },
  account: { providerAccountId: string; access_token?: string; refresh_token?: string; expires_at?: number; scope?: string; token_type?: string; id_token?: string }
): Promise<string | undefined> {
  const email = profile.email?.toLowerCase()
  if (!email) return undefined
  try {
    const user = await prisma.user.upsert({
      where: { email },
      update: { ...(profile.name ? { name: profile.name } : {}), ...(profile.picture ? { image: profile.picture } : {}) },
      create: { email, name: profile.name ?? null, image: profile.picture ?? null, emailVerified: new Date() },
    })
    const tokens = {
      access_token: account.access_token ?? null,
      expires_at: account.expires_at ?? null,
      scope: account.scope ?? null,
      token_type: account.token_type ?? null,
      id_token: account.id_token ?? null,
      ...(account.refresh_token ? { refresh_token: account.refresh_token } : {}),
      disconnectedAt: null,
      // A fresh sign-in (maybe after enabling the Gmail API / granting scopes): re-verify Gmail.
      gmailStatus: null,
      gmailStatusMessage: null,
    }
    await prisma.account.upsert({
      where: { provider_providerAccountId: { provider: 'google', providerAccountId: account.providerAccountId } },
      update: { userId: user.id, ...tokens },
      create: { userId: user.id, type: 'oauth', provider: 'google', providerAccountId: account.providerAccountId, refresh_token: account.refresh_token ?? null, ...tokens },
    })
    return user.id
  } catch (error) {
    console.error('[auth] failed to save Google account in MongoDB:', error)
    return undefined
  }
}

async function persistRefreshedToken(userId: string | undefined, token: JWT) {
  if (!userId || !token.access_token || token.error) return
  try {
    await prisma.account.updateMany({
      where: { userId, provider: 'google' },
      data: { access_token: token.access_token, expires_at: token.expires_at ?? null },
    })
  } catch (error) {
    console.error('[auth] failed to save refreshed token in MongoDB:', error)
  }
}

// Session = signed JWT cookie (no adapter), so login survives refreshes and
// restarts as long as NEXTAUTH_SECRET stays the same, and src/middleware.ts can
// decode it with getToken(). The Google tokens are ALSO stored in MongoDB.
export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: clientId || '',
      clientSecret: clientSecret || '',
      authorization: {
        params: {
          prompt: 'consent',
          access_type: 'offline',
          // Keep previously granted Gmail permissions when the user signs in again.
          include_granted_scopes: 'true',
          scope: GOOGLE_SCOPE,
        },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account, profile }) {
      // `account` is only set on the initial sign-in.
      if (account?.provider === 'google') {
        const id = await persistGoogleAccount(profile ?? { email: token.email, name: token.name, picture: token.picture }, account)
        return {
          ...token,
          id,
          access_token: account.access_token,
          refresh_token: account.refresh_token ?? token.refresh_token,
          expires_at: account.expires_at,
          error: undefined,
        }
      }
      if (token.access_token && tokenIsExpired(token)) {
        const refreshed = await refreshGoogleAccessToken(token)
        await persistRefreshedToken(token.id, refreshed)
        return refreshed
      }
      return token
    },
    // Tokens stay in the cookie / server; the browser only learns whether the
    // Google connection is healthy.
    async session({ session, token }) {
      if (session.user && token.id) (session.user as { id?: string }).id = token.id
      session.error = token.error
      // The cookie itself proves the Google grant, so the UI can show
      // "Connected" without waiting on (or depending on) the database.
      session.googleConnected = !!(token.access_token || token.refresh_token) && !token.error
      return session
    },
    async redirect({ url, baseUrl }) {
      if (url.startsWith(baseUrl)) return url
      if (url.startsWith('/')) return `${baseUrl}${url}`
      return baseUrl
    },
  },
  pages: {
    signIn: '/',
    error: '/auth/error',
  },
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60,
  },
  jwt: { maxAge: 30 * 24 * 60 * 60 },
  secret,
  debug: process.env.NODE_ENV === 'development',
}
