import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import electronPath from 'electron';
await build({ entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' });
await build({ entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' });
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { stdio: 'inherit' });
let electron;
let stopping = false;
let viteError;
const stop = () => { stopping = true; vite.kill(); electron?.kill(); };
process.on('SIGINT', () => { stop(); process.exitCode = 130; });
process.on('SIGTERM', () => { stop(); process.exitCode = 143; });
vite.on('error', error => { viteError = error; });
vite.on('exit', code => {
  if (!stopping) { stop(); process.exitCode = code || 1; }
});
try {
  let ready = false;
  for (let n = 0; n < 100 && !stopping; n++) {
    if (viteError) throw viteError;
    try { if ((await fetch('http://127.0.0.1:5173', { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  if (!ready) throw new Error('Vite did not start at http://127.0.0.1:5173.');
  // Launch the native executable directly; Windows .bin shims are command scripts.
  electron = spawn(electronPath, ['.'], { stdio: 'inherit', env: { ...process.env, HUB_DEV_URL: 'http://127.0.0.1:5173' } });
  electron.on('error', error => { console.error(error); stop(); process.exitCode = 1; });
  electron.on('exit', code => { if (!stopping) { stop(); process.exitCode = code ?? 1; } });
} catch (error) {
  stop();
  throw error;
}
