import { defineConfig } from 'vite';

/**
 * Library build.
 *
 * Produces a single ESM bundle, a CommonJS bundle and declaration files in
 * `dist-lib/`. GLSL sources are imported with `?raw` and therefore arrive as
 * strings inside the bundle: consumers do not need a shader plugin.
 *
 * The demo keeps using `vite.config.ts` and `dist/`; the two builds never
 * overwrite each other.
 */
export default defineConfig({
  publicDir: false,
  build: {
    target: 'es2022',
    outDir: 'dist-lib',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: 'src/library/index.ts',
      name: 'Nebula',
      formats: ['es', 'cjs'],
      fileName: (format) => (format === 'es' ? 'nebula.js' : 'nebula.cjs'),
    },
    rollupOptions: {
      output: {
        exports: 'named',
      },
    },
  },
});
