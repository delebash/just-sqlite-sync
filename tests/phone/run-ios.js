// SPDX-License-Identifier: MIT
// Runs the phone test on a booted iOS simulator (GitHub's macOS runners; any Mac): installs the
// built app fresh, launches it three times (fresh · relaunched · after reinstalling over itself)
// reading its console through `simctl launch --console-pty`, and checks the results.
//   SIM_UDID — the simulator; APP_PATH — the built App.app.
import { spawn, spawnSync } from "node:child_process";
import { checkRuns, parseRun } from "./check.js";

const UDID = process.env.SIM_UDID;
const APP_PATH = process.env.APP_PATH;
const BUNDLE = "org.justfamily.sqlitesynctest";
if (!UDID || !APP_PATH) throw new Error("set SIM_UDID and APP_PATH");
const simctl = (...args) => spawnSync("xcrun", ["simctl", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

function launch() {
  return new Promise((resolve, reject) => {
    const child = spawn("xcrun", ["simctl", "launch", "--console-pty", "--terminate-running-process", UDID, BUNDLE]);
    let buf = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`no "RESULT done" in 120 s; output:\n${buf}`));
    }, 120000);
    const onData = (d) => {
      buf += d.toString();
      if (buf.includes("RESULT done")) {
        clearTimeout(timer);
        child.kill("SIGKILL");
        simctl("terminate", UDID, BUNDLE);
        resolve(buf.split(/\r?\n/).filter((l) => l.includes("JVTEST")).map((l) => l.slice(l.indexOf("JVTEST ") + 7)));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
  });
}

simctl("uninstall", UDID, BUNDLE);
simctl("install", UDID, APP_PATH);
const runs = [];
runs.push(parseRun(await launch()));
runs.push(parseRun(await launch()));
simctl("install", UDID, APP_PATH);
runs.push(parseRun(await launch()));
console.log(JSON.stringify(runs, null, 2));
const problems = checkRuns(runs);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("PASS: the sync engine runs on this simulator's SQLite WASM over OPFS, and the database survives a relaunch and an update");
