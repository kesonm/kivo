import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,symlink,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createProjects} from '../server/projects.mjs';

async function fixture(t){const dataDir=await mkdtemp(path.join(tmpdir(),'cw-files-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));const projects=createProjects({dataDir,hostDataDir:dataDir,testGitMode:'host'});const id=randomUUID();await projects.initialize(id,'Fixture');return {dataDir,projects,id};}

test('files are constrained to project, including symlinks and Git internals',async t=>{
  const {dataDir,projects,id}=await fixture(t);await writeFile(path.join(dataDir,'secret.txt'),'private');
  await symlink(path.join(dataDir,'secret.txt'),path.join(projects.projectPath(id),'linked'));
  await symlink(dataDir,path.join(projects.projectPath(id),'directory-link'));
  for(const name of ['../secret.txt','/etc/passwd','.git/config','linked','directory-link/secret.txt','x/../../secret.txt']){
    await assert.rejects(projects.readFile(id,name));await assert.rejects(projects.writeFile(id,name,'attack'));
  }
  assert.ok(!(await projects.tree(id)).files.some(f=>f.path==='linked'));
});

test('file writes, untracked diff and commit use actual workspace state',async t=>{
  const {projects,id}=await fixture(t);await projects.writeFile(id,'src/index.js','console.log("hello");\n');
  assert.equal((await projects.readFile(id,'src/index.js')).content,'console.log("hello");\n');
  const diff=await projects.diff(id);assert.ok(diff.files.some(f=>f.path==='src/index.js'&&f.status==='??'));assert.match(diff.diff,/\+console.log/);
  await projects.commit(id,'Add entrypoint');assert.equal((await projects.diff(id)).files.length,0);
  await projects.writeFile(id,'src/index.js','console.log("updated");\n');assert.match((await projects.diff(id)).diff,/updated/);
  await projects.deleteFile(id,'src/index.js');assert.ok((await projects.diff(id)).files.some(f=>f.status.includes('D')));
});

test('oversized and nontext files are rejected',async t=>{
  const {projects,id}=await fixture(t);await assert.rejects(projects.writeFile(id,'large.txt','x'.repeat(1024*1024+1)),e=>e.status===413);
  await writeFile(path.join(projects.projectPath(id),'binary'),Buffer.from([0,1,2]));await assert.rejects(projects.readFile(id,'binary'),e=>e.status===415);
});
