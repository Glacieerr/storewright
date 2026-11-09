# 可选的大模型模式

值班助手默认用内置的规则和逻辑回归回答：不要密钥，也不联网。大模型模式是可选的，要用户自己打开。打开以后，由大模型来理解问题、调查询工具、组织语言；工具、规则表、人工确认和审批的流程都不变。关掉以后一切照旧。

[English](06-llm-option.en.md)（下面最后也有英文摘要）

## 它加了什么

- **更灵活的理解**：口语、半句话、夹英文的问题也能理解。英文问的用英文回答。
- **同一套工具**：模型用的就是内置助手的 31 个工具，说明和参数完全一样。工具在本机执行，查的是同一份数据：调度台、闭环孪生、仓储中心的作业计划和预测模型。
- **同样的回答结构**：回答分四段，结论、依据、把握、下一步。依据写用了哪些工具、数据截至几点；把握里带上数据质量的说明。
- **数字核对**：答完用内置的核对程序（`src/assistant/grounding.ts`）逐个核对回答里的数字。在工具结果里找不到出处的数会标出来。找不到的多了（3 个以上，或者 2 个以上而且占回答里的数四分之一以上），这次的回答就改用内置助手的，并说明原因。
- **出错就退回内置**：遇到以下情况，都改用内置助手回答，回答里写明原因：
  - 没有密钥、连不上、超时、被限流、模型拒答；
  - 工具调用超过轮数；
  - 模型没给出回答。

## 它绝不做什么

- **不执行任何操作**。模型只能查询和提议。`propose_decision` 只生成「批准 / 否决建议卡」的提议，提议照样先按规则表检查（`src/assistant/policy.ts`），再由有权限的人在界面上点「确认执行」才执行，超出额度的照样交上级审批。模型说什么都改变不了这一点；要求跳过确认、自称经理的照样拒绝。
- **不编数字**。提示词要求每个数都来自工具结果；答完还会再核对一遍（见上）。
- **不进浏览器**。密钥只在服务端和命令行从环境变量读取，代码里不写密钥，网页的打包里没有提供方的代码。网页的「本机孪生服务」引擎只是把问题发给你自己在本机启动的孪生服务。
- **不默认打开**。没设 `STOREX_LLM` 时，什么都不加载、不联网，测试和持续集成里也一样。

## 隐私

打开以后，问题本身、工具查出来的结果（车次、库存、建议卡、仓储中心的占用等）都会发给你选的提供方。这个孪生里的数据都是仿真合成的，不涉及真实的人和企业。接真实数据之前，先确认提供方的数据政策和你们的规定。要数据不出本机或内网，用本机模型（见下）。

## 费用

云端提供方按输入、输出的 token 计费，价格以提供方公布的为准。一个问题一般调用模型 2–4 次：先回答或要工具，每轮工具结果回来再调一次。每次请求都要带上工具说明和工具结果，所以输入的 token 比问题本身多得多。控制费用的办法：

- **限制轮数和输出**：`STOREX_LLM_MAX_ROUNDS` 限制工具轮数（默认 6），`STOREX_LLM_MAX_TOKENS` 限制每次输出（默认 16000），`STOREX_LLM_TIMEOUT_MS` 限制一个问题总共的时长（默认 90 秒）。
- **调低 effort**：`STOREX_LLM_EFFORT` 默认 `medium`，可以改成 `low`。
- **先估再跑评测**：`npm run assistant:eval -- --llm` 要问 320 题，大约 800 次调用。先用 `--dry-run` 只看估计。

## 设置：云端提供方

1. **拿到密钥**：在提供方的控制台创建一个 API 密钥。
2. **设环境变量**：只设在运行孪生服务、命令行的那台机器上，不要写进代码或提交到仓库。

   ```bash
   export STOREX_LLM=claude
   export ANTHROPIC_API_KEY=你的密钥
   # 可选：
   export STOREX_LLM_MODEL=claude-opus-5-5   # 默认就是它
   export STOREX_LLM_EFFORT=medium            # low / medium / high / xhigh / max；off = 不带思考和 effort（给旧模型用）
   export STOREX_LLM_MAX_TOKENS=16000
   ```

   默认会开自适应思考，并带上服务端的拒答兜底（`fallbacks: "default"`）：模型因安全原因拒答时，由服务端换别的模型接着答。

3. **先在命令行试一句**：`npm run assistant -- "现在有什么风险" --llm`，第一行会写明是哪个引擎答的。不加 `--llm` 就是内置助手。
4. **启动孪生服务**：`npm run twin-server`。启动时会打印「值班助手：大模型 claude · 模型名」。
   - 之后 `GET/POST /api/assistant` 都由大模型回答，回答里的 `engine` 写明是哪个引擎（`claude`、`local`，或者退回内置时的 `builtin`），`engineNote` 写原因。
   - 要在网页里用，启动时加上开发页的来源：`npm run twin-server -- --allow-origin http://localhost:5182`。然后在值班助手面板的「引擎」里选「本机孪生服务（可接大模型）」。孪生服务的数据是它自己那一份，所以网页里只列出它给的提议，不执行。
