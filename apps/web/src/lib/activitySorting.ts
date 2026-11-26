export function activityMinute(timestamp: bigint | number): number {
	return Math.floor(Number(timestamp) / 60_000)
}

type SessionActivityTimestamps = {
	last_activity_at: bigint | number
	created_at: bigint | number
}

export function compareSessionsByActivityMinute(a: SessionActivityTimestamps, b: SessionActivityTimestamps): number {
	const activityDifference = activityMinute(b.last_activity_at) - activityMinute(a.last_activity_at)
	if (activityDifference !== 0) return activityDifference

	const createdDifference = Number(b.created_at) - Number(a.created_at)
	if (createdDifference !== 0) return createdDifference

	return 0
}

/** The most recently active candidate; same-timestamp sessions break ties by ID. */
export function mostRecentlyActiveSession<T extends { id?: string; last_activity_at: bigint | null }>(
	sessions: readonly T[],
): T | null {
	return sessions.reduce<T | null>((latest, session) => {
		const activity = session.last_activity_at ?? 0n
		const latestActivity = latest?.last_activity_at ?? 0n
		return !latest ||
			activity > latestActivity ||
			(activity === latestActivity && (session.id ?? '') > (latest.id ?? ''))
			? session
			: latest
	}, null)
}
