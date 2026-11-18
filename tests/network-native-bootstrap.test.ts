import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {TRANSPORT_NATIVE_RELEASES} from '../server/network-native.js';

const require=createRequire(import.meta.url),tsx=pathToFileURL(require.resolve('tsx')).href;
const platform=process.platform+'-'+process.arch,release=TRANSPORT_NATIVE_RELEASES[platform];
const live=process.env.RELAY_NETWORK_NATIVE_LIVE==='1';
// The only networked case downloads one bounded publisher archive; the race reuses those exact
// pinned bytes. All module resolution, targets and generated code live in owned temporary trees.
let verifiedArchive:Buffer|undefined;

const childSource=String.raw`import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire, syncBuiltinESMExports} from 'node:module';
import {readFile, writeFile, readdir, stat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
const config=JSON.parse(await readFile(process.argv[2],'utf8'));
const realFetch=globalThis.fetch;
let requests=0, raceInjected=false;
function hash(value){return createHash('sha256').update(value).digest('hex');}
globalThis.fetch=async function(input,options){
 requests++;
 assert.equal(String(input),config.url);assert.equal(options.credentials,'omit');assert.ok(options.signal instanceof AbortSignal);
 if(config.scenario==='existing')throw Error('Existing invalid native binary must never cause a download');
 let bytes, sourceUrl=config.url;
 if(config.scenario==='missing'){
  const response=await realFetch(input,options);assert.equal(response.ok,true);sourceUrl=response.url;
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.byteLength;if(size>config.release.archiveBytes)throw Error('Publisher archive exceeds pinned bound');chunks.push(chunk);}
  bytes=Buffer.concat(chunks);assert.equal(bytes.length,config.release.archiveBytes);assert.equal(hash(bytes),config.release.archiveHash);
  await writeFile(config.archive,bytes,{flag:'wx'});
 }else bytes=await readFile(config.archive);
 const response=new Response(bytes,{status:200,headers:{'content-type':'application/gzip'}});
 Object.defineProperty(response,'url',{value:sourceUrl});return response;
};
if(config.scenario==='race'){
 const require=createRequire(import.meta.url), promises=require('node:fs/promises'), original=promises.link;
 promises.link=async function(from,to){
  if(to===config.target){assert.equal(raceInjected,false);await writeFile(to,config.invalid,{flag:'wx'});raceInjected=true;}
  return original.call(this,from,to);
 };
 syncBuiltinESMExports();
}
const {ensureNetworkNativeTransport}=await import(pathToFileURL(config.helper).href);
const attempts=await Promise.allSettled([ensureNetworkNativeTransport(),ensureNetworkNativeTransport(),ensureNetworkNativeTransport()]);
const bytes=await readFile(config.target), metadata=await stat(config.target);
const names=await readdir(dirname(config.target));
assert.equal(names.some(name=>name.startsWith('.relay-native-')),false,'Owned incomplete temporary files must be cleaned');
assert.equal(metadata.nlink,1);
if(config.scenario==='missing'){
 assert.ok(attempts.every(value=>value.status==='fulfilled'));assert.equal(requests,1);assert.equal(bytes.length,config.release.bytes);assert.equal(hash(bytes),config.release.hash);
}else{
 assert.ok(attempts.every(value=>value.status==='rejected'));assert.equal(bytes.toString(),config.invalid);
 assert.equal(requests,config.scenario==='race'?1:0);if(config.scenario==='race')assert.equal(raceInjected,true);
}
console.log(JSON.stringify({scenario:config.scenario,requests,raceInjected,statuses:attempts.map(value=>value.status),binaryHash:hash(bytes),temporaryFiles:names.filter(name=>name.startsWith('.relay-native-'))}));
`;

