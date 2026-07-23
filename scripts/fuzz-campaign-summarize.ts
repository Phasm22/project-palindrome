const IN_PATH = process.argv[2] || "docs/tests/fuzz-results-2026-07-21.jsonl";

function truncate(s: string | undefined | null, n: number): string {
  if (!s) return "";
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? oneLine.slice(0, n) + "…" : oneLine;
}

async function main() {
  const text = await Bun.file(IN_PATH).text();
  const lines = text.split("\n").filter(Boolean);
  for (const line of lines) {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      console.log("PARSE_ERROR", line.slice(0, 100));
      continue;
    }
    if (obj.kind === "multiTurn") {
      console.log(`\n=== MULTI-TURN ${obj.id} (${obj.category}) sessionId=${obj.sessionId} ===`);
      if (obj.description) console.log(`  desc: ${obj.description}`);
      for (const turn of obj.turns || []) {
        const fe = turn.finalEvent;
        console.log(
          `  [${turn.id}] q="${truncate(turn.query, 80)}" status=${turn.postStatus} latency=${turn.latencyMs}ms timedOut=${turn.timedOut} state=${fe?.conversationState || "?"} pendingAction=${fe?.pendingActionId || ""} text="${truncate(fe?.text, 200)}"`
        );
      }
      continue;
    }
    const fe = obj.finalEvent;
    const text_ = fe?.text || "";
    const flags: string[] = [];
    if (obj.postStatus && obj.postStatus !== 200) flags.push(`HTTP${obj.postStatus}`);
    if (obj.timedOut) flags.push("TIMEDOUT");
    if (!fe) flags.push("NO_FINAL_EVENT");
    if (/max (reasoning|steps)/i.test(text_)) flags.push("MAXSTEPS");
    if (/no information found|not found|no vms? (named|called)|no data/i.test(text_)) flags.push("EMPTY_RESULT");
    if (/^error|failed to|exception/i.test(text_)) flags.push("ERROR_TEXT");
    if (fe?.structuredResponse === undefined) flags.push("NO_STRUCTURED_RESPONSE");
    console.log(
      `${obj.id} | ${obj.category} | status=${obj.postStatus} lat=${obj.latencyMs}ms steps=${fe?.totalSteps ?? "?"} tools=${fe?.totalToolCalls ?? "?"} state=${fe?.conversationState || "?"} flags=[${flags.join(",")}]`
    );
    console.log(`   Q: ${truncate(obj.query, 140)}`);
    console.log(`   A: ${truncate(text_, 300)}`);
  }
}

main();
