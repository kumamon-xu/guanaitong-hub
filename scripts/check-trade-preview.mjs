import { build } from 'esbuild';
import electronPath from 'electron';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

// This runner has no submit mode. Real credentials exist only in memory and are
// passed once over an authenticated loopback channel, never argv, env or a file.
const root=await mkdtemp(join(tmpdir(),'gat-trade-preview-'));
const verifiedRoot=resolve(root);if(!verifiedRoot.startsWith(resolve(tmpdir())+sep)||!verifiedRoot.split(sep).at(-1).startsWith('gat-trade-preview-'))throw new Error('临时预览目录无效');
let server;
try{
  await mkdir('.private/trade-preview',{recursive:true,mode:0o700});
  if(process.stdin.isTTY)process.stdin.setRawMode(true);
  console.log('等待一行 JSON 卡片凭据；不回显。真实测试最多到结算预览，禁止最终提交。');
  let body=await new Promise((done,reject)=>{let value='';const receive=chunk=>{value+=chunk;if(value.length>10000){process.stdin.off('data',receive);reject(new Error('输入过大'));}if(/[\r\n]/.test(value)){process.stdin.off('data',receive);process.stdin.pause();done(value.trim());}};process.stdin.on('data',receive);process.stdin.resume();});
  let input;try{input=JSON.parse(body);}catch{throw new Error('凭据 JSON 格式无效，未执行官网请求');}
  if(!input||typeof input!=='object'||!/^\d{6,32}$/.test(input.number)||typeof input.password!=='string'||!input.password||Object.keys(input).some(key=>!['number','password'].includes(key)))throw new Error('测试只接受一张卡的卡号和密码');
  const token=randomBytes(32).toString('hex');
  server=createServer((request,response)=>{if(request.headers.authorization!==`Bearer ${token}`||!body){response.writeHead(403).end();return;}response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(body);body='';server.close();});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const entry=join(root,'preview.cjs');await build({entryPoints:['tests/trade-preview.electron.ts'],outfile:entry,bundle:true,platform:'node',format:'cjs',external:['electron'],target:'node24'});
  const env={...process.env};for(const name of Object.keys(env))if(name.startsWith('HUB_')||name==='ELECTRON_RUN_AS_NODE')delete env[name];
  Object.assign(env,{HUB_TRADE_LIVE_ROOT:root,HUB_TRADE_LIVE_ENTRY:resolve('dist-electron/main.cjs'),HUB_TRADE_LIVE_PORT:String(server.address().port),HUB_TRADE_LIVE_TOKEN:token,HUB_TRADE_PREVIEW_ONLY:'1'});
  const child=spawn(electronPath,[entry],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  child.stdout.on('data',chunk=>{for(const line of String(chunk).split(/\r?\n/))if(line.startsWith('PREVIEW_EVENT '))console.log(line.slice(14));});
  let errors='';child.stderr.on('data',chunk=>{errors+=String(chunk);if(errors.length>100000)errors=errors.slice(-100000);});
  await new Promise((done,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('真实预览测试超时'));},300000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);code===0?done():reject(new Error('真实预览未完成，详见被忽略目录中的报告'));});});
}finally{
  server?.closeAllConnections();server?.close();if(process.stdin.isTTY)process.stdin.setRawMode(false);
  await rm(verifiedRoot,{recursive:true,force:true});
}
