import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SecretVault, type SecretProtector, type SecretAcl } from '../server/secret-vault.js';

function dependencies() {
  const key = randomBytes(32);
  const protector: SecretProtector = {
    async protect(data, purpose) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(purpose));
      return Buffer.concat([iv, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
    },
    async unprotect(data, purpose) {
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0,12));
      cipher.setAAD(Buffer.from(purpose)); cipher.setAuthTag(data.subarray(-16));
      return Buffer.concat([cipher.update(data.subarray(12,-16)), cipher.final()]);
    }
  };
  let valid = true;
  const acl: SecretAcl = { async secureDirectory() {}, async verify() { if (!valid) throw Error('unsafe fixture ACL'); } };
  return { protector, acl, corruptAcl() { valid=false; } };
}
async function fixture() { return mkdtemp(join(tmpdir(),'relay-vault-')); }

test('encrypted secrets survive restart without plaintext files and remove cleanly', async () => {
  const dir=await fixture(), deps=dependencies(), secret='fixture-key-DO-NOT-STORE-PLAINTEXT';
  let vault=new SecretVault(dir,deps);
  try {
    assert.equal(await vault.has('typesafe-api-key'),false);
    await vault.set('typesafe-api-key',secret); assert.equal(await vault.get('typesafe-api-key'),secret);
    const files=await readdir(join(dir,'secure-credentials')); assert.equal(files.length,1);
    assert.equal((await readFile(join(dir,'secure-credentials',files[0]))).includes(Buffer.from(secret)),false);
    vault.close(); vault=new SecretVault(dir,deps); assert.equal(await vault.get('typesafe-api-key'),secret);
    await vault.remove('typesafe-api-key'); assert.equal(await vault.get('typesafe-api-key'),null);
    assert.deepEqual(await readdir(join(dir,'secure-credentials')),[]);
    vault.close(); await assert.rejects(vault.get('typesafe-api-key'),/closed/);
  } finally { vault.close(); await rm(dir,{recursive:true,force:true}); }
});

test('tampered ciphertext, unsafe ACL, links and invalid names fail closed', async () => {
  const dir=await fixture(), deps=dependencies(), vault=new SecretVault(dir,deps);
  try {
    await vault.set('typesafe-api-key','fixture-secret');
    const file=join(dir,'secure-credentials',(await readdir(join(dir,'secure-credentials')))[0]);
    const saved=await readFile(file); await writeFile(file, saved.toString().replace(/ciphertext":"./,'ciphertext":"!'));
    await assert.rejects(vault.get('typesafe-api-key'),/credential/i);
    await writeFile(file,saved); deps.corruptAcl(); await assert.rejects(vault.get('typesafe-api-key'),/credential/i);
    await assert.rejects(vault.set('../escape','secret'),/name/i);
  } finally {vault.close();await rm(dir,{recursive:true,force:true});}
  const dir2=await fixture(), deps2=dependencies(), vault2=new SecretVault(dir2,deps2);
  try {
    await vault2.set('typesafe-api-key','fixture-secret');
    const file=join(dir2,'secure-credentials',(await readdir(join(dir2,'secure-credentials')))[0]);
    await link(file,join(dir2,'copy')); await assert.rejects(vault2.get('typesafe-api-key'),/credential/i);
  } finally {vault2.close();await rm(dir2,{recursive:true,force:true});}
});

test('rejects directory junctions and does not write through them', async () => {
  const dir=await fixture(), target=await fixture(), deps=dependencies();
  try {
    await symlink(target,join(dir,'secure-credentials'),process.platform==='win32'?'junction':'dir');
    const vault=new SecretVault(dir,deps); await assert.rejects(vault.set('typesafe-api-key','secret'),/credential/i);
    assert.deepEqual(await readdir(target),[]); vault.close();
  } finally {await rm(dir,{recursive:true,force:true});await rm(target,{recursive:true,force:true});}
});

test('checks authority after asynchronous protection and leaves no replaced or temporary secret', async () => {
  const dir=await fixture(), deps=dependencies(), vault=new SecretVault(dir,deps);
  try {
    await vault.set('typesafe-api-key','old');
    await assert.rejects(vault.set('typesafe-api-key','new',()=>{throw Error('request expired');}),/expired/);
    assert.equal(await vault.get('typesafe-api-key'),'old');
    assert.equal((await readdir(join(dir,'secure-credentials'))).length,1);
    let resume!:()=>void;
    const blocked=new SecretVault(dir,{...deps,protector:{...deps.protector,async protect(data,purpose){await new Promise<void>(r=>{resume=r;});return deps.protector.protect(data,purpose);}}});
    const pending=blocked.set('typesafe-api-key','never-written');
    while(!resume) await new Promise(r=>setTimeout(r,5)); blocked.close(); resume();
    await assert.rejects(pending,/closed/); assert.equal(await vault.get('typesafe-api-key'),'old');
  } finally {vault.close();await rm(dir,{recursive:true,force:true});}
});

test('unsupported platform has no implicit plaintext fallback',async()=>{
  const dir=await fixture(), vault=new SecretVault(dir,{platform:'linux'});
  try {assert.deepEqual(vault.availability(),{available:false,protection:'unavailable'});await assert.rejects(vault.set('typesafe-api-key','fixture'),/unavailable/i);assert.deepEqual(await readdir(dir),[]);}
  finally{vault.close();await rm(dir,{recursive:true,force:true});}
});

test('real Windows DPAPI ciphertext restarts, detects tamper and rejects widened ACL',{skip:process.platform!=='win32',timeout:120000},async()=>{
  const dir=await fixture(), secret='relay-DPAPI-fixture-'+randomBytes(12).toString('hex');let vault=new SecretVault(dir);
  try {
    assert.deepEqual(vault.availability(),{available:true,protection:'windows-dpapi'});
    await vault.set('typesafe-api-key',secret);vault.close();vault=new SecretVault(dir);
    assert.equal(await vault.get('typesafe-api-key'),secret);
    const file=join(dir,'secure-credentials',(await readdir(join(dir,'secure-credentials')))[0]), bytes=await readFile(file);
    assert.equal(bytes.includes(Buffer.from(secret)),false);
    const envelope=JSON.parse(bytes.toString()); const cipher=Buffer.from(envelope.ciphertext,'base64');cipher[Math.floor(cipher.length/2)]^=1;envelope.ciphertext=cipher.toString('base64');await writeFile(file,JSON.stringify(envelope));
    await assert.rejects(vault.get('typesafe-api-key'),/credential/i);await writeFile(file,bytes);
    const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
    await promisify(execFile)('icacls.exe',[file,'/grant','*S-1-1-0:R'],{windowsHide:true});
    await assert.rejects(vault.get('typesafe-api-key'),/credential/i);
  }finally{vault.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
