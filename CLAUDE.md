# CLAUDE.md — AutoResearcher

> Multi-agent deep research system. LangGraph-orchestrated. Local-first. Open-source Perplexity.

---

## ⚠️ ABSOLUTE RULES — READ FIRST

1. **DO NOT commit anything to GitHub. Ever. Not a single file. Not an init commit. Nothing.** The human will handle all Git operations manually.
2. Do not ask for permission before proceeding to the next step. Execute autonomously unless you hit a genuine blocker.
3. Do not write placeholder logic. Every function you write must be real, working code.
4. Do not use `TODO`, `pass`, or stub implementations unless explicitly told to. If you don't know something, ask once — don't scaffold around it.
5. Never skip error handling. Every API call, every agent invocation, every file operation must have proper try/except with meaningful error messages.
6. When in doubt about a design decision, choose the simpler, more maintainable path.
7. Do not re-order the Build Steps. They are sequenced deliberately. Follow them exactly.

---

## Project Vision

AutoResearcher is a local-first, multi-agent deep research system. The user inputs a research question. Three specialized AI agents — Search, Extraction, and Synthesis — collaborate through a LangGraph state graph to produce a structured, cited research report. The final output is a readable, exportable markdown report with inline citations and source metadata.

Think Perplexity Pro, but running entirely on the user's machine, with full transparency into agent reasoning.

---

## Core Design Philosophy

- **Local-first**: All LLM inference runs through Ollama on localhost. No OpenAI. No Anthropic. No cloud LLMs.
- **Agent transparency**: Every agent's thought process, tool calls, and intermediate outputs are streamed to the frontend in real-time.
- **Source traceability**: Every claim in the final report is traceable back to a specific source chunk stored in ChromaDB.
- **No hallucination safety net**: Because we're local and open-source, we compensate with RAG grounding — the synthesis agent must only use retrieved chunks as evidence, never its parametric memory alone.
- **Modular agents**: Each agent is independently testable. Swapping one agent's model should require changing one config line.
- **Resilient by default**: The pipeline must never crash due to a single bad URL, slow model, or empty search result. Degrade gracefully, log everything, always produce some output.

---

## Models (Ollama — Already Installed)

| Model | Assigned Role | Reason |
|---|---|---|
| `mistral:7b-instruct` | Search Agent | Best instruction-following for structured query generation |
| `qwen2.5:7b` | Extraction Agent | Strong reading comprehension and summarization |
| `qwen2.5:7b` | Synthesis Agent | Handles long context well, good structured output |

**Critical constraint**: The user has 6GB VRAM (RTX 3050). Models run sequentially, not in parallel. LangGraph's sequential node execution naturally handles this — do not attempt any parallel agent invocation. Ollama will swap models between turns; this is fine and expected.

Do not use `synthboard-qwen2.5-1.5b` anywhere in this project. It is too small for agent reasoning.

---

## Tech Stack

### Backend
- **Python 3.11+**
- **FastAPI** — REST API + SSE streaming endpoint
- **LangGraph** — Agent orchestration and state graph
- **LangChain** — Tool abstractions, prompt templates, Ollama integration
- **ChromaDB** — Vector store for RAG source memory (persistent, local, session-scoped collections)
- **sentence-transformers** — Embedding model for ChromaDB (`all-MiniLM-L6-v2`, runs on CPU)
- **DuckDuckGo Search** (`duckduckgo-search` pip package) — Free, no API key, no rate limit issues; primary search tool
- **Tavily API** — Optional upgrade path for better search quality (requires free API key); used only if `TAVILY_API_KEY` is set in `.env`
- **httpx** + **BeautifulSoup4** — Web scraping and HTML extraction
- **python-dotenv** — Environment variable management
- **uvicorn** — ASGI server

### Frontend
- **React + Vite**
- **Tailwind CSS**
- **Framer Motion** — All animations: agent card transitions, report fade-in, panel slide-ins, pulsing borders on active agents
- **Dark cyberpunk terminal aesthetic** — consistent with the user's other projects
- **EventSource API** — For consuming SSE stream from backend
- **React-Markdown** — For rendering the final report markdown
- **No component libraries** — Write custom components. Keep it lean.

---

## Project Structure

