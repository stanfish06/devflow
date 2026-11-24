/** True when the drag carries files. */
export function dragCarriesFiles(dataTransfer: DataTransfer | null | undefined): boolean {
	return dataTransfer?.types?.includes('Files') ?? false
}

/** Files in a drop event. Reads `dataTransfer` synchronously; the object is empty once the handler yields. */
export function readDroppedFiles(dataTransfer: DataTransfer | null | undefined): Promise<File[]> {
	return Promise.resolve(Array.from(dataTransfer?.files ?? []))
}
