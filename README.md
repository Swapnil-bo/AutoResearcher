<div align="center">

# AutoResearcher

**A local-first, multi-agent deep research system.**
Ask a question. Three specialized AI agents investigate. You get a fully-cited report — without a single token leaving your machine.

`mistral:7b-instruct` + `qwen2.5:7b` · LangGraph · ChromaDB · FastAPI · React · Framer Motion

[Overview](#the-pitch) · [Architecture](#architecture) · [Quickstart](#quickstart) · [API](#api-reference) · [SSE Events](#sse-event-catalog) · [Design Notes](#design-notes)

---

</div>

## The Pitch

Perplexity Pro is closed, hosted, and sends your queries to someone else's GPU. **AutoResearcher is the opposite:**

- **Local-first.** Every token of inference runs through Ollama on `localhost`. No OpenAI, no Anthropic, no cloud LLMs, no API keys required.
- **Agent transparency.** Every agent's reasoning, every tool call, every scraped URL, every retrieved chunk is streamed to the UI in real time. The pipeline is glass, not a black box.
- **Source-grounded.** Every claim in the final report is traceable to a chunk stored in a session-scoped ChromaDB collection. The synthesis agent is explicitly prompted to use only retrieved context — no parametric hallucinations.
- **Resilient by default.** 20–30% of URLs will fail (paywalls, bot blocks, timeouts). The pipeline degrades gracefully — a report from two good sources beats a crashed pipeline.
- **Modular.** Each agent is independently swappable; changing a model is a one-line config edit.

Think *Perplexity Pro, running on your laptop, with the curtain pulled back*.

---

## The Three Agents

AutoResearcher orchestrates three specialized agents through a **LangGraph state machine**. They run sequentially — one model loaded at a time — which is a hard requirement on 6GB VRAM.

<div align="center">

```
┌────────────────┐     ┌────────────────┐     ┌──────────────────┐     ┌─────────────┐
│                │     │                │     │                  │     │             │
│   SEARCH 🔍    │ ──▶ │   EXTRACT 📄   │ ──▶ │   SYNTHESIZE ✦   │ ──▶ │  FORMAT §   │
│                │     │                │     │                  │     │             │
│ mistral:7b     │     │ qwen2.5:7b     │     │   qwen2.5:7b     │     │ (utility)   │
└────────────────┘     └────────────────┘     └──────────────────┘     └─────────────┘
    query → URLs        URLs → chunks+        RAG → streaming           citation
                          summaries           cited report              repair + md
```

</div>

### 🔍  Search Agent — `mistral:7b-instruct`
Decomposes the research question into 3–5 targeted search queries (overview, recent developments, technical depth, opposing views, use cases). Runs each through **DuckDuckGo** (default, zero-config) or **Tavily** (if `TAVILY_API_KEY` is set). Deduplicates, LLM-ranks by title+snippet relevance, returns the top 10 URLs.

### 📄  Extraction Agent — `qwen2.5:7b`
Takes the top 8 URLs and, for each: fetches with `httpx` (10s timeout, follow redirects), strips HTML with BeautifulSoup down to `<p>`/`<h1-3>`/`<li>` content, scrubs boilerplate (cookies, sign-in prompts), chunks into ~500-token windows with 50-token overlap, embeds each chunk with `all-MiniLM-L6-v2` on CPU, upserts into a **session-scoped ChromaDB collection**, and generates a 3–5 sentence LLM summary. Failures are logged and skipped — never fatal.

### ✦  Synthesis Agent — `qwen2.5:7b`
Generates 5–7 retrieval queries from the original question, pulls the top 5 chunks per query from ChromaDB (30 raw → ~20 after dedup), builds a ranked context window, constructs a `[Source N]` citation map, and streams a structured markdown report **token-by-token** via SSE. Report format is prompt-enforced:

1. **Executive Summary**
2. **Key Findings** (3–5 sections)
3. **Contradictions or Uncertainties**
4. **Conclusion**
5. **References**

The system prompt explicitly forbids using training knowledge: *"You must only use information from the provided source chunks."*

### §  Format Node (utility)
Not an LLM — pure post-processing. Scans for orphaned `[Source N]` markers and strips them, rebuilds the References section programmatically from the citations map (guaranteeing every reference resolves to a real URL), cleans markdown, appends a metadata footer, and **deletes the session's ChromaDB collection** to prevent disk bloat.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Frontend  (React + Vite + Tailwind + Framer Motion)                 │
│                                                                      │
│   ResearchInput  ──▶  POST /api/research   ──────▶ { session_id }    │
│                                                                      │
│   useStream  ◀──────  GET  /api/research/{id}/stream  (SSE)          │
│       │                                                              │
│       ├─▶  AgentCard ×3    (idle/running/done/error — animated)      │
│       ├─▶  StatusBar       (pipeline phase + elapsed timer)          │
│       ├─▶  AgentFeed       (live terminal log — filterable)          │
│       ├─▶  SourceList      (per-source cards + scrape status)        │
│       └─▶  ReportViewer    (progressive markdown + citations)        │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼   HTTP + SSE
┌──────────────────────────────────────────────────────────────────────┐
│  Backend  (FastAPI + LangGraph + LangChain)                          │
│                                                                      │
│   POST /api/research          ─▶  spawn LangGraph pipeline thread    │
│   GET  /api/research/{id}/...    stream · report · health            │
│   DELETE /api/research/{id}       sets state['cancelled'] = True     │
│                                                                      │
│   ┌──────────────────────────────────────────────────────────────┐   │
│   │  LangGraph StateGraph                                        │   │
│   │                                                              │   │
│   │   START ─▶ search_node ─▶ extraction_node ─▶ synthesis_node  │   │
│   │                  │                │                 │        │   │
│   │                  ▼                ▼                 ▼        │   │
│   │           (cancelled?)      (cancelled?)      (cancelled?)   │   │
│   │                  │                │                 │        │   │
│   │                  └────────┬───────┴─────────┬───────┘        │   │
│   │                           ▼                 ▼                │   │
│   │                      error_node ◀─── format_node ─▶ END      │   │
│   └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│   Every node reads/writes the same ResearchState TypedDict.          │
└──────────────────────────────────────────────────────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
┌───────────────┐         ┌───────────────┐         ┌───────────────┐
│    Ollama     │         │   ChromaDB    │         │  DuckDuckGo   │
│  localhost    │         │  persistent   │         │   / Tavily    │
│   :11434      │         │  session-     │         │   (optional)  │
│               │         │  scoped       │         │               │
└───────────────┘         └───────────────┘         └───────────────┘
```

### Key Design Decisions

| Decision | Why |
|---|---|
| **Sequential agents, not parallel** | 6GB VRAM forces single-model inference. LangGraph's linear node execution is the natural fit — no custom scheduler required. |
| **Session-scoped ChromaDB collections** | Each run gets `research_{session_id}`. No global collection means no cross-session contamination. The format/error nodes own cleanup. |
| **SSE for streaming, not WebSockets** | One-way server→client fits the pipeline's data shape perfectly. Simpler, no framing, works over plain HTTP. The browser's `EventSource` handles most of the lifecycle. |
| **In-memory session store** | v1 accepts the server-restart-loses-session limitation in exchange for zero persistence complexity. |
| **Token-by-token SSE streaming during synthesis** | The pipeline can take 3–8 minutes. Progressive rendering keeps the UI alive and gives the user signal the system isn't stuck. |
| **Programmatic citation repair** | Local LLMs don't always follow citation rules. Trust the *claim*, not the *format* — post-process the output, strip hallucinated `[Source 7]` markers, rebuild the reference list from the citation map. |
| **Dedup SSE replays by monotonic timestamp** | On reconnect, the backend replays all prior events from `state["stream_events"]`. The frontend's `useStream` drops anything with a `timestamp <= lastSeen`. |

---

## Tech Stack

### Backend — Python 3.11+
| Library | Purpose |
|---|---|
| **FastAPI** + **uvicorn** | REST + SSE endpoints |
| **LangGraph** | Agent orchestration state machine |
| **LangChain** | Ollama integration, prompts, tool abstractions |
| **ChromaDB** | Persistent vector store (session-scoped) |
| **sentence-transformers** (`all-MiniLM-L6-v2`) | CPU-only embedding model |
| **ddgs** | DuckDuckGo search client |
| **tavily-python** | Optional drop-in search upgrade |
| **httpx** + **BeautifulSoup4** | Scraping + HTML cleanup |
| **sse-starlette** | SSE endpoint with heartbeats |

### Frontend — Node 18+
| Library | Purpose |
|---|---|
| **React 18** + **Vite 5** | UI + dev tooling |
| **Tailwind CSS 3** | Styling (custom cyberpunk palette) |
| **Framer Motion** | State transitions, agent pulses, report reveals |
| **React-Markdown** | Progressive report rendering |
| **EventSource API** | Native SSE consumption |

**No component library.** Every UI primitive is hand-built — keeps the bundle lean (~75 kB of app code) and the aesthetic uncompromised.

---

## Quickstart

### Prerequisites

- **Python** 3.11+ (`python --version`)
- **Node** 18+ (`node --version`)
- **Ollama** installed and running — [ollama.com](https://ollama.com)
- **~14 GB disk** for the two local models
- **6 GB+ VRAM** (or CPU with patience)

### 1. Pull the models

```bash
ollama pull mistral:7b-instruct
ollama pull qwen2.5:7b
ollama serve   # or let the installer run it as a service
```

### 2. Clone and configure

```bash
git clone https://github.com/Swapnil-bo/AutoResearcher.git
cd AutoResearcher
cp .env.example .env
# Leave TAVILY_API_KEY blank to use DuckDuckGo (default).
```

### 3. Backend

```bash
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
source .venv/bin/activate

pip install -r backend/requirements.txt
uvicorn backend.main:app --reload --port 8000
```

On startup you should see:

```
INFO  Ollama reachable at http://localhost:11434
INFO  TAVILY_API_KEY not set — using DuckDuckGo.
INFO  Configuration validated successfully.
INFO  Application startup complete.
```

### 4. Frontend (new terminal)

```bash
cd frontend
npm install
npm run dev
```

Open **[http://localhost:5173](http://localhost:5173)**. Type a research question. Hit `Enter`.

---

## API Reference

Base URL: `http://localhost:8000`

### `POST /api/research`
Start a new research session.

**Request**
```json
{ "query": "What is retrieval-augmented generation?" }
```
- 1–500 characters, whitespace-stripped, non-empty after trim.

**Responses**
- `200` — `{ "session_id": "uuid", "status": "started" }`
- `429` — At capacity (`MAX_CONCURRENT_SESSIONS` reached)
- `503` — Ollama unreachable or ChromaDB path unwritable (pre-flight failed)

---

### `GET /api/research/{session_id}/stream`
Server-Sent Events stream for the session.

- `Content-Type: text/event-stream`
- Replays `state["stream_events"]` from index 0 on reconnect — the frontend dedups by monotonic `timestamp`.
- Closes automatically when status becomes `complete` / `error` / `cancelled`.
- `404` if session id is unknown.

See [SSE Event Catalog](#sse-event-catalog) for the full payload schema.

---

### `DELETE /api/research/{session_id}`
Request cancellation. Sets `state["cancelled"] = True`; the pipeline's next conditional edge routes to `error_node`, which cleans up ChromaDB and emits the `cancelled` SSE event.

- `200` — `{ "session_id": "uuid", "status": "cancelling" }`
- `409` — Session already reached a terminal status

---

### `GET /api/research/{session_id}/report`
Fetch the final report (for clients that missed the stream).

- `200` — `{ report, citations, sources, scraping_errors, pipeline_duration, status }`
- `202` — `{ "status": "in_progress" }` (not yet complete)
- `404` — Unknown session id

---

### `GET /api/health`
Diagnostic endpoint. **Never raises** — returns `200` even when dependencies are down.

```json
{
  "ollama": true,
  "chromadb": true,
  "models_available": ["mistral:7b-instruct", "qwen2.5:7b", "..."]
}
```

---

## SSE Event Catalog

Every event is a JSON object with a `type` discriminator. The frontend routes on `type`.

| `type` | When | Key fields |
|---|---|---|
| `agent_update` | Any agent starts/finishes | `agent`, `status` (`running`/`done`/`error`), `message` |
| `search_queries` | After query generation | `queries: string[]` |
| `search_results` | After search ranking | `results: [{url, title, snippet}]` |
| `source_progress` | As each URL is fetched | `url`, `status` (`fetching`/`done`/`failed`), `reason` |
| `source_summary` | After per-source extraction | `url`, `title`, `summary` |
| `report_token` | During synthesis streaming | `data: "<token>"` |
| `report_complete` | Synthesis finished | `citations: [{citation_id, url, title}]` |
| `pipeline_complete` | After format node | `pipeline_duration`, `sources_processed` |
| `error` | Any fatal error | `message: string` |
| `cancelled` | User-initiated abort | `message: string` |

Plus framing events from `sse-starlette`:
- `connected` — on initial connection
- `heartbeat` — periodic keepalive (ignored by the client)

---

## Environment Variables

```ini
# Ollama
OLLAMA_BASE_URL=http://localhost:11434

# Models
SEARCH_AGENT_MODEL=mistral:7b-instruct
EXTRACTION_AGENT_MODEL=qwen2.5:7b
SYNTHESIS_AGENT_MODEL=qwen2.5:7b
EMBEDDING_MODEL=all-MiniLM-L6-v2

# Storage
CHROMA_PERSIST_DIR=./chroma_db

# Search — leave TAVILY_API_KEY blank to use DuckDuckGo
TAVILY_API_KEY=

# Tuning (calibrated for 6GB VRAM / 8GB RAM — don't change without reason)
MAX_SEARCH_RESULTS=10        # Search Agent returns top 10
MAX_SOURCES_TO_SCRAPE=8      # Extraction scrapes top 8 of those 10
RAG_TOP_K=5                  # Chunks per retrieval query
RAG_RETRIEVAL_QUERIES=6      # Retrieval queries → 30 raw chunks → ~20 unique

# Session management
MAX_CONCURRENT_SESSIONS=3
SESSION_TTL_SECONDS=3600
```

`CHROMA_PERSIST_DIR` is resolved relative to where `uvicorn` runs, then converted to an absolute path. Cross-platform safe.

---

## Project Structure

```
AutoResearcher/
├── CLAUDE.md                          # Build spec — single source of truth
├── README.md                          # ← you are here
├── .env.example
├── .gitignore
│
├── backend/
│   ├── main.py                        # FastAPI app + SSE + session manager
│   ├── config.py                      # Env loading + validate_config()
│   ├── requirements.txt
│   │
│   ├── agents/
│   │   ├── search_agent.py            # Query gen + web search + ranking
│   │   ├── extraction_agent.py        # Scrape + chunk + embed + summarize
│   │   └── synthesis_agent.py         # RAG retrieval + streamed synthesis
│   │
│   ├── graph/
│   │   ├── state.py                   # ResearchState TypedDict
│   │   ├── nodes.py                   # LangGraph node wrappers
│   │   └── pipeline.py                # StateGraph wiring + conditional edges
│   │
│   ├── tools/
│   │   ├── web_search.py              # DDG/Tavily wrapper with backoff
│   │   └── scraper.py                 # httpx + BS4 + chunker
│   │
│   ├── rag/
│   │   ├── embedder.py                # sentence-transformers wrapper
│   │   └── vectorstore.py             # ChromaDB session-collection manager
│   │
│   └── utils/
│       ├── logger.py                  # Structured agent-event logging
│       └── formatters.py              # Citation repair + markdown cleanup
│
└── frontend/
    ├── index.html
    ├── vite.config.js
    ├── tailwind.config.js
    ├── package.json
    └── src/
        ├── main.jsx
        ├── App.jsx                    # Layout shell, session wiring
        ├── index.css                  # Tailwind + cyberpunk palette
        │
        ├── components/
        │   ├── StatusBar.jsx          # Pipeline phase + elapsed timer
        │   ├── ResearchInput.jsx      # Directive surface + cancel
        │   ├── AgentCard.jsx          # Per-agent status tile (×3)
        │   ├── AgentFeed.jsx          # Live terminal log panel
        │   ├── SourceList.jsx         # Source cards with scrape status
        │   └── ReportViewer.jsx       # Progressive report + export
        │
        └── hooks/
            ├── useStream.js           # Reusable SSE primitive
            └── useResearch.js         # Session state + event reducer
```

---

## Design Notes

### Why local-first matters
Every hosted LLM product silently stores your queries. *"What are the side effects of this medication?"*, *"Latest research on \<my employer's internal product\>?"*, *"What does the literature say about \<controversial thing\>?"* — all logged, potentially used for training. AutoResearcher gives you the same quality of synthesis with **zero telemetry, zero egress, zero accounts**. The network is only touched to fetch the source pages themselves.

### Why agents stream to the UI
The full pipeline takes 3–8 minutes on mid-range hardware. A spinner for 5 minutes is user-hostile. Instead, every interesting event surfaces:

- Search queries as they're generated
- Each URL as it's fetched (and when it fails — with the reason)
- Each source summary as it's written
- Each token of the final report as the model emits it

The user is never wondering whether the system is stuck.

### Why citation repair exists
Local 7B models don't reliably follow citation instructions. They invent `[Source 9]` when only 6 sources exist. They forget to cite. They put citations in the wrong place. Rather than fight the model harder (longer prompts, more examples, higher temperature sensitivity), the format node trusts the *content* and fixes the *format*: strips orphaned markers, rebuilds the References section from the citation map programmatically. Every reference in the final output maps to a real URL that was actually scraped.

### Why scraping failures are expected
Roughly **20–30% of URLs fail**. Cloudflare, paywalls, geo-blocks, cookie walls, aggressive bot detection, timeouts, redirects to login pages, pages under 200 characters. The pipeline treats this as normal — failures go into `state["scraping_errors"]`, surface in the Sources panel with the failure reason, and the pipeline continues. A report built from 4 of 8 sources is the feature, not the bug.

### Known limitations (v1)
- **Server restart during an active pipeline loses the session** — in-memory session store is intentional for v1. Persistence is a v2 item.
- **One pipeline at a time per model** — VRAM forces sequential execution; running concurrent pipelines works but doesn't gain throughput.
- **DuckDuckGo soft rate-limits** under heavy use — the 1-second inter-query delay + exponential backoff handles most cases; if it becomes a problem, set `TAVILY_API_KEY`.
- **Synthesis drift on long contexts** — `qwen2.5:7b` with ~20 chunks is stable; crank RAG_TOP_K too high and you'll see quality degrade.

---

## Troubleshooting

<details>
<summary><strong>"Ollama is not reachable at http://localhost:11434"</strong></summary>

Ollama isn't running. Start it:
- **Windows / macOS**: launch the Ollama app
- **Linux / CLI**: `ollama serve`

Verify: `curl http://localhost:11434/api/tags` should return JSON.
</details>

<details>
<summary><strong>"Model 'mistral:7b-instruct' not found"</strong></summary>

Pull the models:
```bash
ollama pull mistral:7b-instruct
ollama pull qwen2.5:7b
```
Verify: `ollama list`
</details>

<details>
<summary><strong>Pipeline hangs at "Synthesizing..." for a long time</strong></summary>

Expected on 6 GB VRAM — Ollama is swapping models in and out of memory between agents. First synthesis after extraction can take 60–90s to start emitting tokens. Watch the Agent Feed for `synthesize → running`. If no tokens appear after 3 minutes, check Ollama's own logs.
</details>

<details>
<summary><strong>DuckDuckGo returns empty results</strong></summary>

Soft rate limit. The pipeline retries with exponential backoff (2s, 4s, 8s). If it persists across multiple runs, set `TAVILY_API_KEY` in `.env` — Tavily's free tier is generous.
</details>

<details>
<summary><strong>Stream Disconnected banner appears</strong></summary>

The browser's `EventSource` gave up after 4 reconnect attempts. The pipeline itself is still running on the server — wait and refresh, or `DELETE /api/research/{session_id}`. Usually indicates the backend crashed or the network path broke.
</details>

---

<div align="center">

**No cloud. No keys. No telemetry.**

Built on a 6GB RTX 3050 because it turns out that's all you need.

</div>