```
autoresearcher/
├── CLAUDE.md
├── .env.example
├── .gitignore
├── README.md
│
├── backend/
│   ├── main.py                  # FastAPI app, routes, SSE endpoint, cancel endpoint
│   ├── config.py                # All model names, URLs, constants — single source of truth; includes validate_config()
│   ├── requirements.txt
│   │
│   ├── agents/
│   │   ├── __init__.py
│   │   ├── search_agent.py      # Search Agent: query generation + web search tool
│   │   ├── extraction_agent.py  # Extraction Agent: scrape + chunk + embed + summarize
│   │   └── synthesis_agent.py   # Synthesis Agent: RAG retrieval + streamed report generation
│   │
│   ├── graph/
│   │   ├── __init__.py
│   │   ├── state.py             # ResearchState TypedDict — shared state across all nodes
│   │   ├── nodes.py             # LangGraph node functions wrapping each agent
│   │   └── pipeline.py          # StateGraph definition, edge wiring, conditional error routing, compilation
│   │
│   ├── tools/
│   │   ├── __init__.py
│   │   ├── web_search.py        # DuckDuckGo/Tavily search wrapper, returns structured results
│   │   └── scraper.py           # URL fetcher, HTML cleaner, text chunker
│   │
│   ├── rag/
│   │   ├── __init__.py
│   │   ├── vectorstore.py       # ChromaDB client, session-scoped collection management, upsert/query/delete
│   │   └── embedder.py          # sentence-transformers embedding wrapper
│   │
│   └── utils/
│       ├── __init__.py
│       ├── logger.py            # Structured logging for agent events — built in Step 2
│       └── formatters.py        # Report formatting, citation injection, markdown builders
│
└── frontend/
    ├── index.html
    ├── vite.config.js
    ├── package.json
    ├── tailwind.config.js
    └── src/
        ├── main.jsx
        ├── App.jsx
        ├── index.css
        │
        ├── components/
        │   ├── ResearchInput.jsx     # Query input form with submit and cancel
        │   ├── AgentFeed.jsx         # Live SSE stream panel — shows agent activity as terminal log
        │   ├── AgentCard.jsx         # Individual agent status card (idle/running/done/error)
        │   ├── ReportViewer.jsx      # Final report with citation rendering and export controls
        │   ├── SourceList.jsx        # Source cards with URL, title, summary snippet, scrape status
        │   └── StatusBar.jsx         # Global pipeline status indicator
        │
        └── hooks/
            ├── useResearch.js        # Application-level hook: session management, report state, cancel logic
            └── useStream.js          # Reusable low-level SSE primitive: connect, disconnect, event routing
```

---

## The Three Agents — Deep Specification

### Agent 1: Search Agent
**Model**: `mistral:7b-instruct`
**Responsibility**: Turn the user's raw research question into high-quality, diverse search queries, execute them, and return a deduplicated list of URLs to investigate.

**Pre-flight check**: Before doing anything else, verify that Ollama is reachable at `OLLAMA_BASE_URL` and that `mistral:7b-instruct` is available in the model list. If Ollama is unreachable, write a clear error to `state["error"]` immediately and do not proceed. Do not let the pipeline fail 3 minutes in with a cryptic connection error.

**Input**: Raw research question (string)

**Process**:
1. Use the LLM to decompose the research question into 3–5 targeted search queries. Each query should target a different angle (overview, recent developments, technical depth, opposing views, use cases).
2. Check whether `TAVILY_API_KEY` is set in config. If yes, use the Tavily search tool. If no or empty, use the DuckDuckGo search wrapper. This decision happens once at agent initialization — do not check mid-loop.
3. Execute each search query. Add a 1-second delay between queries to avoid rate limiting.
4. Collect all returned URLs and titles.
5. Deduplicate URLs.
6. Score/rank URLs by likely relevance using a quick LLM heuristic — title + snippet scoring only, no full content yet.
7. Return the top 10 URLs with their titles and snippets. These 10 will be passed to the Extraction Agent which will scrape the top 8.

**Output**: List of `{url, title, snippet}` objects stored in `ResearchState.search_results`

**Failure modes to handle**:
- DDG/Tavily rate limiting: retry with exponential backoff (3 attempts, delays: 2s, 4s, 8s)
- Empty search results for a specific query: log warning, continue to next query
- All queries return empty: write to `state["error"]` with message "Search returned no results. Try a more specific query." and set `state["status"]` to `"error"`. The pipeline will route to error exit.
- LLM fails to generate structured queries: fall back to using the raw user question as a single search query, log a warning, continue

---

### Agent 2: Extraction Agent
**Model**: `qwen2.5:7b`
**Responsibility**: Visit each URL, extract clean text, chunk it, embed it into a session-scoped ChromaDB collection, and generate a per-source summary.

