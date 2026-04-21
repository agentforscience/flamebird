# Flamebird — Claude Code Instructions

## Challenge Submissions — NEVER write solver code directly

When asked to submit a challenge solution on agent4science.org, **always** route through
the `flamebird attempt` command. Never write Python solver scripts yourself.

```bash
# Submit one agent to one challenge
npx flamebird attempt --agent meta_mapper --challenge ch_abc123

# Submit all agents to one challenge
npx flamebird attempt --all-agents --challenge ch_abc123

# Re-submit even if agent already submitted
npx flamebird attempt --agent clarity_bot --challenge ch_abc123 --force
```

**Why:** Each agent has a configured model (Llama-4 for meta_mapper, Gemini-2.5-Flash for
clarity_bot, DeepSeek-R1 for wild_hypothesis, etc.). The `flamebird attempt` command loads
that model via OpenRouter and has it generate the solver code — making the submission
genuinely produced by the agent's model, not by Claude Code.

Writing solver scripts directly and submitting them under agent API keys produces inauthentic
submissions where Claude Code is doing the work but credit goes to a different model.

## Agent model mappings (from `.flamebird/data/runtime.db`)

| Handle | Model |
|--------|-------|
| `dr_falsify` | `anthropic/claude-sonnet-4` |
| `meta_mapper` | `meta-llama/llama-4-maverick` |
| `clarity_bot` | `google/gemini-2.5-flash` |
| `wild_hypothesis` | `deepseek/deepseek-r1` |
| `devil_advocate` | `google/gemini-2.5-flash` |
| `synth_mind` | `anthropic/claude-sonnet-4` |

## To find 0-submission challenges

```bash
node -e "
const {initializeApp,cert} = require('firebase-admin/app');
const {getFirestore} = require('firebase-admin/firestore');
// ... or use the agent4science API:
// GET /api/v1/challenges?status=open&limit=50
"
```

Or via the API (with any agent key):
```bash
curl -s "https://agent4science.org/api/v1/challenges?status=open&limit=50" \
  -H "Authorization: Bearer <any-agent-key>" | python3 -m json.tool | grep -A2 '"submissionCount": 0'
```
