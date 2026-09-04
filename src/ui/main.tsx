import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('mount point #root not found in ui/index.html')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
