import { createHash } from 'node:crypto';

const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = (message, code = 'execution_environment_changed', status = 409) => Object.assign(new Error(message), { code, status });
const nonempty = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');

/** These are capabilities exercised by kivo, not every method in upstream Codex. */
export function engineCapabilities(mode) {
  if (!['chat', 'cloud', 'local'].includes(mode)) throw failure('未知执行环境', 'execution_mode_invalid', 400);
  return Object.freeze({
    engine: mode === 'chat' ? 'responses' : 'codex-app-server',
    mode,
    version: mode === 'chat' ? null : '0.167.0',
    create: true,
    continue: mode !== 'chat',
    nativeFork: false,
    interrupt: true,
    interruptMethod: mode === 'chat' ? 'abort-request' : mode === 'cloud' ? 'stop-container' : 'stop-process-group',
    events: true,
    stateRead: 'application-records',
    nativeStateRead: false,
    nativePause: false,
    automaticCompaction: false,
  });
}

function sealEnvironment(value) {
  const identity = {
    engine: value.engine, mode: value.mode, projectId: value.projectId, userId: value.userId,
    workspace: value.workspace, runner: value.runner ?? null,
  };
  return {
    schemaVersion: 1,
    ...value,
    identityFingerprint: fingerprint(identity),
    stateFingerprint: fingerprint({ ...identity, branch: value.branch, baseRevision: value.baseRevision, dirtyFingerprint: value.dirtyFingerprint }),
    capturedAt: new Date().toISOString(),
  };
}

/**
 * The caller holds the existing project lock. Cloud probes run through the
 * existing sandboxed projects API. No Git command executes in the API host.
 * A device binding is not proof of its current branch or checkout contents.
 */
export async function captureExecutionEnvironment({ project = null, projects, config = {}, local } = {}) {
  if (project === null) return sealEnvironment({
    engine: 'responses', mode: 'chat', projectId: null, userId: null, workspace: null,
    branch: null, baseRevision: null, dirtyFingerprint: null, dirtyPaths: [],
    verified: true, reusable: false, requiresLocalValidation: false,
  });
  if (!nonempty(project.id) || !nonempty(project.userId)) throw failure('工作对象身份无效', 'execution_environment_invalid', 400);
  const mode = project.location ?? 'cloud';
  if (mode === 'local') {
    if (!local?.owned || !nonempty(project.deviceId) || typeof project.localPath !== 'string') {
      throw failure('无法核实本地设备的授权', 'execution_environment_unverified');
    }
    // This checks the current device owner and revocation, not a browser-supplied ID.
    local.owned(project.userId, project.deviceId);
    if (project.localPath.length > 1000 || project.localPath.includes('\\') || project.localPath.includes('\0')
      || project.localPath.startsWith('/') || (project.localPath && project.localPath.split('/').some(part => !part || part === '.' || part === '..' || part === '.git'))) {
      throw failure('本地工作区绑定路径无效', 'execution_environment_invalid', 400);
    }
    return sealEnvironment({
      engine: 'codex-app-server', mode, projectId: project.id, userId: project.userId,
      workspace: JSON.stringify({ deviceId: project.deviceId, userId: project.userId, relativePath: project.localPath }),
      runner: 'kivo-local/codex-0.167.0', branch: null, baseRevision: null, dirtyFingerprint: null, dirtyPaths: [],
      verified: false, reusable: false, requiresLocalValidation: true,
    });
  }
  if (mode !== 'cloud') throw failure('未知执行环境', 'execution_mode_invalid', 400);
  if (typeof projects?.executionEnvironment !== 'function') {
    throw failure('执行器尚不能核实当前工作区版本，请保持任务待核对', 'execution_environment_unverified');
  }
  const snapshot = await projects.executionEnvironment(project.id);
  if (!snapshot || !nonempty(snapshot.workspace)
    || !(snapshot.branch === null || nonempty(snapshot.branch))
    || !(snapshot.baseRevision === null || /^[a-f\d]{40,64}$/i.test(snapshot.baseRevision))
    || typeof snapshot.dirtyFingerprint !== 'string' || !/^[a-f\d]{64}$/i.test(snapshot.dirtyFingerprint)
    || !Array.isArray(snapshot.dirtyPaths) || snapshot.dirtyPaths.length > 25_000
    || snapshot.dirtyPaths.some(entry => typeof entry !== 'string' || entry.length > 4096 || entry.includes('\0'))) {
    throw failure('工作区身份或版本核查不完整，任务暂不执行', 'execution_environment_unverified');
  }
  return sealEnvironment({
    engine: 'codex-app-server', mode, projectId: project.id, userId: project.userId,
    workspace: snapshot.workspace, runner: config.runnerImage ?? 'codex-workspace-runner:0.167.0',
    branch: snapshot.branch, baseRevision: snapshot.baseRevision,
    dirtyFingerprint: snapshot.dirtyFingerprint, dirtyPaths: [...snapshot.dirtyPaths],
    verified: true, reusable: true, requiresLocalValidation: false,
  });
}

