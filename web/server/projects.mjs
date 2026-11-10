import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { AppError } from './store.mjs';

const exec = promisify(execFile);
const ID = /^[a-f0-9-]{36}$/;
const MAX_FILE = 1024 * 1024;
const MAX_PROJECT = 100 * 1024 * 1024;
const MAX_DIFF = 1024 * 1024;
const hiddenDirs = new Set(['.git','node_modules','.venv','venv','__pycache__']);

export function createProjects(config) {
  const root=path.resolve(config.dataDir,'projects');
  const hostRoot=path.resolve(config.hostDataDir??config.dataDir,'projects');
  const locks=new Map();
  const markerRoot=path.join(config.dataDir,'git-locks');
  async function cleanupGit(id,name) {
    let removed=false;
    try{await exec('docker',['rm','-f',name],{timeout:10000,maxBuffer:65536});removed=true;}
    catch(error){
      if(/No such (?:container|object)/i.test(error.stderr??''))removed=true;
      else {
        try{await exec('docker',['inspect','--format','{{.Id}}',name],{timeout:5000,maxBuffer:65536});}
        catch(inspectError){if(/No such (?:container|object)/i.test(inspectError.stderr??''))removed=true;}
      }
    }
    if(!removed)throw new AppError('工作容器尚未安全退出，项目已暂时锁定，请联系管理员',503);
    await fs.rm(path.join(markerRoot,id),{force:true});
  }
  const projectPath=(id)=>{
    if(!ID.test(id))throw new AppError('项目不存在',404);
    return path.join(root,id);
  };
  async function withLock(id,fn) {
    const previous=locks.get(id)??Promise.resolve();
    let release;const current=new Promise(resolve=>{release=resolve;});locks.set(id,current);
    await previous;
    try{
      if(config.testGitMode!=='host'){
        const marker=await fs.readFile(path.join(markerRoot,id),'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
        if(marker){if(!/^cw-git-[a-f0-9-]{36}$/.test(marker))throw new AppError('项目锁无效，请联系管理员',503);await cleanupGit(id,marker);}
      }
      return await fn();
    }finally{release();if(locks.get(id)===current)locks.delete(id);}
  }
  async function checkFreeSpace() {
    const disk=await fs.statfs(config.dataDir);
    if(disk.bavail*disk.bsize<1024*1024*1024)throw new AppError('服务器可用存储不足，暂时不能写入项目文件',503);
  }
  async function own(p) {
    if(config.runnerUid!==undefined&&config.runnerUid!==null)await fs.chown(p,config.runnerUid,config.runnerGid??config.runnerUid);
  }
  async function safePath(id,relative,{parents=false,allowMissing=false}={}) {
    if(typeof relative!=='string'||relative.length<1||relative.length>1024||relative.includes('\\')||relative.includes('\0')||path.isAbsolute(relative))throw new AppError('文件路径无效');
    const segments=relative.split('/');
    if(segments.some(s=>!s||s==='.'||s==='..'||s==='.git'))throw new AppError('不允许访问此文件路径');
    const base=projectPath(id);let current=base;
    const baseStat=await fs.lstat(base);
    if(!baseStat.isDirectory()||baseStat.isSymbolicLink())throw new AppError('项目目录无效',409);
    for(let i=0;i<segments.length;i++) {
      current=path.join(current,segments[i]);const final=i===segments.length-1;
      let st;
      try{st=await fs.lstat(current);}catch(e){
        if(e.code!=='ENOENT')throw e;
        if(!final&&parents){await fs.mkdir(current,{mode:0o700});await own(current);continue;}
        if(final&&allowMissing)return current;
        throw new AppError('文件不存在',404);
      }
      if(st.isSymbolicLink())throw new AppError('不能访问符号链接',403);
      if(!final&&!st.isDirectory())throw new AppError('文件路径包含非目录',400);
      if(final&&!st.isFile())throw new AppError('只能操作普通文件',400);
    }
    return current;
  }
  async function readFile(id,relative) {
    const p=await safePath(id,relative);
    const handle=await fs.open(p,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const stat=await handle.stat();if(!stat.isFile()||stat.size>MAX_FILE)throw new AppError('仅支持查看不超过 1 MB 的文本文件',413);
      const bytes=await handle.readFile();if(bytes.includes(0))throw new AppError('此文件为二进制文件，暂不支持文本编辑',415);
      return {path:relative,content:new TextDecoder('utf-8',{fatal:true}).decode(bytes)};
    }catch(e){if(e instanceof TypeError)throw new AppError('此文件不是有效的 UTF-8 文本',415);throw e;}
    finally{await handle.close();}
  }
  async function scan(id,{all=false}={}) {
    const base=projectPath(id),files=[];let size=0,count=0;
    const st=await fs.lstat(base);if(!st.isDirectory()||st.isSymbolicLink())throw new AppError('项目目录无效',409);
    async function visit(dir,relative='') {
      const entries=await fs.readdir(dir,{withFileTypes:true});
      for(const entry of entries){
        if(++count>20_000)throw new AppError('项目文件数量超过限制',413);
        if(!all&&hiddenDirs.has(entry.name))continue;
        const rel=relative?`${relative}/${entry.name}`:entry.name,p=path.join(dir,entry.name),s=await fs.lstat(p);
        if(s.isSymbolicLink())continue;
        if(s.isDirectory())await visit(p,rel);
        else if(s.isFile()){
          size+=s.size;
          if(!all&&files.length<3000)files.push({path:rel,size:s.size});
        }
      }
    }
    await visit(base);return {files:files.sort((a,b)=>a.path.localeCompare(b.path)),size};
  }
  async function git(id,args) {
    const p=projectPath(id);
    const safeArgs=['-c','safe.directory=/workspace','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgsign=false','-c','tag.gpgsign=false','-c','core.pager=cat','-c','core.quotePath=false',...args];
    if(config.testGitMode==='host') {
      // Test fixture repositories only. Production never runs repository hooks or filters on the host.
      const result=await exec('git',safeArgs,{cwd:p,timeout:15000,maxBuffer:MAX_DIFF*4,env:{PATH:process.env.PATH,HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_AUTHOR_NAME:'kivo',GIT_AUTHOR_EMAIL:'workspace@localhost',GIT_COMMITTER_NAME:'kivo',GIT_COMMITTER_EMAIL:'workspace@localhost'}});
      return result.stdout;
    }
    const containerName=`cw-git-${randomUUID()}`;
    await fs.mkdir(markerRoot,{recursive:true,mode:0o700});
    await fs.writeFile(path.join(markerRoot,id),containerName,{mode:0o600});
    const containerArgs=['run','--rm','--name',containerName,'--label','codex-workspace.git=true','--network','none','--user',`${config.runnerUid??1000}:${config.runnerGid??1000}`,
      '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','64','--memory','192m','--cpus','0.5',
      '--ulimit','fsize=67108864:67108864','--tmpfs','/tmp:rw,nosuid,nodev,size=64m,mode=1777',
      '--mount',`type=bind,source=${path.join(hostRoot,id)},target=/workspace`,
      '--workdir','/workspace','--env','HOME=/tmp','--env','GIT_CONFIG_NOSYSTEM=1','--env','GIT_CONFIG_GLOBAL=/dev/null',
      '--env','GIT_TERMINAL_PROMPT=0','--env','GIT_AUTHOR_NAME=kivo','--env','GIT_AUTHOR_EMAIL=workspace@localhost',
      '--env','GIT_COMMITTER_NAME=kivo','--env','GIT_COMMITTER_EMAIL=workspace@localhost',
      '--entrypoint','git',config.runnerImage,...safeArgs];
    try {const result=await exec('docker',containerArgs,{timeout:20000,maxBuffer:MAX_DIFF*4});return result.stdout;}
    catch(e){throw new AppError(e.killed?'Git 操作超时':'Git 操作失败，请检查项目仓库是否有效',409);}
    finally{await cleanupGit(id,containerName);}
  }
  async function changedFiles(id) {
    const raw=await git(id,['status','--porcelain=v1','-z','--untracked-files=all','--no-renames']);
    return raw.split('\0').filter(Boolean).map(r=>({path:r.slice(3),status:r.slice(0,2).trim()}));
  }

  async function executionEnvironment(id) {
    const base = projectPath(id), stat = await fs.lstat(base), real = await fs.realpath(base);
    if (!stat.isDirectory() || stat.isSymbolicLink() || real !== base) throw new AppError('执行目录身份无法核实', 409, 'execution_environment_changed');
    const fingerprint = createHash('sha256');
    let bytes = 0, count = 0;
    // Include both tracked and untracked bytes, never execute repository hooks,
    // filters or follow links while computing a read-only workspace checkpoint.
    async function visit(dir, prefix = '') {
      for (const name of (await fs.readdir(dir)).sort()) {
        if (!prefix && name === '.git') continue;
        if (++count > 25000) throw new AppError('工作区过大，无法核实执行版本', 409, 'execution_environment_unverified');
        const filename = path.join(dir, name), relative = prefix + name, info = await fs.lstat(filename);
        fingerprint.update(JSON.stringify([relative, info.mode, info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'directory' : 'file']));
        if (info.isSymbolicLink()) { fingerprint.update(await fs.readlink(filename)); continue; }
        if (info.isDirectory()) { await visit(filename, relative + '/'); continue; }
        if (!info.isFile() || (bytes += info.size) > 200 * 1024 * 1024) throw new AppError('工作区包含无法核实的文件', 409, 'execution_environment_unverified');
        const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await handle.stat();
          if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size) throw new AppError('检查期间工作区已改变', 409, 'execution_environment_changed');
          for await (const chunk of handle.createReadStream({ autoClose: false })) fingerprint.update(chunk);
          const after = await handle.stat();
          if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new AppError('检查期间文件已改变', 409, 'execution_environment_changed');
        } finally { await handle.close(); }
      }
    }
    await visit(base);
    const branch = (await git(id, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const baseRevision = (await git(id, ['rev-parse', '--verify', 'HEAD'])).trim();
    const dirtyPaths = (await changedFiles(id)).map(file => file.path).slice(0, 3000);
    return { workspace: `${real}#${stat.dev}:${stat.ino}`, branch, baseRevision,
      dirtyFingerprint: fingerprint.digest('hex'), dirtyPaths };
  }

  return {
    withLock,projectPath,executionEnvironment,
    async initialize(id,name) {
      await checkFreeSpace();
      const p=projectPath(id);await fs.mkdir(root,{recursive:true,mode:0o700});await fs.mkdir(p,{mode:0o700});await own(p);
      const readme=path.join(p,'README.md');await fs.writeFile(readme,`# ${name}\n\n在这里开始你的项目。\n`,{flag:'wx',mode:0o600});await own(readme);
      await git(id,['init','--initial-branch=main']);await git(id,['add','--','README.md']);await git(id,['commit','--no-verify','-m','Initialize project']);
    },
    async remove(id) {
      const p=projectPath(id);const st=await fs.lstat(p).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
      if(st?.isSymbolicLink())throw new AppError('项目目录无效',409);
      await fs.rm(p,{recursive:true,force:true});
      await fs.rm(path.join(config.dataDir,'homes',id),{recursive:true,force:true});
    },
    async tree(id){return {files:(await scan(id)).files};},
    readFile,
    async writeFile(id,relative,content) {
      await checkFreeSpace();
      if(typeof content!=='string'||Buffer.byteLength(content)>MAX_FILE)throw new AppError('文件内容不能超过 1 MB',413);
      const {size}=await scan(id,{all:true});
      const p=await safePath(id,relative,{parents:true,allowMissing:true});const old=await fs.lstat(p).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
      if(size-(old?.size??0)+Buffer.byteLength(content)>MAX_PROJECT)throw new AppError('项目空间上限为 100 MB',413);
      const handle=await fs.open(p,constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
      try{await handle.truncate(0);await handle.writeFile(content);await handle.sync();}finally{await handle.close();}
      await own(p);return {ok:true};
    },
    async deleteFile(id,relative){const p=await safePath(id,relative);await fs.unlink(p);return {ok:true};},
    changedFiles,
    async diff(id) {
      const files=await changedFiles(id);
      let diff=await git(id,['diff','--no-ext-diff','--no-textconv','--no-renames','HEAD','--']);let truncated=false;
      for(const file of files.filter(f=>f.status==='??')) {
        if(diff.length>MAX_DIFF){truncated=true;break;}
        try{
          const data=await readFile(id,file.path);const lines=data.content.split('\n');if(lines.at(-1)==='')lines.pop();
          diff+=`diff --git a/${file.path} b/${file.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${file.path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l=>'+'+l).join('\n')}\n`;
        }catch{diff+=`diff --git a/${file.path} b/${file.path}\n新文件（非文本、过大或链接）\n`;}
      }
      if(diff.length>MAX_DIFF){diff=diff.slice(0,MAX_DIFF);truncated=true;}
      return {diff,files:files.slice(0,3000),truncated};
    },
    async commit(id,message) {
      if(!(await git(id,['status','--porcelain=v1'])).trim())throw new AppError('没有需要保存的修改',409);
      await git(id,['add','--all','--','.']);await git(id,['commit','--no-verify','-m',message]);return {ok:true};
    },
  };
}
