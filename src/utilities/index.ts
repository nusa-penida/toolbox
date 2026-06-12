import { registerUtility } from './registry'
import { TextCaseConverter } from './text-case/TextCaseConverter'

// Register every utility here. Order determines sidebar order.
registerUtility({
  id: 'text-case',
  name: 'Text Case Converter',
  description: 'Convert text between upper, lower, title, kebab and snake case.',
  icon: '🔤',
  component: TextCaseConverter,
})
