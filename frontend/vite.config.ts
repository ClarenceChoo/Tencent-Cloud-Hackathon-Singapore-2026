import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const apiTarget = process.env.CARELOOP_API_TARGET || 'http://127.0.0.1:8000';
const proxy = { '/v1': apiTarget };
export default defineConfig({ plugins: [react()], server: { host: '127.0.0.1', proxy }, preview: { host: '127.0.0.1', proxy }, build: { rollupOptions: { input: { app: 'index.html', landing: 'landing/index.html' } } } });
