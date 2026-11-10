import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
test('portable recovery key requires the passphrase and rejects corrupted ciphertext',()=>{
 const folder=mkdtempSync(join(tmpdir(),'feedradar-recovery-'));
 const original=join(folder,'fixture.pem'),encrypted=join(folder,'key.json');
 const phrase='test-only recovery passphrase';
 const run=(mode:string,input:string,output:string,password=phrase)=>spawnSync(process.execPath,[resolve('scripts/recovery-key.mjs'),mode,input,output],{input:password,encoding:'utf8'});
 try{
  writeFileSync(original,'isolated private-key test fixture');
  assert.equal(run('encrypt',original,encrypted).status,0);
  assert.notEqual(run('decrypt',encrypted,join(folder,'wrong.pem'),'another wrong passphrase').status,0);
  assert.equal(run('decrypt',encrypted,join(folder,'correct.pem')).status,0);
  assert.deepEqual(readFileSync(join(folder,'correct.pem')),readFileSync(original));
  const changed=JSON.parse(readFileSync(encrypted,'utf8'));const bytes=Buffer.from(changed.data,'base64');bytes[0]^=1;changed.data=bytes.toString('base64');writeFileSync(encrypted,JSON.stringify(changed));
  assert.notEqual(run('decrypt',encrypted,join(folder,'corrupt.pem')).status,0);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
