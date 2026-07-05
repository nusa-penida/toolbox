/**
 * SVG icons for utilities, from the Lucide icon set (`lucide-react`).
 *
 * CONVENTION: every utility's `icon` is an inline SVG element, NOT an emoji.
 * Lucide icons default to `stroke="currentColor"`, so they inherit the
 * surrounding text color (e.g. the active/hover state in the sidebar).
 *
 * To add a new utility icon: pick one from https://lucide.dev/icons, import
 * it below, and export an element with `className="size-5"` for consistent
 * sizing. Reference it from src/utilities/index.ts.
 */
import {
  CaseSensitive,
  Route,
  Download,
  QrCode,
  Clock,
  Goal,
  Clapperboard,
  TrendingUp,
  UtensilsCrossed,
  Laugh,
  Film,
  Dices,
} from 'lucide-react'

export const textCaseIcon = <CaseSensitive className="size-5" />
export const routeIcon = <Route className="size-5" />
export const downloadIcon = <Download className="size-5" />
export const qrCodeIcon = <QrCode className="size-5" />
export const clockIcon = <Clock className="size-5" />
export const soccerIcon = <Goal className="size-5" />
export const moviesIcon = <Clapperboard className="size-5" />
export const stockIcon = <TrendingUp className="size-5" />
export const mealPlannerIcon = <UtensilsCrossed className="size-5" />
export const memeStudioIcon = <Laugh className="size-5" />
export const videoEditorIcon = <Film className="size-5" />
export const boardGameIcon = <Dices className="size-5" />
