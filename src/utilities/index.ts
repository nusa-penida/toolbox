import { lazy } from 'react'
import { registerUtility } from './registry'

// Register every utility here. Order determines sidebar order.
// Components are lazy-imported so each utility builds into its own chunk
// and only loads when the user opens it.
registerUtility({
  id: 'text-case',
  name: 'Text Case Converter',
  description: 'Convert text between upper, lower, title, kebab and snake case.',
  icon: '🔤',
  availableWithoutAccount: true,
  component: lazy(() =>
    import('./text-case/TextCaseConverter').then((m) => ({ default: m.TextCaseConverter }))
  ),
})

registerUtility({
  id: 'route-optimizer',
  name: 'Shortest Route',
  description: 'Reorder a list of stops into the shortest route and open it in your maps app.',
  icon: '🧭',
  availableWithoutAccount: true,
  component: lazy(() =>
    import('./route-optimizer/RouteOptimizer').then((m) => ({ default: m.RouteOptimizer }))
  ),
})

registerUtility({
  id: 'qr-code',
  name: 'QR Code Generator',
  description: 'Create styled QR codes for URLs, WiFi, contacts, email and more.',
  icon: '🔳',
  availableWithoutAccount: true,
  component: lazy(() =>
    import('./qr-code/QRCodeGenerator').then((m) => ({ default: m.QRCodeGenerator }))
  ),
})
