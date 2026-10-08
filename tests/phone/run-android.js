// SPDX-License-Identifier: MIT
// Runs the phone test on a running Android emulator (or a phone on adb): builds the app, installs
// it fresh, launches it three times (fresh · relaunched after a force-stop · after reinstalling
// over itself, as an app update does) and checks the results.
//   ANDROID_HOME (the SDK), JAVA_HOME (JDK 21) — defaults are this family's dev machine.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkRuns, parseRun } from "./check.js";

const SDK = process.env.ANDROID_HOME || "E:/Android/Sdk";
const JAVA = process.env.JAVA_HOME || "E:/Android/jdk-21";
const ADB = path.join(SDK, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
const APP = "org.justfamily.sqlitesynctest";
const env = { ...process.env, ANDROID_HOME: SDK, ANDROID_SDK_ROOT: SDK, JAVA_HOME: JAVA };
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", env, shell: process.platform === "win32", ...opts });
const adb = (...args) => spawnSync(ADB, args, { env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).stdout ?? "";

sh("npm", ["run", "build"]);
if (!existsSync("android")) sh("npx", ["cap", "add", "android"]);
sh("npx", ["cap", "sync", "android"]);
writeFileSync("android/local.properties", `sdk.dir=${SDK.replace(/\\/g, "/")}\n`);
sh(path.resolve("android", process.platform === "win32" ? "gradlew.bat" : "gradlew"), ["assembleDebug", "-q"], { cwd: "android" });
const apk = "android/app/build/outputs/apk/debug/app-debug.apk";

async function launch() {
  adb("shell", "am", "force-stop", APP);
  adb("logcat", "-c");
  adb("shell", "am", "start", "-W", "-n", `${APP}/.MainActivity`);
  for (let i = 0; i < 60; i++) {
    const log = adb("logcat", "-d", "-s", "Capacitor/Console:*");
    if (log.includes("RESULT done")) {
      adb("shell", "am", "force-stop", APP);
      return log.split(/\r?\n/).filter((l) => l.includes("JVTEST")).map((l) => l.slice(l.indexOf("JVTEST ") + 7));
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("the app never reported RESULT done");
}

adb("uninstall", APP);
adb("install", apk);
const runs = [];
runs.push(parseRun(await launch()));
runs.push(parseRun(await launch()));
adb("install", "-r", apk);
runs.push(parseRun(await launch()));
console.log(JSON.stringify(runs, null, 2));
const problems = checkRuns(runs);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("PASS: the sync engine runs on this phone's SQLite WASM over OPFS, and the database survives a relaunch and an update");
