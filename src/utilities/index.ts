import { lazy } from 'react'
import { registerUtility } from './registry'
import {
  textCaseIcon,
  routeIcon,
  downloadIcon,
  qrCodeIcon,
  clockIcon,
  soccerIcon,
} from './icons'

// Register every utility here. Order determines sidebar order.
// Components are lazy-imported so each utility builds into its own chunk
// and only loads when the user opens it.
registerUtility({
  id: 'text-case',
  name: 'Text Case Converter',
  description: 'Convert text between upper, lower, title, kebab and snake case.',
  icon: textCaseIcon,
  availableWithoutAccount: true,
  component: lazy(() =>
    import('./text-case/TextCaseConverter').then((m) => ({ default: m.TextCaseConverter }))
  ),
})

registerUtility({
  id: 'route-optimizer',
  name: 'Shortest Route',
  description: 'Reorder a list of stops into the shortest route and open it in your maps app.',
  icon: routeIcon,
  availableWithoutAccount: true,
  component: lazy(() =>
    import('./route-optimizer/RouteOptimizer').then((m) => ({ default: m.RouteOptimizer }))
  ),
})

registerUtility({
  id: 'yt-dlp',
  name: 'Video Downloader',
  description: 'Build a ready-to-run yt-dlp command to download video or audio locally.',
  icon: downloadIcon,
  availableWithoutAccount: false,
  component: lazy(() =>
    import('./yt-dlp/YtDlpCommand').then((m) => ({ default: m.YtDlpCommand }))
  ),
})

registerUtility({
  id: 'qr-code',
  name: 'QR Code Generator',
  description: 'Create styled QR codes for URLs, WiFi, contacts, payments and more.',
  icon: qrCodeIcon,
  availableWithoutAccount: true,
  component: lazy(() =>
    import('./qr-code/QRCodeGenerator').then((m) => ({ default: m.QRCodeGenerator }))
  ),
})

registerUtility({
  id: 'work-hours',
  name: 'Work Hours',
  description: 'Track hours worked per week and days off to see how many hours you still owe for the month.',
  icon: clockIcon,
  availableWithoutAccount: false,
  component: lazy(() =>
    import('./work-hours/WorkHoursTracker').then((m) => ({ default: m.WorkHoursTracker }))
  ),
})

registerUtility({
  id: 'soccer-predictor',
  name: 'Soccer Predictor',
  description: 'Compare two teams or browse fixtures for a win % and likely scoreline.',
  icon: soccerIcon,
  availableWithoutAccount: false,
  component: lazy(() =>
    import('./soccer-predictor/SoccerPredictor').then((m) => ({ default: m.SoccerPredictor }))
  ),
})

registerUtility({
  id: 'stock-tracker',
  name: 'Stock Tracker',
  description: 'Track a watchlist of prices, charts and fund holdings via Alpha Vantage, FMP (free) or Morningstar.',
  icon: '📈',
  availableWithoutAccount: false,
  component: lazy(() =>
    import('./stock-tracker/StockTracker').then((m) => ({ default: m.StockTracker }))
  ),
})

registerUtility({
  id: 'movies',
  name: 'Movies',
  description: 'Browse popular, in-theatres and top-rated movies via TMDB, filter or search, then stream — with saved favourites and watch history.',
  icon: '🎬',
  availableWithoutAccount: false,
  component: lazy(() =>
    import('./movies/Movies').then((m) => ({ default: m.Movies }))
  ),
})
