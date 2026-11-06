import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // Relative asset paths so the build works under GitHub Pages' /yunitrade/ subpath.
  base: './',
  plugins: [react(), tailwindcss()],
  // The sales order rules live in supabase/functions/_shared so the scheduled job can use them too.
  server: { fs: { allow: ['..'] } },
})
