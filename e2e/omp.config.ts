import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';
import { fileURLToPath } from 'node:url';
import { agentURL, loggedIn } from './auth.ts';
export default defineConfig({ ...base, testMatch: 'omp.spec.ts', projects: [{ name: 'omp', use: { baseURL: agentURL(4795, 'omp'), storageState: loggedIn('omp', 4795) } }], webServer: [{ command: 'node e2e/omp-serve.mjs', cwd: fileURLToPath(new URL('..', import.meta.url)), url: 'http://127.0.0.1:4795/', reuseExistingServer: false, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } }] });
