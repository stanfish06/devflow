import z from 'zod/v4'

/**
 * Canonical client identifiers for any flow that leaves the app, bounces through a
 * third party, and has to decide where to send the user back to.
 *
 * - `ui`     — devflow-ui served in a browser at `APP_ORIGIN`
 * - `cloud`  — devflow-cloud
 * - `native` — the Tauri desktop app
 */
export const DEVFLOW_CLIENTS = ['ui', 'cloud', 'native'] as const
export const ClientSchema = z.enum(DEVFLOW_CLIENTS)
export type AppClient = z.infer<typeof ClientSchema>
