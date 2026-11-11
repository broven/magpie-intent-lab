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
  filterTiming: "",
  applyPreviewed: false,
  sessionResults: [],
  selectedSessions: new Set(),
  sessionQuery: { q: "", regex: false },
  sessionTimer: null,
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

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function searchRegExp(q, regex) {
  if (!q) return null;
  try {
    return new RegExp(regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  } catch {
    return null;
  }
}

function highlightHtml(text, q, regex) {
  const value = String(text ?? "");
  const re = searchRegExp(q, regex);
  if (!re) return escapeHtml(value);
  let out = "", at = 0;
  re.lastIndex = 0;
  for (;;) {
    const hit = re.exec(value);
    if (!hit) break;
    out += escapeHtml(value.slice(at, hit.index));
    out += `<mark>${escapeHtml(hit[0])}</mark>`;
    at = hit.index + hit[0].length;
    if (!hit[0].length) re.lastIndex++;
    if (re.lastIndex > value.length) break;
  }
  return out + escapeHtml(value.slice(at));
}

function kv(label, value) {
  const row = el("div", "kv");
  row.append(el("span", "", label));
  row.append(el("b", "", String(value ?? "—")));
  return row;
}

function renderLogic() {
  const wrap = $("#logic-body");
  wrap.replaceChildren();
  const logic = state.group?.logic;
  if (!logic?.steps?.length) {
    wrap.append(el("p", "empty-state", "这个组没有可展示的判定逻辑。"));
    return;
  }
  for (const step of logic.steps) {
    const card = el("div", "logic-step");
    card.dataset.testid = "logic-step";
    const title = el("div", "logic-step-head");
    title.append(el("span", "num", String(step.n)));
    title.append(el("b", "", step.title));
    card.append(title);
    card.append(el("p", "logic-copy", step.body));
    wrap.append(card);
  }
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
  if (side?.stopped) {
    wrap.append(el("div", "intent", "未判（已命中即停）"));
    return wrap;
  }
  wrap.append(el("div", "intent", side?.intent || "(none)"));
  wrap.append(el("div", "sure", `sure ${sureText(side?.sure)}`));
  wrap.append(el("div", "model", side?.use || "—"));
  return wrap;
}

function formatTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "", abs = Math.abs(n);
  if (abs >= 1_000_000) return sign + (abs / 1_000_000).toFixed(1).replace(/\.0$/, "") + "m";
  if (abs >= 1_000) return sign + (abs / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

function memberName(value) {
  return value || "组默认路由（成员未知）";
}

function shortMember(value) {
  if (!value) return "未知";
  return value.split("/")[0] || value;
}

function stickyLabel(why) {
  return { rule: "规则命中", kept: "粘住上一轮", initial: "初始成员", unknown: "成员未知" }[why] || "未知";
}

function memberCell(side) {
  const wrap = el("div", "member-cell");
  if (side?.stopped) {
    wrap.append(el("div", "model member-full", "未判（已命中即停）"));
    return wrap;
  }
  const member = side?.member || "";
  const from = side?.from || "";
  if (side?.switched) {
    const mark = el("div", "switch-mark");
    mark.dataset.testid = "switch-mark";
    mark.append(el("span", "from", shortMember(from)));
    mark.append(el("span", "arrow", "→"));
    mark.append(el("span", "to", shortMember(member)));
    mark.title = `${memberName(from)} → ${memberName(member)}`;
    wrap.append(mark);
    wrap.append(el("div", "model member-full", `${memberName(from)} → ${memberName(member)}`));
    if (side.prefixTokens) {
      wrap.append(el("div", "switch-cost", `${side.prefixEstimated ? "≈" : ""}${formatTokens(side.prefixTokens)} 前缀 tokens`));
    }
  } else {
    wrap.append(el("div", "model member-full", memberName(member)));
  }
  wrap.append(el("div", "sticky-why", stickyLabel(side?.stickyWhy)));
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
  renderLogic();
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

function timingLabel(value) {
  return { single: "单轮", early: "开头命中", mid: "中途命中", miss: "未命中" }[value] || value;
}

function timingBadgeClass(value) {
  return `timing-badge ${value}`;
}

function renderSummary() {
  const summaryNode = $("#summary");
  summaryNode.replaceChildren();
  if (!state.result) return;
  const { summary, stats, cache } = state.result;
  const sessions = state.result.sessions ?? [];
  const main = sessions.filter(session => !session.parentId);
  const children = sessions.filter(session => !!session.parentId);
  const turns = sessions.reduce((sum, session) => sum + session.turns, 0);

  const grid = el("div", "summary-grid");
  const stat = (label, value, testid) => {
    const box = el("div", "stat");
    if (testid) box.dataset.testid = testid;
    box.append(el("b", "", String(value)));
    box.append(el("span", "", label));
    grid.append(box);
  };
  stat("主会话", main.length);
  stat("子 agent", children.length);
  stat("轮次", turns);
  stat("变化轮次", summary.changed);
  if (cache) stat("Jev 新请求 / 缓存命中", `${cache.requests ?? 0} / ${cache.hits ?? 0}`);
  summaryNode.append(grid);

  const timing = summary.timing;
  if (timing?.main && timing?.subagents) {
    const title = el("h3", "", "命中时机（主会话 / 子 agent）");
    title.style.fontSize = "13px";
    title.style.margin = "14px 0 6px";
    summaryNode.append(title);
    const wrap = el("div", "matrix-wrap timing-split");
    const table = el("table");
    const thead = el("thead");
    const head = el("tr");
    for (const value of ["指标", "主会话", "子 agent"]) head.append(el("th", "", value));
    thead.append(head);
    table.append(thead);
    const tbody = el("tbody");
    const line = (label, mainValue, subValue, testid) => {
      const row = el("tr");
      const th = el("th", "", label);
      if (testid) th.dataset.testid = testid;
      row.append(th);
      row.append(el("td", "", String(mainValue)));
      row.append(el("td", "", String(subValue)));
      tbody.append(row);
    };
    line("单轮会话", timing.main.single, timing.subagents.single, "timing-single");
    line("开头命中", timing.main.early, timing.subagents.early, "timing-early");
    line("中途命中", timing.main.mid, timing.subagents.mid, "timing-mid");
    line("未命中", timing.main.miss, timing.subagents.miss, "timing-miss");
    line("多轮", timing.main.multi, timing.subagents.multi);
    table.append(tbody);
    wrap.append(table);
    summaryNode.append(wrap);

    const ratioText = (value) => `多轮 ${value.multi} 个：开头 ${(100 * value.ratios.early).toFixed(1)}% · 中途 ${(100 * value.ratios.mid).toFixed(1)}% · 未命中 ${(100 * value.ratios.miss).toFixed(1)}%`;
    const ratio = el("p", "timing-ratios");
    ratio.dataset.testid = "timing-ratios";
    ratio.textContent = `主会话：${ratioText(timing.main)}；子 agent：${ratioText(timing.subagents)}（K=${timing.k}${timing.stopAfterHit ? "，草稿命中即停" : ""}）`;
    summaryNode.append(ratio);

    const histTitle = el("h3", "", "第一次命中所在轮次");
    histTitle.style.fontSize = "13px";
    histTitle.style.margin = "14px 0 6px";
    summaryNode.append(histTitle);
    const histWrap = el("div", "matrix-wrap timing-histogram");
    histWrap.dataset.testid = "timing-histogram";
    const histTable = el("table");
    const histHead = el("thead");
    const histHeadRow = el("tr");
    histHeadRow.append(el("th", "", ""));
    for (const bin of ["1", "2", "3", "4–5", "6–10", ">10"]) histHeadRow.append(el("th", "", bin));
    histHead.append(histHeadRow);
    histTable.append(histHead);
    const histBody = el("tbody");
    for (const [label, value] of [["主会话", timing.main], ["子 agent", timing.subagents]]) {
      const row = el("tr");
      row.append(el("th", "", label));
      for (const bin of ["1", "2", "3", "4-5", "6-10", ">10"]) row.append(el("td", "", String(value.histogram[bin] ?? 0)));
      histBody.append(row);
    }
    histTable.append(histBody);
    histWrap.append(histTable);
    summaryNode.append(histWrap);

    const costText = (value) => `${value.midCost.switches} 次切换 · 重写前缀 ${value.midCost.estimatedTokens ? "≈" : ""}${formatTokens(value.midCost.prefixTokens)} tokens · 中位数 ${value.midCost.median} tokens`;
    const midCost = el("p", "timing-mid-cost");
    midCost.dataset.testid = "timing-mid-cost";
    midCost.textContent = `中途命中切换代价：主会话 ${costText(timing.main)}；子 agent ${costText(timing.subagents)}`;
    summaryNode.append(midCost);
  }

  if (summary.jev) {
    const jev = el("p", "jev-stats");
    jev.dataset.testid = "jev-stats";
    jev.textContent = `Jev 实际请求（不含缓存）：current ${summary.jev.current.requests} · draft ${summary.jev.draft.requests}；缓存命中：current ${summary.jev.current.hits} · draft ${summary.jev.draft.hits}`;
    summaryNode.append(jev);
  }

  const sticky = summary.sticky;
  if (sticky?.current && sticky?.draft) {
    const title = el("h3", "", "会话粘性");
    title.style.fontSize = "13px";
    title.style.margin = "14px 0 6px";
    summaryNode.append(title);
    const wrap = el("div", "matrix-wrap sticky-summary");
    const table = el("table");
    const thead = el("thead");
    const head = el("tr");
    for (const value of ["指标", "current", "draft", "draft − current"]) head.append(el("th", "", value));
    thead.append(head);
    table.append(thead);
    const tbody = el("tbody");
    const signed = value => value > 0 ? `+${value}` : String(value);
    const tokens = counts => `${counts.estimatedTokens ? "≈" : ""}${formatTokens(counts.prefixTokens)}`;
    const estimated = counts => `${counts.estimatedTokens ? "≈" : ""}${formatTokens(counts.estimatedTokens)}${counts.estimatedSwitches ? `（${counts.estimatedSwitches} 次）` : ""}`;
    const line = (label, current, draft, difference) => {
      const row = el("tr");
      row.append(el("th", "", label));
      row.append(el("td", "", String(current)));
      row.append(el("td", "", String(draft)));
      row.append(el("td", "", String(difference)));
      tbody.append(row);
    };
    line("切换次数", sticky.current.switches, sticky.draft.switches, signed(sticky.diff.switches));
    line("发生切换的会话", sticky.current.sessions, sticky.draft.sessions, signed(sticky.diff.sessions));
    line("重写前缀 tokens", tokens(sticky.current), tokens(sticky.draft), `${sticky.diff.estimatedTokens ? "≈" : ""}${formatTokens(sticky.diff.prefixTokens)}`);
    line("其中估算", estimated(sticky.current), estimated(sticky.draft), `${sticky.diff.estimatedTokens ? "≈" : ""}${formatTokens(sticky.diff.estimatedTokens)}`);
    table.append(tbody);
    wrap.append(table);
    summaryNode.append(wrap);
  }

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
}

function traceBlock(title, side, row, testid) {
  const trace = side?.trace;
  const box = el("div", "trace-block wide");
  box.dataset.testid = testid;
  box.append(el("h3", "", title));
  if (!trace) {
    box.append(el("div", "empty-state", "这一侧没有 trace。"));
    return box;
  }

  const message = el("div", "trace-section");
  message.append(el("h4", "", "最终发给 Jev 的 message"));
  const pre = el("pre", "trace-message", trace.cut?.message || "（空）");
  pre.dataset.testid = testid + "-message";
  message.append(pre);
  const stripped = el("div", "trace-facts");
  stripped.append(kv("原始字数", trace.stripped.originalChars));
  stripped.append(kv("system-reminder 段数", trace.stripped.reminders));
  stripped.append(kv("## My request: 之前字数", trace.stripped.beforeRequestChars));
  stripped.append(kv("整段判为注入", trace.stripped.wholeInjection ? "是" : "否"));
  stripped.append(kv("截断", trace.cut?.truncated ? `前 ${trace.cut.head} + 后 ${trace.cut.tail}` : "未截断"));
  message.append(stripped);
  box.append(message);

  const prev = el("div", "trace-section");
  prev.append(el("h4", "", "上一轮上下文"));
  prev.append(el("div", "trace-label", "previous_user_message"));
  prev.append(el("pre", "", trace.prev.user || "（无）"));
  prev.append(el("div", "trace-label", "previous_assistant_reply"));
  prev.append(el("pre", "", trace.prev.reply || "（无）"));
  const prevFacts = el("div", "trace-facts");
  prevFacts.append(kv("previous_message_kind", trace.prev.intent || "（无）"));
  prevFacts.append(kv("是否携带", trace.prev.carried ? "是" : "否"));
  prevFacts.append(kv("候选 intents", trace.prev.candidates.length ? trace.prev.candidates.join(" / ") : "（无）"));
  prev.append(prevFacts);
  box.append(prev);

  const jev = el("div", "trace-section");
  jev.append(el("h4", "", "Jev 返回"));
  if (!trace.jevAnswer) {
    jev.append(el("div", "empty-state", "没有候选 intent，未调用 Jev。"));
  } else {
    const answer = trace.jevAnswer;
    const facts = el("div", "trace-facts");
    facts.append(kv("model", answer.model || "—"));
    facts.append(kv("choice", answer.choice || "（空）"));
    facts.append(kv("confidence", sureText(answer.confidence)));
    facts.append(kv("sure", sureText(trace.sure)));
    facts.append(kv("阈值", sureText(trace.threshold)));
    const passed = el("span", trace.passed ? "badge" : "badge warn", trace.passed ? "是" : "否");
    const passedRow = el("div", "kv");
    passedRow.append(el("span", "", "阈值达标"));
    passedRow.append(passed);
    facts.append(passedRow);
    facts.append(kv("答案接受", trace.accepted ? "是" : "否"));
    facts.append(kv("最终 intent", trace.intent || "（none）"));
    facts.append(kv("缓存", trace.cached ? "命中" : "新请求"));
    jev.append(facts);
    const probs = Object.entries(answer.probabilities || {}).sort((a, b) => b[1] - a[1]);
    const bars = el("div", "probabilities");
    if (!probs.length) bars.append(el("div", "muted", "答案没有 probabilities。"));
    for (const [label, value] of probs) {
      const row = el("div", "prob-row");
      row.append(el("span", "prob-label", label));
      const bar = el("div", "prob-bar");
      const fill = el("div", "prob-fill");
      fill.style.width = `${Math.max(0, Math.min(1, value)) * 100}%`;
      bar.append(fill);
      row.append(bar);
      row.append(el("span", "prob-value", sureText(value)));
      bars.append(row);
    }
    jev.append(bars);
  }
  if (trace.levelProbe) {
    const probe = el("div", "trace-section level-probe");
    probe.append(el("h4", "", "levels 探测"));
    const facts = el("div", "trace-facts");
    facts.append(kv("结果", trace.levelProbe.levels ? "levels" : "topics"));
    facts.append(kv("探测缓存", trace.levelProbe.cached ? "命中" : "新请求"));
    if (trace.levelProbe.work) {
      for (const [intent, work] of Object.entries(trace.levelProbe.work)) {
        facts.append(kv(intent, work));
      }
    }
    probe.append(facts);
    jev.append(probe);
  }
  box.append(jev);

  const walk = el("div", "trace-section");
  walk.append(el("h4", "", "规则逐条判定"));
  const walkNode = el("div", "rule-walk");
  walkNode.dataset.testid = testid + "-rulewalk";
  for (const rule of trace.ruleWalk || []) {
    const card = el("div", "rule-walk-item" + (rule.chosen ? " chosen" : ""));
    const head = el("div", "rule-walk-head");
    head.append(el("b", "", `规则 ${rule.n}`));
    head.append(el("span", "muted", rule.use || "（无 use）"));
    if (rule.chosen) head.append(el("span", "badge", "选中"));
    card.append(head);
    const conds = el("div", "conds");
    for (const cond of rule.conds || []) {
      const icon = cond.result === "pass" ? "✓" : cond.result === "fail" ? "✗" : "?";
      const row = el("div", "cond " + cond.result);
      row.append(el("span", "cond-icon", icon));
      row.append(el("span", "cond-name", cond.name));
      row.append(el("span", "cond-detail", `期望 ${cond.want} · 实际 ${cond.got} — ${cond.why}`));
      conds.append(row);
    }
    card.append(conds);
    walkNode.append(card);
  }
  const chosen = el("div", "chosen-rule");
  chosen.textContent = trace.chosen?.n
    ? `选中规则 ${trace.chosen.n} · ${trace.chosen.use}`
    : "未命中规则，按组默认路由";
  walk.append(walkNode);
  walk.append(chosen);
  box.append(walk);

  const sticky = trace.sticky;
  if (sticky) {
    const section = el("div", "trace-section sticky-trace");
    section.dataset.testid = testid + "-sticky";
    section.append(el("h4", "", "粘性"));
    const flow = el("div", "sticky-flow");
    flow.append(el("span", "", memberName(sticky.from)));
    flow.append(el("span", "arrow", "→"));
    flow.append(el("span", "", sticky.rule ? `命中规则 ${sticky.ruleUse}` : "未命中规则"));
    flow.append(el("span", "arrow", "→"));
    flow.append(el("span", "to", memberName(sticky.member)));
    section.append(flow);
    const facts = el("div", "trace-facts");
    facts.append(kv("上一轮成员", memberName(sticky.from)));
    facts.append(kv("是否命中规则", sticky.rule ? `是（${sticky.ruleUse}）` : "否"));
    facts.append(kv("实际成员", memberName(sticky.member)));
    facts.append(kv("原因", stickyLabel(sticky.why)));
    if (sticky.switched) {
      facts.append(kv("切换前缀", `${sticky.prefixEstimated ? "≈" : ""}${formatTokens(sticky.prefixTokens)} tokens`));
    }
    section.append(facts);
    box.append(section);
  }

  const rawBox = (label, value, id) => {
    const details = document.createElement("details");
    details.dataset.testid = id;
    const summary = document.createElement("summary");
    summary.textContent = label;
    details.append(summary);
    details.append(el("pre", "", JSON.stringify(value, null, 2)));
    return details;
  };
  box.append(rawBox("原始请求体", trace.jevRequest, testid + "-request"));
  box.append(rawBox("原始答案 JSON", trace.jevAnswer?.raw ?? null, testid + "-answer"));
  return box;
}

function detailRow(row) {
  const tr = el("tr", "detail");
  tr.dataset.testid = "row-detail";
  const td = document.createElement("td");
  td.colSpan = 11;
  const grid = el("div", "detail-grid");

  const full = el("div");
  full.append(el("h3", "", "全文"));
  full.append(el("pre", "", row.fullText || row.text || ""));
  grid.append(full);

  const prev = el("div");
  prev.append(el("h3", "", "上一轮上下文"));
  prev.append(el("h3", "", "上一轮用户"));
  prev.append(el("pre", "", row.prev?.user || "(无)"));
  prev.append(el("h3", "", "上一轮回复"));
  prev.append(el("pre", "", row.prev?.reply || "(无)"));
  grid.append(prev);

  grid.append(traceBlock("当前判定过程", row.current, row, "trace-current"));
  grid.append(traceBlock("草稿判定过程", row.draft, row, "trace-draft"));

  td.append(grid);
  tr.append(td);
  return tr;
}

function sessionScopes() {
  return [...document.querySelectorAll(".scope:checked")].map(node => node.value);
}

function renderSessionList(data) {
  const list = $("#session-list");
  list.replaceChildren();
  if (!data.sessions.length) {
    list.append(el("p", "empty-state", "没有会话。"));
    return;
  }
  const searching = !!state.sessionQuery.q;
  for (const session of data.sessions) {
    const card = el("div", "session-card");
    card.dataset.sessionId = session.id;
    const head = el("div", "session-card-head");
    const check = document.createElement("label");
    check.className = "session-check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = state.selectedSessions.has(session.id);
    box.dataset.testid = "session-checkbox";
    box.dataset.sessionId = session.id;
    box.addEventListener("change", () => {
      if (box.checked) state.selectedSessions.add(session.id);
      else state.selectedSessions.delete(session.id);
    });
    check.append(box);
    check.append(el("span", "session-agent", `${session.agent} · ${session.folder || "—"}`));
    head.append(check);
    const preview = el("button", "secondary", "预览");
    preview.type = "button";
    preview.dataset.testid = "session-preview";
    preview.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      openSession(session.id);
    });
    head.append(preview);
    card.append(head);
    card.append(el("div", "session-first", shortText(session.first, 240) || "（首条消息为空）"));
    const meta = el("div", "session-time");
    meta.append(el("span", "", `最后一轮 ${formatTime(session.lastTurn)} · ${session.turns} 轮`));
    if (session.subagents) {
      const subagents = el("span", "session-subagents", `含 ${session.subagents} 个子 agent`);
      subagents.dataset.testid = "session-subagents";
      meta.append(subagents);
    }
    card.append(meta);
    if (searching) card.append(el("div", "session-meta", `命中 ${session.hits} 次`));
    const snippets = el("div", "snippets");
    if (searching) {
      for (const snippet of (session.snippets || []).slice(0, 3)) {
        const row = el("div", "snippet");
        if (snippet.subagent) {
          const badge = el("span", "subagent-badge", "子 agent");
          badge.dataset.testid = "snippet-subagent";
          badge.title = snippet.subagent;
          row.append(badge);
        }
        row.append(el("span", "scope", snippet.scope));
        const text = el("span", "snippet-text");
        text.innerHTML = (snippet.lead ? "…" : "") + highlightHtml(snippet.text, state.sessionQuery.q, state.sessionQuery.regex) + (snippet.trail ? "…" : "");
        row.append(text);
        snippets.append(row);
      }
    }
    card.append(snippets);
    list.append(card);
  }
}

function selectedAgents() {
  return [...document.querySelectorAll(".agent:checked")].map(node => node.value);
}

function scheduleSessionLoad() {
  if (state.sessionTimer) clearTimeout(state.sessionTimer);
  state.sessionTimer = setTimeout(() => {
    state.sessionTimer = null;
    loadSessionList();
  }, 400);
}

async function loadSessionList() {
  const q = $("#session-search").value.trim();
  const status = $("#session-status");
  status.classList.remove("warn");
  const scopes = sessionScopes();
  if (q && !scopes.length) {
    status.textContent = "至少选择一个搜索范围。";
    status.classList.add("warn");
    return;
  }
  const agents = selectedAgents();
  if (!agents.length) {
    state.sessionResults = [];
    state.selectedSessions.clear();
    renderSessionList({ sessions: [] });
    status.textContent = "至少选择一个 agent。";
    status.classList.add("warn");
    return;
  }
  const limit = Number($("#session-limit").value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    status.textContent = "最近 N 个会话必须是 1…1000 的整数。";
    status.classList.add("warn");
    return;
  }
  const params = new URLSearchParams({ limit: String(limit) });
  if (q) {
    params.set("q", q);
    params.set("scopes", scopes.join(","));
    if ($("#session-regex").checked) params.set("regex", "1");
  }
  // All three agents is the warm-up's default read; leave it off the query
  // so the first list does not start a second full transcript parse.
  if (agents.length && agents.length < 3) params.set("agents", agents.join(","));
  if ($("#from").value) params.set("from", $("#from").value);
  if ($("#to").value) params.set("to", $("#to").value);
  status.textContent = q ? "搜索中…" : "读取最近会话…";
  try {
    const response = await api("/api/sessions?" + params.toString());
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    state.sessionResults = data.sessions ?? [];
    state.selectedSessions = new Set(state.sessionResults.map(session => session.id));
    state.sessionQuery = { q, regex: $("#session-regex").checked };
    renderSessionList(data);
    status.textContent = q
      ? `命中 ${state.sessionResults.length} 个会话 · 搜索耗时 ${data.durationMs} ms`
      : `最近 ${state.sessionResults.length} 个会话 · 读取耗时 ${data.durationMs} ms`;
  } catch (error) {
    state.sessionResults = [];
    state.selectedSessions.clear();
    $("#session-list").replaceChildren();
    status.textContent = "读取失败：" + (error?.message || String(error));
    status.classList.add("warn");
  }
}

function clearSessionSearch() {
  $("#session-search").value = "";
  state.sessionQuery = { q: "", regex: false };
  loadSessionList();
}

function selectAllSessions(checked) {
  state.selectedSessions = checked
    ? new Set(state.sessionResults.map(session => session.id))
    : new Set();
  renderSessionList({ sessions: state.sessionResults });
}

function closeSessionModal() {
  const modal = $("#session-modal");
  modal.hidden = true;
  document.body.classList.remove("modal-open");
  $("#session-modal-body").replaceChildren();
}

function renderPreviewItems(container, items, focus) {
  items.forEach((item, index) => {
    if (item.kind === "bash") {
      const details = document.createElement("details");
      details.className = "preview-item bash";
      details.dataset.index = String(index);
      details.dataset.testid = "preview-bash";
      const summary = document.createElement("summary");
      summary.innerHTML = `bash · ${highlightHtml(shortText(item.command || "（无命令）", 100), state.sessionQuery.q, state.sessionQuery.regex)}`;
      details.append(summary);
      const command = el("pre", "", "");
      command.innerHTML = highlightHtml(item.command || "（无命令）", state.sessionQuery.q, state.sessionQuery.regex);
      details.append(command);
      const output = el("pre", "", "");
      output.innerHTML = highlightHtml(item.output || "（无输出）", state.sessionQuery.q, state.sessionQuery.regex);
      details.append(output);
      container.append(details);
      return;
    }
    const node = el("div", "preview-item " + item.kind);
    node.dataset.index = String(index);
    node.dataset.testid = item.kind === "user" ? "preview-user" : "preview-assistant";
    if (item.sampleId) {
      node.classList.add("sample-turn");
      node.dataset.sampleId = item.sampleId;
      node.append(el("span", "badge", "回测样本"));
    }
    const text = el("div", "preview-text");
    text.innerHTML = highlightHtml(item.text || "", state.sessionQuery.q, state.sessionQuery.regex);
    node.append(text);
    container.append(node);
  });
  if (focus >= 0) {
    const target = container.querySelector(`[data-index="${focus}"]`);
    if (target) {
      target.classList.add("focus");
      target.scrollIntoView({ block: "center" });
    }
  }
}

function renderPreview(data) {
  const body = $("#session-modal-body");
  body.replaceChildren();
  const meta = el("div", "preview-meta", `${data.agent} · ${data.folder || "—"} · ${data.turnCount} 个回测 turn`);
  if (data.subagents?.length) meta.append(el("span", "session-subagents", `含 ${data.subagents.length} 个子 agent`));
  body.append(meta);
  renderPreviewItems(body, data.items, data.focus);
  for (const sub of data.subagents ?? []) {
    const details = el("details", "preview-subagent");
    details.dataset.testid = "preview-subagent";
    details.dataset.subagentId = sub.subagentId;
    const summary = el("summary", "preview-subagent-head");
    summary.append(el("span", "subagent-badge", "子 agent"));
    summary.append(el("b", "", sub.subagentId));
    summary.append(el("span", "muted", `${sub.turnCount} 轮 · ${shortText(sub.first, 120) || "（首条消息为空）"}`));
    details.append(summary);
    const pane = el("div", "preview-subagent-body");
    details.append(pane);
    details.addEventListener("toggle", async () => {
      if (!details.open || details.dataset.loaded) return;
      details.dataset.loaded = "1";
      pane.append(el("p", "empty-state", "正在读取子 agent…"));
      try {
        const response = await api("/api/session?id=" + encodeURIComponent(sub.id));
        const child = await response.json();
        if (!response.ok) throw new Error(child.error || `HTTP ${response.status}`);
        pane.replaceChildren();
        renderPreviewItems(pane, child.items, -1);
      } catch (error) {
        pane.replaceChildren(el("p", "warn", "读取子 agent 失败：" + (error?.message || String(error))));
      }
    });
    body.append(details);
  }
}

async function openSession(id, sampleId) {
  const modal = $("#session-modal");
  modal.hidden = false;
  document.body.classList.add("modal-open");
  const body = $("#session-modal-body");
  body.replaceChildren(el("p", "empty-state", "正在读取会话…"));
  $("#session-modal-title").textContent = "会话预览";
  const params = new URLSearchParams({ id });
  if (sampleId) params.set("sample", sampleId);
  try {
    const response = await api("/api/session?" + params.toString());
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    $("#session-modal-title").textContent = `${data.agent} · ${data.folder || "会话预览"}`;
    renderPreview(data);
  } catch (error) {
    body.replaceChildren(el("p", "warn", "读取会话失败：" + (error?.message || String(error))));
  }
}

function turnRow(row) {
  const tr = el("tr", "result-row turn-row");
  tr.dataset.testid = "turn-row";
  const cell = (label, content, className = "") => {
    const td = el("td", className);
    td.dataset.label = label;
    if (content instanceof Node) td.append(content);
    else td.textContent = content;
    return td;
  };
  tr.append(cell("轮次", String(row.turn)));
  tr.append(cell("时间", formatTime(row.time)));
  tr.append(cell("agent", row.agent));
  tr.append(cell("folder", row.folder || "—"));
  const messageCell = el("div", "msg-cell");
  messageCell.append(el("span", "msg-text", shortText(row.fullText || row.text, 120)));
  tr.append(cell("消息摘要", messageCell, "msg"));
  tr.append(cell("当前 intent · sure · 规则 use", sideCell(row.current)));
  tr.append(cell("当前 实际模型", memberCell(row.current), row.current?.switched ? "actual switched" : "actual"));
  tr.append(cell("草稿 intent · sure · 规则 use", sideCell(row.draft)));
  tr.append(cell("草稿 实际模型", memberCell(row.draft), row.draft?.switched ? "actual switched" : "actual"));
  const changed = el("span", row.changed ? "badge" : "badge none", row.changed ? "变化" : "—");
  tr.append(cell("变化", changed));
  const unknown = el("span", row.unknownConds?.length ? "badge warn" : "badge none", row.unknownConds?.length ? `${row.unknownConds.length} 个` : "—");
  tr.append(cell("unknown", unknown));
  tr.addEventListener("click", () => {
    const next = tr.nextElementSibling;
    if (next?.classList.contains("detail")) next.remove();
    else tr.after(detailRow(row));
  });
  return tr;
}

function turnTable(rows) {
  const wrap = el("div", "table-wrap turn-table");
  const table = el("table");
  table.dataset.testid = "result-table";
  const thead = el("thead");
  const head = el("tr");
  for (const value of ["轮次", "时间", "agent", "folder", "消息摘要", "当前 intent · sure · 规则 use", "当前 实际模型", "草稿 intent · sure · 规则 use", "草稿 实际模型", "变化", "unknown"]) {
    head.append(el("th", "", value));
  }
  thead.append(head);
  table.append(thead);
  const tbody = el("tbody");
  for (const row of rows) tbody.append(turnRow(row));
  table.append(tbody);
  wrap.append(table);
  return wrap;
}

function timelineFor(session) {
  const timeline = el("div", "session-timeline");
  timeline.dataset.testid = "session-timeline";
  for (const row of session.rows) {
    const kind = row.draft.stopped ? "stopped" : row.draft.rule > 0 ? "hit" : "miss";
    const kindLabel = { hit: "命中", miss: "未命中", stopped: "未判" }[kind];
    const cell = el("span", `turn-cell ${kind}` + (row.draft.switched ? " switch" : ""));
    cell.dataset.testid = "turn-cell";
    cell.dataset.turn = String(row.turn);
    cell.dataset.kind = kind;
    cell.title = `第 ${row.turn} 轮 · ${kindLabel}${row.draft.switched ? ` · 切换 ${shortMember(row.draft.from)} → ${shortMember(row.draft.member)}` : ""}`;
    cell.textContent = String(row.turn);
    timeline.append(cell);
  }
  return timeline;
}

function sessionCard(session, subagent = false) {
  const card = el("article", "session-result" + (subagent ? " subagent-result" : ""));
  card.dataset.testid = subagent ? "subagent-result" : "session-result";
  card.dataset.class = session.class;
  const head = el("div", "session-result-head");
  head.dataset.testid = "session-result-head";
  const badge = el("span", timingBadgeClass(session.class), timingLabel(session.class));
  head.append(badge);
  const title = subagent
    ? `子 agent ${session.subagentId || session.agent} · ${session.folder || "—"}`
    : `${session.agent} · ${session.folder || "—"}`;
  head.append(el("b", "session-result-agent", title));
  head.append(el("span", "muted", `${session.turns} 轮`));
  head.append(el("span", "muted", session.firstHit === null ? "未命中" : `第一次命中：第 ${session.firstHit} 轮`));
  if (session.switched) {
    const mark = el("span", "switch-mark");
    mark.dataset.testid = "session-switch";
    mark.append(el("span", "from", shortMember(session.from)));
    mark.append(el("span", "arrow", "→"));
    mark.append(el("span", "to", shortMember(session.to)));
    mark.title = `${memberName(session.from)} → ${memberName(session.to)}`;
    head.append(mark);
    if (session.prefixTokens) head.append(el("span", "switch-cost", `${formatTokens(session.prefixTokens)} 前缀 tokens`));
  }
  const preview = el("button", "secondary tiny", "预览");
  preview.type = "button";
  preview.dataset.testid = subagent ? "subagent-preview-button" : "session-preview-result";
  preview.addEventListener("click", event => {
    event.stopPropagation();
    const hit = session.firstHit === null ? null : session.rows.find(row => row.turn === session.firstHit);
    openSession(session.id, hit?.id);
  });
  head.append(preview);
  card.append(head);
  card.append(el("div", "session-first", shortText(session.first, 240) || "（首条消息为空）"));
  card.append(timelineFor(session));

  if (!subagent) {
    const children = (state.result?.sessions ?? []).filter(child => child.parentId === session.id);
    if (children.length) {
      const summary = el("div", "subagent-count", `含 ${children.length} 个子 agent`);
      summary.dataset.testid = "result-subagents";
      card.append(summary);
      const details = document.createElement("details");
      details.className = "subagent-group";
      details.dataset.testid = "subagent-summary";
      const label = el("summary", "subagent-summary-head");
      const counts = { early: 0, mid: 0, miss: 0 };
      for (const child of children) counts[child.class] = (counts[child.class] ?? 0) + 1;
      label.textContent = `${children.length} 个子 agent：开头 ${counts.early} / 中途 ${counts.mid} / 未命中 ${counts.miss}`;
      details.append(label);
      const body = el("div", "subagent-results");
      for (const child of children) body.append(sessionCard(child, true));
      details.append(body);
      card.append(details);
    }
  }

  const turns = el("div", "session-turns");
  turns.hidden = true;
  turns.dataset.testid = "session-turns";
  turns.append(turnTable(session.rows));
  card.append(turns);
  head.addEventListener("click", event => {
    if (event.target.closest("button")) return;
    turns.hidden = !turns.hidden;
    card.classList.toggle("open", !turns.hidden);
  });
  return card;
}

function renderResults() {
  const body = $("#session-results");
  body.replaceChildren();
  const empty = $("#result-empty");
  if (!state.result) {
    setHidden(empty, false);
    empty.textContent = "还没有回测结果。";
    $("#result-count").textContent = "";
    return;
  }
  const all = state.result.sessions ?? [];
  const sessions = all.filter(session => !session.parentId && (!state.filterTiming || session.class === state.filterTiming));
  const children = all.filter(session => !!session.parentId).length;
  $("#result-count").textContent = `${sessions.length} 个主会话 · ${children} 个子 agent`;
  if (!sessions.length) {
    setHidden(empty, false);
    empty.textContent = "没有符合分类条件的会话。";
    return;
  }
  setHidden(empty, true);
  for (const session of sessions) body.append(sessionCard(session));
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

$("#session-search-button").addEventListener("click", () => loadSessionList());
$("#session-search").addEventListener("input", () => scheduleSessionLoad());
$("#session-search").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    loadSessionList();
  }
});
$("#session-clear").addEventListener("click", () => clearSessionSearch());
$("#session-select-all").addEventListener("click", () => selectAllSessions(true));
$("#session-select-none").addEventListener("click", () => selectAllSessions(false));
for (const id of ["#from", "#to", "#session-limit"]) {
  $(id).addEventListener("input", () => scheduleSessionLoad());
  $(id).addEventListener("change", () => scheduleSessionLoad());
}
for (const node of document.querySelectorAll(".agent")) node.addEventListener("change", () => scheduleSessionLoad());
$("#session-regex").addEventListener("change", () => { if ($("#session-search").value.trim()) scheduleSessionLoad(); });
for (const node of document.querySelectorAll(".scope")) node.addEventListener("change", () => { if ($("#session-search").value.trim()) scheduleSessionLoad(); });
$("#timing-filter").addEventListener("change", event => {
  state.filterTiming = event.target.value;
  renderResults();
});
$("#session-modal").addEventListener("click", event => {
  if (event.target?.dataset?.close) closeSessionModal();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("#session-modal").hidden) closeSessionModal();
});

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