type Scenario='missing'|'existing'|'race';
async function isolated(scenario:Scenario):Promise<{scenario:Scenario;requests:number;raceInjected:boolean;statuses:string[];binaryHash:string;temporaryFiles:string[]}>{
 assert.ok(release,'A pinned host architecture is required');
 if(scenario==='race'&&!verifiedArchive)await isolated('missing');
 const fixture=await mkdtemp(join(tmpdir(),'relay-native-bootstrap-'));
 try{
  const packageRoot=join(fixture,'node_modules','@fails-components','webtransport-transport-http3-quiche'),helper=join(fixture,'server','network-native.ts'),target=join(packageRoot,'build','Release','webtransport.node'),archive=join(fixture,'publisher.tar.gz'),runner=join(fixture,'main.mjs'),configuration=join(fixture,'config.json');
  await mkdir(join(packageRoot,'lib'),{recursive:true});await mkdir(dirname(helper),{recursive:true});
  await writeFile(join(fixture,'package.json'),JSON.stringify({type:'module'}));
  await writeFile(join(packageRoot,'package.json'),JSON.stringify({name:'@fails-components/webtransport-transport-http3-quiche',version:'1.6.12',type:'module',exports:{'.':{node:'./lib/index.js'}}}));
  await writeFile(join(packageRoot,'lib','index.js'),'export {};\n');
  // Copy the production helper unchanged; createRequire(import.meta.url) must resolve the fake
  // package beside this copy, proving the actual bootstrap path rather than a rewritten helper.
  await writeFile(helper,await readFile(new URL('../server/network-native.ts',import.meta.url),'utf8'));
  const invalid='unexpected existing native file — preserve me';
  if(scenario==='existing'){await mkdir(dirname(target),{recursive:true});await writeFile(target,invalid,{flag:'wx'});}
  if(scenario==='race'){
   assert.ok(verifiedArchive,'Run the live missing-binary case first to obtain the exact verified publisher archive');
   await writeFile(archive,verifiedArchive,{flag:'wx'});
  }
  const url='https://github.com/fails-components/webtransport/releases/download/v1.6.12/webtransport-transport-http3-quiche-v1.6.12-napi-v6-'+platform+'.tar.gz';
  await writeFile(configuration,JSON.stringify({scenario,helper,target,archive,invalid,url,release}));
  await writeFile(runner,childSource);
  const env:NodeJS.ProcessEnv={...process.env,NODE_OPTIONS:''};delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  const output=await new Promise<string>((resolve,reject)=>execFile(process.execPath,['--import',tsx,runner,configuration],{cwd:fixture,env,windowsHide:true,timeout:45000,maxBuffer:512*1024},(error,stdout,stderr)=>error?reject(new Error('Isolated native bootstrap failed: '+error.message+'\n'+stderr+'\n'+stdout)):resolve(stdout)));
  if(scenario==='missing')verifiedArchive=await readFile(archive);
  return JSON.parse(output.trim().split(/\r?\n/).at(-1)!) as Awaited<ReturnType<typeof isolated>>;
 }finally{
  // Only the absolute mkdtemp result owned by this scenario is removed.
  assert.ok(fixture.startsWith(join(tmpdir(),'relay-native-bootstrap-')));await rm(fixture,{recursive:true,force:true});
 }
}

test('native bootstrap preserves an existing mismatched binary and performs no download',{skip:!release,timeout:60000},async()=>{
 const result=await isolated('existing');assert.deepEqual(result.statuses,['rejected','rejected','rejected']);assert.equal(result.requests,0);assert.deepEqual(result.temporaryFiles,[]);
});
test('missing native binary downloads its pinned publisher release without install scripts',{skip:!release||!live,timeout:60000},async()=>{
 const result=await isolated('missing');assert.deepEqual(result.statuses,['fulfilled','fulfilled','fulfilled']);assert.equal(result.requests,1);assert.equal(result.binaryHash,release!.hash);assert.deepEqual(result.temporaryFiles,[]);
});
test('native publication rejects a concurrent mismatched destination without replacing it',{skip:!release||!live,timeout:60000},async()=>{
 const result=await isolated('race');assert.equal(result.raceInjected,true);assert.deepEqual(result.statuses,['rejected','rejected','rejected']);assert.equal(result.requests,1);assert.deepEqual(result.temporaryFiles,[]);
});
