/* 计时核心不依赖浏览器，方便用 Node.js 验证时间计算。 */
(function (root) {
  "use strict";
  const limits = { focus: 180, break: 60 };
  const duration = (state) => state.settings[state.mode] * 60000;
  const validMinute = (value, max) => Number.isInteger(value) && value >= 1 && value <= max;

  function createState() {
    return { version: 1, settings: { focus: 25, break: 5, sound: true }, mode: "focus", remainingMs: 1500000, endAt: null, running: false, sessions: [] };
  }

  // 恢复时校验数据；浏览器存储可能来自旧版本，也可能已损坏。
  function restore(raw) {
    const state = createState();
    if (!raw || raw.version !== 1) return state;
    for (const mode of ["focus", "break"]) {
      if (validMinute(raw.settings?.[mode], limits[mode])) state.settings[mode] = raw.settings[mode];
    }
    if (typeof raw.settings?.sound === "boolean") state.settings.sound = raw.settings.sound;
    state.mode = raw.mode === "break" ? "break" : "focus";
    state.remainingMs = Number.isFinite(raw.remainingMs) && raw.remainingMs >= 0 && raw.remainingMs <= duration(state) ? raw.remainingMs : duration(state);
    state.running = raw.running === true && Number.isFinite(raw.endAt) && raw.endAt > 0;
    state.endAt = state.running ? raw.endAt : null;
    if (Array.isArray(raw.sessions)) {
      state.sessions = raw.sessions.filter((session) => session && Number.isFinite(session.completedAt) && session.completedAt > 0 && validMinute(session.minutes, 180)).slice(-1000).map(({ completedAt, minutes }) => ({ completedAt, minutes }));
    }
    return state;
  }

  // 定时器仅负责唤醒；真正的剩余时间由绝对结束时间计算。
  function tick(state, now) {
    if (!state.running) return { state, completed: null };
    const remainingMs = Math.min(duration(state), Math.max(0, state.endAt - now));
    if (remainingMs > 0) return { state: { ...state, remainingMs }, completed: null };
    const completed = { mode: state.mode, completedAt: state.endAt, minutes: state.settings[state.mode] };
    const mode = state.mode === "focus" ? "break" : "focus";
    const sessions = state.mode === "focus" ? [...state.sessions, { completedAt: completed.completedAt, minutes: completed.minutes }].slice(-1000) : state.sessions;
    const next = { ...state, mode, running: false, endAt: null, sessions };
    next.remainingMs = duration(next);
    return { state: next, completed };
  }

  function start(state, now) {
    if (state.running) return state;
    const remainingMs = state.remainingMs > 0 ? state.remainingMs : duration(state);
    return { ...state, remainingMs, running: true, endAt: now + remainingMs };
  }

  function pause(state, now) {
    const result = tick(state, now);
    return { ...result, state: { ...result.state, running: false, endAt: null } };
  }

  function reset(state, mode = state.mode) {
    const next = { ...state, mode: mode === "break" ? "break" : "focus", running: false, endAt: null };
    return { ...next, remainingMs: duration(next) };
  }

  function configure(state, focus, rest) {
    if (!validMinute(focus, 180) || !validMinute(rest, 60)) throw new RangeError("请输入有效的整数时长");
    return reset({ ...state, settings: { ...state.settings, focus, break: rest } });
  }

  function dayKey(timestamp) {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  }

  function todayStats(state, now) {
    const today = dayKey(now);
    const sessions = state.sessions.filter((session) => dayKey(session.completedAt) === today);
    return { count: sessions.length, minutes: sessions.reduce((total, session) => total + session.minutes, 0) };
  }

  const api = { createState, restore, tick, start, pause, reset, configure, todayStats, duration };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PomodoroCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
