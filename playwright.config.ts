import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 1, // canvas/timing apps tolerate one retry
  workers: 1, // one browser at a time (house convention)
  use: {
    baseURL: 'http://localhost:4173', // local port — NOT the *.dev.kkhost.pl proxy domain
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run build && npm run preview', // preview = vite preview --port 4173 --strictPort
    url: 'http://localhost:4173/',
    reuseExistingServer: true, // reuse an already-running preview server
    timeout: 120_000,
  },
  projects: [
    { name: 'chromium' },
  ],
});
