import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

export default defineConfig({
  plugins: [cesium()],
  server: {
    port: 3001,
    // Don't HMR-watch the tile trees under public/data — they're served
    // statically and the thousands of GLB files crash chokidar on Windows
    // ("scandir UNKNOWN" -4094). Vite still serves them; it just stops
    // watching them for changes.
    watch: {
      ignored: ['**/public/data/**', '**/tools/tmp/**', '**/Lublin City scan/**'],
    },
  },
  base: '/cesium-splat-streetview/'
});