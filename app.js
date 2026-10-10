(function () {
  "use strict";
  const core = window.PomodoroCore;
  const storageKey = "tomato.state.v2";
  const element = (id) => document.getElementById(id);
  let state = core.createState();
  let audioContext;
  const activeSounds = new Set();
  let storageAvailable = true;
  let historyFilter = "all";
  let historyQuery = "";
  let historyPage = 1;
  let historyCache;
  const pageSize = 8;

  function notify(message) { element("notice").textContent = message; }
  try {
    // 首次升级读取第一版数据；保留旧键，避免破坏旧版的存档。
    state = core.restore(JSON.parse(localStorage.getItem(storageKey) ?? localStorage.getItem("tomato.state.v1")));
  } catch {
    // localStorage 不可用时，当前页面的计时仍能运行。
    storageAvailable = false;
    notify("本地存储不可用或记录损坏；当前页面仍可计时。");
  }

  function persist() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
      storageAvailable = true;
    } catch {
      storageAvailable = false;
      notify("无法保存进度，请保持页面打开以继续计时。");
    }
  }

  // 用振荡器合成柔和音效，不依赖音频下载；等待解锁完成，避免首次点击无声。
  async function unlockAudio() {
    if (!state.settings.sound) return false;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return false;
    try {
      audioContext ||= new AudioContext();
      if (audioContext.state !== "running") await audioContext.resume();
      return audioContext.state === "running";
    } catch { return false; }
  }

  function stopSounds() {
    for (const oscillator of activeSounds) {
      try { oscillator.stop(); } catch { /* 已结束的音效无需重复停止。 */ }
    }
    activeSounds.clear();
  }

  async function playSound(kind = "complete") {
    if (!await unlockAudio() || !state.settings.sound) return false;
    const melodies = {
      start: { notes: [440, 660], spacing: 0.09, length: 0.18, volume: 0.06 },
      pause: { notes: [440], spacing: 0, length: 0.16, volume: 0.05 },
      reset: { notes: [440, 330], spacing: 0.09, length: 0.18, volume: 0.05 },
      complete: { notes: [660, 880, 990], spacing: 0.22, length: 0.6, volume: 0.14 }
    };
    const melody = melodies[kind] || melodies.complete;
    try {
      stopSounds();
      melody.notes.forEach((frequency, index) => {
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        const startAt = audioContext.currentTime + index * melody.spacing;
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, startAt);
        gain.gain.linearRampToValueAtTime(melody.volume, startAt + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, startAt + melody.length);
        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start(startAt);
        oscillator.stop(startAt + melody.length + 0.05);
        activeSounds.add(oscillator);
        oscillator.onended = () => { activeSounds.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
      });
      return true;
    } catch { stopSounds(); return false; }
  }

  function handleCompletion(completed) {
    if (completed) {
      persist();
      void playSound("complete");
      notify(completed.mode === "focus" ? "专注完成，已记录一个番茄。准备好了，就开始休息吧。" : "休息结束。准备好了，再开始一个番茄吧。");
    }
  }

  function advance() {
    const result = core.tick(state, Date.now());
    state = result.state;
    handleCompletion(result.completed);
  }

  function renderHistory() {
    const now = Date.now();
    const day = new Date(now).toDateString();
    if (historyCache && historyCache.sessions === state.sessions && historyCache.day === day && historyCache.filter === historyFilter && historyCache.query === historyQuery && historyCache.page === historyPage) return;
    const sessions = core.selectSessions(state, historyFilter, historyQuery, now);
    const pages = Math.max(1, Math.ceil(sessions.length / pageSize));
    historyPage = Math.min(historyPage, pages);
    const minutes = sessions.reduce((sum, session) => sum + session.minutes, 0);
    element("history-summary").textContent = `共 ${sessions.length} 条记录 · ${minutes} 分钟`;
    element("export-history").disabled = sessions.length === 0;
    element("history-empty").hidden = sessions.length > 0;
    element("history-empty").querySelector("h3").textContent = state.sessions.length ? "这个范围内，还没有记录。" : "第一颗番茄，正在等你。";
    element("history-empty").querySelector("p").textContent = state.sessions.length ? "试试切换时间范围，或换一个任务关键词。" : "完成一次专注后，就能在这里看到记录。";
    const dateFormat = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
    const rows = sessions.slice((historyPage - 1) * pageSize, historyPage * pageSize).map((session) => {
      const row = document.createElement("li");
      const icon = Object.assign(document.createElement("span"), { className: "record-icon", textContent: "●" });
      icon.setAttribute("aria-hidden", "true");
      const detail = Object.assign(document.createElement("div"), { className: "record-detail" });
      // 用户输入只能作为文本插入，任务中包含 HTML 时也不会执行。
      const name = Object.assign(document.createElement("strong"), { textContent: session.task || "未命名专注" });
      const time = Object.assign(document.createElement("time"), { textContent: dateFormat.format(new Date(session.completedAt)), dateTime: new Date(session.completedAt).toISOString() });
      detail.append(name, time);
      const duration = Object.assign(document.createElement("span"), { className: "record-duration", textContent: `${session.minutes} 分钟` });
      row.append(icon, detail, duration);
      return row;
    });
    element("history-list").replaceChildren(...rows);
    element("history-pagination").hidden = pages <= 1;
    element("history-page").textContent = `${historyPage} / ${pages}`;
    element("history-prev").disabled = historyPage <= 1;
    element("history-next").disabled = historyPage >= pages;
    for (const button of document.querySelectorAll("[data-history-filter]")) {
      const active = button.dataset.historyFilter === historyFilter;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    const week = core.weekStats(state, now);
    const totalMinutes = week.reduce((sum, entry) => sum + entry.minutes, 0);
    element("week-minutes").replaceChildren(document.createTextNode(String(totalMinutes)), Object.assign(document.createElement("small"), { textContent: " 分钟" }));
    element("week-count").textContent = `完成 ${week.reduce((sum, entry) => sum + entry.count, 0)} 个番茄`;
    const maxMinutes = Math.max(1, ...week.map((entry) => entry.minutes));
    element("week-chart").replaceChildren(...week.map((entry, index) => {
      const column = Object.assign(document.createElement("div"), { className: `chart-column${index === 6 ? " today" : ""}` });
      const date = new Date(entry.date);
      column.setAttribute("role", "listitem");
      column.setAttribute("aria-label", `${date.getMonth() + 1}月${date.getDate()}日：${entry.minutes}分钟，${entry.count}个番茄`);
      const value = Object.assign(document.createElement("span"), { className: "chart-value", textContent: entry.minutes });
      const track = Object.assign(document.createElement("div"), { className: "chart-track" });
      const bar = Object.assign(document.createElement("div"), { className: `chart-bar${entry.minutes === 0 ? " empty" : ""}` });
      bar.style.height = entry.minutes === 0 ? "4px" : `${Math.max(8, entry.minutes / maxMinutes * 100)}%`;
      track.append(bar);
      const label = Object.assign(document.createElement("span"), { className: "chart-label", textContent: index === 6 ? "今天" : `${date.getMonth() + 1}/${date.getDate()}` });
      column.append(value, track, label);
      return column;
    }));
    historyCache = { sessions: state.sessions, day, filter: historyFilter, query: historyQuery, page: historyPage };
  }

  function render() {
    const focus = state.mode === "focus";
    const seconds = Math.ceil(state.remainingMs / 1000);
    const minutesText = String(Math.floor(seconds / 60)).padStart(2, "0");
    const secondsText = String(seconds % 60).padStart(2, "0");
    const text = `${minutesText}:${secondsText}`;
    element("time-display").textContent = text;
    element("time-display").setAttribute("aria-label", `剩余 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`);
    document.title = state.running ? `${text} · ${focus ? "专注" : "休息"} | 番茄` : "番茄 · 专注当下";
    document.body.classList.toggle("break-mode", !focus);
    document.body.classList.toggle("running", state.running);
    element("focus-mode").classList.toggle("active", focus);
    element("break-mode").classList.toggle("active", !focus);
    element("focus-mode").setAttribute("aria-pressed", String(focus));
    element("break-mode").setAttribute("aria-pressed", String(!focus));
    element("mode-caption").textContent = focus ? "留给自己的专注时间" : "让思绪和眼睛休息一下";
    const paused = !state.running && state.remainingMs < core.duration(state);
    element("timer-status").textContent = state.running ? (focus ? "专注中，每一刻都算数" : "休息中，给自己充充电") : paused ? "已暂停，按你的节奏来" : "准备好，就开始吧";
    element("start-label").textContent = state.running ? "暂停计时" : paused ? "继续计时" : focus ? "开始专注" : "开始休息";
    element("start-icon").textContent = state.running ? "Ⅱ" : "▶";
    element("ring-progress").style.strokeDashoffset = String(929.912 * (1 - state.remainingMs / core.duration(state)));
    element("save-settings").disabled = state.running;
    element("focus-duration").disabled = state.running;
    element("break-duration").disabled = state.running;
    element("sound-state").textContent = state.settings.sound ? "已开启" : "已关闭";
    element("sound-state").classList.toggle("muted", !state.settings.sound);
    element("preview-sound").disabled = !state.settings.sound;
    element("task-name").disabled = core.taskLocked(state);
    element("task-help").textContent = core.taskLocked(state) ? "本轮任务已锁定；完成或重置后可修改。" : state.mode === "break" ? "休息时可以提前写好下一轮的任务。" : "可留空。完成一个番茄后，任务会记入专注历史。";
    const stats = core.todayStats(state, Date.now());
    element("today-count").textContent = stats.count;
    element("today-minutes").replaceChildren(document.createTextNode(String(stats.minutes)), Object.assign(document.createElement("small"), { textContent: " 分钟" }));
    element("today-date").textContent = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date());
    element("stats-hint").textContent = stats.count === 0 ? "种下今天的第一颗番茄。" : `今天已完成 ${stats.count} 个番茄，继续按自己的节奏来。`;
    element("session-dots").replaceChildren(...Array.from({ length: 8 }, (_, index) => Object.assign(document.createElement("span"), { className: `session-dot${index < stats.count ? " done" : ""}` })));
    renderHistory();
  }

  element("start-button").addEventListener("click", () => {
    void unlockAudio();
    const wasRunning = state.running;
    advance();
    // 如果点击时恰好到期，只完成旧一轮，不立即启动下一轮。
    if (wasRunning && !state.running) { render(); return; }
    if (state.running) {
      const result = core.pause(state, Date.now());
      state = result.state;
      // 点击暂停与到期重合时，也必须处理完成提醒。
      if (result.completed) { handleCompletion(result.completed); render(); return; }
    } else {
      state = core.start(state, Date.now());
    }
    void playSound(state.running ? "start" : "pause");
    notify(storageAvailable ? "" : "当前进度无法持久保存，请保持页面打开。");
    persist();
    render();
  });

  element("reset-button").addEventListener("click", () => {
    advance();
    state = core.reset(state);
    void playSound("reset");
    notify("当前计时已重置。");
    persist(); render();
  });

  for (const mode of ["focus", "break"]) {
    element(`${mode}-mode`).addEventListener("click", () => {
      advance();
      if (state.mode !== mode) {
        // 模式切换会放弃未完成的一轮，不计入今日统计。
        if ((state.running || state.remainingMs < core.duration(state)) && !window.confirm("切换模式会重置当前计时，确定切换吗？")) return;
        state = core.reset(state, mode);
        notify(mode === "focus" ? "专注模式已就绪。" : "休息模式已就绪。");
        persist();
      }
      render();
    });
  }

  element("settings-form").addEventListener("submit", (event) => {
    event.preventDefault();
    advance();
    if (state.running) return;
    try {
      state = core.configure(state, Number(element("focus-duration").value), Number(element("break-duration").value));
      persist();
      notify("时长已保存，当前计时已重置。");
      render();
    } catch { notify("请输入整数：专注 1–180 分钟，休息 1–60 分钟。"); }
  });

  element("sound-toggle").addEventListener("change", (event) => {
    state.settings.sound = event.target.checked;
    if (state.settings.sound) void playSound("start");
    else stopSounds();
    notify(state.settings.sound ? "音效已开启，可点击试听确认声音。" : "音效已关闭，计时结束仍会显示文字提醒。");
    persist();
    render();
  });

  element("preview-sound").addEventListener("click", async () => {
    if (!state.settings.sound) return;
    const played = await playSound("complete");
    // 等待浏览器解锁声音期间，用户可能已经关闭开关。
    if (!state.settings.sound) return;
    notify(played ? "正在试听结束提示音。" : "声音暂时无法播放，请检查浏览器和系统声音设置。");
  });

  element("task-name").addEventListener("input", (event) => {
    advance();
    if (core.taskLocked(state)) return;
    state = core.setTask(state, event.target.value);
    element("task-counter").textContent = `${event.target.value.length} / 80`;
    persist();
  });
  element("task-name").addEventListener("blur", () => {
    element("task-name").value = state.task;
    element("task-counter").textContent = `${state.task.length} / 80`;
  });

  for (const button of document.querySelectorAll("[data-history-filter]")) {
    button.addEventListener("click", () => {
      historyFilter = button.dataset.historyFilter;
      historyPage = 1;
      renderHistory();
    });
  }
  element("history-query").addEventListener("input", (event) => {
    historyQuery = event.target.value;
    historyPage = 1;
    renderHistory();
  });
  element("history-prev").addEventListener("click", () => { historyPage = Math.max(1, historyPage - 1); renderHistory(); });
  element("history-next").addEventListener("click", () => { historyPage += 1; renderHistory(); });
  element("export-history").addEventListener("click", () => {
    advance();
    const sessions = core.selectSessions(state, historyFilter, historyQuery, Date.now());
    if (!sessions.length) { renderHistory(); return; }
    try {
      const blob = new Blob([core.toCSV(sessions)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const date = new Date();
      link.href = url;
      link.download = `tomato-${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}.csv`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      element("history-notice").textContent = `已生成 ${sessions.length} 条筛选记录的 CSV 文件。`;
    } catch {
      element("history-notice").textContent = "浏览器未能导出文件，请在 Chrome 或 Edge 中尝试。";
    }
    render();
  });

  element("task-name").value = state.task;
  element("task-counter").textContent = `${state.task.length} / 80`;
  element("focus-duration").value = state.settings.focus;
  element("break-duration").value = state.settings.break;
  element("sound-toggle").checked = state.settings.sound;
  // 重新打开页面时按原结束时间校正；已到期的专注只记录一次。
  advance(); persist(); render();
  setInterval(() => { advance(); render(); }, 250);
  document.addEventListener("visibilitychange", () => { advance(); persist(); render(); });
  window.addEventListener("pagehide", persist);
})();
