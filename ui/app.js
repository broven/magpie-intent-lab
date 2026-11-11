// The service takes a token of its own on /api (see src/server.ts), and
// is asked by relative address so it works behind magpie web's proxy path.
const API_TOKEN = document.querySelector('meta[name="intent-lab-token"]')?.content ?? "";
function api(path, init = {}) {
  return fetch(path.replace(/^\//, ""), { ...init, headers: { ...(init.headers || {}), "x-intent-lab-token": API_TOKEN } });
}
const $ = (selector, root = document) => root.querySelector(selector);

const state = {
  groups: [],
  group: null,
  draft: null,
  result: null,
  filterChanged: false,
  filterIntent: "",
  applyPreviewed: false,
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setHidden(node, hidden) {
  if (node) node.hidden = hidden;
}

function formatTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value || "—";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function shortText(text, length = 160) {
  const runes = Array.from(String(text || ""));
  return runes.length > length ? runes.slice(0, length).join("") + "…" : runes.join("");
}

function sureText(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "—";
}

function ruleSummary(rule) {
  const extras = [];
  if (rule.more?.length) extras.push(`more=${rule.more.join(",")}`);
  if (rule.agents?.length) extras.push(`agents=${rule.agents.join(",")}`);
  if (rule.tokens != null) extras.push(`tokens=${rule.tokens}`);
  if (rule.images) extras.push("images");
  if (rule.effort) extras.push(`effort=${rule.effort}`);
  if (rule.useEffort) extras.push(`use-effort=${rule.useEffort}`);
  if (rule.compact) extras.push("compact");
  if (rule.time) extras.push(`time=${rule.time.from}-${rule.time.to}${rule.time.zone ? " " + rule.time.zone : ""}`);
  if (rule.folders?.length) extras.push(`folders=${rule.folders.join(",")}`);
  if (rule.exceptFolders?.length) extras.push(`except-folders=${rule.exceptFolders.join(",")}`);
  if (rule.where?.length) extras.push(`where=${rule.where.length}`);
  if (rule.pause) extras.push("pause");
  return extras.join(" · ");
}

function sideCell(side) {
  const wrap = el("div");
  wrap.append(el("div", "intent", side?.intent || "(none)"));
  wrap.append(el("div", "sure", `sure ${sureText(side?.sure)}`));
  wrap.append(el("div", "model", side?.use || "—"));
  return wrap;
}

function renderGroupMeta() {
  const group = state.group;
  const meta = $("#group-meta");
  if (!group) { meta.textContent = ""; return; }
  const sure = group.intentSure == null ? "默认 0.4" : String(group.intentSure);
  meta.textContent = `分类器 ${group.classifier || "—"} · intentSure ${sure} · ${group.members?.length ?? 0} 个成员`;
}

function renderCurrentRules() {
  const wrap = $("#current-rules");
  wrap.replaceChildren();
  const rules = state.group?.rules ?? [];
  if (!rules.length) {
    wrap.append(el("p", "empty-state", "这个组没有规则。"));
    return;
  }
  rules.forEach((rule, index) => {
    const card = el("div", "rule");
    const head = el("div", "rule-head");
    head.append(el("span", "num", String(index + 1)));
    head.append(el("span", "intent", rule.intent || "(无 intent)"));
    head.append(el("span", "muted", rule.use || "(无 use)"));
    card.append(head);
    const extra = ruleSummary(rule);
    if (extra) card.append(el("div", "meta", extra));
    wrap.append(card);
  });
}

function renderDraft() {
  const wrap = $("#draft-rules");
  wrap.replaceChildren();
  const sure = $("#intent-sure");
  sure.value = state.draft?.intentSure == null ? "" : String(state.draft.intentSure);
  const rules = state.draft?.rules ?? [];
  if (!rules.length) {
    wrap.append(el("p", "empty-state", "草稿里还没有规则。"));
    return;
  }
  const members = state.group?.members ?? [];
  rules.forEach((rule, index) => {
    const card = el("div", "rule");
    const head = el("div", "rule-head");
    head.append(el("span", "num", String(index + 1)));

    const intent = document.createElement("input");
    intent.type = "text";
    intent.value = rule.intent ?? "";
    intent.placeholder = "intent 文本（留空表示不按 intent 匹配）";
    intent.addEventListener("input", () => {
      rule.intent = intent.value;
      invalidateApply();
    });
    head.append(intent);

    const use = document.createElement("select");
    const options = [...members];
    if (rule.use && !options.includes(rule.use)) options.push(rule.use);
    if (!options.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "（组没有成员）";
      use.append(option);
    }
    for (const member of options) {
      const option = document.createElement("option");
      option.value = member;
      option.textContent = members.includes(member) ? member : `${member}（非组成员）`;
      if (!members.includes(member)) option.disabled = true;
      use.append(option);
    }
    use.value = rule.use ?? "";
    use.addEventListener("change", () => {
      rule.use = use.value;
      invalidateApply();
    });
    head.append(use);

    const remove = el("button", "secondary", "删除");
    remove.type = "button";
    remove.addEventListener("click", () => {
      state.draft.rules.splice(index, 1);
      renderDraft();
      invalidateApply();
    });
    head.append(remove);
    card.append(head);

    const extra = ruleSummary(rule);
    if (extra) card.append(el("div", "meta", extra));
    wrap.append(card);
  });
}

function selectGroup(id) {
  const group = state.groups.find(item => item.id === id);
  if (!group) return;
  state.group = group;
  state.draft = {
    rules: structuredClone(group.rules ?? []),
    intentSure: group.intentSure ?? null,
  };
  state.result = null;
  $("#group-select").value = group.id;
  renderGroupMeta();
  renderCurrentRules();
  renderDraft();
  renderResults();
  renderSummary();
  setHidden($("#summary-panel"), true);
  setHidden($("#results-panel"), true);
  const unsupported = $("#unsupported");
  if (group.supported) {
    setHidden(unsupported, true);
  } else {
    unsupported.textContent = group.reason || "该组的分类器不是 System One 决策模型，无法回测。";
    setHidden(unsupported, false);
  }
  $("#run-button").disabled = !group.supported;
  setHidden($("#apply-panel"), false);
  invalidateApply("尚未预览。");
}

async function loadGroups() {
  const response = await api("/api/groups");
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  state.groups = data.groups ?? [];
  const select = $("#group-select");
  select.replaceChildren();
  for (const group of state.groups) {
    const option = document.createElement("option");
    option.value = group.id;
    option.textContent = group.name && group.name !== group.id ? `${group.id} — ${group.name}` : group.id;
    select.append(option);
  }
  if (!state.groups.length) {
    $("#current-rules").replaceChildren(el("p", "empty-state", "没有带 intent 规则的路由组。"));
    $("#run-button").disabled = true;
    return;
  }
  const wanted = state.groups.some(group => group.id === "claude-opus") ? "claude-opus" : state.groups[0].id;
  selectGroup(wanted);
}

function setProgress(done, total, phase) {
  const fill = $("#progress-fill");
  const text = $("#progress-text");
  if (phase === "history") {
    fill.style.width = "4%";
    text.textContent = "正在读取历史样本…";
    return;
  }
  const percent = total > 0 ? Math.max(2, Math.min(100, Math.round(100 * done / total))) : 0;
  fill.style.width = percent + "%";
  text.textContent = `回测中 ${done}/${total}`;
}

async function runBacktest(body) {
  const response = await api("/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    try { throw new Error(JSON.parse(text).error || text); } catch (err) { throw err instanceof Error ? err : new Error(text); }
  }
  if (!response.body) throw new Error("服务没有返回进度流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (!event || !data) continue;
      const parsed = JSON.parse(data);
      if (event === "progress") setProgress(parsed.done ?? 0, parsed.total ?? 0, parsed.phase);
      else if (event === "result") result = parsed;
      else if (event === "error") throw new Error(parsed.error || "回测失败");
    }
  }
  if (!result) throw new Error("回测没有返回结果");
  return result;
}

function renderSummary() {
  const summaryNode = $("#summary");
  summaryNode.replaceChildren();
  if (!state.result) return;
  const { rows, summary, stats, cache } = state.result;

  const grid = el("div", "summary-grid");
  const stat = (label, value) => {
    const box = el("div", "stat");
    box.append(el("b", "", String(value)));
    box.append(el("span", "", label));
    grid.append(box);
  };
  stat("样本", rows.length);
  stat("变化", summary.changed);
  stat("当前 intent 数", Object.keys(summary.current ?? {}).length);
  stat("草稿 intent 数", Object.keys(summary.draft ?? {}).length);
  if (cache) stat("Jev 新请求 / 缓存命中", `${cache.requests ?? 0} / ${cache.hits ?? 0}`);
  summaryNode.append(grid);

  if (stats?.agents) {
    const cards = el("div", "agent-stats");
    for (const agent of ["claude", "codex", "pi"]) {
      const item = stats.agents[agent];
      if (!item) continue;
      const card = el("div", "agent-stat");
      card.append(el("div", "agent-name", agent));
      const line = (label, value) => {
        const row = el("div", "kv");
        row.append(el("span", "", label));
        row.append(el("b", "", String(value)));
        card.append(row);
      };
      line("routing", item.routingRecords);
      line("关联", item.linkedRecords);
      line("transcript", item.transcripts);
      line("命中率", `${(100 * item.hitRate).toFixed(2)}%`);
      line("turn", item.turns);
      line("ambiguous", item.ambiguous);
      cards.append(card);
    }
    summaryNode.append(cards);
  }

  const transitions = summary.transitions ?? {};
  const froms = Object.keys(transitions).sort();
  const tos = [...new Set([...Object.keys(summary.current ?? {}), ...Object.keys(summary.draft ?? {})])].sort();
  if (froms.length) {
    const title = el("h3", "", "current → draft 转移矩阵");
    title.style.fontSize = "13px";
    title.style.margin = "14px 0 6px";
    summaryNode.append(title);
    const wrap = el("div", "matrix-wrap");
    const table = el("table");
    const thead = el("thead");
    const headRow = el("tr");
    headRow.append(el("th", "", "current \\ draft"));
    for (const to of tos) headRow.append(el("th", "", to));
    thead.append(headRow);
    table.append(thead);
    const tbody = el("tbody");
    for (const from of froms) {
      const row = el("tr");
      row.append(el("th", "", from));
      for (const to of tos) row.append(el("td", "", String(transitions[from]?.[to] ?? 0)));
      tbody.append(row);
    }
    table.append(tbody);
    wrap.append(table);
    summaryNode.append(wrap);
  }

  renderIntentFilter();
}

function renderIntentFilter() {
  const select = $("#intent-filter");
  const previous = state.filterIntent;
  select.replaceChildren();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "全部";
  select.append(all);
  const values = new Set([
    ...Object.keys(state.result?.summary?.current ?? {}),
    ...Object.keys(state.result?.summary?.draft ?? {}),
  ]);
  for (const value of [...values].sort()) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.append(option);
  }
  state.filterIntent = values.has(previous) ? previous : "";
  select.value = state.filterIntent;
}

function detailRow(row) {
  const tr = el("tr", "detail");
  const td = document.createElement("td");
  td.colSpan = 8;
  const grid = el("div", "detail-grid");

  const full = el("div");
  full.append(el("h3", "", "全文"));
  full.append(el("pre", "", row.fullText || row.text || ""));
  grid.append(full);

  const prev = el("div");
  prev.append(el("h3", "", "上一轮上下文"));
  const user = el("pre", "", row.prev?.user || "(无)");
  const reply = el("pre", "", row.prev?.reply || "(无)");
  prev.append(el("h3", "", "上一轮用户"));
  prev.append(user);
  prev.append(el("h3", "", "上一轮回复"));
  prev.append(reply);
  grid.append(prev);

  const raw = (title, side, value) => {
    const box = el("div");
    box.append(el("h3", "", title));
    if (value === undefined || value === null) {
      box.append(el("div", "empty-state", "(没有调用 Jev)"));
      return box;
    }
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "展开原始答案";
    details.append(summary);
    details.append(el("pre", "", JSON.stringify(value, null, 2)));
    box.append(details);
    return box;
  };
  grid.append(raw("当前 Jev 原始答案", "current", row.currentRaw));
  grid.append(raw("草稿 Jev 原始答案", "draft", row.draftRaw));

  td.append(grid);
  tr.append(td);
  return tr;
}

function renderResults() {
  const body = $("#result-body");
  body.replaceChildren();
  const empty = $("#result-empty");
  if (!state.result) {
    setHidden(empty, false);
    empty.textContent = "还没有回测结果。";
    return;
  }
  const rows = state.result.rows.filter(row => {
    if (state.filterChanged && !row.changed) return false;
    if (state.filterIntent && row.current?.intent !== state.filterIntent && row.draft?.intent !== state.filterIntent) return false;
    return true;
  });
  if (!rows.length) {
    setHidden(empty, false);
    empty.textContent = "没有符合条件的结果。";
    return;
  }
  setHidden(empty, true);
  for (const row of rows) {
    const tr = el("tr", "result-row");
    const cell = (label, content, className = "") => {
      const td = el("td", className);
      td.dataset.label = label;
      if (content instanceof Node) td.append(content);
      else td.textContent = content;
      return td;
    };
    tr.append(cell("时间", formatTime(row.time)));
    tr.append(cell("agent", row.agent));
    tr.append(cell("folder", row.folder || "—"));
    tr.append(cell("消息摘要", shortText(row.fullText || row.text, 120), "msg"));
    tr.append(cell("当前 intent · sure · 模型", sideCell(row.current)));
    tr.append(cell("草稿 intent · sure · 模型", sideCell(row.draft)));
    const changed = el("span", row.changed ? "badge" : "badge none", row.changed ? "变化" : "—");
    tr.append(cell("变化", changed));
    const unknown = row.unknownConds?.length
      ? el("span", "badge warn", `${row.unknownConds.length} 个`)
      : el("span", "badge none", "—");
    tr.append(cell("unknown", unknown));
    tr.addEventListener("click", () => {
      const next = tr.nextElementSibling;
      if (next?.classList.contains("detail")) {
        next.remove();
      } else {
        tr.after(detailRow(row));
      }
    });
    body.append(tr);
  }
}

function invalidateApply(message = "草稿已修改，请重新预览。") {
  state.applyPreviewed = false;
  $("#apply-run").disabled = true;
  $("#apply-status").textContent = message;
  setHidden($("#apply-error"), true);
  setHidden($("#apply-commands"), true);
  setHidden($("#apply-readback"), true);
}

async function postApply(body) {
  const response = await api("/api/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text || `HTTP ${response.status}` }; }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function showApplyError(message) {
  const error = $("#apply-error");
  error.textContent = message || "写回失败";
  setHidden(error, false);
}

function renderApplyPlan(data) {
  const commands = data.commands ?? [];
  const rejected = data.rejected ?? [];
  const pre = $("#apply-commands");
  pre.textContent = commands.join("\n");
  setHidden(pre, !commands.length);
  if (data.error) {
    showApplyError(data.error);
  } else if (rejected.length) {
    showApplyError(rejected.map(item => `规则 ${item.rule}: ${item.reason}`).join("；"));
  } else {
    setHidden($("#apply-error"), true);
  }
  if (data.error || !commands.length) {
    $("#apply-status").textContent = data.error
      ? "无法生成写回命令。"
      : rejected.length
        ? "没有可执行的命令，部分规则无法写回。"
        : "草稿与当前规则一致，没有需要执行的命令。";
    state.applyPreviewed = false;
    $("#apply-run").disabled = true;
  } else {
    $("#apply-status").textContent = `共 ${commands.length} 条命令。确认后执行，执行完会读回规则。`;
    state.applyPreviewed = true;
    $("#apply-run").disabled = false;
  }
}

async function refreshGroup() {
  if (!state.group) return;
  const response = await api("/api/groups");
  if (!response.ok) return;
  const data = await response.json();
  state.groups = data.groups ?? state.groups;
  const fresh = state.groups.find(group => group.id === state.group.id);
  if (!fresh) return;
  state.group = fresh;
  renderGroupMeta();
  renderCurrentRules();
}

function renderApplyResult(data) {
  const executed = data.executed ?? [];
  const pre = $("#apply-commands");
  pre.textContent = executed.map(item => {
    const output = [item.stdout?.trim(), item.stderr?.trim()].filter(Boolean).join("\n");
    return `$ ${item.command}${output ? "\n" + output : ""}`;
  }).join("\n\n");
  setHidden(pre, !executed.length);
  const readBack = $("#apply-readback");
  if (data.readBack) {
    readBack.textContent = data.readBack;
    setHidden(readBack, false);
  } else {
    setHidden(readBack, true);
  }
  if (data.ok) {
    $("#apply-status").textContent = "执行完成，已读回规则。";
    setHidden($("#apply-error"), true);
    state.applyPreviewed = false;
    $("#apply-run").disabled = true;
    refreshGroup();
  } else {
    showApplyError(data.error || "写回失败");
    $("#apply-status").textContent = "执行失败。";
    state.applyPreviewed = false;
    $("#apply-run").disabled = true;
  }
}

$("#group-select").addEventListener("change", event => selectGroup(event.target.value));

$("#intent-sure").addEventListener("input", event => {
  if (!state.draft) return;
  const raw = event.target.value.trim();
  state.draft.intentSure = raw === "" ? null : Number(raw);
  invalidateApply();
});

$("#add-rule").addEventListener("click", () => {
  if (!state.draft) return;
  state.draft.rules.push({ use: state.group?.members?.[0] ?? "", intent: "" });
  renderDraft();
  invalidateApply();
});

$("#only-changed").addEventListener("change", event => {
  state.filterChanged = event.target.checked;
  renderResults();
});

$("#intent-filter").addEventListener("change", event => {
  state.filterIntent = event.target.value;
  renderResults();
});

$("#run-button").addEventListener("click", async () => {
  if (!state.group || !state.group.supported || !state.draft) return;
  const agents = [...document.querySelectorAll(".agent:checked")].map(node => node.value);
  const errorNode = $("#run-error");
  setHidden(errorNode, true);
  if (!agents.length) {
    errorNode.textContent = "至少选择一个 agent。";
    setHidden(errorNode, false);
    return;
  }
  const limit = Number($("#limit-input").value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
    errorNode.textContent = "最近 N 必须是 1…10000 的整数。";
    setHidden(errorNode, false);
    return;
  }
  const body = {
    group: state.group.id,
    draft: { rules: state.draft.rules, intentSure: state.draft.intentSure },
    agents,
    limit,
  };
  if ($("#from").value) body.from = $("#from").value;
  if ($("#to").value) body.to = $("#to").value;
  $("#run-button").disabled = true;
  setHidden($("#progress-wrap"), false);
  setProgress(0, 0, "history");
  try {
    const result = await runBacktest(body);
    state.result = result;
    renderSummary();
    renderResults();
    setHidden($("#summary-panel"), false);
    setHidden($("#results-panel"), false);
    $("#progress-text").textContent = `完成：${result.rows.length} 条，${result.summary.changed} 条变化`;
    $("#progress-fill").style.width = "100%";
  } catch (error) {
    errorNode.textContent = error?.message || String(error);
    setHidden(errorNode, false);
    setHidden($("#progress-wrap"), true);
  } finally {
    $("#run-button").disabled = !state.group?.supported;
  }
});

$("#apply-preview").addEventListener("click", async () => {
  if (!state.group || !state.draft) return;
  const button = $("#apply-preview");
  button.disabled = true;
  setHidden($("#apply-error"), true);
  $("#apply-status").textContent = "正在生成命令…";
  try {
    const data = await postApply({
      group: state.group.id,
      draft: { rules: state.draft.rules, intentSure: state.draft.intentSure },
      dryRun: true,
    });
    renderApplyPlan(data);
  } catch (error) {
    showApplyError(error?.message || String(error));
    $("#apply-status").textContent = "无法生成写回命令。";
  } finally {
    button.disabled = false;
  }
});

$("#apply-run").addEventListener("click", async () => {
  if (!state.group || !state.draft || !state.applyPreviewed) return;
  const button = $("#apply-run");
  button.disabled = true;
  setHidden($("#apply-error"), true);
  $("#apply-status").textContent = "正在执行写回命令…";
  try {
    const data = await postApply({
      group: state.group.id,
      draft: { rules: state.draft.rules, intentSure: state.draft.intentSure },
      dryRun: false,
    });
    renderApplyResult(data);
  } catch (error) {
    showApplyError(error?.message || String(error));
    $("#apply-status").textContent = "执行失败。";
    state.applyPreviewed = false;
    button.disabled = true;
  }
});

loadGroups().catch(error => {
  const node = $("#unsupported");
  node.textContent = "读取路由组失败：" + (error?.message || String(error));
  setHidden(node, false);
  $("#run-button").disabled = true;
});
