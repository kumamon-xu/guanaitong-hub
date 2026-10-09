import { build } from 'esbuild';
import electronPath from 'electron';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const index=process.argv.indexOf('--entry'),entry=resolve(index>=0?process.argv[index+1]:'dist-electron/main.cjs');
const root=await mkdtemp(join(tmpdir(),'gat-trade-native-'));
const verifiedRoot=resolve(root);if(!verifiedRoot.startsWith(resolve(tmpdir())+sep)||!verifiedRoot.split(sep).at(-1).startsWith('gat-trade-native-'))throw new Error('Unexpected temporary path');
try{
  const test=join(root,'trade-test.cjs');await build({entryPoints:['tests/trade.electron.ts'],outfile:test,bundle:true,platform:'node',format:'cjs',external:['electron'],target:'node24'});
  for(const mode of ['preview','submit']){
    const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('HUB_')||key==='ELECTRON_RUN_AS_NODE')delete env[key];
    Object.assign(env,{HUB_TRADE_TEST_ROOT:join(root,mode),HUB_TRADE_TEST_ENTRY:entry,HUB_TRADE_TEST_MODE:mode,HUB_TRADE_PREVIEW_ONLY:mode==='preview'?'1':'0'});
    const child=spawn(electronPath,[test],{env,stdio:'inherit',windowsHide:true});
    await new Promise((done,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('Native trade test timed out'));},30000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);code===0?done():reject(new Error('Native trade check failed'));});});
  }
}finally{await rm(verifiedRoot,{recursive:true,force:true});}