**Input**: Top 8 URLs from `ResearchState.search_results` (indices 0–7 from the ranked list)

**Process**:
1. For each URL:
   - Fetch the page with httpx. Timeout: 10 seconds. Follow redirects. If fetch fails (404, timeout, connection error, bot block), log the URL and reason to `state["scraping_errors"]`, skip it, and move on.
   - Strip HTML with BeautifulSoup — extract only `<p>`, `<h1>`–`<h3>`, `<li>` content. Remove nav, footer, ads, scripts, and cookie/subscribe boilerplate patterns.
   - Clean the text: collapse excessive whitespace and newlines. Remove common boilerplate strings ("Accept cookies", "Subscribe to continue", "Sign in to read more").
   - If the cleaned text is under 200 characters, the page is likely paywalled or empty. Log it to `state["scraping_errors"]` and skip.
   - Chunk the text into overlapping chunks of approximately 500 tokens with a 50-token overlap.
   - Embed each chunk using the sentence-transformers embedder (`all-MiniLM-L6-v2` on CPU).
   - Upsert all chunks into the session's ChromaDB collection. Each chunk's metadata must include: `source_url`, `source_title`, `chunk_index`, `session_id`, `timestamp`.
   - Use the LLM to generate a 3–5 sentence summary of the full extracted text for that source.
   - Emit an SSE event after each source completes: `{ "type": "source_summary", "data": { "url": ..., "title": ..., "summary": ... } }`
2. After all URLs are processed, check `state["sources_processed"]`. If fewer than 3 sources were successfully scraped, write a warning to the stream but do NOT abort. A report built from 2 good sources is better than a crashed pipeline.

**Output**:
- ChromaDB session collection populated with embedded chunks
- `ResearchState.source_summaries`: list of `{url, title, summary}`
- `ResearchState.sources_processed`: count of successfully scraped sources
- `ResearchState.scraping_errors`: list of `{url, reason}` for all skipped URLs

**Failure modes to handle**:
- Expect 20–30% of URLs to fail (paywalls, bot detection, timeouts). This is normal.
- Embedding failure for a specific chunk: retry once, then skip that chunk. Do not abort.
- LLM summary generation fails: use the first 3 sentences of the raw extracted text as a fallback summary.

---

### Agent 3: Synthesis Agent
**Model**: `qwen2.5:7b`
**Responsibility**: Use RAG to retrieve the most relevant chunks from ChromaDB and synthesize a structured, cited research report. Stream the report token-by-token to the frontend as it is generated.

**Input**: Original research question + populated ChromaDB session collection

**Process**:
1. Generate 5–7 retrieval queries from the original research question (different angles, using LLM).
2. For each retrieval query, query ChromaDB for the top 5 most similar chunks.
3. Deduplicate retrieved chunks by content similarity (exact string match is sufficient for v1).
4. Build a ranked context window from the top 20 most relevant chunks, ordered by relevance score descending.
5. Assign each unique source URL a citation ID: `[Source 1]`, `[Source 2]`, etc. Build this citation map before prompting the LLM. Pass the citation map as part of the prompt so the LLM knows which ID maps to which source.
6. Prompt the LLM to write a structured research report. The prompt must explicitly state: *"You must only use information from the provided source chunks. You must not use your training knowledge. If the chunks do not contain enough information to answer a specific sub-question, say explicitly that the sources do not cover it."*
7. Report format to enforce via prompt:
   - **Executive Summary** (2–3 paragraphs)
   - **Key Findings** (3–5 sections, each with a clear header)
   - **Contradictions or Uncertainties** (where sources disagree or are silent)
   - **Conclusion**
   - **References** (list of all cited sources with their citation IDs and URLs)
8. Stream the LLM output token-by-token to the SSE endpoint as `{ "type": "report_token", "data": "<token>" }` events. The frontend assembles these progressively. Do NOT buffer the entire report before sending.
9. After streaming is complete, emit a final `{ "type": "report_complete", "data": { "citations": [...] } }` event.

**Output**:
- `ResearchState.final_report`: full assembled markdown report string
- `ResearchState.citations`: list of `{citation_id, url, title}` used in report

**Failure modes to handle**:
- LLM fails to follow citation format: the format_node will repair citations in post-processing (see format_node spec below)
- ChromaDB returns zero chunks: write a clear error to `state["error"]` — this means extraction failed entirely, which should have been caught earlier

---

