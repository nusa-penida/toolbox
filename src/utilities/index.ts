import { lazy } from 'react'
import { registerUtility } from './registry'
import {
  // textCaseIcon,
  routeIcon,
  downloadIcon,
  qrCodeIcon,
  clockIcon,
  // soccerIcon,
  // stockIcon,
  // moviesIcon,
  mealPlannerIcon,
  memeStudioIcon,
  videoEditorIcon,
  boardGameIcon,
  solarRoofIcon,
} from './icons'

// Register every utility here. Order determines sidebar order.
// Components are lazy-imported so each utility builds into its own chunk
// and only loads when the user opens it.
// registerUtility({
//   id: 'text-case',
//   name: 'Text Case Converter',
//   description: 'Convert text between upper, lower, title, kebab and snake case.',
//   icon: textCaseIcon,
//   availableWithoutAccount: true,
//   component: lazy(() =>
//     import('./text-case/TextCaseConverter').then((m) => ({ default: m.TextCaseConverter }))
//   ),
// })

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
  id: 'solar-roof',
  name: 'Solar Roof Planner',
  description:
    'Trace a roof on the satellite map, set each face’s slope and direction, and find the best surface for solar panels by yearly sun.',
  icon: solarRoofIcon,
  availableWithoutAccount: true,
  component: lazy(() =>
    import('./solar-roof/SolarRoof').then((m) => ({ default: m.SolarRoof }))
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

// registerUtility({
//   id: 'soccer-predictor',
//   name: 'Soccer Predictor',
//   description: 'Compare two teams or browse fixtures for a win % and likely scoreline.',
//   icon: soccerIcon,
//   availableWithoutAccount: false,
//   component: lazy(() =>
//     import('./soccer-predictor/SoccerPredictor').then((m) => ({ default: m.SoccerPredictor }))
//   ),
// })

// registerUtility({
//   id: 'stock-tracker',
//   name: 'Stock Tracker',
//   description: 'Track a watchlist of prices, charts and fund holdings via Alpha Vantage, FMP (free) or Morningstar.',
//   icon: stockIcon,
//   availableWithoutAccount: false,
//   component: lazy(() =>
//     import('./stock-tracker/StockTracker').then((m) => ({ default: m.StockTracker }))
//   ),
// })

registerUtility({
  id: 'meal-planner',
  name: 'Meal Planner',
  description: 'Plan a lunch and dinner for each day of the week from your own list of meals.',
  icon: mealPlannerIcon,
  availableWithoutAccount: false,
  component: lazy(() =>
    import('./meal-planner/MealPlanner').then((m) => ({ default: m.MealPlanner }))
  ),
})

registerUtility({
  id: 'meme-studio',
  name: 'Meme Studio',
  description:
    'Make memes from trending templates or your own image, GIF or video — add captions, flip and rotate, then download.',
  icon: memeStudioIcon,
  availableWithoutAccount: true,
  component: lazy(() =>
    import('./meme-studio/MemeStudio').then((m) => ({ default: m.MemeStudio }))
  ),
})

registerUtility({
  id: 'video-editor',
  name: 'Video Editor',
  description:
    'Stitch local video files on a timeline, layer text, images and colour cards, mix audio tracks, then export to MP4 — all in your browser.',
  icon: videoEditorIcon,
  availableWithoutAccount: true,
  component: lazy(() =>
    import('./video-editor/VideoEditor').then((m) => ({ default: m.VideoEditor }))
  ),
})

registerUtility({
  id: 'board-game-scores',
  name: 'Board Game Scores',
  description: 'Keep score for any board game — add players and rounds, live totals and a crowned leader. Saved to your account.',
  icon: boardGameIcon,
  availableWithoutAccount: false,
  component: lazy(() =>
    import('./board-game-scores/BoardGameScores').then((m) => ({ default: m.BoardGameScores }))
  ),
})

// registerUtility({
//   id: 'movies',
//   name: 'Movies & TV',
//   description: 'Browse popular, in-theatres/on-air and top-rated movies and TV via TMDB, filter or search, then stream — with saved favourites and watch history.',
//   icon: moviesIcon,
//   availableWithoutAccount: false,
//   component: lazy(() =>
//     import('./movies/Movies').then((m) => ({ default: m.Movies }))
//   ),
// })
