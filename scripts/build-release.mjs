import { build,Platform } from 'electron-builder';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync,writeFileSync } from 'node:fs';
import { basename,resolve } from 'node:path';

const platform=process.argv[2];
if(!['win','mac'].includes(platform))throw new Error('Usage: node scripts/build-release.mjs win|mac [--signed]');
const signed=process.argv.includes('--signed')||process.env.REQUIRE_SIGNED==='true';
if(signed&&platform==='win'&&!process.env.WIN_CSC_LINK&&!process.env.CSC_LINK)throw new Error('Signed Windows release requires WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD in the environment.');
if(signed&&platform==='mac'&&!process.env.CSC_LINK&&!process.env.CSC_NAME)throw new Error('Signed macOS release requires CSC_LINK/CSC_KEY_PASSWORD or CSC_NAME in the environment.');
const pkg=JSON.parse(readFileSync('package.json','utf8'));
// Run the same build stages with Node directly; Windows command scripts need no shell.
execFileSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'--noEmit'],{stdio:'inherit'});
execFileSync(process.execPath,[resolve('node_modules/vite/bin/vite.js'),'build'],{stdio:'inherit'});
execFileSync(process.execPath,[resolve('scripts/build-electron.mjs')],{stdio:'inherit'});
const files=await build({targets:(platform==='win'?Platform.WINDOWS:Platform.MAC).createTarget(platform==='win'?'nsis':'zip'),publish:'never',config:{forceCodeSigning:signed,...(platform==='mac'?{mac:{target:'zip'}}:{})}});
const assets=files.filter(path=>platform==='win'?path.endsWith('.exe'):path.endsWith('.zip'));
const checksums=assets.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}));
writeFileSync(`release/SHA256SUMS-${platform}.txt`,checksums.map(item=>`${item.sha256}  ${basename(item.path)}`).join('\n')+'\n');
const base=process.env.RELEASE_BASE_URL;
if(base){
  const url=new URL(base.endsWith('/')?base:base+'/');if(url.protocol!=='https:'||url.username||url.password)throw new Error('RELEASE_BASE_URL must be public HTTPS.');
  const downloads={};
  for(const item of checksums){const name=basename(item.path);const arch=/arm64/i.test(name)?'arm64':/ia32/i.test(name)?'ia32':'x64';downloads[`${platform==='win'?'win32':'darwin'}-${arch}`]={url:new URL(encodeURIComponent(name),url).toString(),sha256:item.sha256};}
  const notes=readFileSync('CHANGELOG.md','utf8');
  writeFileSync(`release/release-${platform}.json`,JSON.stringify({format:'guanaitong-release',schemaVersion:1,version:pkg.version,publishedAt:new Date().toISOString(),notes,downloads},null,2));
}
console.log(JSON.stringify({version:pkg.version,platform,signed,artifacts:assets,manifest:!!base}));
