/**
 * dsh-empty-text-guard
 *
 * 修复缺陷：模型把整段回答写进了 reasoning（思考）通道、正文（text）为空，
 * agent loop 仍判定本轮「completed」，界面上只显示「已完成」而没有任何内容。
 *
 * 思路（不改核心代码，只用官方扩展点）：
 *   agent loop 在结束一轮之前会依次做两步：
 *     1. await dispatch.serial("agent/turn-stopping", { agent, turn, signal })
 *     2. if (turnEnds && inbox.nextStep.length === 0) break;      ← 这里才真正收尾
 *   只要在第 1 步里往 `inbox.next-step` 里塞一条消息，第 2 步就不会成立，
 *   循环会带着 target="next-step" 再走一步，模型因此获得一次重新输出的机会。
 *   这与内置 dsh-goal-round-driver 自动续跑用的是同一套机制。
 *
 * 判定「正文为空」：
 *   - 该 turn 最后一条 assistant/message 里没有任何 text 块（或 text 全是空白）
 *   - 且没有 tool-call 块（有工具调用说明这一步本来就会继续，不该干预）
 *
 * 防死循环：
 *   每个 turn 最多注入 maxAttempts 次，用完就放行并记 warn 日志。
 *
 * @module dsh-empty-text-guard
 */
import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";

/** 插件名（cordis）。 */
const name = "empty-text-guard";

/** 需要的服务：拿得到 Agent 与其 inbox。 */
const inject = ["agents"];

/** 默认续写提示：明确告诉模型「正文为空」并禁止只输出计划。 */
const DEFAULT_NUDGE = [
  "【harness 自动提示，这不是用户发言】",
  "你上一条回复只产出了思考内容，正文（text）为空，用户什么也看不到。",
  "请立刻把完整回答写进正文：不要复述思考过程，不要只说要做什么，直接把结论、数据与说明本身写出来。",
].join("\n");

/** Runtime schema for {@link Config}. */
const Config = z.object({
  /** 关闭后只记录日志、不注入续写提示。 */
  enabled: z.boolean().default(true),
  /** 同一个 turn 最多注入几次续写提示。 */
  maxAttempts: z.number().step(1).min(1).default(3),
  /** 正文（trim 后）至少多少字符才算「有正文」。 */
  minTextChars: z.number().step(1).min(1).default(1),
  /** 自定义续写提示；留空用 {@link DEFAULT_NUDGE}。 */
  nudgeText: z.string().default(""),
});

/**
 * 一条消息是否带有用户可见的正文。
 * @param message - assistant 消息（可能为空）。
 * @param minChars - 正文最少字符数。
 * @returns 是否有足够正文。
 */
function hasVisibleText(message, minChars) {
  const content = message?.content;
  if (!Array.isArray(content)) return false;
  let total = 0;
  for (const block of content) {
    if (block?.type !== "text") continue;
    const text = typeof block.text === "string" ? block.text.trim() : "";
    total += text.length;
    if (total >= minChars) return true;
  }
  return total >= minChars;
}

/**
 * 一条消息是否带工具调用。带工具调用时不干预，让 loop 自己继续。
 * @param message - assistant 消息（可能为空）。
 * @returns 是否含 tool-call 块。
 */
function hasToolCall(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block?.type === "tool-call");
}

/**
 * 取 @deepseek-ai/dsh-llm 的 createUserMessage。
 *
 * 插件随 harness 进程运行、通常能解析到该包；解析不到时退化为本地等价实现
 * （createUserMessage 本身只做「补 id + 冻结」），保证插件不会因解析失败而不可用。
 * @returns 消息构造函数。
 */
let userMessageFactory;
async function resolveUserMessageFactory() {
  if (userMessageFactory !== undefined) return userMessageFactory;
  try {
    const llm = await import("@deepseek-ai/dsh-llm");
    userMessageFactory = llm.createUserMessage;
  } catch {
    userMessageFactory = (input) => Object.freeze({
      ...input,
      role: "user",
      id: randomUUID(),
    });
  }
  return userMessageFactory;
}

/**
 * 插件入口。
 * @param ctx - cordis context。
 * @param config - {@link Config} 实例。
 */
function apply(ctx, config) {
  const enabled = config.enabled !== false;
  const maxAttempts = Math.max(1, Math.trunc(config.maxAttempts ?? 3));
  const minTextChars = Math.max(1, Math.trunc(config.minTextChars ?? 1));
  const customNudge = typeof config.nudgeText === "string" ? config.nudgeText.trim() : "";
  const nudgeText = customNudge === "" ? DEFAULT_NUDGE : config.nudgeText;

  /** session -> 该 session 最近一条 assistant 消息。 */
  const lastAssistant = new WeakMap();
  /** session -> Map<turn, 已注入次数>。 */
  const attempts = new WeakMap();

  // 追踪 assistant 消息：turn-stopping 紧跟在最后一步的 assistant/message 之后。
  ctx.on("session/event", (session, event) => {
    if (event?.type !== "assistant/message") return;
    const data = event.data;
    if (data?.message === undefined) return;
    lastAssistant.set(session, {
      turn: data.turn,
      step: data.step,
      message: data.message,
    });
  });

  // 收尾前拦截：正文为空就往 next-step 塞一条提示，让这一轮继续跑。
  ctx.on("agent/turn-stopping", async ({ agent, turn, signal }) => {
    if (!enabled) return;
    if (signal?.aborted) return;
    const session = agent?.session;
    if (session === undefined) return;

    const record = lastAssistant.get(session);
    if (record === undefined || record.turn !== turn) return;
    if (hasToolCall(record.message)) return;
    if (hasVisibleText(record.message, minTextChars)) return;

    let perTurn = attempts.get(session);
    if (perTurn === undefined) {
      perTurn = new Map();
      attempts.set(session, perTurn);
    }
    const used = perTurn.get(turn) ?? 0;
    if (used >= maxAttempts) {
      ctx.logger.warn(
        `empty-text-guard: agent "${agent.id}" turn ${turn} 正文仍为空，已达重试上限 ${maxAttempts} 次，放弃续写`,
      );
      return;
    }
    const attempt = used + 1;

    try {
      const createUserMessage = await resolveUserMessageFactory();
      const message = createUserMessage({
        content: [{ type: "text", text: nudgeText }],
        source: {
          kind: "empty-text-guard",
          form: "notice",
          summary: `正文为空，已自动要求重新输出（第 ${attempt}/${maxAttempts} 次）`,
          attempt,
        },
      });
      agent.inbox.prepend("next-step", message);
      perTurn.set(turn, attempt);
      ctx.logger.info(
        `empty-text-guard: agent "${agent.id}" turn ${turn} 正文为空，已注入续写提示（第 ${attempt}/${maxAttempts} 次）`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.logger.warn(`empty-text-guard: agent "${agent.id}" turn ${turn} 注入续写提示失败: ${reason}`);
    }
  });
}

export { Config, DEFAULT_NUDGE, apply, hasToolCall, hasVisibleText, inject, name };
