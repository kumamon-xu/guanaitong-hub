import { createHash } from 'node:crypto';
import { readFileSync,statSync } from 'node:fs';
import { basename } from 'node:path';
import { DATABASE_VERSION } from '../electron/database-migrations.ts';

export function versionNotes(changelog,version){
  const sections=changelog.split(/^#\s+/m).filter(Boolean);
  const section=sections.find(value=>value.split(/\r?\n/,1)[0].trim()==='v'+version);
  if(!section)throw new Error('CHANGELOG.md must contain # v'+version);
  const notes=section.split(/\r?\n/).slice(1).join('\n').trim();
  if(!notes||notes.length>20000)throw new Error('Release notes are missing or too large');return notes;
}
export function artifactManifest({version,platform,arch,files,baseUrl,notes,signed=false,publishedAt=new Date().toISOString()}){
  if(!/^\d+\.\d+\.\d+$/.test(version)||!['win32','darwin'].includes(platform)||!['x64','arm64'].includes(arch))throw new Error('Invalid release version or target');
  const base=new URL(baseUrl.endsWith('/')?baseUrl:baseUrl+'/');if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw new Error('Release base must be public HTTPS without credentials or query');
  const extension=platform==='win32'?'.exe':'.zip';
  const assets=files.filter(file=>file.endsWith(extension));if(assets.length!==1)throw new Error('Expected exactly one installer for '+platform+'-'+arch);
  const file=assets[0],name=basename(file);
  if(!name.includes(version)||!name.includes(arch))throw new Error('Installer filename must include the actual version and architecture');
  const size=statSync(file).size;if(size<1||size>512*1024*1024)throw new Error('Installer size is invalid');
  const sha256=createHash('sha256').update(readFileSync(file)).digest('hex');
  return {format:'guanaitong-release',schemaVersion:1,version,publishedAt,notes,databaseVersion:DATABASE_VERSION,signed,downloads:{[platform+'-'+arch]:{url:new URL(encodeURIComponent(name),base).toString(),sha256,size}}};
}
export function mergeManifests(manifests,required=['win32-x64','darwin-arm64','darwin-x64']){
  if(!manifests.length)throw new Error('No platform manifests');
  const first=manifests[0],downloads={};
  for(const item of manifests){
    if(item.format!=='guanaitong-release'||item.schemaVersion!==1||item.version!==first.version||item.databaseVersion!==first.databaseVersion||item.notes!==first.notes||item.signed!==first.signed||!Number.isFinite(Date.parse(item.publishedAt)))throw new Error('Platform release metadata differs');
    for(const [target,asset] of Object.entries(item.downloads??{})){
      if(downloads[target]||!/^[a-f0-9]{64}$/.test(asset.sha256)||!Number.isSafeInteger(asset.size)||asset.size<1)throw new Error('Duplicate or invalid release asset');
      const url=new URL(asset.url);if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new Error('Invalid release URL');downloads[target]=asset;
    }
  }
  if(required.some(target=>!downloads[target])||Object.keys(downloads).some(target=>!required.includes(target)))throw new Error('Missing or unexpected target');
  return {...first,publishedAt:manifests.map(item=>item.publishedAt).sort().at(-1),downloads};
}
