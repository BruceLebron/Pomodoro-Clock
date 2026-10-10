const { test } = require("node:test");
const assert = require("node:assert/strict");
const core = require("../timer-core.js");

test("第一版升级保留暂停进度、设置与历史记录", () => {
  const old = { version: 1, settings: { focus: 30, break: 8, sound: false }, mode: "focus", remainingMs: 123456, running: false, endAt: null, sessions: [{ completedAt: 1000000, minutes: 25 }] };
  const restored = core.restore(JSON.parse(JSON.stringify(old)));
  assert.equal(restored.version, 2);
  assert.deepEqual(restored.settings, old.settings);
  assert.equal(restored.remainingMs, old.remainingMs);
  assert.equal(restored.activeTask, "");
  assert.deepEqual(restored.sessions, [{ completedAt: 1000000, minutes: 25, task: "" }]);
  assert.deepEqual(old.sessions, [{ completedAt: 1000000, minutes: 25 }]);
});

test("任务经过暂停、恢复、完成后仍正确归属，且只记录一次", () => {
  const initial = core.setTask(core.createState(), "学习 Go");
  const started = core.start(initial, 1000000);
  const paused = core.pause(started, 1060000).state;
  assert.throws(() => core.setTask(paused, "其他任务"));
  const resumed = core.start(core.restore(JSON.parse(JSON.stringify(paused))), 2000000);
  const finished = core.tick(resumed, resumed.endAt).state;
  assert.equal(finished.sessions[0].task, "学习 Go");
  assert.equal(finished.sessions[0].minutes, 25);
  assert.equal(core.tick(finished, 9999999).state.sessions.length, 1);
});

test("休息时修改任务仅影响下一轮，不篡改完成的历史", () => {
  const first = core.start(core.setTask(core.createState(), "任务 A"), 1000000);
  const rest = core.setTask(core.tick(first, first.endAt).state, "任务 B");
  assert.equal(rest.sessions[0].task, "任务 A");
  const second = core.start(core.reset(rest, "focus"), 5000000);
  assert.equal(core.tick(second, second.endAt).state.sessions[1].task, "任务 B");
});

test("重置放弃未完成任务，但保留任务草稿，不增加记录", () => {
  const reset = core.reset(core.start(core.setTask(core.createState(), "集群巡检"), 1000000));
  assert.equal(reset.activeTask, null);
  assert.equal(reset.task, "集群巡检");
  assert.equal(reset.sessions.length, 0);
  assert.equal(core.setTask(reset, "阅读").task, "阅读");
});

test("任务名称有长度限制，未命名记录仍可搜索", () => {
  const state = core.setTask(core.createState(), "  Kubernetes\n  巡检  ");
  assert.equal(state.task, "Kubernetes 巡检");
  assert.equal(core.setTask(state, "番".repeat(200)).task.length, 80);
  state.sessions = [{ completedAt: 1000000, minutes: 25, task: "" }];
  assert.equal(core.selectSessions(state, "all", "未命名").length, 1);
});

test("任务名称在 80 单元边界截断时保留完整 emoji，JSON 与 UTF-8 往返保持内容", () => {
  const atBoundary = core.setTask(core.createState(), "番".repeat(78) + "🍅" + "继续").task;
  assert.equal(atBoundary, "番".repeat(78) + "🍅");
  assert.equal(atBoundary.length, 80);
  const beyondBoundary = core.setTask(core.createState(), "番".repeat(79) + "🍅").task;
  assert.equal(beyondBoundary, "番".repeat(79));
  assert.equal(core.setTask(core.createState(), "🍅".repeat(41)).task, "🍅".repeat(40));
  assert.equal(Buffer.from(atBoundary, "utf8").toString("utf8"), atBoundary);
  const started = core.start(core.setTask(core.createState(), "番".repeat(79) + "🍅"), 1000000);
  const finished = core.tick(started, started.endAt).state;
  assert.deepEqual(core.restore(JSON.parse(JSON.stringify(finished))).sessions, finished.sessions);
});

test("旧存档孤立代理项修复为替换字符，任务草稿、进行中任务和历史保持一致", () => {
  const broken = "  学习\uD83D\nGo\uDC00  ";
  const state = core.restore({
    version: 2, task: broken, activeTask: broken, mode: "focus", running: true, endAt: 1000000,
    sessions: [{ completedAt: 999999, minutes: 25, task: broken }]
  });
  assert.equal(state.task, "学习\uFFFD Go\uFFFD");
  assert.equal(state.activeTask, state.task);
  assert.equal(state.sessions[0].task, state.task);
  assert.equal(Buffer.from(state.task, "utf8").toString("utf8"), state.task);
  assert.equal(core.setTask(core.createState(), "番".repeat(79) + " " + "🍅").task, "番".repeat(79));
});

