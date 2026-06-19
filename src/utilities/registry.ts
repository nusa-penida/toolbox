import type { ComponentType, LazyExoticComponent, ReactNode } from 'react'

/**
 * A utility is a self-contained tool page. To add a new one:
 *   1. Create a folder under src/utilities/<your-utility>/ with a component.
 *   2. Register it in src/utilities/index.ts (lazy-imported so each tool
 *      ships as its own chunk and loads on first visit).
 * Routing, navigation and config persistence are handled automatically.
 */
export interface Utility {
  /** Unique stable id — also the key under which user configs are stored. */
  id: string
  name: string
  description: string
  /**
   * SVG icon shown in the sidebar and on cards. Use an inline SVG element
   * (see src/utilities/icons.tsx), NOT an emoji — icons inherit the
   * surrounding text color via `stroke="currentColor"`.
   */
  icon: ReactNode
  /**
   * When true, the utility can be used without logging in — saving
   * (configs, saved items) still requires an account. Defaults to false:
   * unauthenticated visitors are redirected to the login page.
   */
  availableWithoutAccount?: boolean
  component: ComponentType | LazyExoticComponent<ComponentType>
}

const utilities: Utility[] = []

export function registerUtility(utility: Utility) {
  if (utilities.some((u) => u.id === utility.id)) {
    throw new Error(`Utility with id "${utility.id}" is already registered`)
  }
  utilities.push(utility)
}

export function getUtilities(): readonly Utility[] {
  return utilities
}

export function getUtility(id: string): Utility | undefined {
  return utilities.find((u) => u.id === id)
}
