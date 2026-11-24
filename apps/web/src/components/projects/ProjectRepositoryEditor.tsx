import { normalizeRepositoryIdentity } from '@devflow/schemas/effect/project-workspace'
import { Button } from '@devflow/ui/components/button'
import { Checkbox } from '@devflow/ui/components/checkbox'
import { Field, FieldError } from '@devflow/ui/components/field'
import { Input } from '@devflow/ui/components/input'
import { Textarea } from '@devflow/ui/components/textarea'
import { Star, Trash2 } from 'lucide-react'
import { Controller, useWatch, type Control } from 'react-hook-form'

import type { ProjectCreatorFormValues } from './ProjectCreator'

export function ProjectRepositoryEditor({
	control,
	index,
	onDefault,
	onRemove,
	disabled,
	roomy = false,
}: {
	control: Control<ProjectCreatorFormValues>
	index: number
	onDefault: () => void
	onRemove?: () => void
	disabled: boolean
	roomy?: boolean
}) {
	const repository = useWatch({ control, name: `repositories.${index}` })
	const isDefault = repository.default
	const label =
		normalizeRepositoryIdentity(repository.remoteUrl)?.split('/').slice(1).join('/') ?? repository.remoteUrl
	return (
		<fieldset
			aria-label={`Settings for ${label}`}
			disabled={disabled}
			className="min-w-0 space-y-2 border border-border/50 px-3 py-2"
		>
			<div className="flex min-w-0 items-center gap-2">
				<span className="min-w-0 truncate text-sm font-medium" title={repository.remoteUrl}>
					{label}
				</span>
				<Button
					type="button"
					size="xs"
					variant={isDefault ? 'secondary' : 'ghost'}
					className="ml-auto normal-case tracking-normal"
					aria-pressed={isDefault}
					aria-label={`Use ${label} as default repository`}
					onClick={onDefault}
					disabled={disabled}
					title="Sessions start in the default repository"
				>
					<Star className={isDefault ? 'size-3 fill-current' : 'size-3'} />
					{isDefault ? 'Default' : 'Make default'}
				</Button>
				{onRemove && (
					<Button
						type="button"
						size="icon"
						variant="destructive"
						className="size-6"
						aria-label={`Remove ${label}`}
						onClick={onRemove}
						disabled={disabled}
					>
						<Trash2 className="size-3.5" />
					</Button>
				)}
			</div>
			<div className="flex flex-wrap items-end gap-x-4 gap-y-2">
				<Controller
					control={control}
					name={`repositories.${index}.remoteUrl`}
					render={({ field, fieldState }) => (
						<Field data-invalid={fieldState.invalid} className={fieldState.error ? 'w-36 gap-1' : 'hidden'}>
							<FieldError errors={[fieldState.error]} />
						</Field>
					)}
				/>
				<Controller
					control={control}
					name={`repositories.${index}.defaultBranch`}
					render={({ field, fieldState }) => (
						<Field data-invalid={fieldState.invalid} className="w-36 gap-1">
							<label className="flex w-36 min-w-0 flex-col gap-1 text-xs text-muted-foreground">
								<span>Default branch</span>
								<Input
									className="h-7 px-2 py-1 text-xs md:text-xs"
									aria-label={`Default branch for ${label}`}
									{...field}
									aria-invalid={fieldState.invalid}
								/>
							</label>
							<FieldError errors={[fieldState.error]} />
						</Field>
					)}
				/>
				<Controller
					control={control}
					name={`repositories.${index}.autoPushBranch`}
					render={({ field, fieldState }) => (
						<Field data-invalid={fieldState.invalid} className="w-auto gap-1">
							<label className="flex min-h-7 items-center gap-2 text-xs text-muted-foreground">
								<Checkbox
									name={field.name}
									ref={field.ref}
									onBlur={field.onBlur}
									checked={field.value}
									onCheckedChange={(checked) => field.onChange(checked === true)}
									disabled={disabled}
								/>{' '}
								Push branches to remote when creating a task
							</label>
							<FieldError errors={[fieldState.error]} />
						</Field>
					)}
				/>
			</div>
			<div className={roomy ? 'grid gap-5' : 'grid gap-3 sm:grid-cols-2'}>
				<Controller
					control={control}
					name={`repositories.${index}.copyGlobsText`}
					render={({ field, fieldState }) => (
						<Field data-invalid={fieldState.invalid} className="gap-1">
							<label className="min-w-0 space-y-1 text-xs text-muted-foreground">
								Files to copy (globs)
								<Textarea
									aria-label={`Copy globs for ${label}`}
									rows={roomy ? 8 : 1}
									className={
										roomy
											? 'min-h-40 font-mono text-xs leading-6'
											: 'min-h-7 max-h-32 px-2 py-1 text-xs md:text-xs leading-5'
									}
									placeholder="e.g. .env.local (one glob per line)"
									title="One pattern per line, relative to the source repository."
									{...field}
									aria-invalid={fieldState.invalid}
								/>
							</label>
							<FieldError errors={[fieldState.error]} />
						</Field>
					)}
				/>
				<Controller
					control={control}
					name={`repositories.${index}.setupCommand`}
					render={({ field, fieldState }) => (
						<Field data-invalid={fieldState.invalid} className="gap-1">
							<label className="min-w-0 space-y-1 text-xs text-muted-foreground">
								Setup command
								<Textarea
									aria-label={`Setup command for ${label}`}
									rows={roomy ? 10 : 1}
									spellCheck={false}
									className={
										roomy
											? 'min-h-40 font-mono text-xs leading-6'
											: 'min-h-7 max-h-32 px-2 py-1 text-xs md:text-xs leading-5'
									}
									title="Runs in this repository's new workspace after copying files."
									placeholder="e.g. bun install"
									{...field}
									aria-invalid={fieldState.invalid}
								/>
							</label>
							<FieldError errors={[fieldState.error]} />
						</Field>
					)}
				/>
			</div>
		</fieldset>
	)
}
