import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig, type Plugin } from 'vite';

/**
 * Development-only sink for the screenshot harness.
 *
 * The bench page renders at a fixed size (independent of the browser panel)
 * and POSTs the encoded frame here, so documentation images are reproducible
 * with a single URL. Production builds never see this middleware.
 */
function captureSink(): Plugin {
  return {
    name: 'nebula-capture-sink',
    configureServer(server) {
      server.middlewares.use('/__capture', (request, response, next) => {
        if (request.method !== 'POST') {
          next();
          return;
        }

        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          const body = Buffer.concat(chunks);
          const requested = String(request.headers['x-capture-name'] ?? 'capture.jpg');
          const name = requested.replace(/[^a-zA-Z0-9._-]/g, '_');
          const directory = resolve(process.cwd(), 'screenshots');

          try {
            mkdirSync(directory, { recursive: true });
            writeFileSync(resolve(directory, name), body);
            response.statusCode = 200;
            response.end(`saved screenshots/${name}`);
          } catch (error) {
            response.statusCode = 500;
            response.end(error instanceof Error ? error.message : String(error));
          }
        });
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [captureSink()],
  server: {
    port: 5183,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    sourcemap: true,
  },
});
