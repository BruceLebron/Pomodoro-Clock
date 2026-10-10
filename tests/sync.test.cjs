const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSync, sessionKey, mergeSessions } = require("../sync.js");

const record = (completedAt, task = "学习 Go") => ({ completedAt, minutes: 25, task });
const response = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function server(initial = []) {
  const stored = new Map(initial.map((item) => [sessionKey(item), { ...item, id: "id-" + sessionKey(item) }]));
  const calls = [];
  const fetch = async (url, options) => {
    assert.equal(url, "/api/sessions");
    calls.push(options.method);
    if (options.method === "GET") return response({ sessions: [...stored.values()].sort((a, b) => a.completedAt - b.completedAt).slice(-1000), total: stored.size });
    const incoming = JSON.parse(options.body).sessions;
    const sessions = incoming.map((item) => {
      const key = sessionKey(item);
      if (!stored.has(key)) stored.set(key, { ...item, id: "id-" + key });
      return stored.get(key);
    });
    return response({ sessions, saved: sessions.length });
  };
  return { stored, calls, fetch };
}

function client(initial, fetch, extra = {}) {
  const state = { sessions: initial.slice() };
  const statuses = [];
  const sync = createSync({ load: () => state.sessions, merge: (items) => { state.sessions = mergeSessions(state.sessions, items); }, onStatus: (status) => statuses.push(status), fetchImpl: fetch, ...extra });
  return { ...sync, state, statuses };
}

test("旧本地记录先下载后上传，重复同步不会重复 POST", async () => {
  const backend = server([record(1000, "远程任务")]);
  const app = client([record(2000)], backend.fetch);
  assert.equal(app.pendingCount(), 1);
  assert.equal((await app.sync()).phase, "synced");
  assert.equal(backend.stored.size, 2);
  assert.equal(app.state.sessions.length, 2);
  assert.ok(app.state.sessions.every((item) => item.id));
  assert.equal(app.pendingCount(), 0);
  await app.sync();
  assert.deepEqual(backend.calls, ["GET", "POST", "GET"]);
  assert.deepEqual(app.statuses.at(-1), { phase: "synced", pending: 0 });
});

test("POST 已落库但响应丢失，重试 GET 确认后不会重复上传", async () => {
  const backend = server();
  let drop = true;
  const app = client([record(1000)], async (url, options) => {
    const result = await backend.fetch(url, options);
    if (options.method === "POST" && drop) { drop = false; throw new Error("响应丢失"); }
    return result;
  });
  assert.equal((await app.sync()).phase, "offline");
  assert.equal(app.state.sessions.length, 1);
  assert.equal(app.pendingCount(), 1);
  assert.equal(backend.stored.size, 1);
  assert.equal((await app.sync()).phase, "synced");
  assert.deepEqual(backend.calls, ["GET", "POST", "GET"]);
  assert.equal(backend.stored.size, 1);
});

test("断网保留本地记录和待同步状态，网络恢复后可重试", async () => {
  const backend = server();
  let online = false;
  const app = client([record(1000)], (...args) => online ? backend.fetch(...args) : Promise.reject(new Error("网络不可用")));
  assert.equal((await app.sync()).phase, "offline");
  assert.deepEqual(app.state.sessions, [record(1000)]);
  assert.equal(app.statuses.at(-1).pending, 1);
  online = true;
  assert.equal((await app.sync()).phase, "synced");
  assert.equal(backend.stored.size, 1);
});

test("GET 请求期间的新记录被合并保留并在当前轮上传", async () => {
  const backend = server([record(1000, "远程任务")]);
  const gate = deferred();
  const app = client([], async (url, options) => {
    const result = await backend.fetch(url, options);
    if (options.method === "GET") await gate.promise;
    return result;
  });
  const promise = app.sync();
  app.state.sessions.push(record(2000));
  gate.resolve();
  assert.equal((await promise).phase, "synced");
  assert.equal(app.state.sessions.length, 2);
  assert.equal(backend.stored.size, 2);
});

