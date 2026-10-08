// SPDX-License-Identifier: MIT
// What a passing run looks like: three launches (fresh, relaunched, after an app update), each
// finding the earlier runs in its OPFS database, the device's sequence continuing, and the two
// devices equal after merging.

export function parseRun(lines) {
  const text = lines.join("\n");
  const fail = lines.find((l) => l.includes("RESULT FAIL"));
  const m = /RESULT runsBefore=(\d+) seqBefore=(\d+) seqAfter=(\d+) title=("[^"]*") equal=(true|false)/.exec(text);
  return {
    fail: fail ?? null,
    runsBefore: m ? Number(m[1]) : null,
    seqBefore: m ? Number(m[2]) : null,
    seqAfter: m ? Number(m[3]) : null,
    equal: m ? m[5] === "true" : false,
    saves: /RESULT saves200=(\d+)ms/.exec(text)?.[1] ?? null,
    ua: /JVTEST ua (.*)/.exec(text)?.[1] ?? lines.find((l) => l.startsWith("ua "))?.slice(3) ?? null,
  };
}

export function checkRuns(runs) {
  const problems = [];
  runs.forEach((r, i) => {
    if (r.fail) problems.push(`run ${i + 1}: ${r.fail}`);
    if (r.runsBefore !== i) problems.push(`run ${i + 1}: found ${r.runsBefore} earlier runs, expected ${i}`);
    if (!r.equal) problems.push(`run ${i + 1}: the two devices differ after merging`);
    if (i > 0 && !(r.seqBefore >= runs[i - 1].seqAfter)) problems.push(`run ${i + 1}: the sequence went back (${r.seqBefore} < ${runs[i - 1].seqAfter})`);
  });
  return problems;
}
