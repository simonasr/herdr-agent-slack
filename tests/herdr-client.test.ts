import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAgentList,
  buildSendTextArgs,
  buildSendKeysArgs,
  buildWaitArgs,
  herdrBin,
  resetHerdrBinCache,
  getAgentInfo,
  getAgentInfoAsync,
} from "../src/herdr-client.js";

describe("herdrBin resolution", () => {
  let originalEnv: string | undefined;
  let tmpDir: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.HERDR_BIN_PATH;
    // Always start with a clean cache so env / PATH changes take effect
    resetHerdrBinCache();
  });

  afterEach(() => {
    process.env.HERDR_BIN_PATH = originalEnv;
    resetHerdrBinCache();
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true }); } catch {}
      tmpDir = undefined;
    }
  });

  it("uses HERDR_BIN_PATH when it points to an existing file", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "herdr-test-"));
    const fakeBin = join(tmpDir, "herdr");
    writeFileSync(fakeBin, "#!/bin/sh\necho ok\n");
    chmodSync(fakeBin, 0o755);
    process.env.HERDR_BIN_PATH = fakeBin;
    resetHerdrBinCache();
    expect(herdrBin()).toBe(fakeBin);
  });

  it("ignores HERDR_BIN_PATH when it points to a missing file", () => {
    process.env.HERDR_BIN_PATH = "/nonexistent/path/to/herdr";
    resetHerdrBinCache();
    const bin = herdrBin();
    // Should fall back to "which" lookup or "herdr" — never silently accept
    // a bogus override.
    expect(bin).not.toBe("/nonexistent/path/to/herdr");
  });

  it("returns the cached value across calls (no repeated resolution)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "herdr-test-"));
    const fakeBin = join(tmpDir, "herdr");
    writeFileSync(fakeBin, "#!/bin/sh\necho ok\n");
    chmodSync(fakeBin, 0o755);
    process.env.HERDR_BIN_PATH = fakeBin;
    resetHerdrBinCache();
    const first = herdrBin();
    // Mutate env after the first call — should not affect the cached value
    process.env.HERDR_BIN_PATH = "/somewhere/else";
    const second = herdrBin();
    expect(second).toBe(first);
  });
});

describe("parseAgentList", () => {
  it("parses herdr agent list JSON output", () => {
    const raw = JSON.stringify({
      id: "cli:agent:list",
      result: {
        agents: [
          {
            agent: "pi",
            agent_status: "idle",
            cwd: "/home/user/project",
            pane_id: "w1:pZ",
            tab_id: "w1:tZ",
            workspace_id: "w1",
          },
        ],
      },
    });
    const agents = parseAgentList(raw);
    expect(agents).toHaveLength(1);
    expect(agents[0].pane_id).toBe("w1:pZ");
    expect(agents[0].agent).toBe("pi");
  });

  it("retains display metadata without changing the binding label", () => {
    const raw = JSON.stringify({ result: { agents: [{
      pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent: "pi", agent_status: "working",
      name: "payments-fix", cwd: "/repo", foreground_cwd: "/repo/worktree",
      terminal_title_stripped: "Fix payments", terminal_title: "\u001b[1mFix payments",
    }] } });
    expect(parseAgentList(raw, new Map([["w1:t1", "1"]]))[0]).toMatchObject({
      label: "1", name: "payments-fix", cwd: "/repo/worktree", title: "Fix payments", status: "working",
    });
  });

  it("uses the launch cwd when foreground metadata is missing and ignores blank display names", () => {
    const raw = JSON.stringify({ result: { agents: [{
      pane_id: "w1:p1", tab_id: "w1:t1", agent: "pi", cwd: "/repo", foreground_cwd: "",
      name: "  ", terminal_title_stripped: null,
    }] } });
    const pane = parseAgentList(raw, new Map([["w1:t1", "project"]]))[0];
    expect(pane).toMatchObject({ label: "project", cwd: "/repo" });
    expect(pane.name).toBeUndefined();
    expect(pane.title).toBeUndefined();
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseAgentList("{ invalid }")).toEqual([]);
  });

  it("returns empty array for missing result", () => {
    expect(parseAgentList('{"id":"x"}')).toEqual([]);
  });
});

describe("buildSendTextArgs", () => {
  it("builds correct args tuple", () => {
    expect(buildSendTextArgs("w1:pZ", "hello world")).toEqual([
      "pane", "run", "w1:pZ", "hello world",
    ]);
  });
});

describe("buildSendKeysArgs", () => {
  it("builds args tuple with a single named key", () => {
    expect(buildSendKeysArgs("w1:pZ", "Escape")).toEqual([
      "pane", "send-keys", "w1:pZ", "Escape",
    ]);
  });

  it("appends additional named keys when given", () => {
    expect(buildSendKeysArgs("w1:pZ", "Escape", "Enter")).toEqual([
      "pane", "send-keys", "w1:pZ", "Escape", "Enter",
    ]);
  });
});