test("并发调用复用同一 Promise，POST 期间新记录串行进入下一轮", async () => {
  const backend = server();
  const posted = deferred();
  const release = deferred();
  let firstPost = true;
  let active = 0;
  let maxActive = 0;
  const app = client([record(1000)], async (url, options) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      const result = await backend.fetch(url, options);
      if (options.method === "POST" && firstPost) {
        firstPost = false;
        posted.resolve();
        await release.promise;
      }
      return result;
    } finally { active -= 1; }
  });
  const promise = app.sync();
  await posted.promise;
  app.state.sessions.push(record(2000, "第二项任务"));
  assert.equal(app.sync(), promise);
  release.resolve();
  assert.equal((await promise).phase, "synced");
  assert.deepEqual(backend.calls, ["GET", "POST", "POST"]);
  assert.equal(maxActive, 1);
  assert.equal(app.state.sessions.length, 2);
  assert.equal(backend.stored.size, 2);
  assert.equal(app.pendingCount(), 0);
});

test("合并内容键去重、保留远程 id，并按完成时间升序且不修改输入", () => {
  const local = [record(3000), record(1000), { completedAt: 2000, minutes: 25 }];
  const remote = [{ ...record(1000), id: "server-id" }, record(2000, ""), record(4000)];
  const snapshot = JSON.stringify([local, remote]);
  const merged = mergeSessions(local, remote);
  assert.deepEqual(merged.map((item) => item.completedAt), [1000, 2000, 3000, 4000]);
  assert.equal(merged[0].id, "server-id");
  assert.equal(merged[1].task, "");
  assert.equal(JSON.stringify([local, remote]), snapshot);
  assert.equal(sessionKey({ ...record(1000), id: "other" }), sessionKey(record(1000)));
});

test("合并最多保留时间最新的 1000 条，忽略损坏本地记录", () => {
  const local = Array.from({ length: 1100 }, (_, index) => record(index + 1));
  const merged = mergeSessions([...local, null, { completedAt: NaN, minutes: 25 }], [record(2000)]);
  assert.equal(merged.length, 1000);
  assert.equal(merged[0].completedAt, 102);
  assert.equal(merged.at(-1).completedAt, 2000);
});

test("静态网页 GET 404 标为 local，不上传也不清除本地记录", async () => {
  const methods = [];
  const app = client([record(1000)], async (_, options) => {
    methods.push(options.method);
    return response(null, 404);
  });
  const result = await app.sync();
  assert.equal(result.phase, "local");
  assert.equal(result.pending, 1);
  assert.deepEqual(methods, ["GET"]);
  assert.deepEqual(app.state.sessions, [record(1000)]);
});

test("超时会 abort 请求并恢复 offline，忽略 abort 的 fetch 也不会卡住", async () => {
  let signal;
  const app = client([record(1000)], (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  }, { timeoutMs: 20 });
  const status = await app.sync();
  assert.equal(signal.aborted, true);
  assert.equal(status.phase, "offline");
  assert.match(status.message, /超时/);
  assert.equal(status.pending, 1);
  assert.deepEqual(app.state.sessions, [record(1000)]);
});

test("响应正文读取也受超时限制", async () => {
  const app = client([record(1000)], async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }), { timeoutMs: 20 });
  assert.equal((await app.sync()).phase, "offline");
  assert.equal(app.pendingCount(), 1);
});

test("非法成功正文、HTTP 错误和缺少 POST 确认均不得显示 synced", async (t) => {
  for (const body of [null, {}, { sessions: "bad", total: 0 }, { sessions: [record(-1)], total: 1 }, { sessions: [], total: -1 }]) {
    await t.test(JSON.stringify(body), async () => {
      const app = client([record(1000)], async () => response(body));
      assert.equal((await app.sync()).phase, "offline");
      assert.equal(app.state.sessions.length, 1);
      assert.equal(app.pendingCount(), 1);
    });
  }
  await t.test("GET 500", async () => {
    const app = client([record(1000)], async () => response({}, 500));
    assert.equal((await app.sync()).phase, "offline");
    assert.match(app.statuses.at(-1).message, /500/);
  });
  await t.test("伪造 ok 但 HTTP 状态失败", async () => {
    const app = client([record(1000)], async () => ({ ok: true, status: 500, json: async () => ({ sessions: [], total: 0 }) }));
    assert.equal((await app.sync()).phase, "offline");
    assert.equal(app.pendingCount(), 1);
  });
  await t.test("POST 未确认上传记录", async () => {
    const app = client([record(1000)], async (_, options) => response(options.method === "GET" ? { sessions: [], total: 0 } : { sessions: [], saved: 0 }));
    assert.equal((await app.sync()).phase, "offline");
    assert.equal(app.pendingCount(), 1);
  });
});

