import { AppError } from './store.mjs';
import { createWorkStore } from './work-store.mjs';
import { resolveWorkRoute, requireExecutableRoute } from './work-routing.mjs';
import { captureExecutionEnvironment, chooseLifecycle, engineCapabilities } from './engine-adapter.mjs';
import { buildWorkContext } from './work-context.mjs';

export function createWorkService({ store, config, projects, local }) {
  const graph = store.work ??= createWorkStore({ store });
  const mode = config.workRoutingMode ?? 'shadow';
  function route(userId, conversationId, text, work, { record = true } = {}) {
    let decision;
    try { decision = resolveWorkRoute({ workStore: graph, userId, conversationId, text, work }); }
    catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('历史检索服务暂不可用，未开始执行，也未创建替代任务', 503, 'work_history_unavailable');
    }
    if (record) graph.recordDecision(userId, conversationId, { ...decision, mode });
    return decision;
  }
  function state(userId, conversationId) {
    const common = { mode, objects: graph.listObjects(userId, { limit: 200 }), tasks: graph.listTasks(userId, { limit: 200 }) };
    if (!conversationId) return common;
    const conversation = graph.ensureConversation(userId, conversationId);
    const focus = graph.getFocus(userId, conversationId);
    const context = focus.taskId ? graph.getTaskContext(userId, focus.taskId) : null;
    const target = context?.task.objects.find(item => item.role === 'target');
    const executionProject = target?.projectId ? store.getProject(target.projectId) : null;
    return { ...common, focus, task: context?.task ?? null, sessions: context?.sessions ?? [], artifacts: context?.artifacts ?? [],
      decisions: graph.getDecisions(userId, conversationId, { limit: 10 }), historyStatus: conversation.historyStatus,
      executionScope: context?.task ? 'task' : focus.source === 'explicit_question' ? 'question' : 'legacy_project',
      executionProject, engineCapabilities: engineCapabilities(executionProject?.location ?? 'chat') };
  }
  async function prepare({ userId, thread, text, work, decision }) {
    decision ??= route(userId, thread.id, text, work);
    requireExecutableRoute(decision);
    if (decision.allowed.some(action => action === 'cancel' || action === 'pause')) {
      const error = new AppError('请使用任务的停止操作，确认在途执行结束后再继续', 409, 'work_stop_required');
      error.details = { route: decision };
      throw error;
    }
    if (!decision.taskId && decision.status !== 'new') {
      if (decision.clearFocus) graph.setFocus(userId, thread.id, { taskId: null, objectId: null, expectedRevision: decision.focusRevision, source: 'explicit_question' });
      return { decision, project: null, task: null };
    }
    let task = decision.taskId ? graph.getTask(userId, decision.taskId) : null;
    if (!task) {
      const object = decision.createObject
        ? graph.createObject(userId, { kind: 'collection', name: text.slice(0, 80) || '新的工作' })
        : graph.getObject(userId, decision.objectId);
      task = graph.createTask(userId, { goal: text, conversationId: thread.id,
        objects: [{ id: object.id, role: 'target' }, ...decision.referenceIds.filter(id => id !== object.id).map(id => ({ id, role: 'reference' }))],
        ...(decision.parentTaskId ? { parentTaskId: decision.parentTaskId, relation: 'fork' } : {}) });
    }
    const target = task.objects.find(object => object.role === 'target');
    const object = graph.getObject(userId, target.objectId ?? target.id);
    const project = object.projectId ? store.getProject(object.projectId) : null;
    if (object.projectId && (!project || project.userId !== userId)) throw new AppError('工作区已删除或访问权限已改变', 404, 'work_target_unavailable');
    // The caller acquires the actual target project lock before capturing its
    // version. A reference project's lock never authorizes target writes.
    return { task, project, decision };
  }
  async function bind({ userId, thread, task, project, run, text, message, decision, model }) {
    const environment = await captureExecutionEnvironment({ project, projects, config, local });
    const previous = graph.getTaskContext(userId, task.id).sessions.at(-1);
    const lifecycle = chooseLifecycle({ task, previousSession: previous, environment, intent: decision.intent });
    if (lifecycle.action === 'blocked') throw new AppError(lifecycle.reason, 409, 'work_session_busy');
    // Build before leasing; budget failures cannot leave a live worker behind.
    const packet = buildWorkContext({ workStore: graph, userId, taskId: task.id, text, config, model,
      requestMessageId: message.id, lifecycle: lifecycle.action, environment });
    const binding = graph.prepareRun(userId, { conversationId: thread.id, taskId: task.id, runId: run.id,
      expectedVersion: task.version, lifecycle: lifecycle.action, environment, requestMessageId: message.id, inputArtifactIds:packet.inputArtifactIds });
    graph.setFocus(userId, thread.id, { taskId: task.id, objectId: decision.objectId ?? task.objects.find(item => item.role === 'target').id,
      expectedRevision: decision.focusRevision, source: 'user_request' });
    graph.recordDecision(userId, thread.id, { status: 'bound', runId: run.id, taskId: task.id,
      sessionId: binding.sessionId, lifecycle: lifecycle.action, evidence: decision.evidence,
      context: packet.manifest, mode });
    return { binding, packet, environment, lifecycle, recheck: async () => {
      graph.assertRunCurrent(userId, run.id, { generation: binding.generation, taskVersion: binding.taskVersion, leaseToken: binding.leaseToken });
      return captureExecutionEnvironment({ project, projects, config, local });
    } };
  }
  return { mode, graph, route, state, prepare, bind };
}
