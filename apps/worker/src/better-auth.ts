import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { passkey } from "@better-auth/passkey";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzle } from "drizzle-orm/d1";
import { authSchema } from "./auth-schema.js";
import type { Bindings } from "./types.js";

const REGISTRATION_CONTEXT_TTL_MS = 10 * 60 * 1_000;

interface RegistrationContext {
  id: string;
  expiresAt: number;
}

function base64Url(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function issuePasskeyRegistrationContext(env: Bindings): Promise<string> {
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({
    id: crypto.randomUUID(),
    expiresAt: Date.now() + REGISTRATION_CONTEXT_TTL_MS,
  } satisfies RegistrationContext)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(env.BETTER_AUTH_SECRET),
    new TextEncoder().encode(payload),
  );
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}

async function readPasskeyRegistrationContext(
  env: Bindings,
  token: string | null | undefined,
): Promise<RegistrationContext | null> {
  const [payload, encodedSignature, extra] = token?.split(".") ?? [];
  const signature = encodedSignature ? decodeBase64Url(encodedSignature) : null;
  if (!payload || !signature || extra) return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(env.BETTER_AUTH_SECRET),
    signature,
    new TextEncoder().encode(payload),
  );
  if (!valid) return null;
  const bytes = decodeBase64Url(payload);
  if (!bytes) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<RegistrationContext>;
    if (typeof value.id !== "string" || typeof value.expiresAt !== "number") return null;
    if (value.expiresAt < Date.now() || value.expiresAt > Date.now() + REGISTRATION_CONTEXT_TTL_MS) {
      return null;
    }
    return { id: value.id, expiresAt: value.expiresAt };
  } catch {
    return null;
  }
}

function socialProviders(env: Bindings): NonNullable<BetterAuthOptions["socialProviders"]> {
  const providers: NonNullable<BetterAuthOptions["socialProviders"]> = {};
  if (env.AUTH_GOOGLE_CLIENT_ID && env.AUTH_GOOGLE_CLIENT_SECRET) {
    providers.google = {
      clientId: env.AUTH_GOOGLE_CLIENT_ID,
      clientSecret: env.AUTH_GOOGLE_CLIENT_SECRET,
    };
  }
  if (env.AUTH_GITHUB_CLIENT_ID && env.AUTH_GITHUB_CLIENT_SECRET) {
    providers.github = {
      clientId: env.AUTH_GITHUB_CLIENT_ID,
      clientSecret: env.AUTH_GITHUB_CLIENT_SECRET,
    };
  }
  return providers;
}

export function createAuth(env: Bindings, requestUrl = env.BASE_URL) {
  const requestOrigin = new URL(requestUrl).origin;
  const requestHost = new URL(requestOrigin).hostname;
  const local = requestHost === "localhost" || requestHost === "127.0.0.1";
  const baseURL = local ? requestOrigin : new URL(env.BASE_URL).origin;
  const database = drizzle(env.DB, { schema: authSchema });

  return betterAuth({
    appName: "usebench.dev",
    baseURL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [baseURL],
    database: drizzleAdapter(database, {
      provider: "sqlite",
      schema: authSchema,
    }),
    socialProviders: socialProviders(env),
    account: {
      accountLinking: { enabled: true, trustedProviders: ["google", "github"] },
      encryptOAuthTokens: true,
    },
    session: {
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
    },
    advanced: {
      cookiePrefix: "usebench",
      useSecureCookies: baseURL.startsWith("https://"),
    },
    telemetry: { enabled: false },
    plugins: [
      passkey({
        rpID: new URL(baseURL).hostname,
        rpName: "usebench.dev",
        origin: baseURL,
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
        registration: {
          requireSession: false,
          resolveUser: async ({ context }) => {
            const registration = await readPasskeyRegistrationContext(env, context);
            if (!registration) throw new Error("Passkey registration expired. Start again.");
            const now = Date.now();
            const email = `passkey-${registration.id}@accounts.usebench.invalid`;
            await env.DB.prepare(
              `INSERT OR IGNORE INTO users
                 (id, name, email, email_verified, created_at, updated_at)
               VALUES (?, 'Passkey account', ?, 0, ?, ?)`,
            ).bind(registration.id, email, now, now).run();
            return {
              id: registration.id,
              name: email,
              displayName: "usebench.dev account",
            };
          },
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

export async function signedSessionCookie(
  env: Bindings,
  token: string,
  requestUrl = env.BASE_URL,
): Promise<string> {
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    await hmacKey(env.BETTER_AUTH_SECRET),
    new TextEncoder().encode(token),
  ));
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  const signed = encodeURIComponent(`${token}.${btoa(binary)}`);
  const secure = new URL(requestUrl).protocol === "https:";
  const name = `${secure ? "__Secure-" : ""}usebench.session_token`;
  return `${name}=${signed}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}${secure ? "; Secure" : ""}`;
}

/** Mount Better Auth and finish passkey-first registration with a session only
 * after the plugin has successfully persisted the credential. */
export async function handleAuthRequest(env: Bindings, request: Request): Promise<Response> {
  const auth = createAuth(env, request.url);
  const response = await auth.handler(request);
  const path = new URL(request.url).pathname;
  if (
    request.method !== "POST"
    || path !== "/api/auth/passkey/verify-registration"
    || !response.ok
    || await auth.api.getSession({ headers: request.headers })
  ) return response;

  const body = await response.clone().json().catch(() => null) as { userId?: unknown } | null;
  if (!body || typeof body.userId !== "string") return response;
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(body.userId);
  if (!session) return response;
  const headers = new Headers(response.headers);
  headers.append("set-cookie", await signedSessionCookie(env, session.token, request.url));
  return new Response(response.body, { status: response.status, headers });
}
