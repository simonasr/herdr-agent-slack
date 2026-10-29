import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, resolveConfigDir } from "../src/config.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("loadConfig — the turn settings", () => {
  const tmpDir = path.join(os.tmpdir(), "herdr-slack-test-" + Date.now());
  const configFile = path.join(tmpDir, "config.toml");

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    delete process.env.HERDR_BRIDGE_OUTPUT_MODE;
    delete process.env.HERDR_SLACK_OUTPUT_MODE;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("has defaults for everything the turn machinery reads", () => {
    fs.writeFileSync(configFile, '[slack]\nbot_token = "xoxb"\napp_token = "xapp"\n');
    const cfg = loadConfig(tmpDir);
    expect(cfg.throttleMs).toBe(60_000);
    expect(cfg.progressIntervalMs).toBe(15_000);
    expect(cfg.maxProgressUpdates).toBe(60);
    expect(cfg.stabilityWindowMs).toBe(30_000);
    expect(cfg.followTimeoutMinutes).toBe(30);
    expect(cfg.outputMode).toBe("final");
    expect(cfg.relayTerminalTurns).toBe(true);
    expect(cfg.slackBots[0].conciergePane).toBe("");
    expect(cfg.slackBots[0].conciergeRecentContext).toBe(false);
  });

  it("reads the turn settings from a [slack.<name>] section", () => {
    fs.writeFileSync(configFile, [
      "[slack.shaka]",
      'bot_token = "xoxb"',
      'app_token = "xapp"',
      "progress_interval_ms = 5000",
      "stability_window_ms = 45000",
      "max_total_wait_s = 600",
      "relay_terminal_turns = false",
    ].join("\n"));
    const cfg = loadConfig(tmpDir);
    expect(cfg.progressIntervalMs).toBe(5_000);
    expect(cfg.stabilityWindowMs).toBe(45_000);
    expect(cfg.maxTotalWaitS).toBe(600);
    expect(cfg.relayTerminalTurns).toBe(false);
  });

  it("falls back to the default output mode for an unknown value", () => {
    fs.writeFileSync(configFile, '[slack]\nbot_token = "xoxb"\napp_token = "xapp"\noutput_mode = "verbose"\n');
    expect(loadConfig(tmpDir).outputMode).toBe("final");
  });

  it("lets the environment override the output mode", () => {
    fs.writeFileSync(configFile, '[slack]\nbot_token = "xoxb"\napp_token = "xapp"\n');
    process.env.HERDR_SLACK_OUTPUT_MODE = "STREAM";
    expect(loadConfig(tmpDir).outputMode).toBe("stream");
  });

  it("takes the first bot's tokens from the environment", () => {
    fs.writeFileSync(configFile, '[slack]\nbot_token = "file"\napp_token = "file-app"\n');
    process.env.HERDR_SLACK_BOT_TOKEN = "env";
    try {
      expect(loadConfig(tmpDir).slackBotToken).toBe("env");
    } finally {
      delete process.env.HERDR_SLACK_BOT_TOKEN;
    }
  });
});

describe("resolveConfigDir", () => {
  let home: string;
  let realHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cfgdir-home-"));
    realHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.HERDR_SLACK_CONFIG_DIR;
  });

  it("prefers an explicit argument over everything", () => {
    process.env.HERDR_SLACK_CONFIG_DIR = "/from/env";
    expect(resolveConfigDir("/explicit")).toBe("/explicit");
  });

  it("reads the environment variable", () => {
    process.env.HERDR_SLACK_CONFIG_DIR = path.join(home, "a");
    expect(resolveConfigDir()).toBe(path.join(home, "a"));
  });

  it("defaults to ~/.config/herdr-slack", () => {
    expect(resolveConfigDir()).toBe(path.join(home, ".config", "herdr-slack"));
  });
});

const { mkdtempSync, writeFileSync, rmSync } = fs;
const { join } = path;
const { tmpdir } = os;

