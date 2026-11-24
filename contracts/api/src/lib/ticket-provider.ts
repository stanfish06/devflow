import z from 'zod/v4'

export const TicketProviderSchema = z.enum(['github'])

export type TicketProvider = z.infer<typeof TicketProviderSchema>
