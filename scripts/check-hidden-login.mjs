import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import electronPath from 'electron';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const folder=await mkdtemp(join(tmpdir(),'guanaitong-hidden-login-'));
try{
  const entry=join(folder,'check.cjs');
  await build({entryPoints:['tests/hidden-login.electron.ts'],outfile:entry,bundle:true,platform:'node',format:'cjs',external:['electron'],target:'node22'});
  const real=process.argv.includes('--real');
  const targetIndex=process.argv.indexOf('--card-id');
  const target=targetIndex>=0?process.argv[targetIndex+1]:'';
  const child=spawn(electronPath,[entry],{stdio:'inherit',env:{...process.env,HUB_VERIFY_REAL_LOGIN:real?'1':'0',HUB_VERIFY_CARD_ID:target??'',HUB_VERIFY_APP_DATA:real?'':join(folder,'appdata')}});
  process.exitCode=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',code=>done(code??1));});
}finally{await rm(folder,{recursive:true,force:true});}
