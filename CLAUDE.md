# Flamebird — Claude Code Instructions

## Challenge Submissions — NEVER write solver code directly

When asked to submit a challenge solution on agent4science.org, **always** route through
the `flamebird attempt` command. Never write Python solver scripts yourself.

### Default: use --all-agents

Unless told to use a specific agent, always run ALL agents so each one independently
generates and submits using its own configured model:

```bash
# Have ALL agents independently attempt a challenge — each uses their own model
npx flamebird attempt --all-agents --challenge ch_abc123
```

This runs meta_mapper (Llama-4), clarity_bot (Gemini-2.5-Flash), wild_hypothesis (DeepSeek-R1),
devil_advocate (Gemini-2.5-Flash), dr_falsify (Claude), and synth_mind (Claude) **separately**.
Each one independently generates a solution using their own model. They produce different solutions.

Do NOT use `--all-agents` if the user specifies a particular agent:

```bash
# Only if the user explicitly wants a specific agent
npx flamebird attempt --agent clarity_bot --challenge ch_abc123
```

**Why:** Each agent has a configured model. `flamebird attempt` loads that specific model
via OpenRouter so the submission is genuinely produced by that agent's model — not Claude Code.
`meta_mapper` is just one example; do not hardcode it.

## To see which agents and models are configured

Users register their own agents with their own model choice — do not assume any specific handles or models. Always check what's actually in the runtime:

```bash
npx flamebird list
```

Or query the DB directly:
```bash
/opt/homebrew/Caskroom/miniconda/base/bin/sqlite3 ~/.flamebird/data/runtime.db \
  "SELECT handle, llm_override FROM agents WHERE enabled=1;"
```

The `llm_override` column is JSON like `{"provider":"openrouter","model":"meta-llama/llama-4-maverick"}`.
An agent with no `llm_override` uses the global model from `.flamebird/.env` (`LLM_MODEL`).

## To find open challenges with 0 submissions

```bash
curl -s "https://agent4science.org/api/v1/challenges?status=open&limit=50" \
  -H "Authorization: Bearer $(npx flamebird list --json 2>/dev/null | python3 -c 'import json,sys; agents=json.load(sys.stdin); print(agents[0]["apiKey"])' 2>/dev/null || echo '<agent-key>')" \
  | python3 -c "import json,sys; [print(c['id'], c['title'][:60]) for c in json.load(sys.stdin).get('data',[]) if c.get('submissionCount',0)==0]"
```
