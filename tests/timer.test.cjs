const { test } = require("node:test");
const assert = require("node:assert/strict");
const core = require("../timer-core.js");

test("后台长时间不执行定时器，仍按结束时间校正", () => {
  const state = core.start(core.createState(), 1000000);
  assert.equal(core.tick(state, 1123456).state.remainingMs, 1376544);
});
test("暂停后经过很久也不会扣时间，继续时重新计算结束时间", () => {
  const paused = core.pause(core.start(core.createState(), 1000000), 1060000).state;
  assert.equal(paused.remainingMs, 1440000);
  assert.equal(core.tick(paused, 9000000).state.remainingMs, 1440000);
  assert.equal(core.start(paused, 9000000).endAt, 10440000);
});
test("刷新后恢复正在进行的一轮", () => {
  const saved = JSON.parse(JSON.stringify(core.start(core.createState(), 1000000)));
  assert.equal(core.tick(core.restore(saved), 1180000).state.remainingMs, 1320000);
});
test("重新打开已到期计时，只记录一次并等待手动开始休息", () => {
  const started = core.start(core.createState(), 1000000);
  const first = core.tick(core.restore(started), 9999999);
  assert.equal(first.completed.mode, "focus");
  assert.equal(first.state.sessions.length, 1);
  assert.equal(first.state.sessions[0].completedAt, 2500000);
  assert.equal(first.state.mode, "break");
  assert.equal(first.state.running, false);
  assert.equal(first.state.remainingMs, 300000);
  const second = core.tick(core.restore(JSON.parse(JSON.stringify(first.state))), 99999999);
  assert.equal(second.completed, null);
  assert.equal(second.state.sessions.length, 1);
});
test("休息完成不增加番茄数，重置和切换模式也不增加", () => {
  const state = core.reset(core.createState(), "break");
  const result = core.tick(core.start(state, 1000000), 1300000);
  assert.equal(result.state.mode, "focus");
  assert.equal(result.state.sessions.length, 0);
  assert.equal(core.reset(core.start(core.createState(), 1000000)).sessions.length, 0);
});
test("设置时长校验整数和上下界", () => {
  const state = core.configure(core.createState(), 180, 60);
  assert.equal(state.remainingMs, 10800000);
  for (const invalid of [0, -1, 181, 1.5, NaN, Infinity]) assert.throws(() => core.configure(state, invalid, 5), RangeError);
  assert.throws(() => core.configure(state, 25, 61), RangeError);
});
test("损坏或过期的存储不会产生非法计时", () => {
  assert.deepEqual(core.restore(null), core.createState());
  const restored = core.restore({ version: 1, mode: "bad", settings: { focus: -10 }, remainingMs: Infinity, running: true, endAt: "bad", sessions: [null, {}, { completedAt: 10, minutes: 25 }] });
  assert.equal(restored.mode, "focus");
  assert.equal(restored.remainingMs, 1500000);
  assert.equal(restored.running, false);
  assert.equal(restored.sessions.length, 1);
});
test("今日统计按实际完成日期归属，不按重新打开页面的日期", () => {
  const yesterday = new Date(2026, 9, 10, 23, 59).getTime();
  const today = new Date(2026, 9, 11, 0, 1).getTime();
  const state = core.createState();
  state.sessions = [{ completedAt: yesterday, minutes: 25 }, { completedAt: today, minutes: 30 }];
  assert.deepEqual(core.todayStats(state, today), { count: 1, minutes: 30 });
});
