import { AppInner } from './AppInner.js'
import { AppProviders } from './AppProviders.js'

export const App = () => (
  <AppProviders>
    <AppInner />
  </AppProviders>
)