### Format Node — Full Specification

**Responsibility**: Post-process the raw LLM report output. Repair citations, inject real URLs, clean markdown, and finalize state. This is the last node before END.

**Input**: `ResearchState.final_report` (raw LLM output) + `ResearchState.citations`

**Process**:
1. **Citation repair**: Scan the report for all citation markers matching the pattern `[Source N]`. For each found marker, verify it exists in `ResearchState.citations`. If the LLM invented a `[Source 7]` that doesn't exist, remove the orphaned marker from the text.
2. **Reference section rebuild**: Do not trust the LLM's generated References section. Replace it entirely. Rebuild it programmatically from `ResearchState.citations` — this guarantees every referenced source has a real URL.
3. **Markdown cleanup**: Remove any double-blank lines, fix any malformed headers, ensure code blocks are properly closed.
4. **Metadata injection**: Append a small metadata footer to the report:
   - Query used
   - Number of sources scraped
   - Sources that failed (count only, not full list)
   - Pipeline duration (from `state["session_start_time"]` to now)
   - Generation timestamp
5. **Final state update**: Set `state["status"]` to `"complete"`. Set `state["pipeline_duration"]`. Store the cleaned report back into `state["final_report"]`.
6. **ChromaDB cleanup**: Delete the session-scoped ChromaDB collection (`research_{session_id}`) to prevent disk bloat. Log the deletion.

**Failure modes to handle**:
- If citation repair produces a report with zero valid citations, log a warning but still return the report — partial output is better than nothing.
- If ChromaDB collection deletion fails, log the error but do not fail the node. The report is already complete.

---

## LangGraph State — ResearchState

This is the single shared state object that flows through all nodes. Every agent reads from and writes to this state. Define it as a TypedDict.

Fields:
- `query`: str — original user research question
- `session_id`: str — UUID4 for this research session
- `session_start_time`: float — Unix timestamp at session creation; used for duration calculation and TTL
- `search_queries`: list[str] — generated search queries
- `search_results`: list[dict] — raw search results with url/title/snippet (top 10)
- `sources_processed`: int — count of successfully scraped sources
- `scraping_errors`: list[dict] — list of `{url, reason}` for every skipped URL
- `source_summaries`: list[dict] — per-source LLM summaries
- `retrieval_queries`: list[str] — queries used for ChromaDB retrieval
- `retrieved_chunks`: list[dict] — chunks retrieved from ChromaDB with relevance scores
- `final_report`: str — synthesized and cleaned markdown report
- `citations`: list[dict] — citation map: `{citation_id, url, title}`
- `pipeline_duration`: float — total pipeline runtime in seconds (set by format_node)
- `stream_events`: list[dict] — log of all SSE events emitted during the pipeline
- `cancelled`: bool — set to True if the user cancels mid-pipeline; every node checks this at entry
- `error`: str | None — any pipeline-level error message
- `status`: str — one of: `"searching"`, `"extracting"`, `"synthesizing"`, `"formatting"`, `"complete"`, `"error"`, `"cancelled"`

---

## LangGraph Pipeline — Node Architecture

```
START
  ↓
[search_node]         — runs Search Agent; updates status to "searching"
  ↓
[should_continue?]    — conditional edge: if state["error"] is set or state["cancelled"] is True → route to [error_node]; otherwise continue
  ↓
[extraction_node]     — runs Extraction Agent; updates status to "extracting"
  ↓
[should_continue?]    — conditional edge: if state["error"] is set or state["cancelled"] is True → route to [error_node]; otherwise continue
  ↓
[synthesis_node]      — runs Synthesis Agent; updates status to "synthesizing"
  ↓
[should_continue?]    — conditional edge: if state["error"] is set or state["cancelled"] is True → route to [error_node]; otherwise continue
  ↓
[format_node]         — cleans report, repairs citations, deletes ChromaDB collection; updates status to "complete"
  ↓
END

[error_node]          — emits a final SSE error event, sets status to "error" or "cancelled", cleans up ChromaDB collection, routes to END
  ↓
END
```

**Every node must**:
1. Check `state["cancelled"]` at the very start. If True, return immediately without doing any work — the conditional edge handles routing.
2. Update `state["status"]` at entry.
3. Append an entry to `state["stream_events"]` at both entry and exit.
4. Handle its own exceptions internally — write to `state["error"]` if fatal, do not raise to the graph level.
5. Emit the appropriate SSE event(s) for its work (see SSE Event Catalog below).

---

