import { build } from 'esbuild';
import electronPath from 'electron';
import { spawn } from 'node:child_process';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve,sep } from 'node:path';
import { readFileSync } from 'node:fs';

const oldIndex=process.argv.indexOf('--old-entry'),versionIndex=process.argv.indexOf('--old-version');
if(oldIndex<0||versionIndex<0)throw new Error('Usage: node scripts/check-upgrade.mjs --old-entry <old main.cjs> --old-version <x.y.z>');
const old=resolve(process.argv[oldIndex+1]),oldVersion=process.argv[versionIndex+1],pkg=JSON.parse(readFileSync('package.json','utf8'));
const root=await mkdtemp(join(tmpdir(),'gat-program-upgrade-'));
function verified(path){const value=resolve(path);if(!value.startsWith(resolve(tmpdir())+sep)||!value.split(sep).at(-1).startsWith('gat-program-upgrade-'))throw new Error('Unexpected temporary path');return value;}
try{
  const entry=join(root,'upgrade-check.cjs');await build({entryPoints:['tests/desktop.electron.ts'],outfile:entry,bundle:true,platform:'node',format:'cjs',external:['electron'],target:'node24'});
  for(const phase of ['write','read']){
    const env={...process.env};for(const name of Object.keys(env))if(name.startsWith('HUB_')||name==='ELECTRON_RUN_AS_NODE')delete env[name];
    Object.assign(env,{HUB_DESKTOP_TEST_ROOT:root,HUB_DESKTOP_TEST_PHASE:phase,HUB_DESKTOP_TEST_ENTRY:phase==='write'?old:resolve('dist-electron/main.cjs'),HUB_DESKTOP_EXPECTED_VERSION:phase==='write'?oldVersion:pkg.version});
    const child=spawn(electronPath,[entry],{env,stdio:'inherit',windowsHide:true});
    await new Promise((done,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('Upgrade regression timed out'));},45000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);code===0?done():reject(new Error('Upgrade regression failed'));});});
  }
  console.log(JSON.stringify({case:'old-program-to-new-program',from:oldVersion,to:pkg.version,ok:true,realUserDataTouched:false}));
}finally{await rm(verified(root),{recursive:true,force:true});}
