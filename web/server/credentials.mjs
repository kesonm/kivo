import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export class CredentialError extends Error {
  constructor(message,status=500){super(message);this.status=status;this.code='credential_error';}
}

export async function loadCredentialsKey(filename){
  if(!filename)throw new CredentialError('CREDENTIALS_KEY_FILE is required.');
  const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const stat=await handle.stat();
    if(!stat.isFile()||(stat.mode&0o077)!==0)throw new CredentialError('The credentials master key must be a private regular file (mode 0600 or 0400).');
    const key=await handle.readFile();
    if(key.length!==32)throw new CredentialError('The credentials master key must contain exactly 32 raw bytes.');
    return key;
  }finally{await handle.close();}
}

export function validateApiKey(value){
  if(typeof value!=='string'||!/^sk-[A-Za-z0-9_-]{16,1024}$/.test(value.trim()))throw new CredentialError('请填写有效格式的 OpenAI API 密钥（以 sk- 开头），不要填写 Bearer 前缀或空格。',400);
  return value.trim();
}

export function createCredentialCipher(masterKey){
  if(!Buffer.isBuffer(masterKey)||masterKey.length!==32)throw new CredentialError('A 32-byte credentials master key is required.');
  const key=Buffer.from(masterKey);
  const aad=userId=>Buffer.from(`codex-workspace:openai-api-key:v1:${userId}`,'utf8');
  return {
    encrypt(userId,value){
      const secret=validateApiKey(value),iv=randomBytes(12);
      const cipher=createCipheriv('aes-256-gcm',key,iv,{authTagLength:16});cipher.setAAD(aad(userId));
      const ciphertext=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
      return JSON.stringify({version:1,iv:iv.toString('base64url'),ciphertext:ciphertext.toString('base64url'),tag:cipher.getAuthTag().toString('base64url')});
    },
    decrypt(userId,envelope){
      try{
        const record=JSON.parse(envelope);
        if(record.version!==1)throw new Error('version');
        const iv=Buffer.from(record.iv,'base64url'),tag=Buffer.from(record.tag,'base64url'),ciphertext=Buffer.from(record.ciphertext,'base64url');
        if(iv.length!==12||tag.length!==16||!ciphertext.length||ciphertext.length>2048)throw new Error('envelope');
        const decipher=createDecipheriv('aes-256-gcm',key,iv,{authTagLength:16});decipher.setAAD(aad(userId));decipher.setAuthTag(tag);
        return validateApiKey(Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8'));
      }catch{throw new CredentialError('个人 API 密钥无法解密，请联系服务器管理员检查加密主密钥；不要覆盖现有密钥文件。');}
    },
  };
}
