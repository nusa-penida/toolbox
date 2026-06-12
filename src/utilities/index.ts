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
  component: lazy(() =>
    import('./text-case/TextCaseConverter').then((m) => ({ default: m.TextCaseConverter }))
  ),
})

registerUtility({
  id: 'qr-code',
  name: 'QR Code Generator',
  description: 'Create styled QR codes for URLs, WiFi, contacts, email and more.',
  icon: '🔳',
  component: lazy(() =>
    import('./qr-code/QRCodeGenerator').then((m) => ({ default: m.QRCodeGenerator }))
  ),
})
