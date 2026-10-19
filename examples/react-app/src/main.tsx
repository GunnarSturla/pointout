import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../shared/App.tsx'
import '../../shared/styles.css'

const host = document.getElementById('root')
if (!host) throw new Error('index.html carries no #root element to mount into.')

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
