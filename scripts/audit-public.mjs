import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';

const roots=new Set(['.github','.githooks','assets','docs','electron','scripts','src','tests']);
const rootFiles=new Set(['.gitignore','.gitattributes','README.md','CHANGELOG.md','SECURITY.md','CONTRIBUTING.md','package.json','package-lock.json','tsconfig.json','vite.config.ts','eslint.config.mjs','index.html']);
const binaries=new Set(['assets/icon.png','assets/icon.icns','docs/images/catalog-demo.png']);
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',maxBuffer:16*1024*1024});
const files=git('ls-files','--cached','-z').split('\0').filter(Boolean);
if(!files.length)throw new Error('Git 暂存区没有可审查文件');
const violations=[];
const forbidden=/(?:^|\/)(?:node_modules|dist|dist-electron|release|output|artifacts|coverage|backups|vault[^/]*|\.private|\.local|\.research|\.playwright-cli|\.env[^/]*|\.ssh|\.DS_Store|\._[^/]*|state\.json|addresses\.enc|result\.json|latest\.json)(?:\/|$)|\.(?:db|sqlite\d*|enc|gathub|gataddr|pfx|p12|pem|key|jks|keystore|exe|dll|dylib|so|node|asar|zip|7z|log|tmp|bak|map|blockmap)(?:-|$)/i;
const contentRules=[
  ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['access-token',/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/],
  ['numeric-password',/\b(?:password|passwd|cardPassword)\s*[:=]\s*["']\d{6,128}["']/],
  ['personal-email',/[A-Za-z0-9.+_-]+@privaterelay\.appleid\.com/i],
  ['personal-home-path',/[A-Za-z]:[\\/](?:Users|Project)[\\/][A-Za-z0-9._-]+/i],
];
let bytes=0;
for(const file of files){
  const parts=file.split('/');
  if(/[\r\n\0]/.test(file)||(!roots.has(parts[0])&&!rootFiles.has(file))||forbidden.test(file)){violations.push({file,reason:'forbidden-path'});continue;}
  const object=execFileSync('git',['show',':'+file],{maxBuffer:16*1024*1024});bytes+=object.length;
  if(binaries.has(file))continue;
  if(!['.ts','.tsx','.css','.md','.json','.mjs','.py','.html','.yml','.yaml','.cmd','.command'].includes(posix.extname(file))&&!['.gitignore','.gitattributes','.githooks/pre-commit'].includes(file)){violations.push({file,reason:'unreviewed-file-type'});continue;}
  if(object.includes(0)){violations.push({file,reason:'unexpected-binary'});continue;}
  const text=object.toString('utf8');
  for(const [reason,pattern] of contentRules){const match=pattern.exec(text);if(match)violations.push({file,reason,line:text.slice(0,match.index).split('\n').length});}
  if(file==='README.md'||file.startsWith('docs/')){
    for(const [reason,pattern] of [
      ['account-tail',/(?:卡尾号|尾号)\s*[：:·]?\s*\d{4,12}/],
      ['private-account-statistics',/(?:余额合计|已确认余额合计|合计余额)\s*\d/],
      ['account-cms-link',/cms\.guanaitong\.com\/product\/\d+\/\d+\.html/],
    ]){const match=pattern.exec(text);if(match)violations.push({file,reason,line:text.slice(0,match.index).split('\n').length});}
  }
}
console.log(JSON.stringify({ok:violations.length===0,files:files.length,bytes,reviewedBinaries:files.filter(file=>binaries.has(file)),violations},null,2));
if(violations.length)process.exitCode=1;
