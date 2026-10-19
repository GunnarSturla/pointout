import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { pointout } from 'pointout/vite'

export default defineConfig({
  plugins: [react(), pointout()],
})
