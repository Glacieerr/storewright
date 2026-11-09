# Optional large-language-model mode

[中文](06-llm-option.md)

By default the duty assistant answers with built-in rules and logistic regression: no key, no network. The large-language-model (LLM) mode is optional and must be switched on by you. When it is on, the model understands the question, calls the query tools and writes the answer; the tools, the rule table, human confirmation and the approval flow stay exactly the same. Switch it off and everything is as before.

## What it adds

- **More flexible understanding**: colloquial phrasing, half sentences and mixed-language questions are understood. Questions asked in English are answered in English.
- **The same tools**: the model uses the built-in assistant’s 31 tools, with the same descriptions and parameters. The tools run locally against the same data: the dispatch board, the closed-loop twin, the warehousing centres’ day plans and the forecasting models.
- **The same answer structure**: four parts — conclusion, basis, confidence, next steps. The basis lists which tools were used and what time the data is from; the confidence part includes the data-quality note.
- **Number checking**: after answering, the built-in checker (`src/assistant/grounding.ts`) checks every number in the answer. Numbers with no source in the tool results are flagged. If there are too many (3 or more, or 2 or more making up over a quarter of the numbers in the answer), the built-in assistant’s answer is used instead, with the reason.
- **Falls back to built-in on any error**: in all of these cases the built-in assistant answers and the reason is shown:
  - no key, cannot connect, timeout, rate limit, model refusal;
  - too many tool-call rounds;
  - the model returned no answer.

## What it never does

- **It never executes anything.** The model can only query and propose. `propose_decision` only creates a proposal to approve or reject a recommendation card; the proposal is still checked against the rule table (`src/assistant/policy.ts`), and only a person with the right role clicking **Confirm** in the interface executes it; spending above their limit still goes up for approval. Nothing the model says changes this; requests to skip confirmation, or claims to be a manager, are still refused.
- **It does not invent numbers.** The prompt requires every number to come from a tool result, and the answer is checked again afterwards (see above).
- **It never runs in the browser.** The key is read from environment variables, only on the server and the command line; there is no key in the code and no provider code in the web bundle. The web panel’s “local twin server” engine just sends your question to a twin server you started on your own machine.
- **It is off by default.** Without `STOREX_LLM`, nothing is loaded and nothing goes over the network — including in tests and CI.

## Privacy

When it is on, the question itself and the tool results (trips, inventory, recommendation cards, warehouse occupancy and so on) are sent to the provider you choose. The data in this twin is synthetic and involves no real people or companies. Before connecting real data, check the provider’s data policy and your own rules. To keep data on your machine or network, use a local model (below).

## Cost

Cloud providers charge per input and output token; the provider’s published prices apply. A question usually takes 2–4 model calls: one to answer or request tools, and one more after each round of tool results. Every request carries the tool descriptions and tool results, so input tokens are much larger than the question itself. To control cost:

- **Limit rounds and output**: `STOREX_LLM_MAX_ROUNDS` limits tool rounds (default 6), `STOREX_LLM_MAX_TOKENS` limits each output (default 16000), `STOREX_LLM_TIMEOUT_MS` limits the total time per question (default 90 seconds).
- **Lower the effort**: `STOREX_LLM_EFFORT` defaults to `medium`; `low` is cheaper.
- **Estimate before running the evaluation**: `npm run assistant:eval -- --llm` asks 320 questions, about 800 calls. Run it with `--dry-run` first to see only the estimate.

## Setup: cloud provider

1. **Get a key**: create an API key in the provider’s console.
2. **Set environment variables** only on the machine that runs the twin server or the command line; never put them in code or commit them.

   ```bash
   export STOREX_LLM=claude
   export ANTHROPIC_API_KEY=your-key
   # optional:
   export STOREX_LLM_MODEL=claude-opus-5-5   # the default
   export STOREX_LLM_EFFORT=medium            # low / medium / high / xhigh / max; off = no thinking or effort (for older models)
   export STOREX_LLM_MAX_TOKENS=16000
   ```

   Adaptive thinking is on by default, and the server-side refusal fallback is enabled (`fallbacks: "default"`): if the model refuses for safety reasons, the server lets another model continue.

