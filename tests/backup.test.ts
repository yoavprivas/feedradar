import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
// @ts-expect-error Plain Node script shared with the Linux backup runner.
import {encryptBackup,decryptBackup} from '../scripts/backup-crypto.mjs';
test('portable backup encryption restores with a protected key and rejects tampering',()=>{
 const pair=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem',cipher:'aes-256-cbc',passphrase:'test-only-recovery-passphrase'}});
 const original=Buffer.from('PGDMP isolated fixture');
 const encrypted=encryptBackup(original,pair.publicKey);
 assert.deepEqual(decryptBackup(encrypted,pair.privateKey,'test-only-recovery-passphrase'),original);
 assert.throws(()=>decryptBackup(encrypted,pair.privateKey,'wrong-passphrase'));
 const altered=JSON.parse(encrypted.toString());const payload=Buffer.from(altered.data,'base64');payload[0]^=1;altered.data=payload.toString('base64');
 assert.throws(()=>decryptBackup(Buffer.from(JSON.stringify(altered)),pair.privateKey,'test-only-recovery-passphrase'));
});