describe("buildWaitArgs", () => {
  it("builds correct args tuple with timeout in ms", () => {
    expect(buildWaitArgs("w1:pZ", 5)).toEqual([
      "agent", "wait", "w1:pZ", "--status", "idle", "--timeout", "5000",
    ]);
  });
});

describe("getAgentInfo", () => {
  let originalBinEnv: string | undefined;
  let originalSocketEnv: string | undefined;
  let tmpDir: string;
  let fakeBin: string;
  let configPath: string;
  let argsPath: string;
  let socketPath: string;
  let socketServer: Server | undefined;

  const target = "w1:pX";

  function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  function configureCli(stdout: string, options: { exitCode?: number; replaceSocket?: boolean; delayMs?: number } = {}): void {
    writeFileSync(configPath, JSON.stringify({ stdout, ...options, socketPath }));
  }

  function validAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      agent: "pi",
      agent_status: "idle",
      pane_id: target,
      tab_id: "w1:tX",
      workspace_id: "w1",
      foreground_cwd: "/repo",
      agent_session: { kind: "path", value: "/sessions/current.jsonl" },
      terminal_id: "terminal-1",
      state_change_seq: 0,
      ...overrides,
    };
  }

  function configureAgent(agent: Record<string, unknown>): void {
    configureCli(JSON.stringify({ result: { agent } }));
  }

  async function startSocket(): Promise<void> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    socketServer = server;
  }

  function socketIdentity(path: string): string {
    const info = statSync(path, { bigint: true });
    return `${info.dev}:${info.ino}:${info.ctimeNs}`;
  }

  beforeEach(() => {
    originalBinEnv = process.env.HERDR_BIN_PATH;
    originalSocketEnv = process.env.HERDR_SOCKET_PATH;
    resetHerdrBinCache();
    tmpDir = mkdtempSync(join(tmpdir(), "herdr-info-test-"));
    fakeBin = join(tmpDir, "fake-herdr");
    configPath = join(tmpDir, "cli-config.json");
    argsPath = join(tmpDir, "cli-args.json");
    socketPath = join(tmpDir, "herdr.sock");
    const executable = `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst net = require("node:net");\nconst config = JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}, "utf8"));\nfs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));\nconst finish = () => setTimeout(() => process.stdout.write(config.stdout, () => process.exit(config.exitCode ?? 0)), config.delayMs ?? 0);\nif (config.replaceSocket) {\n  fs.renameSync(config.socketPath, config.socketPath + ".previous");\n  const server = net.createServer();\n  server.once("error", () => process.exit(2));\n  server.listen(config.socketPath, finish);\n} else finish();\n`;
    writeFileSync(fakeBin, executable);
    chmodSync(fakeBin, 0o755);
    process.env.HERDR_BIN_PATH = fakeBin;
    process.env.HERDR_SOCKET_PATH = socketPath;
    configureAgent(validAgent());
    resetHerdrBinCache();
  });

  afterEach(async () => {
    if (socketServer) {
      await new Promise<void>((resolve) => socketServer!.close(() => resolve()));
      socketServer = undefined;
    }
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv("HERDR_BIN_PATH", originalBinEnv);
    restoreEnv("HERDR_SOCKET_PATH", originalSocketEnv);
    resetHerdrBinCache();
  });

  it("fetches metadata with a real asynchronous child without blocking event-loop timers", async () => {
    await startSocket();
    configureCli(JSON.stringify({ result: { agent: validAgent({
      state_change_seq: 8, completion_seq: 8, screen_detection_skipped: true, launch_pending: false,
    }) } }), { delayMs: 200 });
    let settled = false;
    const query = getAgentInfoAsync(target).then(info => { settled = true; return info; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false); // would fail if agent get used spawnSync
    const info = await query;
    expect(info).toMatchObject({
      agent: "pi", pane_id: target, agent_session: { kind: "path", path: "/sessions/current.jsonl" },
      completion_evidence: {
        endpoint_identity: socketIdentity(socketPath), state_change_seq: 8, completion_seq: 8,
        screen_detection_skipped: true, launch_pending: false,
      },
    });
    expect(JSON.parse(readFileSync(argsPath, "utf8"))).toEqual(["agent", "get", target]);
  });

  it("withholds asynchronous evidence after endpoint replacement", async () => {
    await startSocket();
    configureCli(JSON.stringify({ result: { agent: validAgent() } }), { replaceSocket: true });
    const info = await getAgentInfoAsync(target);
    expect(info).toMatchObject({ agent: "pi", pane_id: target });
    expect(info).not.toHaveProperty("completion_evidence");
  });

  it("keeps asynchronous metadata but no proof for an unavailable endpoint", async () => {
    const info = await getAgentInfoAsync(target);
    expect(info).toMatchObject({ agent: "pi", pane_id: target });
    expect(info).not.toHaveProperty("completion_evidence");
  });

  it.each([
    ["CLI failure", JSON.stringify({ result: { agent: { agent: "pi" } } }), 1],
    ["malformed JSON", "not json", 0],
    ["missing agent", JSON.stringify({ result: {} }), 0],
  ])("returns null for asynchronous %s", async (_label, stdout, exitCode) => {
    configureCli(stdout, { exitCode });
    expect(await getAgentInfoAsync(target)).toBeNull();
  });

  it("returns null for asynchronous process launch failure", async () => {
    // Cache an existing path, then remove it to exercise spawn's error event.
    herdrBin();
    rmSync(fakeBin);
    expect(await getAgentInfoAsync(target)).toBeNull();
  });

  it("returns ordinary metadata and exact normalized evidence for a stable socket", async () => {
    await startSocket();
    const endpoint = socketIdentity(socketPath);
    const info = getAgentInfo(target);

    expect(info).toEqual({
      agent: "pi",
      agent_status: "idle",
      pane_id: target,
      tab_id: "w1:tX",
      workspace_id: "w1",
      agent_session: { kind: "path", path: "/sessions/current.jsonl" },
      cwd: "/repo",
      completion_evidence: {
        terminal_id: "terminal-1",
        state_change_seq: 0,
        completion_seq: null,
        screen_detection_skipped: false,
        launch_pending: false,
        endpoint_identity: endpoint,
      },
    });
    expect(JSON.parse(readFileSync(argsPath, "utf8"))).toEqual(["agent", "get", target]);
  });

  it("preserves explicit completion, id-session mapping, true booleans, and safe large counters", async () => {
    await startSocket();
    configureAgent(validAgent({
      agent_session: { kind: "id", value: "session-42" },
      state_change_seq: Number.MAX_SAFE_INTEGER,
      completion_seq: Number.MAX_SAFE_INTEGER,
      screen_detection_skipped: true,
      launch_pending: true,
    }));

    const info = getAgentInfo(target);
    expect(info).not.toBeNull();
    expect(info?.agent_session).toEqual({ kind: "id", id: "session-42" });
    expect(info?.completion_evidence).toMatchObject({
      state_change_seq: Number.MAX_SAFE_INTEGER,
      completion_seq: Number.MAX_SAFE_INTEGER,
      screen_detection_skipped: true,
      launch_pending: true,
    });
  });

  it("normalizes an explicit null completion sequence to no current completion", async () => {
    await startSocket();
    configureAgent(validAgent({ completion_seq: null, screen_detection_skipped: false, launch_pending: false }));
    expect(getAgentInfo(target)?.completion_evidence).toMatchObject({
      completion_seq: null,
      screen_detection_skipped: false,
      launch_pending: false,
    });
  });

  it("accepts an older completion sequence without imposing a counter-gap rule", async () => {
    await startSocket();
    configureAgent(validAgent({ state_change_seq: 100, completion_seq: 17 }));
    expect(getAgentInfo(target)?.completion_evidence?.completion_seq).toBe(17);
  });

  it("uses the same endpoint identity across repeated stable reads", async () => {
    await startSocket();
    const first = getAgentInfo(target);
    const second = getAgentInfo(target);
    expect(first?.completion_evidence?.endpoint_identity).toBe(socketIdentity(socketPath));
    expect(second?.completion_evidence?.endpoint_identity).toBe(first?.completion_evidence?.endpoint_identity);
  });

  it.each([
    ["string state counter", (agent: Record<string, unknown>) => { agent.state_change_seq = "1"; }],
    ["fractional state counter", (agent: Record<string, unknown>) => { agent.state_change_seq = 1.5; }],
    ["negative state counter", (agent: Record<string, unknown>) => { agent.state_change_seq = -1; }],
    ["unsafe state counter", (agent: Record<string, unknown>) => { agent.state_change_seq = Number.MAX_SAFE_INTEGER + 1; }],
    ["missing state counter", (agent: Record<string, unknown>) => { delete agent.state_change_seq; }],
    ["null state counter", (agent: Record<string, unknown>) => { agent.state_change_seq = null; }],
    ["string completion counter", (agent: Record<string, unknown>) => { agent.completion_seq = "1"; }],
    ["fractional completion counter", (agent: Record<string, unknown>) => { agent.completion_seq = 1.5; }],
    ["negative completion counter", (agent: Record<string, unknown>) => { agent.completion_seq = -1; }],
    ["unsafe completion counter", (agent: Record<string, unknown>) => { agent.completion_seq = Number.MAX_SAFE_INTEGER + 1; }],
    ["zero completion counter", (agent: Record<string, unknown>) => { agent.completion_seq = 0; }],
    ["completion above state counter", (agent: Record<string, unknown>) => { agent.completion_seq = 101; }],
    ["missing terminal id", (agent: Record<string, unknown>) => { delete agent.terminal_id; }],
    ["empty terminal id", (agent: Record<string, unknown>) => { agent.terminal_id = " "; }],
    ["malformed terminal id", (agent: Record<string, unknown>) => { agent.terminal_id = 7; }],
    ["missing agent identity", (agent: Record<string, unknown>) => { delete agent.agent; }],
    ["empty agent identity", (agent: Record<string, unknown>) => { agent.agent = ""; }],
    ["malformed agent identity", (agent: Record<string, unknown>) => { agent.agent = 7; }],
    ["missing pane identity", (agent: Record<string, unknown>) => { delete agent.pane_id; }],
    ["empty pane identity", (agent: Record<string, unknown>) => { agent.pane_id = " "; }],
    ["malformed pane identity", (agent: Record<string, unknown>) => { agent.pane_id = 7; }],
    ["missing session", (agent: Record<string, unknown>) => { delete agent.agent_session; }],
    ["unsupported session kind", (agent: Record<string, unknown>) => { agent.agent_session = { kind: "other", value: "x" }; }],
    ["empty session value", (agent: Record<string, unknown>) => { agent.agent_session = { kind: "path", value: "" }; }],
    ["malformed session value", (agent: Record<string, unknown>) => { agent.agent_session = { kind: "id", value: 7 }; }],
    ["wrong screen flag type", (agent: Record<string, unknown>) => { agent.screen_detection_skipped = "false"; }],
    ["null screen flag", (agent: Record<string, unknown>) => { agent.screen_detection_skipped = null; }],
    ["wrong launch flag type", (agent: Record<string, unknown>) => { agent.launch_pending = "false"; }],
    ["null launch flag", (agent: Record<string, unknown>) => { agent.launch_pending = null; }],
  ])("omits all evidence for %s while preserving ordinary metadata", async (_name, mutate) => {
    await startSocket();
    const agent = validAgent({ state_change_seq: 100 });
    mutate(agent);
    configureAgent(agent);

    const info = getAgentInfo(target);
    expect(info).not.toBeNull();
    expect(info?.agent_status).toBe("idle");
    expect(info?.tab_id).toBe("w1:tX");
    expect(info).not.toHaveProperty("completion_evidence");
  });

  it.each([
    ["absent socket environment", "absent"],
    ["missing socket path", "missing"],
    ["regular-file endpoint", "regular"],
  ])("omits evidence for %s and keeps parsed metadata", async (_name, endpointCase) => {
    if (endpointCase === "absent") delete process.env.HERDR_SOCKET_PATH;
    if (endpointCase === "missing") process.env.HERDR_SOCKET_PATH = `${socketPath}.missing`;
    if (endpointCase === "regular") writeFileSync(socketPath, "not a socket");

    const info = getAgentInfo(target);
    expect(info).not.toBeNull();
    expect(info?.agent).toBe("pi");
    expect(info?.agent_session).toEqual({ kind: "path", path: "/sessions/current.jsonl" });
    expect(info).not.toHaveProperty("completion_evidence");
    expect(JSON.parse(readFileSync(argsPath, "utf8"))).toEqual(["agent", "get", target]);
  });

  it("omits evidence when the inherited socket endpoint is replaced during the query", async () => {
    await startSocket();
    const before = socketIdentity(socketPath);
    configureCli(JSON.stringify({ result: { agent: validAgent() } }), { replaceSocket: true });

    const info = getAgentInfo(target);
    const after = socketIdentity(socketPath);
    expect(after).not.toBe(before);
    expect(info).not.toBeNull();
    expect(info?.agent_status).toBe("idle");
    expect(info).not.toHaveProperty("completion_evidence");
  });

  it.each([
    ["nonzero CLI exit", JSON.stringify({ result: { agent: validAgent() } }), 1],
    ["malformed JSON", "{ not json", 0],
    ["missing agent", JSON.stringify({ result: {} }), 0],
  ])("returns null for %s without falling through", (_name, stdout, exitCode) => {
    configureCli(stdout, { exitCode });
    expect(getAgentInfo(target)).toBeNull();
    expect(JSON.parse(readFileSync(argsPath, "utf8"))).toEqual(["agent", "get", target]);
  });
});
