import type { ComponentType } from 'react'

/**
 * A utility is a self-contained tool page. To add a new one:
 *   1. Create a folder under src/utilities/<your-utility>/ with a component.
 *   2. Register it in src/utilities/index.ts.
 * Routing, navigation and config persistence are handled automatically.
 */
export interface Utility {
  /** Unique stable id — also the key under which user configs are stored. */
  id: string
  name: string
  description: string
  /** Emoji or short string shown in the sidebar. */
  icon: string
  component: ComponentType
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
