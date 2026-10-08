import { build } from 'esbuild';
import electronPath from 'electron';
import { spawn } from 'node:child_process';
import { mkdir,mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve,join,sep } from 'node:path';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

// Credentials arrive through stdin and stay in memory. No credentials in source, argv or files.
const directory=await mkdtemp(join(tmpdir(),'gat-live-runner-'));
function verifiedTemporary(path){const resolved=resolve(path);if(!resolved.startsWith(resolve(tmpdir())+sep)||!resolved.split(sep).at(-1).startsWith('gat-live-runner-'))throw new Error('临时目录路径核对失败');return resolved;}
let inputServer;
const output=resolve('.private/live-test');await mkdir(output,{recursive:true,mode:0o700});
if(process.stdin.isTTY)process.stdin.setRawMode(true);
console.log('等待一行 JSON 卡片凭据；不会回显或保存明文。');
let input=await new Promise((resolve,reject)=>{
  let value='';const data=chunk=>{value+=chunk.toString();if(Buffer.byteLength(value)>20000){cleanup();reject(new Error('输入过大'));return;}if(value.includes('\n')||value.includes('\r')){cleanup();resolve(value.trim());}};
  const end=()=>{cleanup();resolve(value);};
  const cleanup=()=>{process.stdin.removeListener('data',data);process.stdin.removeListener('end',end);process.stdin.pause();};
  process.stdin.on('data',data);process.stdin.once('end',end);process.stdin.resume();
});
let payload;try{payload=JSON.parse(input);}catch{throw new Error('输入必须为 JSON');}
if(!payload.inspect&&(!Array.isArray(payload.cards)||!payload.cards.length))throw new Error('缺少卡片输入');
const entry=join(directory,'live.cjs');
try{
  await build({entryPoints:['tests/live.electron.ts'],outfile:entry,bundle:true,platform:'node',format:'cjs',external:['electron'],target:'node24'});
  const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('HUB_')||key==='ELECTRON_RUN_AS_NODE')delete env[key];
  // Windows GUI Electron does not consistently expose stdin. A one-use loopback channel
  // transfers the in-memory payload without a plaintext file or credentials in argv/env.
  const token=randomBytes(32).toString('hex');let inputBody=JSON.stringify(payload);
  const server=createServer((request,response)=>{
    if(request.headers.authorization!==`Bearer ${token}`||!inputBody){response.writeHead(403);response.end();return;}
    response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','Connection':'close'});response.end(inputBody);inputBody='';server.close();
  });
  inputServer=server;
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  Object.assign(env,{HUB_LIVE_ENTRY:resolve('dist-electron/main.cjs'),HUB_LIVE_REPORT:join(output,'result.json'),HUB_LIVE_INPUT_PORT:String(port),HUB_LIVE_INPUT_TOKEN:token});
  const child=spawn(electronPath,[entry],{env,stdio:['pipe','pipe','pipe'],windowsHide:true});
  let buffer='',errors='';
  child.stdout.on('data',chunk=>{buffer+=chunk.toString();let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);if(line.startsWith('LIVE_EVENT ')){console.log(line.slice(11));}}});
  child.stderr.on('data',chunk=>{errors+=chunk.toString();if(errors.length>100000)errors=errors.slice(-100000);});
  child.stdin.end();input='';payload=null;
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});
  server.close();inputBody='';
  console.log(JSON.stringify({type:'runner-finished',exitCode:code,report:join(output,'result.json')}));
  if(code)process.exitCode=1;
}finally{inputServer?.closeAllConnections();inputServer?.close();if(process.stdin.isTTY)process.stdin.setRawMode(false);await rm(verifiedTemporary(directory),{recursive:true,force:true});}
