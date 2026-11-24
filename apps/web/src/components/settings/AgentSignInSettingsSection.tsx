import { WiredOtherHostsSignIn } from './agent-sign-in/WiredOtherHostsSignIn'

export function AgentSignInSettingsSection() {
	return (
		<div className="space-y-8">
			<p className="text-sm leading-6 text-muted-foreground">
				Each host signs in to Claude and ChatGPT on its own and keeps the credentials. Sessions on a host use
				that host&apos;s sign-in.
			</p>
			<WiredOtherHostsSignIn />
		</div>
	)
}
