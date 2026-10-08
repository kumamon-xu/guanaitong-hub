import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync,copyFileSync,readFileSync,statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join,resolve,sep } from 'node:path';
import { afterEach,test } from 'node:test';
import { artifactManifest,mergeManifests,versionNotes,signingEnvironment } from '../scripts/release-metadata.mjs';

const folders=[];afterEach(()=>{for(const folder of folders.splice(0)){const path=resolve(folder);assert.ok(path.startsWith(resolve(tmpdir())+sep)&&path.split(sep).at(-1).startsWith('gat-release-metadata-'));rmSync(path,{recursive:true,force:true});}});
function manifest(platform,arch,patch={}){
  const folder=mkdtempSync(join(tmpdir(),'gat-release-metadata-'));folders.push(folder);const file=join(folder,`guanaitong-hub-0.6.1-${arch}.${platform==='win32'?'exe':'zip'}`);writeFileSync(file,'synthetic package bytes');
  return artifactManifest({version:'0.6.1',platform,arch,files:[file],baseUrl:'https://github.com/example/project/releases/download/v0.6.1/',notes:'本版说明',publishedAt:'2026-10-08T00:00:00.000Z',...patch});
}
test('release notes include only the matching version',()=>{
  assert.equal(versionNotes('# v0.6.1\n\n- 新版\n\n# v0.6.0\n\n- 旧版','0.6.1'),'- 新版');assert.throws(()=>versionNotes('# v0.6.0\nold','0.6.1'),/contain/);
});
test('empty CI signing secrets are absent and unsigned builds never use supplied certificates',()=>{
  assert.deepEqual(signingEnvironment({CSC_LINK:'',WIN_CSC_LINK:'',KEEP:'yes'},true),{KEEP:'yes'});
  const original={CSC_LINK:'fixture-certificate',WIN_CSC_LINK:'fixture-windows-certificate',CSC_KEY_PASSWORD:'fixture-password',KEEP:'yes'};
  assert.deepEqual(signingEnvironment(original,false),{KEEP:'yes',CSC_IDENTITY_AUTO_DISCOVERY:'false'});assert.equal(original.CSC_LINK,'fixture-certificate');assert.equal(signingEnvironment(original,true).WIN_CSC_LINK,original.WIN_CSC_LINK);
});
test('multi-platform manifests use explicit architecture and merge all three installers',()=>{
  const parts=[manifest('win32','x64'),manifest('darwin','arm64'),manifest('darwin','x64')],merged=mergeManifests(parts);assert.deepEqual(Object.keys(merged.downloads).sort(),['darwin-arm64','darwin-x64','win32-x64']);assert.equal(merged.databaseVersion,3);for(const asset of Object.values(merged.downloads)){assert.equal(asset.size,23);assert.match(asset.sha256,/^[0-9a-f]{64}$/);}
});
test('release assembly refuses missing, duplicate, mismatched and unsigned-claiming platforms',()=>{
  const windows=manifest('win32','x64'),arm=manifest('darwin','arm64'),intel=manifest('darwin','x64');assert.throws(()=>mergeManifests([windows,arm]),/Missing/);assert.throws(()=>mergeManifests([windows,arm,intel,windows]),/Duplicate/);assert.throws(()=>mergeManifests([windows,arm,{...intel,version:'0.7.0'}]),/differs/);assert.throws(()=>mergeManifests([windows,arm,{...intel,signed:true}]),/differs/);
});
test('manifest creation rejects arbitrary files, invalid targets and secret-bearing base URLs',()=>{
  assert.throws(()=>manifest('win32','x64',{files:[]}),/one installer/);assert.throws(()=>manifest('win32','x64',{baseUrl:'https://user:secret@example.com/'}),/HTTPS/);assert.throws(()=>manifest('win32','x64',{arch:'unknown'}),/target/);assert.throws(()=>manifest('win32','x64',{version:'0.7.0'}),/filename/);
});
test('assembly verifies actual installer bytes before creating a publication manifest',()=>{
  const parts=[manifest('win32','x64'),manifest('darwin','arm64'),manifest('darwin','x64')],sources=folders.slice(-3);
  const folder=mkdtempSync(join(tmpdir(),'gat-release-metadata-'));folders.push(folder);
  parts.forEach((part,i)=>{const target=Object.keys(part.downloads)[0],name=decodeURIComponent(new URL(Object.values(part.downloads)[0].url).pathname.split('/').at(-1));copyFileSync(join(sources[i],name),join(folder,name));writeFileSync(join(folder,'release-'+target+'.json'),JSON.stringify(part));});
  execFileSync(process.execPath,['scripts/merge-release.mjs',folder],{stdio:'pipe'});assert.equal(Object.keys(JSON.parse(readFileSync(join(folder,'release.json'),'utf8')).downloads).length,3);
  const asset=join(folder,'guanaitong-hub-0.6.1-x64.exe');writeFileSync(asset,Buffer.alloc(statSync(asset).size,0));assert.throws(()=>execFileSync(process.execPath,['scripts/merge-release.mjs',folder],{stdio:'pipe'}),error=>String(error.stderr).includes('checksum differs'));
});
