# dsh-empty-text-guard

修一个很烦的收尾缺陷：**模型把整段回答写进了「思考」通道，正文是空的**。
界面上只显示「已完成」，展开以后什么都没有——因为那一轮 assistant 消息里一个
`text` 块都没有，只有 `reasoning`。

本插件让这种情况**不再允许收尾**：发现正文为空就自动催一轮，直到模型真正输出正文。

## 怎么做到的（只用官方扩展点）

agent loop 结束一轮之前是这样一个顺序（`@deepseek-ai/dsh-agent-loop`）：

```js
if (turnEnds && this.inbox.nextStep.length === 0) {
    await this.dispatch.serial("agent/turn-stopping", { turn, signal });   // ← 本插件挂这里
}
if (turnEnds && this.inbox.nextStep.length === 0) break;                   // ← 才真正收尾
```

所以在 `agent/turn-stopping` 里往 `agent.inbox` 的 `next-step` 塞一条消息，
第二个判断就不成立，循环会带着 `target: "next-step"` 再跑一步，模型因此获得
一次重新输出的机会。内置的 `dsh-goal-round-driver`（目标自动续跑）用的是同一套机制。

判定「正文为空」的条件：

- 该 turn 最后一条 `assistant/message` 里**没有任何 `text` 块**（或 text 全是空白）
- **且没有 `tool-call` 块**（有工具调用说明这一步本来就会继续，不该干预）

## 装法

```bash
# 本地开发（link 安装）
dsh plugin --profile web add /absolute/path/to/dsh-empty-text-guard

# 从 git 安装
dsh plugin --profile web add github:xingzoudefengye/dsh-empty-text-guard
```

然后把包名登记进 profile 的 `dsh.profile.bundles`（`~/.dsh/profiles/web/package.json`），
否则 bundle patch 不会生效：

```json
"bundles": [
  "...",
  "dsh-empty-text-guard"
]
```

## 配置

```yaml
- insert:
    - id: empty-text-guard
      name: 'dsh-empty-text-guard'
      config:
        enabled: true      # false = 只观察不干预
        maxAttempts: 3     # 同一 turn 最多催几次，用完放行并记 warn
        minTextChars: 1    # 正文至少多少字符算「有正文」
        nudgeText: ''      # 留空用内置提示语
```

## 行为

| 场景 | 结果 |
| --- | --- |
| 正文为空、无工具调用 | 注入续写提示，这一轮继续，不出「已完成」空壳 |
| 正文为空、有工具调用 | 不干预（该步骤本来就会继续） |
| 正文非空 | 不干预 |
| 连续 `maxAttempts` 次都是空 | 放行并 `warn` 日志，避免死循环 |
| `signal` 已中止 / `enabled=false` | 不干预 |

日志关键字：`empty-text-guard:`。

## 测试

```bash
npm install     # 或者本地把 schemastery 软链进 node_modules
node --test
```

11 个用例覆盖：正文判定、工具调用判定、注入内容与形状、turn 隔离、重试上限、
中止信号、开关、自定义提示语、Config 默认值。

## 为什么不做成改核心代码

`agent/turn-stopping` 就是官方为「收尾前最后一刻」留的钩子，`inbox.prepend` 是
官方给插件注入消息的入口。用插件做的好处：**harness 升级不会被覆盖**，
出问题 `dsh plugin remove` 就能回滚，也不影响其他 profile。

## License

MIT
