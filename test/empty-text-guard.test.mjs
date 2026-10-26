import test from "node:test";
import assert from "node:assert/strict";
import { Config, DEFAULT_NUDGE, apply, hasToolCall, hasVisibleText } from "../lib/index.js";

/** 构造一个只记录监听器的最小 ctx。 */
function createHarness(config = {}) {
  const listeners = new Map();
  const logs = { info: [], warn: [] };
  const ctx = {
    logger: {
      info: (msg) => logs.info.push(String(msg)),
      warn: (msg) => logs.warn.push(String(msg)),
      debug: () => {},
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return () => {};
    },
  };
  apply(ctx, {
    enabled: true,
    maxAttempts: 3,
    minTextChars: 1,
    nudgeText: "",
    ...config,
  });
  const emit = async (event, ...args) => {
    for (const handler of listeners.get(event) ?? []) await handler(...args);
  };
  return { ctx, emit, logs };
}

/** 构造最小 agent：带 session 与可写 next-step inbox。 */
function createAgent() {
  const nextStep = [];
  return {
    id: "agent-1",
    session: { id: "session-1" },
    inbox: {
      prepend(target, message) {
        assert.equal(target, "next-step");
        nextStep.unshift(message);
      },
    },
    nextStep,
  };
}

/** 让 harness 收到一条 assistant/message。 */
async function seeAssistant(emit, session, turn, content) {
  await emit("session/event", session, {
    type: "assistant/message",
    data: { turn, step: 1, message: { content } },
  });
}

const REASONING_ONLY = [{ type: "reasoning", text: "我想了很多，但什么都没写出来。" }];
const WITH_TEXT = [
  { type: "reasoning", text: "想" },
  { type: "text", text: "昆明二手房约 9571 元/㎡。" },
];
const WITH_TOOL = [{ type: "tool-call", name: "bash", arguments: "{}" }];

test("hasVisibleText：只认 text 块，reasoning 不算正文", () => {
  assert.equal(hasVisibleText({ content: REASONING_ONLY }, 1), false);
  assert.equal(hasVisibleText({ content: WITH_TEXT }, 1), true);
  assert.equal(hasVisibleText({ content: [{ type: "text", text: "   \n " }] }, 1), false);
  assert.equal(hasVisibleText(undefined, 1), false);
});

test("hasToolCall：识别 tool-call 块", () => {
  assert.equal(hasToolCall({ content: WITH_TOOL }), true);
  assert.equal(hasToolCall({ content: WITH_TEXT }), false);
  assert.equal(hasToolCall(undefined), false);
});

test("正文为空：注入一条续写提示到 next-step", async () => {
  const { emit } = createHarness();
  const agent = createAgent();

  await seeAssistant(emit, agent.session, 1, REASONING_ONLY);
  await emit("agent/turn-stopping", { agent, turn: 1, signal: { aborted: false } });

  assert.equal(agent.nextStep.length, 1);
  assert.equal(agent.nextStep[0].role, "user");
  assert.equal(agent.nextStep[0].content[0].type, "text");
  assert.equal(agent.nextStep[0].content[0].text, DEFAULT_NUDGE);
  assert.equal(typeof agent.nextStep[0].id, "string");
  assert.ok(agent.nextStep[0].id.length > 0);
});

test("正文非空：不注入，正常收尾", async () => {
  const { emit } = createHarness();
  const agent = createAgent();

  await seeAssistant(emit, agent.session, 1, WITH_TEXT);
  await emit("agent/turn-stopping", { agent, turn: 1, signal: { aborted: false } });

  assert.equal(agent.nextStep.length, 0);
});

test("有 tool-call：不干预（这一步本来就会继续）", async () => {
  const { emit } = createHarness();
  const agent = createAgent();

  await seeAssistant(emit, agent.session, 1, WITH_TOOL);
  await emit("agent/turn-stopping", { agent, turn: 1, signal: { aborted: false } });

  assert.equal(agent.nextStep.length, 0);
});

test("只对同一个 turn 生效：上一轮的空消息不该影响本轮", async () => {
  const { emit } = createHarness();
  const agent = createAgent();

  // turn 1 是空正文，但 turn-stopping 发生在 turn 2
  await seeAssistant(emit, agent.session, 1, REASONING_ONLY);
  await emit("agent/turn-stopping", { agent, turn: 2, signal: { aborted: false } });

  assert.equal(agent.nextStep.length, 0);
});

test("达到 maxAttempts 后放行并记 warn，不无限续写", async () => {
  const { emit, logs } = createHarness({ maxAttempts: 2 });
  const agent = createAgent();

  for (let i = 0; i < 5; i += 1) {
    await seeAssistant(emit, agent.session, 7, REASONING_ONLY);
    await emit("agent/turn-stopping", { agent, turn: 7, signal: { aborted: false } });
  }

  assert.equal(agent.nextStep.length, 2, "只应注入 maxAttempts 次");
  assert.equal(logs.warn.length, 3, "超限的 3 次每次都要 warn");
  assert.ok(logs.warn.every((line) => line.includes("重试上限")));
});

test("signal 已中止时不注入", async () => {
  const { emit } = createHarness();
  const agent = createAgent();

  await seeAssistant(emit, agent.session, 1, REASONING_ONLY);
  await emit("agent/turn-stopping", { agent, turn: 1, signal: { aborted: true } });

  assert.equal(agent.nextStep.length, 0);
});

test("enabled=false 时完全不动", async () => {
  const { emit } = createHarness({ enabled: false });
  const agent = createAgent();

  await seeAssistant(emit, agent.session, 1, REASONING_ONLY);
  await emit("agent/turn-stopping", { agent, turn: 1, signal: { aborted: false } });

  assert.equal(agent.nextStep.length, 0);
});

test("可以自定义提示语", async () => {
  const { emit } = createHarness({ nudgeText: "请输出正文。" });
  const agent = createAgent();

  await seeAssistant(emit, agent.session, 1, REASONING_ONLY);
  await emit("agent/turn-stopping", { agent, turn: 1, signal: { aborted: false } });

  assert.equal(agent.nextStep[0].content[0].text, "请输出正文。");
});

test("Config 有合理默认值", () => {
  assert.equal(Config({}).maxAttempts, 3);
  assert.equal(Config({}).minTextChars, 1);
  assert.equal(Config({}).enabled, true);
});
