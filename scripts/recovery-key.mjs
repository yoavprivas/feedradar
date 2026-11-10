import {readFileSync,writeFileSync} from 'node:fs';
import {randomBytes,scryptSync,createCipheriv,createDecipheriv,timingSafeEqual} from 'node:crypto';
const [mode,input,output]=process.argv.slice(2);
if(!['encrypt','decrypt'].includes(mode)||!output)throw new Error('Usage: recovery-key.mjs encrypt|decrypt input output; passphrase on stdin');
let passphrase='';for await(const part of process.stdin)passphrase+=part;
if(passphrase.length<16||passphrase.length>256)throw new Error('Recovery passphrase must have 16-256 characters');
function key(salt){return scryptSync(passphrase,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});}
function decrypt(value){
 if(value.version!==1||value.kdf!=='scrypt-32768-8-1')throw new Error('Unknown recovery format');
 const derived=key(Buffer.from(value.salt,'base64'));
 try{const cipher=createDecipheriv('aes-256-gcm',derived,Buffer.from(value.iv,'base64'));cipher.setAuthTag(Buffer.from(value.tag,'base64'));return Buffer.concat([cipher.update(Buffer.from(value.data,'base64')),cipher.final()]);}finally{derived.fill(0);}
}
if(mode==='encrypt'){
 const plain=readFileSync(input),salt=randomBytes(16),iv=randomBytes(12),derived=key(salt);
 try{const cipher=createCipheriv('aes-256-gcm',derived,iv);const data=Buffer.concat([cipher.update(plain),cipher.final()]);const value={version:1,kdf:'scrypt-32768-8-1',salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')};const check=decrypt(value);if(!timingSafeEqual(check,plain))throw new Error('Recovery verification failed');check.fill(0);writeFileSync(output,JSON.stringify(value),{flag:'wx',mode:0o600});}finally{derived.fill(0);plain.fill(0);}
}else{const plain=decrypt(JSON.parse(readFileSync(input,'utf8')));try{writeFileSync(output,plain,{flag:'wx',mode:0o600});}finally{plain.fill(0);}}
console.log('Recovery file processed and verified.');
