// SPDX-License-Identifier: MIT
// The page: report the webview and storage, start the worker, print every line as "JVTEST …" so
// the runner scripts can read it from the device log.
const out = document.getElementById("out");
const log = (line) => {
  out.textContent += `${line}\n`;
  console.log(`JVTEST ${line}`);
};
log(`ua ${navigator.userAgent}`);
log(`origin ${location.origin} secure=${window.isSecureContext}`);
try {
  log(`persisted=${await navigator.storage.persisted()} persist()=${await navigator.storage.persist()}`);
} catch (err) {
  log(`storage api error ${err}`);
}
const w = new Worker("worker.js", { type: "module" });
w.onmessage = (ev) => log(ev.data);
w.onerror = (ev) => log(`RESULT FAIL worker error ${ev.message || ev}`);