5. **可选：跑一遍评测**：`npm run assistant:eval -- --llm`，先打印估计的调用次数。结果写到 `docs/results/assistant-eval-llm.md`，内置的评测报告不动。这四套题都已经看过，所以结果只是内置和大模型两种模式的对照，不是新的盲测成绩。

## 设置：本机模型

本机或内网有一个模型服务，提供常见的 `/v1/chat/completions` 接口、支持 tools 调用，就可以用它，数据不出本机。

```bash
export STOREX_LLM=local
export STOREX_LLM_BASE_URL=http://127.0.0.1:11434/v1   # 写到 /v1 为止
export STOREX_LLM_MODEL=你在本机服务里的模型名
# 可选：export STOREX_LLM_LOCAL_KEY=…（服务要密钥时）；export STOREX_LLM_MAX_TOKENS=2048（默认）
npm run assistant -- "现在有哪些车晚点" --llm
```

小模型调工具、守格式的能力有限，退回内置助手的次数会多一些，回答里都会写明。

## 排查问题

| 现象 | 原因和办法 |
| --- | --- |
| 回答写「密钥不对或没设」 | `ANTHROPIC_API_KEY` 没设，或者设在了别的终端里。在启动孪生服务的同一个终端里设 |
| 「连不上模型服务」 | 网络或代理挡住了；本机模型要先启动，并检查 `STOREX_LLM_BASE_URL` 是否写到 `/v1` |
| 「超时」 | 调大 `STOREX_LLM_TIMEOUT_MS`，或者调低 `STOREX_LLM_EFFORT` |
| 「被限流」 | 请求太密，稍后再问；跑评测时换个时间 |
| 「找不到出处」 | 模型用了工具结果里没有的数，已经改用内置回答。可以换个问法，或者调高 effort |
| 网页里「连不上本机孪生服务」 | 孪生服务没启动，或者启动时没加 `--allow-origin http://localhost:5182` |
| 启动时写「大模型模式没打开」 | `STOREX_LLM=local` 却没设 `STOREX_LLM_BASE_URL`，或者别的设置不全；这时值班助手用内置的 |

## 怎么关掉

- 不设或删掉 `STOREX_LLM`（或设成 `off`），重启孪生服务。
- 命令行不加 `--llm`。
- 网页面板的「引擎」切回「内置」。

关掉以后不加载提供方的代码、不联网，回答和评测结果和没有这个功能时完全一样。

## 代码在哪

- `src/assistant/llm/types.ts`：提供方接口。
- `claude.ts`：云端，官方 SDK。
- `local.ts`：本机，`/v1/chat/completions`。
- `config.ts`：环境变量。
- `agent.ts`：工具循环、规则表检查、数字核对、退回内置。
- `src/cli/assistant.ts`：命令行。
- `src/cli/assistantEvalLlm.ts`：可选的评测。
- `server/twinServer.ts`：`/api/assistant`。
- `web/src/assistantPanel.ts`：网页面板的引擎切换。
- 测试：`tests/assistantLlm.test.ts`，用假的提供方，不联网。

---

## English summary

- **Default and optional mode**: by default the duty assistant uses built-in rules and logistic regression, with no key and no network. The large-language-model mode is optional and switched on by the user. The model understands the question, calls the assistant's own 31 tools (executed locally, read-only) and writes the answer in the asker's language. English questions get English answers, in the same four parts: conclusion, basis, confidence, next steps.
- **No execution, no invented numbers**:
  - `propose_decision` only creates proposals. They still go through the rule table and need a person with the right role to confirm.
  - The model cannot execute anything, and requests to skip confirmation are refused.
  - Every number in the answer is checked against the tool results. Unmatched numbers are flagged; if there are many, the built-in answer is shown instead.
  - Any provider error, timeout, refusal or round limit falls back to the built-in assistant, with a note.
- **Privacy**: questions and tool results are sent to the chosen provider. The twin's data is synthetic. For data that must stay on your machine, use a local model.
- **Cloud setup**:
  1. `export STOREX_LLM=claude ANTHROPIC_API_KEY=…`. Optional: `STOREX_LLM_MODEL` (default `claude-opus-5-5`), `STOREX_LLM_EFFORT`, `STOREX_LLM_MAX_TOKENS`, `STOREX_LLM_MAX_ROUNDS`, `STOREX_LLM_TIMEOUT_MS`.
  2. Try `npm run assistant -- "What are the risks right now?" --llm`.
  3. Start `npm run twin-server`. For the web panel, add `--allow-origin http://localhost:5182` and pick the engine "本机孪生服务（可接大模型）" (local twin server).
  4. Optional: `npm run assistant:eval -- --llm` runs the four blind sets through the model (about 800 calls; `--dry-run` prints the estimate). Results go to `docs/results/assistant-eval-llm.md`.
- **Local model**: `STOREX_LLM=local`, `STOREX_LLM_BASE_URL=http://127.0.0.1:11434/v1` (any `/v1/chat/completions` server with tool calling) and `STOREX_LLM_MODEL=…`.
- **Switch off**: unset `STOREX_LLM` (or set it to `off`), drop `--llm`, or choose "内置" (built-in) in the panel. Nothing is loaded and nothing goes over the network.
