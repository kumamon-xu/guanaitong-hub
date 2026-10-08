import { readdirSync,readFileSync,writeFileSync,createReadStream,statSync } from 'node:fs';
import { resolve,join,basename } from 'node:path';
import { createHash } from 'node:crypto';
import { mergeManifests } from './release-metadata.mjs';

const directory=resolve(process.argv[2]??'release');
const files=readdirSync(directory).filter(name=>/^release-(?:win32|darwin)-(?:x64|arm64)\.json$/.test(name));
const manifest=mergeManifests(files.map(name=>JSON.parse(readFileSync(join(directory,name),'utf8'))));
for(const asset of Object.values(manifest.downloads)){
  const name=decodeURIComponent(new URL(asset.url).pathname.split('/').at(-1));
  if(!name||basename(name)!==name||/[\\/]/.test(name))throw new Error('Unsafe installer filename');
  const file=join(directory,name),stat=statSync(file);
  if(!stat.isFile()||stat.size!==asset.size)throw new Error('Installer is missing or size differs: '+name);
  const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
  if(hash.digest('hex')!==asset.sha256)throw new Error('Installer checksum differs: '+name);
}
writeFileSync(join(directory,'release.json'),JSON.stringify(manifest,null,2)+'\n');
const checksums=Object.values(manifest.downloads).map(asset=>`${asset.sha256}  ${decodeURIComponent(new URL(asset.url).pathname.split('/').at(-1))}`).join('\n')+'\n';
writeFileSync(join(directory,'SHA256SUMS.txt'),checksums);
writeFileSync(join(directory,'release-notes.md'),manifest.notes+'\n');
console.log(JSON.stringify({version:manifest.version,targets:Object.keys(manifest.downloads),manifest:'release.json'}));