$("#run-button").addEventListener("click", async () => {
  if (!state.group || !state.group.supported || !state.draft) return;
  const errorNode = $("#run-error");
  setHidden(errorNode, true);
  const selected = [...state.selectedSessions];
  if (!selected.length) {
    errorNode.textContent = "至少勾选一个会话。";
    setHidden(errorNode, false);
    return;
  }
  const k = Number($("#k-input").value);
  if (!Number.isInteger(k) || k < 1 || k > 10000) {
    errorNode.textContent = "前 K 轮必须是 1…10000 的整数。";
    setHidden(errorNode, false);
    return;
  }
  const body = {
    group: state.group.id,
    draft: { rules: state.draft.rules, intentSure: state.draft.intentSure },
    sessions: selected,
    k,
    includeSubagents: $("#include-subagents").checked,
    stopAfterHit: $("#stop-after-hit").checked,
  };
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
    const turns = result.sessions.reduce((sum, session) => sum + session.turns, 0);
    const childCount = result.sessions.filter(session => session.parentId).length;
    $("#progress-text").textContent = `完成：${result.sessions.length - childCount} 个主会话，${childCount} 个子 agent，${turns} 轮，${result.summary.changed} 轮变化`;
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
      baseline: state.group.rules,
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
      baseline: state.group.rules,
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
loadSessionList().catch(error => {
  $("#session-status").textContent = "读取会话失败：" + (error?.message || String(error));
  $("#session-status").classList.add("warn");
});
