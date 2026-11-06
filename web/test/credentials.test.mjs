import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm,writeFile,chmod,symlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createCredentialCipher,loadCredentialsKey,validateApiKey} from '../server/credentials.mjs';

const fakeKey='sk-project-test-only-aaaaaaaaaaaaaaaaaaaaaaaaAAAA';
test('AES-GCM uses random nonces, authenticates user identity, and detects tampering',()=>{
  const cipher=createCredentialCipher(randomBytes(32)),a=cipher.encrypt('alice',fakeKey),b=cipher.encrypt('alice',fakeKey);
  assert.notEqual(a,b);assert.ok(!a.includes(fakeKey));assert.equal(cipher.decrypt('alice',a),fakeKey);assert.throws(()=>cipher.decrypt('bob',a));
  const envelope=JSON.parse(a);const bytes=Buffer.from(envelope.ciphertext,'base64url');bytes[0]^=1;envelope.ciphertext=bytes.toString('base64url');assert.throws(()=>cipher.decrypt('alice',JSON.stringify(envelope)));
});
test('master key must be a private regular file containing exactly 32 raw bytes',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'cw-master-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'master'),key=randomBytes(32);
  await writeFile(file,key,{mode:0o600});assert.deepEqual(await loadCredentialsKey(file),key);
  await chmod(file,0o644);await assert.rejects(loadCredentialsKey(file),/private regular file/);
  await chmod(file,0o600);await writeFile(file,key.toString('hex'));await assert.rejects(loadCredentialsKey(file),/32 raw bytes/);
  await symlink(file,path.join(dir,'link'));await assert.rejects(loadCredentialsKey(path.join(dir,'link')));
});
test('API key format validation never echoes rejected input',()=>{
  assert.equal(validateApiKey(` ${fakeKey} `),fakeKey);for(const value of ['Bearer '+fakeKey,'not-a-key','sk-short',null])assert.throws(()=>validateApiKey(value),e=>e.status===400&&!e.message.includes(String(value)));
});
