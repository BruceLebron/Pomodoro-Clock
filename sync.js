/* 同步只传输完成的专注记录；计时、暂停与设置仍由浏览器独立负责。 */
(function (root) {
  "use strict";

  const MAX_SESSIONS = 1000;
  const DATA_ERROR = "同步服务返回的数据格式不正确";

  // 内容键与后端幂等键使用相同字段；服务端 id 不参与去重。
  function sessionKey(session) {
    return JSON.stringify([session.completedAt, session.minutes, session.task || ""]);
  }

  function validSession(session) {
    return session && typeof session === "object" &&
      Number.isInteger(session.completedAt) && session.completedAt > 0 && session.completedAt <= 8640000000000000 &&
      Number.isInteger(session.minutes) && session.minutes >= 1 && session.minutes <= 180 &&
      (session.task === undefined || (typeof session.task === "string" && session.task.length <= 80)) &&
      (session.id === undefined || (typeof session.id === "string" && session.id.length > 0));
  }

  function copySession(session) {
    const result = { completedAt: session.completedAt, minutes: session.minutes, task: session.task || "" };
    if (session.id !== undefined) result.id = session.id;
    return result;
  }

  function combineSessions(local, remote) {
    const byKey = new Map();
    // 先放本地，再放服务端，同内容记录优先保留服务端字段。
    for (const sessions of [local, remote]) {
      for (const session of Array.isArray(sessions) ? sessions : []) {
        if (validSession(session)) byKey.set(sessionKey(session), copySession(session));
      }
    }
    return [...byKey.values()].sort((a, b) => a.completedAt - b.completedAt);
  }

  function mergeSessions(local, remote) {
    return combineSessions(local, remote).slice(-MAX_SESSIONS);
  }

  function createSync({ load, merge, onStatus = () => {}, fetchImpl = root.fetch?.bind(root), timeoutMs = 5000 } = {}) {
    if (typeof load !== "function" || typeof merge !== "function") throw new TypeError("同步需要 load 与 merge 回调");
    const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
    let acknowledged = new Set();
    let retained = [];
    let inFlight = null;

    function readLocal() {
      const sessions = load();
      if (!Array.isArray(sessions)) throw new TypeError("本地专注记录格式不正确");
      return mergeSessions(sessions, []);
    }

    function pendingCount() {
      try { return combineSessions(retained, readLocal()).filter((session) => !acknowledged.has(sessionKey(session))).length; }
      catch (_) { return 0; }
    }

    function emit(phase, message) {
      const status = { phase, pending: pendingCount() };
      if (message) status.message = message;
      // 状态显示故障不能阻断数据同步，也不能产生未处理的 Promise 拒绝。
      try {
        const rendered = onStatus(status);
        if (rendered && typeof rendered.then === "function") Promise.resolve(rendered).catch(() => {});
      } catch (_) { /* 页面继续以本地记录工作。 */ }
      return status;
    }

    function validateBody(body, get) {
      if (!body || !Array.isArray(body.sessions) || body.sessions.length > MAX_SESSIONS || !body.sessions.every(validSession)) {
        throw new Error(DATA_ERROR);
      }
      if (get && (!Number.isInteger(body.total) || body.total < body.sessions.length)) throw new Error(DATA_ERROR);
      return body;
    }

    async function request(method, sessions) {
      if (typeof fetchImpl !== "function") throw new Error("当前浏览器无法连接同步服务");
      const controller = new AbortController();
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("同步请求超时，请稍后重试"));
          controller.abort();
        }, deadline);
      });
      try {
        // 超时包含响应正文读取；即使 fetch 实现忽略 abort，调用也会按时返回。
        return await Promise.race([timeout, (async () => {
          const options = { method, credentials: "same-origin", cache: "no-store", signal: controller.signal, headers: { Accept: "application/json" } };
          if (method === "POST") {
            options.headers["Content-Type"] = "application/json";
            options.body = JSON.stringify({ sessions: sessions.map(({ completedAt, minutes, task }) => ({ completedAt, minutes, task })) });
          }
          const response = await fetchImpl("/api/sessions", options);
          if (method === "GET" && response?.status === 404) return null;
          if (!response || response.ok !== true || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300 || typeof response.json !== "function") {
            throw new Error(`同步服务暂时不可用${Number.isInteger(response?.status) ? `（HTTP ${response.status}）` : ""}`);
          }
          return validateBody(await response.json(), method === "GET");
        })()]);
      } finally { clearTimeout(timer); }
    }

    async function run() {
      emit("syncing");
      try {
        // 同一轮只有一个请求在途；期间新增记录会串行进入下一批上传。
        do {
          // 请求前保存本地副本：后续视图保留上限不能挤掉未确认的历史。
          retained = combineSessions(retained, readLocal()).filter((session) => !acknowledged.has(sessionKey(session)));
          const remote = await request("GET");
          if (remote === null) return emit("local", "当前为静态网页，专注记录保存在本机");
          const remoteKeys = new Set(remote.sessions.map(sessionKey));
          // 完整服务端快照可识别数据库重建；分页快照保留之前的确认信息。
          acknowledged = remote.total === remote.sessions.length ? remoteKeys : new Set([...acknowledged, ...remoteKeys]);
          let received = remote.sessions;
          while (true) {
            // GET/POST 期间新增的记录同样先上传；每次提交最多 1000 条。
            retained = combineSessions(retained, readLocal()).filter((session) => !acknowledged.has(sessionKey(session)));
            if (!retained.length) break;
            const pending = retained.slice(0, MAX_SESSIONS);
            emit("syncing");
            const posted = await request("POST", pending);
            const confirmed = new Set(posted.sessions.map(sessionKey));
            if (!pending.every((session) => confirmed.has(sessionKey(session)))) throw new Error(DATA_ERROR);
            for (const key of confirmed) acknowledged.add(key);
            received = combineSessions(received, posted.sessions);
          }

          // 所有本地记录已确认后再更新视图，避免远程最新 1000 条提前淘汰旧 local。
          // POST 失败时不执行 merge，页面原始历史和待同步副本都会保留。
          merge(received);
          const local = readLocal();
          const localKeys = new Set(local.map(sessionKey));
          acknowledged = new Set([...acknowledged].filter((key) => localKeys.has(key)));
          if (!local.some((session) => !acknowledged.has(sessionKey(session)))) return emit("synced");
        } while (true);
      } catch (error) {
        return emit("offline", error instanceof Error ? error.message : "同步失败，请稍后重试");
      }
    }

    function sync() {
      // 多个按钮、计时完成与网络恢复事件可复用同一个同步任务。
      if (inFlight) return inFlight;
      let resolve;
      const task = new Promise((done) => { resolve = done; });
      // 先设置在途标记，再执行会触发页面回调的 run，避免同步重入。
      inFlight = task;
      run().then((result) => {
        inFlight = null;
        resolve(result);
      }, (error) => {
        inFlight = null;
        resolve(emit("offline", error instanceof Error ? error.message : "同步失败，请稍后重试"));
      });
      return task;
    }

    return { sync, pendingCount };
  }

  const api = { createSync, sessionKey, mergeSessions };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TomatoSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
