// Sends this frame to the plugin's local service, which serves the whole
// interface. Kept in its own file: magpie's page policy allows scripts only
// from the plugin's folder, so an inline <script> never runs.
(async () => {
  const DEFAULT_PORT = 3488;
  const status = document.getElementById("status");
  let port = DEFAULT_PORT;
  let service = "";
  // Armed before anything is awaited: WebKit says nothing when the target
  // can't be reached, and a bridge that never answers would hang here too.
  // Still on this document after 5s means the jump didn't happen.
  setTimeout(() => {
    const where = service || `127.0.0.1:${port}`;
    status.textContent = `本地服务没有响应（${where}），请确认插件已开启。`;
    if (document.getElementById("retry")) return;
    const btn = document.createElement("button");
    btn.id = "retry";
    btn.type = "button";
    btn.textContent = "重试";
    btn.style.cssText = "margin-top:10px;padding:2px 12px;font:inherit;cursor:pointer;";
    btn.addEventListener("click", () => location.reload());
    status.after(btn);
  }, 5000);
  try {
    await window.magpie?.ready;
    const s = window.magpie?.service;
    if (typeof s === "string" && /^https?:\/\//.test(s)) service = s;
  } catch { /* no bridge: go to 127.0.0.1 */ }
  try {
    const o = await window.magpie?.options?.get?.();
    if (o && Number(o.port) > 0) port = Number(o.port);
  } catch { /* no options: default port */ }


  location.replace(service || `http://127.0.0.1:${port}/`);
})();