/** Compare actual fields, not caller-provided fingerprint strings. */
export function assertEnvironmentCompatible(expected, actual) {
  if (!expected || !actual || expected.schemaVersion !== 1 || actual.schemaVersion !== 1
    || !['chat', 'cloud', 'local'].includes(expected.mode) || !['chat', 'cloud', 'local'].includes(actual.mode)) {
    throw failure('缺少可验证的工作区快照，请重新核对执行目标', 'execution_environment_unverified');
  }
  const fields = ['engine', 'mode', 'projectId', 'userId', 'workspace', 'runner', 'branch', 'baseRevision', 'dirtyFingerprint'];
  if (fields.some(key => (expected[key] ?? null) !== (actual[key] ?? null))) {
    throw failure('工作区、分支或文件版本已改变，请重新确认任务目标后继续');
  }
  if (actual.mode !== 'local' && (!expected.verified || !actual.verified)) {
    throw failure('无法核实执行环境，任务暂不执行', 'execution_environment_unverified');
  }
  return { compatible: true, verified: actual.verified === true, requiresLocalValidation: actual.mode === 'local' };
}

/**
 * A lifecycle decision never grants permissions or changes task identity.
 * The orchestration layer allocates/links tasks and enforces its write lease.
 */
export function chooseLifecycle({ task, previousSession, environment, intent = 'continue' } = {}) {
  if (!environment || !['chat', 'cloud', 'local'].includes(environment.mode)) {
    throw failure('执行环境尚未核实', 'execution_environment_unverified');
  }
  const operation = typeof intent === 'string' ? intent : intent?.operation ?? intent?.kind;
  const result = (action, reason, reusesThread = false) => ({
    action, reason, engine: environment.engine, reusesThread,
    engineThreadId: reusesThread ? previousSession.engineThreadId : null,
  });
  if (operation === 'fork') return result('fork', '新建干净执行会话，原任务与产物版本保持独立');
  if (operation === 'new' || !task) return result('new', '明确的新工作使用独立任务和执行会话');
  if (operation === 'rebuild') return result('rebuild', '用户要求从已核实任务状态重建执行会话');
  if (!previousSession) return result(operation === 'revise' ? 'revise' : 'rebuild', '任务尚无可继续的执行会话，从已核实状态建立干净会话');
  if (previousSession.taskId !== task.id) return result('rebuild', '旧执行会话属于不同任务');
  if (previousSession.status === 'running') return result('blocked', '旧执行会话仍在运行，先等待或停止当前执行');
  if (previousSession.invalidated || !['ready'].includes(previousSession.status)) {
    return result(operation === 'revise' ? 'revise' : 'rebuild', '旧执行会话已不可用，保留任务并从权威状态重建');
  }
  if (!Number.isSafeInteger(task.version) || task.version < 1
    || !Number.isSafeInteger(previousSession.taskVersion) || previousSession.taskVersion !== task.version) {
    return result(operation === 'revise' ? 'revise' : 'rebuild', '任务版本未能核实一致，从当前目标和约束重建会话');
  }
  if (environment.mode === 'chat') return result(operation === 'revise' ? 'revise' : 'rebuild', 'Responses 使用本次任务上下文，不复用供应商线程');
  if (!environment.verified || !environment.reusable) return result(operation === 'revise' ? 'revise' : 'rebuild', '当前执行位置未能核实全部版本，使用干净线程并保留原文件');
  try { assertEnvironmentCompatible(previousSession.environment, environment); }
  catch { return result(operation === 'revise' ? 'revise' : 'rebuild', '执行目标或工作区版本已改变，重新组装必要上下文'); }
  if (!nonempty(previousSession.engineThreadId)) return result(operation === 'revise' ? 'revise' : 'rebuild', '旧会话没有可恢复的引擎线程标识');
  // Revision retains the business task but deliberately starts a clean engine
  // session, matching prepareRun's version-preserving revision semantics.
  if (operation === 'revise') return result('revise', '修订保留当前任务，从已核实产物和约束建立干净会话');
  return result('continue', '同一任务和工作区版本，继续经过验证的执行线程', true);
}
