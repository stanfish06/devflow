/**
 * Single-user auth for a local install.
 *
 * - Issues RS256 access tokens signed by the key at DEVFLOW_AUTH_PRIVATE_JWK_PATH, with the claims
 *   `auth/jwt-validator.ts` reads (`sub`, `sid`, `org_id`, `internal_org_id`, `role`, ...).
 * - Serves the public key as a JWKS so the sync proxy can verify the same tokens.
 * - Seeds the in-memory user directory with the one user, organization and admin membership.
 *
 * The user comes from DEVFLOW_USER_ID / DEVFLOW_USER_EMAIL / DEVFLOW_USER_NAME; the organization is the
 * `organizations` row with id DEVFLOW_ORGANIZATION_ID. The token endpoint has no credential check: the
 * API listens on loopback, and remote access goes through an SSH/SSM tunnel to that loopback port.
 */
import { readFileSync } from 'node:fs'

import { organizations } from '@devflow/db/tables/organizations'
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { importJWK, type JWK, SignJWT } from 'jose'

import { UserDirectory } from '../auth/directory'
import { db } from '../db/db'
import { requireEnvironment } from '../lib/environment'

const TOKEN_TTL_SECONDS = 60 * 60
const ISSUER = 'devflow-local'
const SESSION_ID = 'devflow-local-session'

export type LocalIdentity = {
	userId: string
	email: string
	firstName: string
	lastName: string
	organizationId: string
	/** `organizations.workos_organization_id` of the local organization; sent as the `org_id` claim. */
	externalOrganizationId: string
	organizationName: string
}

let identityPromise: Promise<LocalIdentity> | null = null

/** Resolve the local user and organization once; a failed lookup is retried on the next call. */
export function loadLocalIdentity(): Promise<LocalIdentity> {
	identityPromise ??= resolveLocalIdentity().catch((error: unknown) => {
		identityPromise = null
		throw error
	})
	return identityPromise
}

async function resolveLocalIdentity(): Promise<LocalIdentity> {
	const [firstName = 'devflow', ...rest] = (process.env.DEVFLOW_USER_NAME ?? 'devflow user').split(' ')
	const organizationId = requireEnvironment('DEVFLOW_ORGANIZATION_ID')
	const [organization] = await db
		.select({ externalId: organizations.workos_organization_id, name: organizations.name })
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1)
	if (!organization) {
		throw new Error(`Organization ${organizationId} (DEVFLOW_ORGANIZATION_ID) not found in the database`)
	}
	return {
		userId: requireEnvironment('DEVFLOW_USER_ID'),
		email: process.env.DEVFLOW_USER_EMAIL ?? 'me@devflow.localhost',
		firstName,
		lastName: rest.join(' '),
		organizationId,
		externalOrganizationId: organization.externalId,
		organizationName: organization.name,
	}
}

let privateJwk: JWK | null = null
function loadPrivateJwk(): JWK {
	privateJwk ??= JSON.parse(readFileSync(requireEnvironment('DEVFLOW_AUTH_PRIVATE_JWK_PATH'), 'utf8')) as JWK
	return privateJwk
}

/** Public half of the signing key as a JWKS. */
export function localJwks(): { keys: JWK[] } {
	const { kty, n, e, kid, alg } = loadPrivateJwk()
	return { keys: [{ kty, n, e, kid, alg, use: 'sig' }] }
}

export async function issueLocalAccessToken(): Promise<{ accessToken: string; expiresAt: number }> {
	const jwk = loadPrivateJwk()
	const identity = await loadLocalIdentity()
	const key = await importJWK(jwk, 'RS256')
	const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
	const accessToken = await new SignJWT({
		sid: SESSION_ID,
		org_id: identity.externalOrganizationId,
		internal_org_id: identity.organizationId,
		role: 'admin',
		roles: ['admin'],
		permissions: [],
		entitlements: [],
		feature_flags: [],
	})
		.setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
		.setIssuer(ISSUER)
		.setSubject(identity.userId)
		.setIssuedAt()
		.setExpirationTime(expiresAt)
		.sign(key)
	return { accessToken, expiresAt: expiresAt * 1000 }
}

let directoryPromise: Promise<UserDirectory> | null = null

/** The process-wide directory holding the local user, organization and admin membership. */
export function getLocalDirectory(): Promise<UserDirectory> {
	directoryPromise ??= loadLocalIdentity().then(
		(identity) => {
			const directory = new UserDirectory()
			directory.addUser({
				id: identity.userId,
				email: identity.email,
				firstName: identity.firstName,
				lastName: identity.lastName || null,
				createdAt: new Date(0).toISOString(),
			})
			directory.addOrganization({ id: identity.externalOrganizationId, name: identity.organizationName })
			directory.addMembership({
				userId: identity.userId,
				organizationId: identity.externalOrganizationId,
				role: 'admin',
			})
			return directory
		},
		(error: unknown) => {
			directoryPromise = null
			throw error
		},
	)
	return directoryPromise
}

/**
 * GET  /devflow/auth/jwks     public key for token verification
 * POST /devflow/auth/session  the local user plus a fresh access token (used by the UI and CLI)
 */
export function registerLocalAuthRoutes(app: Hono): void {
	app.get('/devflow/auth/jwks', (c) => c.json(localJwks()))
	app.post('/devflow/auth/session', async (c) => {
		const identity = await loadLocalIdentity()
		const token = await issueLocalAccessToken()
		return c.json({
			...token,
			organizationId: identity.externalOrganizationId,
			internalOrganizationId: identity.organizationId,
			user: {
				object: 'user',
				id: identity.userId,
				email: identity.email,
				emailVerified: true,
				profilePictureUrl: null,
				firstName: identity.firstName,
				lastName: identity.lastName || null,
				lastSignInAt: null,
				externalId: undefined,
				createdAt: new Date(0).toISOString(),
				updatedAt: new Date(0).toISOString(),
			},
		})
	})
}
