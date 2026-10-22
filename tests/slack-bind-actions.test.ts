import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockButtonAction } from "@slack/bolt";
import type { SlackClientDeps } from "../src/slack-client.js";

const mocks = vi.hoisted(() => ({
  actionId: "",
  handler: undefined as undefined | ((args: {
    ack: () => Promise<void>; body: BlockButtonAction; action: BlockButtonAction["actions"][number];
  }) => Promise<void>),
  post: vi.fn(),
}));

vi.mock("@slack/bolt", () => ({ default: {
  App: class {
    client = { chat: { postMessage: mocks.post } };
    assistant() {}
    message() {}
    action(id: string, handler: typeof mocks.handler) { mocks.actionId = id; mocks.handler = handler; }
  },
  Assistant: class {},
  LogLevel: { WARN: "warn" },
} }));

import { BIND_PANE_ACTION, SlackClient } from "../src/slack-client.js";

function client() {
  const deps: SlackClientDeps = {
    name: "test", botToken: "test", appToken: "test",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    onThreadStarted: vi.fn(), onUserMessage: vi.fn(), onUserFiles: vi.fn(),
    onBindPane: vi.fn(async () => {}), isOwnBot: id => id === "UBOT",
  };
  return { deps, slack: new SlackClient(deps) };
}

function body(threadTs: string | undefined = "1.0"): BlockButtonAction {
  return {
    type: "block_actions", user: { id: "U1" }, channel: { id: "C1" },
    message: { ts: "2.0", ...(threadTs ? { thread_ts: threadTs } : {}) },
    actions: [{ type: "button", action_id: BIND_PANE_ACTION, value: "target" }],
  } as BlockButtonAction;
}

async function click(payload: BlockButtonAction, ack = vi.fn(async () => {})) {
  await mocks.handler!({ ack, body: payload, action: payload.actions[0] });
  expect(ack).toHaveBeenCalledOnce();
}

beforeEach(() => { vi.clearAllMocks(); mocks.post.mockReset().mockResolvedValue({ ts: "3.0" }); });

describe("Slack Bind action transport", () => {
  it("acknowledges before dispatch and uses the list message's parent thread", async () => {
    const { deps } = client();
    expect(mocks.actionId).toBe(BIND_PANE_ACTION);
    let release!: () => void;
    const ack = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const payload = body();
    const pending = click(payload, ack);
    expect(deps.onBindPane).not.toHaveBeenCalled();
    release();
    await pending;
    expect(deps.onBindPane).toHaveBeenCalledExactlyOnceWith({ channel: "C1", threadTs: "1.0" }, "U1", "target");
    expect(deps.onUserMessage).not.toHaveBeenCalled();
  });

  it("uses the clicked message itself for a top-level list, including DMs", async () => {
    const { deps } = client();
    const payload = body("");
    payload.channel!.id = "D1";
    await click(payload);
    expect(deps.onBindPane).toHaveBeenCalledWith({ channel: "D1", threadTs: "2.0" }, "U1", "target");
  });

  it.each(["channel", "message", "bot", "value"])("acks but ignores actions missing safe context: %s", async invalid => {
    const { deps } = client();
    const payload = body();
    if (invalid === "channel") payload.channel = undefined;
    if (invalid === "message") payload.message = undefined;
    if (invalid === "bot") payload.user.id = "UBOT";
    if (invalid === "value") payload.actions[0].value = undefined;
    await click(payload);
    expect(deps.onBindPane).not.toHaveBeenCalled();
  });

  it("posts blocks alongside fallback text and retries as text if Slack rejects them", async () => {
    const { slack, deps } = client();
    const thread = { channel: "C1", threadTs: "1.0" };
    const blocks = [{ type: "section" as const, text: { type: "mrkdwn" as const, text: "pane" } }];
    mocks.post.mockRejectedValueOnce(Object.assign(new Error("invalid_blocks"), { data: { error: "invalid_blocks" } }));
    expect(await slack.post(thread, "!bind w1:p1", blocks)).toBe("3.0");
    expect(mocks.post.mock.calls[0][0]).toMatchObject({ channel: "C1", thread_ts: "1.0", text: "!bind w1:p1", blocks });
    expect(mocks.post.mock.calls[1][0]).not.toHaveProperty("blocks");
    expect(deps.logger.warn).toHaveBeenCalledOnce();
  });

  it("does not retry ordinary posts or ambiguous network failures with blocks", async () => {
    const { slack } = client();
    mocks.post.mockRejectedValue(new Error("offline"));
    await expect(slack.post({ channel: "C1", threadTs: "1.0" }, "hello")).rejects.toThrow("offline");
    expect(mocks.post).toHaveBeenCalledOnce();
    await expect(slack.post({ channel: "C1", threadTs: "1.0" }, "panes", [])).rejects.toThrow("offline");
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });

  it("does not hide a failed text fallback", async () => {
    const { slack } = client();
    mocks.post.mockRejectedValueOnce({ data: { error: "invalid_blocks" } }).mockRejectedValueOnce(new Error("offline"));
    await expect(slack.post({ channel: "C1", threadTs: "1.0" }, "panes", [])).rejects.toThrow("offline");
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });
});