## FastAPI — API Design

### Endpoints

**POST /api/research**
- Body: `{ "query": "string" }`
- Validates the query: non-empty, stripped of whitespace, maximum 500 characters
- Checks that current active sessions < `MAX_CONCURRENT_SESSIONS`. If at limit, return HTTP 429 with message "System at capacity. Please wait and try again."
- Runs `validate_config()` to confirm Ollama is reachable and ChromaDB path is accessible before starting. If pre-flight fails, return HTTP 503 with a descriptive message — never let the pipeline start in a broken state.
- Generates a `session_id` (UUID4), records `session_start_time`
- Initializes a fresh `ResearchState` with `cancelled: False` and `status: "searching"`
- Kicks off the LangGraph pipeline in a background thread
- Returns: `{ "session_id": "uuid", "status": "started" }`

**GET /api/research/{session_id}/stream**
- SSE endpoint (Server-Sent Events, `text/event-stream`)
- Client connects here immediately after receiving `session_id`
- Streams JSON events as the pipeline executes (see SSE Event Catalog below)
- Replays any events already in `state["stream_events"]` if the client reconnects mid-session
- Connection closes when status reaches `"complete"`, `"error"`, or `"cancelled"`
- If `session_id` is not found, return HTTP 404

**DELETE /api/research/{session_id}**
- Cancel endpoint. Sets `state["cancelled"]` to True for the given session.
- The pipeline's conditional edges will route to `error_node` on the next node boundary.
- Returns: `{ "session_id": "uuid", "status": "cancelling" }`
- If session is already complete, return HTTP 409 with message "Session already complete."

**GET /api/research/{session_id}/report**
- Returns the final report for a completed session
- If session status is not `"complete"`, return HTTP 202 with `{ "status": "in_progress" }`
- Response: `{ "report": "string", "citations": [...], "sources": [...], "scraping_errors": [...], "pipeline_duration": float, "status": "complete" }`

**GET /api/health**
- Checks and returns Ollama connectivity (attempt a lightweight ping to `OLLAMA_BASE_URL`) and ChromaDB accessibility (attempt to list collections)
- Response: `{ "ollama": true/false, "chromadb": true/false, "models_available": [...] }`
- This endpoint must not raise — always return 200 with boolean flags, even if services are down

### Session Management
- Store session states in an in-memory dict keyed by `session_id` for v1
- **Known limitation**: A server restart during an active pipeline will lose the session. This is acceptable for v1. Document it in the README.
- Sessions expire and are removed from memory after `SESSION_TTL_SECONDS` (default: 3600)
- Maximum `MAX_CONCURRENT_SESSIONS` active sessions enforced at the `/api/research` endpoint
- Background cleanup: every 10 minutes, sweep the session dict and remove expired sessions

### CORS
- Allow `http://localhost:5173` (Vite dev server)
- Allow `http://localhost:4173` (Vite preview)

---

## SSE Event Catalog

Every event sent over the SSE stream must be a JSON object with a `"type"` field. The client routes based on `type`. Here is the complete catalog:

| Event Type | When Emitted | Key Fields |
|---|---|---|
| `agent_update` | When any agent starts or finishes | `agent` (search/extract/synthesize/format), `status` (running/done/error), `message` |
| `search_queries` | After Search Agent generates queries | `queries: list[str]` |
| `search_results` | After Search Agent finishes | `results: list[{url, title, snippet}]` |
| `source_progress` | As each URL is being scraped | `url`, `status` (fetching/done/failed), `reason` (if failed) |
| `source_summary` | After each source is fully processed | `url`, `title`, `summary` |
| `report_token` | During Synthesis Agent LLM streaming | `data: "<token>"` — frontend appends to live report display |
| `report_complete` | After Synthesis Agent finishes streaming | `citations: list[{citation_id, url, title}]` |
| `pipeline_complete` | After Format Node finishes | `pipeline_duration: float`, `sources_processed: int` |
| `error` | On any fatal pipeline error | `message: str` |
| `cancelled` | When a cancel request is processed | `message: "Pipeline cancelled by user"` |

---

## ChromaDB — Design

