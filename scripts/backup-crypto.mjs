import {randomBytes,createCipheriv,createDecipheriv,publicEncrypt,privateDecrypt,constants} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
export function encryptBackup(data,publicKey) {
 const key=randomBytes(32),iv=randomBytes(12);
 try {
  const cipher=createCipheriv('aes-256-gcm',key,iv);
  const ciphertext=Buffer.concat([cipher.update(data),cipher.final()]);
  const wrapped=publicEncrypt({key:publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key);
  return Buffer.from(JSON.stringify({version:1,key:wrapped.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:ciphertext.toString('base64')}));
 } finally {key.fill(0);}
}
export function decryptBackup(data,privateKey,passphrase) {
 const value=JSON.parse(data.toString());
 if(value.version!==1) throw new Error('Unsupported backup version');
 const key=privateDecrypt({key:privateKey,passphrase,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(value.key,'base64'));
 try {
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(value.iv,'base64'));
  decipher.setAuthTag(Buffer.from(value.tag,'base64'));
  return Buffer.concat([decipher.update(Buffer.from(value.data,'base64')),decipher.final()]);
 } finally {key.fill(0);}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 const [mode,input,keyFile,output]=process.argv.slice(2);
 if(!['encrypt','decrypt'].includes(mode)||!output) throw new Error('Usage: backup-crypto.mjs encrypt|decrypt input key-file output');
 const data=readFileSync(input);
 try {writeFileSync(output,mode==='encrypt'?encryptBackup(data,readFileSync(keyFile)):decryptBackup(data,readFileSync(keyFile),process.env.BACKUP_RECOVERY_PASSPHRASE),{flag:'wx',mode:0o600});}
 finally {data.fill(0);}
}
