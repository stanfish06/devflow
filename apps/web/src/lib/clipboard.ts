export async function copyAsyncTextToClipboard(textPromise: Promise<string>): Promise<void> {
	await navigator.clipboard.write([
		new ClipboardItem({ 'text/plain': textPromise.then((text) => new Blob([text], { type: 'text/plain' })) }),
	])
}
