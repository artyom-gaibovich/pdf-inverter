import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base соответствует пути публикации на GitHub Pages: https://<user>.github.io/pdf-inverter/
export default defineConfig({
  base: '/pdf-inverter/',
  plugins: [react()],
});