test("完成时间采用整数毫秒，损坏的浮点历史被隔离且旧计时进度可继续", () => {
  const state = core.restore({
    version: 2, mode: "focus", running: true, endAt: 2000000.25, remainingMs: 1000.5,
    sessions: [{ completedAt: 999999.5, minutes: 25, task: "损坏记录" }, { completedAt: 1000000, minutes: 25, task: "正常记录" }]
  });
  assert.equal(state.endAt, 2000001);
  assert.deepEqual(state.sessions, [{ completedAt: 1000000, minutes: 25, task: "正常记录" }]);
  const resumed = core.start({ ...state, running: false, endAt: null }, 3000000);
  assert.equal(resumed.endAt, 3001001);
  const completed = core.tick(resumed, resumed.endAt);
  assert.equal(completed.completed.completedAt, 3001001);
  assert.ok(Number.isInteger(completed.state.sessions.at(-1).completedAt));
  assert.equal(core.restore({ version: 2, running: true, endAt: 1e30 }).running, false);
});

test("今天与近七天筛选按自然日处理边界，并按完成时间倒序", () => {
  const now = new Date(2026, 9, 11, 10).getTime();
  const state = core.createState();
  const at = (day, hour = 0) => new Date(2026, 9, day, hour).getTime();
  state.sessions = [
    { completedAt: at(4, 23), minutes: 25, task: "Go" },
    { completedAt: at(5), minutes: 30, task: "Go" },
    { completedAt: at(11, 8), minutes: 40, task: "Python" },
    { completedAt: at(11, 9), minutes: 45, task: "GO" }
  ];
  assert.deepEqual(core.selectSessions(state, "week", "go", now).map((entry) => entry.minutes), [45, 30]);
  assert.deepEqual(core.selectSessions(state, "today", "", now).map((entry) => entry.minutes), [45, 40]);
  assert.equal(core.selectSessions(state, "all", "", now).length, 4);
  assert.equal(state.sessions[0].minutes, 25);
});

test("七天统计跨月连续，空日期补零", () => {
  const now = new Date(2026, 10, 2, 12).getTime();
  const state = core.createState();
  state.sessions = [{ completedAt: new Date(2026, 9, 31, 22).getTime(), minutes: 25, task: "学习" }];
  const week = core.weekStats(state, now);
  assert.equal(week.length, 7);
  assert.equal(new Date(week[0].date).getDate(), 27);
  assert.equal(new Date(week[6].date).getDate(), 2);
  assert.equal(week[4].minutes, 25);
  assert.equal(week[5].minutes, 0);
});

test("CSV 保留中文、逗号与引号，包含 BOM 和本地时间", () => {
  const csv = core.toCSV([{ completedAt: new Date(2026, 9, 11, 8, 5, 2).getTime(), minutes: 25, task: '阅读, "Go"' }]);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes('"2026-10-11 08:05:02","阅读, ""Go""","25"\r\n'));
  assert.equal(csv.split("\r\n").length, 3);
});

test("CSV 中的任务不会被表格软件当成公式", () => {
  for (const task of ['=HYPERLINK("url")', "+123", "-123", "@SUM(A1)", "  =1+1"]) {
    const csv = core.toCSV([{ completedAt: 1000000, minutes: 25, task }]);
    assert.ok(csv.includes('"\''));
  }
});

test("导出空列表仍有标题，筛选不会修改原历史", () => {
  assert.equal(core.toCSV([]).split("\r\n").length, 2);
  const state = core.createState();
  state.sessions = [{ completedAt: 1000000, minutes: 25, task: "Go" }];
  const before = JSON.stringify(state.sessions);
  core.toCSV(core.selectSessions(state, "all", "Go"));
  assert.equal(JSON.stringify(state.sessions), before);
});

test("保留最多一千条记录，丢弃最早一条并保留最新任务", () => {
  const state = core.setTask(core.createState(), "最新任务");
  state.sessions = Array.from({ length: 1000 }, (_, index) => ({ completedAt: index + 1, minutes: 25, task: "旧任务" }));
  const started = core.start(state, 1000000);
  const completed = core.tick(started, started.endAt).state;
  assert.equal(completed.sessions.length, 1000);
  assert.equal(completed.sessions[0].completedAt, 2);
  assert.equal(completed.sessions[999].task, "最新任务");
});

test("未知存储版本与超出 Date 范围的时间戳不会破坏历史界面", () => {
  assert.deepEqual(core.restore({ version: 999 }), core.createState());
  const state = core.restore({ version: 2, sessions: [{ completedAt: 1e30, minutes: 25, task: "坏记录" }, { completedAt: 1000000, minutes: 25, task: 123 }] });
  assert.deepEqual(state.sessions, [{ completedAt: 1000000, minutes: 25, task: "" }]);
});
