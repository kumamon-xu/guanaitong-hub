import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({command})=>({ plugins: [react(),{name:'desktop-csp',transformIndexHtml:command==='build'?()=>[{tag:'meta',attrs:{'http-equiv':'Content-Security-Policy',content:"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.guanaitong.com https://*.360buyimg.com; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'"},injectTo:'head'}]:undefined}], base: './', server: { host: '127.0.0.1', port: 5173, strictPort: true } }));
