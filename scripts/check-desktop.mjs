import { build } from 'esbuild';
import electronPath from 'electron';
import { spawn } from 'node:child_process';
import { mkdtemp, rm,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const entryIndex = process.argv.indexOf('--entry');
const appEntry = resolve(entryIndex >= 0 ? process.argv[entryIndex + 1] : 'dist-electron/main.cjs');
const screenshotIndex=process.argv.indexOf('--screenshots');
const screenshots=screenshotIndex>=0?resolve(process.argv[screenshotIndex+1]):null;
if(screenshots)await mkdir(screenshots,{recursive:true});
const directory = await mkdtemp(join(tmpdir(), 'guanaitong-desktop-test-'));
try {
  const testEntry = join(directory, 'desktop-test.cjs');
  await build({ entryPoints: ['tests/desktop.electron.ts'], outfile: testEntry, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' });
  for (const phase of ['write', 'read']) {
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith('HUB_') || name === 'ELECTRON_RUN_AS_NODE') delete env[name];
    Object.assign(env, { HUB_DESKTOP_TEST_ROOT: directory, HUB_DESKTOP_TEST_ENTRY: appEntry, HUB_DESKTOP_TEST_PHASE: phase });
    if(screenshots)env.HUB_DESKTOP_TEST_SCREENSHOTS=screenshots;
    const child = spawn(electronPath, [testEntry], { stdio: 'inherit', env });
    await new Promise((done, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Desktop ${phase} check timed out.`)); }, 30000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) done(); else reject(new Error(`Desktop ${phase} check failed (${signal ?? code}).`));
      });
    });
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
execFileSync(process.execPath,['scripts/check-trade.mjs','--entry',appEntry],{stdio:'inherit',windowsHide:true});