test("服务端数据库重建后，完整空快照使本地记录重新上传", async () => {
  const backend = server();
  const app = client([record(1000)], backend.fetch);
  await app.sync();
  backend.stored.clear();
  assert.equal((await app.sync()).phase, "synced");
  assert.deepEqual(backend.calls, ["GET", "POST", "GET", "POST"]);
  assert.equal(backend.stored.size, 1);
});

test("服务端已有最新 1000 条时，较旧本地记录先落库再从视图淘汰", async () => {
  const remote = Array.from({ length: 1000 }, (_, index) => record(index + 10000));
  const backend = server(remote);
  const app = client([record(1000, "第一版旧记录")], backend.fetch);
  assert.equal((await app.sync()).phase, "synced");
  assert.equal(backend.stored.size, 1001);
  assert.ok(backend.stored.has(sessionKey(record(1000, "第一版旧记录"))));
  assert.equal(app.state.sessions.length, 1000);
  assert.equal(app.state.sessions[0].completedAt, 10000);
  assert.equal(app.pendingCount(), 0);
  await app.sync();
  assert.deepEqual(backend.calls, ["GET", "POST", "GET"]);
});

test("远程已有 1000 条且 POST 失败，不提前合并而丢弃旧本地记录", async () => {
  const backend = server(Array.from({ length: 1000 }, (_, index) => record(index + 10000)));
  let fail = true;
  const old = record(1000, "离线期间完成");
  const app = client([old], (url, options) => {
    if (fail && options.method === "POST") return Promise.reject(new Error("上传失败"));
    return backend.fetch(url, options);
  });
  assert.equal((await app.sync()).phase, "offline");
  assert.deepEqual(app.state.sessions, [old]);
  assert.equal(app.pendingCount(), 1);
  assert.equal(backend.stored.size, 1000);
  fail = false;
  assert.equal((await app.sync()).phase, "synced");
  assert.equal(backend.stored.size, 1001);
});

test("GET 期间本地视图替换为另 1000 条，原快照与新增记录分批全部上传", async () => {
  const backend = server();
  const gate = deferred();
  const postedSizes = [];
  const before = Array.from({ length: 1000 }, (_, index) => record(index + 1, "旧记录"));
  const after = Array.from({ length: 1000 }, (_, index) => record(index + 10001, "新记录"));
  const app = client(before, async (url, options) => {
    const result = await backend.fetch(url, options);
    if (options.method === "GET") await gate.promise;
    else postedSizes.push(JSON.parse(options.body).sessions.length);
    return result;
  });
  const promise = app.sync();
  app.state.sessions = after;
  gate.resolve();
  assert.equal((await promise).phase, "synced");
  assert.deepEqual(postedSizes, [1000, 1000]);
  assert.equal(backend.stored.size, 2000);
  assert.equal(app.state.sessions.length, 1000);
  assert.equal(app.state.sessions[0].completedAt, 10001);
});

test("状态渲染回调抛错不能中断同步，数据回调抛错转为 offline", async () => {
  const backend = server();
  const app = client([record(1000)], backend.fetch, { onStatus: () => { throw new Error("渲染失败"); } });
  assert.equal((await app.sync()).phase, "synced");
  const broken = createSync({ load: () => [record(1000)], merge: () => { throw new Error("存储失败"); }, fetchImpl: backend.fetch });
  assert.equal((await broken.sync()).phase, "offline");
  assert.equal(broken.pendingCount(), 0);
});

test("状态回调同步再次调用 sync 复用在途任务，不重入发出请求", async () => {
  const backend = server();
  let sync;
  let nested;
  sync = createSync({ load: () => [], merge: () => {}, fetchImpl: backend.fetch, onStatus: ({ phase }) => {
    if (phase === "syncing") nested = sync.sync();
  } });
  const promise = sync.sync();
  assert.equal(nested, promise);
  assert.equal((await promise).phase, "synced");
  assert.deepEqual(backend.calls, ["GET"]);
});