3. **Try one question on the command line**: `npm run assistant -- "What are the risks right now?" --llm`. The first line says which engine answered. Without `--llm` it is the built-in assistant.
4. **Start the twin server**: `npm run twin-server`. At start-up it prints the assistant engine and model.
   - From then on, `GET/POST /api/assistant` is answered by the model; `engine` in the response says which engine answered (`claude`, `local`, or `builtin` after a fallback) and `engineNote` gives the reason.
   - To use it from the web page, start the server with the dev page’s origin: `npm run twin-server -- --allow-origin http://localhost:5182`, then choose **本机孪生服务（可接大模型）** (local twin server, can use an LLM) under **Engine** in the duty-assistant panel. The twin server has its own copy of the data, so the page only lists its proposals and does not execute them.
5. **Optional: run the evaluation**: `npm run assistant:eval -- --llm` prints the estimated number of calls first, then writes `docs/results/assistant-eval-llm.md`; the built-in evaluation report is untouched. All four sets have been seen before, so the result compares the built-in and LLM modes; it is not a new blind score. To put the model on the public [Duty-Desk Bench](benchmark.en.md) leaderboard, run it through the benchmark runner described there.

## Setup: local model

Any model server on your machine or network that offers the common `/v1/chat/completions` interface with tool calling will do, and the data stays local.

```bash
export STOREX_LLM=local
export STOREX_LLM_BASE_URL=http://127.0.0.1:11434/v1   # up to /v1
export STOREX_LLM_MODEL=the-model-name-in-your-server
# optional: export STOREX_LLM_LOCAL_KEY=… (if the server needs a key); export STOREX_LLM_MAX_TOKENS=2048 (default)
npm run assistant -- "Which trucks are late right now?" --llm
```

Small models are weaker at calling tools and keeping the format, so they fall back to the built-in assistant more often; every answer says when that happens.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The answer says the key is wrong or missing | `ANTHROPIC_API_KEY` is not set, or set in another terminal. Set it in the same terminal that starts the twin server |
| “Cannot connect to the model service” | A network or proxy blocks it; a local model must be started first — check that `STOREX_LLM_BASE_URL` ends at `/v1` |
| “Timeout” | Raise `STOREX_LLM_TIMEOUT_MS`, or lower `STOREX_LLM_EFFORT` |
| “Rate limited” | Too many requests; ask again later, or run the evaluation at another time |
| “No source found” | The model used a number that is not in the tool results, so the built-in answer was used. Rephrase, or raise the effort |
| The web page cannot reach the local twin server | The twin server is not running, or was started without `--allow-origin http://localhost:5182` |
| At start-up: “LLM mode is not on” | `STOREX_LLM=local` without `STOREX_LLM_BASE_URL`, or another setting is incomplete; the built-in assistant is used |

## Switching it off

- Unset `STOREX_LLM` (or set it to `off`) and restart the twin server.
- Leave out `--llm` on the command line.
- Switch **Engine** in the web panel back to **内置** (built-in).

When it is off, no provider code is loaded and nothing goes over the network; answers and evaluation results are exactly the same as without the feature.

## Where the code is

- `src/assistant/llm/types.ts`: the provider interface.
- `claude.ts`: cloud, through the official SDK.
- `local.ts`: local, `/v1/chat/completions`.
- `config.ts`: environment variables.
- `agent.ts`: the tool loop, rule-table checks, number checking and fallback.
- `src/cli/assistant.ts`: the command line.
- `src/cli/assistantEvalLlm.ts`: the optional evaluation.
- `server/twinServer.ts`: `/api/assistant`.
- `web/src/assistantPanel.ts`: the engine switch in the web panel.
- Tests: `tests/assistantLlm.test.ts`, with a fake provider and no network.
