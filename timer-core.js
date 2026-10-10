/* 计时核心不依赖浏览器，方便用 Node.js 验证时间计算。 */
(function (root) {
  "use strict";
  const limits = { focus: 180, break: 60 };
  const duration = (state) => state.settings[state.mode] * 60000;
  const validMinute = (value, max) => Number.isInteger(value) && value >= 1 && value <= max;
  const taskName = (value) => typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 80) : "";

  function createState() {
    return { version: 2, settings: { focus: 25, break: 5, sound: true }, task: "", activeTask: null, mode: "focus", remainingMs: 1500000, endAt: null, running: false, sessions: [] };
  }

  // 恢复时校验数据；浏览器存储可能来自旧版本，也可能已损坏。
  function restore(raw) {
    const state = createState();
    if (!raw || ![1, 2].includes(raw.version)) return state;
    for (const mode of ["focus", "break"]) {
      if (validMinute(raw.settings?.[mode], limits[mode])) state.settings[mode] = raw.settings[mode];
    }
    if (typeof raw.settings?.sound === "boolean") state.settings.sound = raw.settings.sound;
    state.mode = raw.mode === "break" ? "break" : "focus";
    state.remainingMs = Number.isFinite(raw.remainingMs) && raw.remainingMs >= 0 && raw.remainingMs <= duration(state) ? raw.remainingMs : duration(state);
    state.running = raw.running === true && Number.isFinite(raw.endAt) && raw.endAt > 0;
    state.endAt = state.running ? raw.endAt : null;
    state.task = taskName(raw.task);
    // 第一版记录没有任务名称，升级时保留计时与记录并补齐字段。
    state.activeTask = state.mode === "focus" && (state.running || state.remainingMs < duration(state)) ? taskName(raw.activeTask ?? raw.task) : null;
    if (Array.isArray(raw.sessions)) {
      state.sessions = raw.sessions.filter((session) => session && Number.isFinite(session.completedAt) && session.completedAt > 0 && session.completedAt <= 8640000000000000 && validMinute(session.minutes, 180)).slice(-1000).map(({ completedAt, minutes, task }) => ({ completedAt, minutes, task: taskName(task) }));
    }
    return state;
  }

  // 定时器仅负责唤醒；真正的剩余时间由绝对结束时间计算。
  function tick(state, now) {
    if (!state.running) return { state, completed: null };
    const remainingMs = Math.min(duration(state), Math.max(0, state.endAt - now));
    if (remainingMs > 0) return { state: { ...state, remainingMs }, completed: null };
    const completed = { mode: state.mode, completedAt: state.endAt, minutes: state.settings[state.mode], task: state.activeTask ?? state.task };
    const mode = state.mode === "focus" ? "break" : "focus";
    const sessions = state.mode === "focus" ? [...state.sessions, { completedAt: completed.completedAt, minutes: completed.minutes, task: completed.task }].slice(-1000) : state.sessions;
    const next = { ...state, mode, activeTask: null, running: false, endAt: null, sessions };
    next.remainingMs = duration(next);
    return { state: next, completed };
  }

  function start(state, now) {
    if (state.running) return state;
    const remainingMs = state.remainingMs > 0 ? state.remainingMs : duration(state);
    return { ...state, remainingMs, activeTask: state.mode === "focus" ? (state.activeTask ?? state.task) : null, running: true, endAt: now + remainingMs };
  }

  function pause(state, now) {
    const result = tick(state, now);
    return { ...result, state: { ...result.state, running: false, endAt: null } };
  }

  function reset(state, mode = state.mode) {
    const next = { ...state, mode: mode === "break" ? "break" : "focus", activeTask: null, running: false, endAt: null };
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

  function taskLocked(state) {
    return state.mode === "focus" && (state.running || state.remainingMs < duration(state));
  }

  function setTask(state, value) {
    if (taskLocked(state)) throw new Error("请先完成或重置当前专注，再修改任务");
    return { ...state, task: taskName(value) };
  }

  // 用本地自然日计算最近七天，避免把“一天”简单当成固定毫秒数。
  function weekStats(state, now) {
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(now);
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() - 6 + index);
      const stats = todayStats(state, date.getTime());
      return { date: date.getTime(), ...stats };
    });
  }

  function selectSessions(state, filter = "all", query = "", now = Date.now()) {
    const days = new Set(weekStats(state, now).map((day) => dayKey(day.date)));
    const search = taskName(query).toLocaleLowerCase();
    return state.sessions.filter((session) => {
      const day = dayKey(session.completedAt);
      const inRange = filter === "today" ? day === dayKey(now) : filter === "week" ? days.has(day) : true;
      return inRange && (session.task || "未命名专注").toLocaleLowerCase().includes(search);
    }).slice().sort((a, b) => b.completedAt - a.completedAt);
  }

  function toCSV(sessions) {
    const quote = (value) => {
      let text = String(value);
      // 任务名称来自用户输入，避免导出后被表格软件当成公式执行。
      if (/^\s*[=+\-@]/.test(text)) text = "'" + text;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const localTime = (timestamp) => {
      const date = new Date(timestamp);
      const pad = (number) => String(number).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    };
    const rows = [["完成时间（本地）", "任务名称", "专注分钟"], ...sessions.map((session) => [localTime(session.completedAt), session.task || "未命名专注", session.minutes])];
    // BOM 帮助 Excel 正确识别中文；双引号与 CRLF 按 CSV 规则编码。
    return "\uFEFF" + rows.map((row) => row.map(quote).join(",")).join("\r\n") + "\r\n";
  }

  const api = { createState, restore, tick, start, pause, reset, configure, todayStats, duration, taskLocked, setTask, weekStats, selectSessions, toCSV };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PomodoroCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