- Use persistent ChromaDB, stored at the path defined by `CHROMA_PERSIST_DIR` in config (default: `./chroma_db/`, relative to where uvicorn runs — make this clear in the README)
- **Session-scoped collections only**: Every session gets its own collection named `research_{session_id}`. No shared global collection. This prevents session data from cross-contaminating.
- **Cleanup ownership**: The `format_node` is responsible for deleting the session's ChromaDB collection after the report is finalized. The `error_node` is also responsible for cleanup if the pipeline terminates early. No collection should persist after its session ends.
- Embedding model: `all-MiniLM-L6-v2` from sentence-transformers — runs on CPU, fast enough, good quality for this use case
- Chunk metadata schema: `{ source_url, source_title, chunk_index, session_id, timestamp }`

---

## config.py — Startup Validation

`config.py` must include a `validate_config()` function that is called:
1. Once at application startup (in `main.py`)
2. Once at the start of `POST /api/research` before launching the pipeline

`validate_config()` must check:
- `OLLAMA_BASE_URL` is set and Ollama responds to a basic HTTP ping
- `CHROMA_PERSIST_DIR` is set and the path either exists or can be created
- `SEARCH_AGENT_MODEL`, `EXTRACTION_AGENT_MODEL`, `SYNTHESIS_AGENT_MODEL` are all non-empty strings
- `MAX_CONCURRENT_SESSIONS` is a positive integer
- `SESSION_TTL_SECONDS` is a positive integer

If `TAVILY_API_KEY` is set, validate it's non-empty. If it's empty or missing, log an info message: "TAVILY_API_KEY not set — using DuckDuckGo." This is expected and not an error.

If any required check fails, raise a descriptive `RuntimeError` with the exact config key and what was wrong.

---

## Frontend — Design Specification

### Visual Language
- **Background**: Near-black (`#0a0a0f`)
- **Primary accent**: Cyan (`#00d4ff`)
- **Secondary accent**: Purple/violet (`#7c3aed`)
- **Text**: Off-white (`#e2e8f0`) for body, pure white for headings
- **Agent cards**: Dark panels with subtle glowing borders that change color by state:
  - Idle → gray border, no glow
  - Running → cyan border with Framer Motion pulsing glow animation
  - Done → green border, static
  - Error → red border, static
- **Font**: `JetBrains Mono` or `Fira Code` for monospace / terminal elements, `Inter` for prose
- **Animations (Framer Motion)**: 
  - Agent cards transition between states with border color animation
  - Report panel slides in from below with a fade when complete
  - Each report section (heading + paragraph) fades in with a stagger delay as tokens stream in
  - Agent feed new entries animate in from the left
  - Status bar progress indicator pulses while pipeline is active

### Layout
- Single-page application, no routing needed for v1
- **Top**: App header — "AUTORESEARCHER" title with subtle tagline. Status bar underneath showing current pipeline step.
- **Center**: Research input — large text field. "RESEARCH" button to start. "CANCEL" button (appears only while pipeline is running) that calls `DELETE /api/research/{session_id}`.
- **Below input**: Three agent status cards side by side — Search / Extract / Synthesize. Each shows: agent name, current status, last log message.
- **Agent Feed panel**: Live scrolling terminal-style log. Each entry shows timestamp, agent name, and message. Auto-scrolls to latest. Monospace font.
- **Report panel**: Hidden until synthesis streaming begins. Renders markdown progressively as `report_token` events arrive. When `report_complete` fires, the References section renders and two buttons appear: "Copy Report" (copies raw markdown to clipboard) and "Export as Markdown" (downloads `.md` file).
- **Sources panel**: Visible after extraction completes. Cards showing source title, URL, summary snippet, and scrape status (success/failed). Failed sources shown with a muted style and the failure reason.

### UX Behaviors
- While pipeline is running: input field is disabled, "RESEARCH" button shows a spinner
- "CANCEL" button only visible during active pipeline; clicking it calls the cancel endpoint and shows "Cancelling..." state
- Agent cards pulse (Framer Motion) when their agent is active; go static when done
- Agent feed auto-scrolls to the latest event
- Report text streams progressively — never blank until complete
- Error state: red banner at top with the error message, "START OVER" button that resets all state
- Cancelled state: neutral banner explaining the pipeline was cancelled, "START OVER" button

### Hook Architecture
- **`useStream.js`**: A reusable, low-level SSE hook. Manages `EventSource` connection lifecycle — connect, disconnect, reconnect on drop, route raw events to a callback. Has no knowledge of research-specific state. Can be reused for any SSE endpoint in future projects.
- **`useResearch.js`**: Application-level hook. Uses `useStream` internally. Manages all research state: `sessionId`, `status`, `agentStatuses`, `agentFeedEvents`, `sourceSummaries`, `reportTokens` (assembled into live report string), `citations`, `scrapingErrors`. Exposes `startResearch(query)` and `cancelResearch()` functions to components.

