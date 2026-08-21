/* global document */

const api = globalThis.cosmasDesktop;
const status = document.querySelector("#status");
const refresh = document.querySelector("#refresh");
const start = document.querySelector("#start");
const stop = document.querySelector("#stop");

if (
  api === undefined ||
  status === null ||
  refresh === null ||
  start === null ||
  stop === null
) {
  throw new Error("Desktop companion renderer contract is unavailable");
}

function render(snapshot) {
  status.textContent = `Status: ${snapshot.state.replaceAll("_", " ")}`;
  refresh.disabled = snapshot.state === "recording" || snapshot.state === "failed";
  start.disabled = snapshot.state !== "ready";
  stop.disabled = snapshot.state !== "recording";
}

async function invoke(action) {
  const result = await action();
  if (!result.ok) {
    status.textContent = `Unavailable: ${result.errorCode.replaceAll("_", " ")}`;
  }
}

refresh.addEventListener("click", () => void invoke(() => api.refreshPermissions()));
start.addEventListener("click", () => void invoke(() => api.start()));
stop.addEventListener("click", () => void invoke(() => api.stop()));
api.onStateChanged(render);
void api.getState().then(render);
