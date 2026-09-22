import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { agentInspect } from 'vite-agent-inspect'

export default defineConfig({
  plugins: [react(), agentInspect()],
})