---

## Environment Variables

Define all in `.env` (document all in `.env.example`):

```
OLLAMA_BASE_URL=http://localhost:11434
SEARCH_AGENT_MODEL=mistral:7b-instruct
EXTRACTION_AGENT_MODEL=qwen2.5:7b
SYNTHESIS_AGENT_MODEL=qwen2.5:7b
EMBEDDING_MODEL=all-MiniLM-L6-v2
CHROMA_PERSIST_DIR=./chroma_db
TAVILY_API_KEY=                        # Optional. Leave blank to use DuckDuckGo. If set, must be non-empty.
MAX_SEARCH_RESULTS=10                  # Search Agent returns top 10 URLs
MAX_SOURCES_TO_SCRAPE=8                # Extraction Agent scrapes top 8 of those 10
RAG_TOP_K=5                            # ChromaDB returns top 5 chunks per retrieval query
RAG_RETRIEVAL_QUERIES=6                # Synthesis Agent generates 6 retrieval queries
MAX_CONCURRENT_SESSIONS=3
SESSION_TTL_SECONDS=3600
```

**Number alignment note**: `MAX_SEARCH_RESULTS=10` → Search Agent ranks and returns 10. `MAX_SOURCES_TO_SCRAPE=8` → Extraction Agent takes indices 0–7 from that list. `RAG_TOP_K=5` × `RAG_RETRIEVAL_QUERIES=6` = up to 30 chunks before deduplication, targeting ~20 unique chunks for the synthesis context window. These numbers are calibrated for the hardware constraints. Do not change them without reason.

---

## Build Order — Steps for Claude Code to Follow

Execute these steps in order. Do not skip ahead. Do not commit at any step.

**Step 1**: Scaffold the full project directory structure. Create all `__init__.py` files, `requirements.txt`, `.env.example`, `.gitignore`, and `package.json`. Do not write any logic yet — structure only.

**Step 2**: Write `backend/utils/logger.py`. This must be done before any agents, as all subsequent modules will import from it. Then write `backend/config.py` — load all environment variables and implement `validate_config()`.

**Step 3**: Write `backend/rag/embedder.py` and `backend/rag/vectorstore.py`. Implement session-scoped collection creation, upsert, query, and delete. Test ChromaDB connectivity and basic operations before moving on.

**Step 4**: Write `backend/tools/web_search.py`. Implement the search wrapper with Tavily/DDG fallback logic and retry with exponential backoff.

**Step 5**: Write `backend/tools/scraper.py`. Implement URL fetching, HTML cleaning, boilerplate removal, and text chunking. Test on 2–3 real URLs before moving on.

**Step 6**: Write `backend/graph/state.py`. Define the complete `ResearchState` TypedDict with all fields exactly as specified in the State section.

**Step 7**: Write `backend/agents/search_agent.py`. Full implementation including pre-flight Ollama check, LLM query generation, search execution with delay and retry, deduplication, and ranking.

**Step 8**: Write `backend/agents/extraction_agent.py`. Full implementation including per-URL scraping, chunking, embedding, ChromaDB upsert, and LLM summarization.

**Step 9**: Write `backend/agents/synthesis_agent.py`. Full implementation including retrieval query generation, ChromaDB querying, chunk deduplication, citation map construction, token-streaming LLM output.

**Step 10**: Write `backend/graph/nodes.py` and `backend/graph/pipeline.py`. Implement all node functions wrapping each agent. Wire the conditional error routing edges. Implement the `format_node` per its full specification. Test the entire pipeline end-to-end from a Python script with a hardcoded query before adding the API layer.

**Step 11**: Write `backend/main.py`. Implement the FastAPI app with all four endpoints (POST research, GET stream, DELETE cancel, GET report, GET health), SSE streaming, session management, background cleanup, and startup validation call.

**Step 12**: Write `backend/utils/formatters.py`. Implement citation repair, reference section rebuilding, markdown cleanup, and metadata footer injection — as specified in the format_node section.

**Step 13**: Scaffold the React frontend. Set up Vite, Tailwind, Framer Motion, React-Markdown, folder structure, and base CSS variables for the cyberpunk color scheme.

**Step 14**: Build frontend components in this order: `StatusBar` → `ResearchInput` (with cancel button) → `AgentCard` (with Framer Motion state transitions) → `AgentFeed` → `SourceList` → `ReportViewer` (with progressive token rendering, copy, and export).

