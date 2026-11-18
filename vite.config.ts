import { defineConfig } from 'vite';
import {fileURLToPath} from 'node:url';
export default defineConfig({ root: 'client', define:{__RELAY_HOSTED__:JSON.stringify(process.env.RELAY_HOSTED==='1')}, cacheDir:fileURLToPath(new URL('./.data-ui-preview/quiet-radiance/vite-cache',import.meta.url)), build: { outDir: '../dist/client', emptyOutDir: true }, server: { host: '127.0.0.1' } });
