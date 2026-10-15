'use strict';
// Local dependency build only. No credentials, repository, fixtures or business
// records are in the Docker context. npm pack must have fetched the pinned CLI.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const policy=require('./codex-wire');
const output=path.resolve(process.argv[2]||'data/environment-agent-demo/codex-sdk-sol-high');
const dir=path.join(output,'runtime-build');
fs.mkdirSync(dir,{recursive:true});
const tar=`openai-codex-${policy.VERSION}-linux-x64.tgz`;
if(!fs.existsSync(path.join(dir,tar)))fs.copyFileSync(path.resolve('data/environment-agent-demo/codex-sdk-integration/runtime-build',tar),path.join(dir,tar));
if(!fs.existsSync(path.join(dir,tar)))throw Error('Fetch the pinned official Linux npm package before building.');
const sdk=path.resolve('node_modules/@openai/codex-sdk');
if(JSON.parse(fs.readFileSync(path.join(sdk,'package.json'))).version!==policy.VERSION)throw Error('SDK_VERSION_MISMATCH');
fs.copyFileSync(path.join(sdk,'dist/index.js'),path.join(dir,'codex-sdk.mjs'));
fs.copyFileSync(path.join(__dirname,'codex-container.js'),path.join(dir,'codex-container.cjs'));
fs.copyFileSync(path.join(__dirname,'codex-models.js'),path.join(dir,'codex-models.cjs'));
fs.writeFileSync(path.join(dir,'codex-operator-instructions.txt'),require('./codex-operator-instructions'));
const base=JSON.parse(fs.readFileSync('data/environment-agent-demo/sandbox-certificate.json')).image;
const localTag='stockchief-codex-offline-base:'+base.slice(7);
execFileSync('docker',['tag',base,localTag],{windowsHide:true});
fs.writeFileSync(path.join(dir,'Dockerfile'),`FROM ${localTag}\nUSER root\nCOPY ${tar} /opt/codex.tgz\nRUN mkdir -p /opt/codex /opt/stockchief && tar -xzf /opt/codex.tgz -C /opt/codex --strip-components=1 && rm /opt/codex.tgz\nCOPY codex-sdk.mjs codex-container.cjs codex-models.cjs codex-operator-instructions.txt /opt/stockchief/\nUSER 1000:1000\n`);
execFileSync('docker',['build','--network=none','--pull=false','--iidfile',path.join(dir,'image-id'),dir],{stdio:'inherit',windowsHide:true});
const image=fs.readFileSync(path.join(dir,'image-id'),'utf8').trim();
const version=execFileSync('docker',['run','--rm','--network','none','--read-only','--entrypoint','/opt/codex/vendor/x86_64-unknown-linux-musl/bin/codex',image,'--version'],{encoding:'utf8',windowsHide:true}).trim();
if(!version.endsWith(policy.VERSION))throw Error('CLI_VERSION_MISMATCH');
const result={image,sdkVersion:policy.VERSION,cli:version,profile:policy.PROFILE.id,model:policy.MODEL,effort:policy.EFFORT};
fs.writeFileSync(path.join(dir,'../runtime.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