**Step 15**: Write `useStream.js` (reusable SSE primitive) and `useResearch.js` (application state logic). Wire all SSE event types from the catalog to the appropriate state updates.

**Step 16**: Full integration — connect frontend to backend. Test end-to-end with a real research query. Fix all issues.

**Step 17**: Polish — Framer Motion animations for all transitions, error state UI, cancel state UI, mobile responsiveness (nice to have, not blocking).

---

## Testing Strategy

- After Step 3: Run a quick Python script to verify ChromaDB can create a session-scoped collection, upsert chunks, query them, and delete the collection.
- After Step 5: Run scraper on `https://en.wikipedia.org/wiki/Large_language_model` — verify clean text output with no nav/footer/boilerplate.
- After Step 10: Run the full LangGraph pipeline from a Python script (not via API) with query `"What is retrieval augmented generation?"`. Verify all three agents and the format node execute, produce a report with citations, and clean up ChromaDB.
- After Step 11: Use curl to test all API endpoints. Specifically test: start a session, connect to SSE stream, receive events, retrieve the final report, and test the cancel endpoint mid-pipeline.
- After Step 16: Full end-to-end test with three different research queries of increasing complexity. Verify the cancel button works mid-pipeline and leaves no orphaned ChromaDB collections.

---

## Known Constraints & Gotchas

1. **VRAM**: 6GB RTX 3050. Models run sequentially via Ollama. Never load two models at once. LangGraph's linear graph handles this naturally.
2. **RAM**: 8GB DDR4. `all-MiniLM-L6-v2` + ChromaDB in-process + FastAPI will consume 3–4GB. Keep an eye on memory. Do not load a larger embedding model.
3. **Windows + PowerShell**: The user is on Windows with PowerShell. All file paths must use `pathlib.Path` or `os.path.join` — never hardcoded forward slashes in backend file operations.
4. **Ollama model names**: Use exactly `mistral:7b-instruct` and `qwen2.5:7b` — these are the confirmed installed names. Do not alter these strings.
5. **DuckDuckGo rate limiting**: The `duckduckgo-search` library can hit soft rate limits. Always add a 1-second delay between search queries. The retry backoff (2s, 4s, 8s) handles transient blocks.
6. **Tavily fallback**: If `TAVILY_API_KEY` is set but the key is invalid, the Tavily client will raise an auth error. Catch this, log it, fall back to DuckDuckGo for that session, and note the fallback in the SSE stream as an info event.
7. **SSE on Windows**: FastAPI `StreamingResponse` for SSE works fine. Ensure the client-side `EventSource` reconnect logic is implemented in `useStream.js` — some browsers close idle SSE connections.
8. **ChromaDB persist path**: `CHROMA_PERSIST_DIR` is relative to where uvicorn is run from. Document this clearly in the README. Use `pathlib.Path.resolve()` in config to convert to an absolute path at startup.
9. **Scraping failures**: Expect 20–30% of URLs to fail. The pipeline is designed to be resilient. Log failures to `scraping_errors` in state and surface them in the Sources panel.
10. **LLM output parsing**: Local models don't always follow JSON formatting instructions. Never `json.loads()` raw LLM output without a try/except. Always have a fallback: either a regex-based extractor or a graceful degradation path.
11. **Long-running pipeline**: The full pipeline may take 3–8 minutes on this hardware. The SSE stream, progressive token streaming, and per-source events exist precisely to keep the UI alive and the user informed. The UI must never appear frozen.
12. **Session memory loss on restart**: In-memory session storage means a server crash during an active pipeline loses the session. This is a known v1 limitation. Document it. Do not implement persistence for v1.

---

## What "Done" Looks Like

The project is complete when:
- A user can type a research question into the UI and click "RESEARCH"
- All three agents execute sequentially with live status updates visible in the Agent Feed
- The report streams token-by-token into the Report panel during synthesis — no blank waiting period
- A structured markdown report is produced with inline citations
- Every citation in the report maps to a real URL that was actually scraped
- The Sources panel shows all processed sources with their summaries and any scraping failures
- The report can be copied as markdown or downloaded as a `.md` file
- The CANCEL button aborts the pipeline cleanly and cleans up ChromaDB
- The system handles failures gracefully (bad URLs, slow models, rate limits) without crashing
- The UI matches the dark cyberpunk aesthetic with smooth Framer Motion transitions

---

*This CLAUDE.md is the single source of truth for this project. When in doubt, refer back here.*