describe("[slack.<name>] — several bots in one config", () => {
  it("reads each bot with its own tokens, allowlist and spawn defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-bots-"));
    try {
      writeFileSync(join(dir, "config.toml"), [
        "[slack.shaka]",
        'bot_token = "xoxb-s"',
        'app_token = "xapp-s"',
        'allowed_user_ids = ["U1"]',
        "",
        "[slack.lilith]",
        'bot_token = "xoxb-l"',
        'app_token = "xapp-l"',
        'spawn_agent = "codex"',
        'spawn_args = ["--yolo"]',
        'default_pane = "coder-home"',
        'concierge_pane = "w9:p2"',
        'concierge_recent_context = true',
        'channel_pane = "fresh"',
        'spawn_cwd = "/srv/work"',
        'idle_close_minutes = 30',
        'role = "You code. Plans come from shaka."',
        'max_handoffs = 5',
      ].join("\n"));
      const cfg = loadConfig(dir);
      expect(cfg.slackBots.map((b) => b.name)).toEqual(["shaka", "lilith"]);
      expect(cfg.slackBots[0]).toMatchObject({ botToken: "xoxb-s", appToken: "xapp-s", allowedUserIds: ["U1"], spawnAgent: "codex", spawnArgs: [] });
      expect(cfg.slackBots[1]).toMatchObject({ botToken: "xoxb-l", allowedUserIds: [], spawnArgs: ["--yolo"], defaultPane: "coder-home", channelPane: "fresh", spawnCwd: "/srv/work", idleCloseMinutes: 30, role: "You code. Plans come from shaka.", maxHandoffs: 5 });
      expect(cfg.slackBots[0].maxHandoffs).toBe(20);
      expect(cfg.slackBots.map(bot => bot.conciergePane)).toEqual(["", "w9:p2"]);
      expect(cfg.slackBots.map(bot => bot.conciergeRecentContext)).toEqual([false, true]);
      expect(cfg.slackBots[0]).toMatchObject({ defaultPane: "", channelPane: "shared", spawnCwd: "", idleCloseMinutes: 120 });
      // The flat fields still describe the first bot.
      expect(cfg.slackBotToken).toBe("xoxb-s");
      expect(cfg.allowedSlackUserIds).toEqual(["U1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a per-channel pane table for each bot", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-channels-"));
    try {
      writeFileSync(join(dir, "config.toml"), [
        "[slack.shaka]",
        'bot_token = "xoxb-s"',
        'app_token = "xapp-s"',
        "",
        "[slack.shaka.channels]",
        'C0BJLRE4GP4 = "develop-legal-bot"',
        '"#legal-bot-test" = "develop-legal-bot"',
        'Harness = "planner-harness"',
        "",
        "[slack.lilith]",
        'bot_token = "xoxb-l"',
        'app_token = "xapp-l"',
      ].join("\n"));
      const cfg = loadConfig(dir);
      expect(cfg.slackBots.map((b) => b.name)).toEqual(["shaka", "lilith"]);
      // Keys are lower-cased and stripped of `#`, so either spelling matches.
      expect(cfg.slackBots[0].channelPanes).toEqual({
        c0bjlre4gp4: "develop-legal-bot",
        "legal-bot-test": "develop-legal-bot",
        harness: "planner-harness",
      });
      expect(cfg.slackBots[1].channelPanes).toEqual({});
      // The table did not disturb the bot's own fields.
      expect(cfg.slackBots[1].botToken).toBe("xoxb-l");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a bare [slack] as the one bot named default", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-bot-"));
    try {
      writeFileSync(join(dir, "config.toml"), '[slack]\nbot_token = "xoxb-1"\napp_token = "xapp-1"\n');
      const cfg = loadConfig(dir);
      expect(cfg.slackBots).toHaveLength(1);
      expect(cfg.slackBots[0].name).toBe("default");
      expect(cfg.slackBotToken).toBe("xoxb-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
