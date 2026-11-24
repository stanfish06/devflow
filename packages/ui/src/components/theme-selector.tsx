import * as React from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { useHotkeys } from '@devflow/hotkeys'
import { Tooltip, TooltipContent, TooltipTrigger } from '@devflow/ui/components/tooltip'
import { useTheme, type ThemePreference } from './theme-provider'
import { cn } from '@devflow/ui/lib/utils'
import { KeyboardShortcut } from './keyboard-shortcut'

const themes: { value: ThemePreference; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
]
const themeSections = [{ label: null, themes }]
const themeIndexByValue = new Map(themes.map((theme, index) => [theme.value, index]))

interface ThemeSelectorProps {
  className?: string
  enableHotkeys?: boolean
  hotkeyScope?: string
  showTooltip?: boolean
  onOpenChange?: (open: boolean) => void
}

export function ThemeSelector({
  className,
  enableHotkeys = false,
  hotkeyScope,
  showTooltip = true,
  onOpenChange,
}: ThemeSelectorProps) {
  const { preference: theme, setPreference: setTheme } = useTheme()
  const [isOpen, setIsOpenState] = React.useState(false)
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const [positionAbove, setPositionAbove] = React.useState(false)

  const setIsOpen = React.useCallback((open: boolean | ((prev: boolean) => boolean)) => {
    setIsOpenState((prev) => {
      const newState = typeof open === 'function' ? open(prev) : open
      onOpenChange?.(newState)
      return newState
    })
  }, [onOpenChange])

  const buttonRef = React.useRef<HTMLButtonElement>(null)
  const dropdownRef = React.useRef<HTMLDivElement>(null)
  const itemRefs = React.useRef<(HTMLButtonElement | null)[]>([])

  const currentTheme = themes.find((t) => t.value === theme) || themes[0]
  const Icon = currentTheme?.icon ?? Sun

  // Calculate dropdown position
  React.useEffect(() => {
    if (isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      const spaceBelow = window.innerHeight - rect.bottom
      const spaceAbove = rect.top
      const dropdownHeight = 400 // Approximate height

      setPositionAbove(spaceBelow < dropdownHeight && spaceAbove > spaceBelow)
    }
  }, [isOpen])

  // Scroll selected item into view
  React.useEffect(() => {
    if (isOpen && itemRefs.current[selectedIndex]) {
      itemRefs.current[selectedIndex]?.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      })
    }
  }, [selectedIndex, isOpen])

  // Hotkeys - always call hooks, but conditionally enable them
  useHotkeys(
    'alt+t',
    (e) => {
      e.preventDefault()
      setIsOpen((prev) => !prev)
      if (!isOpen) {
        setSelectedIndex(themes.findIndex((t) => t.value === theme))
      }
    },
    {
      enableOnFormTags: false,
      enabled: enableHotkeys
    }
  )

  useHotkeys(
    'j, ArrowDown',
    (e) => {
      e.preventDefault()
      setSelectedIndex((prev) => {
        const next = (prev + 1) % themes.length
        return next
      })
    },
    {
      enableOnFormTags: false,
      scopes: hotkeyScope ? [hotkeyScope] : undefined,
      enabled: enableHotkeys && isOpen
    }
  )

  useHotkeys(
    'k, ArrowUp',
    (e) => {
      e.preventDefault()
      setSelectedIndex((prev) => {
        const next = (prev - 1 + themes.length) % themes.length
        return next
      })
    },
    {
      enableOnFormTags: false,
      scopes: hotkeyScope ? [hotkeyScope] : undefined,
      enabled: enableHotkeys && isOpen
    }
  )

  useHotkeys(
    'enter',
    (e) => {
      e.preventDefault()
      const selectedTheme = themes[selectedIndex]
      if (selectedTheme) {
        setTheme(selectedTheme.value)
        setIsOpen(false)
      }
    },
    {
      enableOnFormTags: false,
      scopes: hotkeyScope ? [hotkeyScope] : undefined,
      enabled: enableHotkeys && isOpen
    }
  )

  useHotkeys(
    'escape',
    (e) => {
      e.preventDefault()
      setIsOpen(false)
    },
    {
      enableOnFormTags: false,
      scopes: hotkeyScope ? [hotkeyScope] : undefined,
      enabled: enableHotkeys && isOpen
    }
  )

  const button = (
    <button
      ref={buttonRef}
      onClick={() => {
        setIsOpen(!isOpen)
        if (!isOpen) {
          setSelectedIndex(themes.findIndex((t) => t.value === theme))
        }
      }}
      className={cn(
        'px-1.5 py-0.5 text-xs font-mono border border-border',
        'bg-background text-foreground hover:bg-accent/10 transition-colors',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none',
        className
      )}
      aria-label="Select theme"
    >
      <Icon className="w-3 h-3" />
    </button>
  )

  return (
    <div className="relative">
      {showTooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>Theme: {currentTheme?.label}</p>
            {enableHotkeys && <KeyboardShortcut>{'⌥+T'}</KeyboardShortcut>}
          </TooltipContent>
        </Tooltip>
      ) : (
        button
      )}

      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />

          {/* Dropdown */}
          <div
            ref={dropdownRef}
            className={cn(
              'absolute right-0 z-20 min-w-48 border border-border bg-background',
              positionAbove ? 'bottom-full mb-1' : 'top-full mt-1'
            )}
          >
            <div className="max-h-64 overflow-y-auto">
              {themeSections.map((section) => (
                <React.Fragment key={section.label ?? 'main'}>
                  {section.label && (
                    <div
                      role="heading"
                      aria-level={2}
                      className="border-t border-border px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground"
                    >
                      {section.label}
                    </div>
                  )}
                  {section.themes.map((themeOption) => {
                    const index = themeIndexByValue.get(themeOption.value) ?? 0
                    const ThemeIcon = themeOption.icon
                    const isSelected = theme === themeOption.value
                    const isHighlighted = index === selectedIndex

                    return (
                      <button
                        key={themeOption.value}
                        ref={(el) => {
                          itemRefs.current[index] = el
                        }}
                        onClick={() => {
                          setTheme(themeOption.value)
                          setIsOpen(false)
                        }}
                        onMouseEnter={() => {
                          setSelectedIndex(index)
                        }}
                        className={`w-full px-2 py-1.5 text-left text-xs font-mono transition-colors flex items-center gap-2 ${
                          isHighlighted
                            ? 'bg-accent/20 text-accent'
                            : isSelected
                              ? 'bg-accent/10 text-accent'
                              : 'text-foreground hover:bg-accent/5'
                        }`}
                      >
                        <ThemeIcon className="w-3 h-3" />
                        <span>{themeOption.label}</span>
                      </button>
                    )
                  })}
                </React.Fragment>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
