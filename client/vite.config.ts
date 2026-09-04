import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { jsonlSse } from './vite-plugins/jsonl-sse'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), jsonlSse()],
  server: {
    port: 5273,
  },
})
