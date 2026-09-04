# LazyDev Frontend Plan — A Beginner's Companion Guide

> This document walks through [\`lazydev\_frontend\_ui\_plan.md\`](./lazydev_frontend_ui_plan.md) section by section and explains every idea as if you're new to computer science. Jargon is introduced gently — each term is explained the first time it appears.

---

## Background: what is this project even doing?

Before the sections, one mental model. **LazyDev** is a robot assistant for software teams:

1. Someone posts a bug report (an **issue**) on GitHub — a website where programmers store and collaborate on code.
2. LazyDev notices the issue automatically.
3. It uses an **AI language model** (the same family of technology behind chatbots) to research the bug, write a fix, test it in a safe sandbox, and propose the corrected code as a **pull request** ("here's my suggested change, please review it").

The "frontend" we're planning is simply the **website/dashboard** where humans watch this robot work and occasionally correct it.

---

## Section 1: "What the backend already exposes" → *What does the robot already tell us?*

**Plain meaning:** Before designing screens, the author looked at what information already flows out of the existing system. You can't display data that doesn't exist.

New concepts:
- **Backend vs frontend**: The backend is the program running on a server (invisible to users) that holds data and does the heavy lifting. The frontend is what you see and click in a browser. They talk over the network.
- **API endpoint**: A specific web address where the frontend can *ask* the backend for something, like `GET /api/dashboard/metrics` means "please give me current statistics." `GET` = "read only," `POST` = "I'm sending you new data."
- **Queue**: Imagine a printer queue, but for tasks. Each GitHub issue becomes a job waiting in line. BullMQ (a tool used here) manages that line.
- **Database table / entity**: Data stored in organized rows, like a spreadsheet. The `audit_logs` table keeps one row per fix attempt: which issue, did it succeed or fail, how many tries, and the final code patch.
- **Webhook**: A way for GitHub to *push* news to LazyDev instantly ("hey, a new issue was just created!") rather than LazyDev constantly checking.
- **Redis**: A super-fast memory store used for temporary notes between programs — here, it holds a human's feedback message until the robot picks it up (it self-deletes after 24 hours).

The section also lists **gaps**: things the backend *doesn't* provide yet but the UI would need, like a way to list past runs or send feedback from a webpage instead of a developer-only tool.

---

## Section 2: "Product goal & personas" → *Who is looking at this website and why?*

**Plain meaning:** Good design starts by asking who will use it and what questions they need answered.

The three questions:
1. *"Is it working right now?"* — like checking whether your car dashboard shows warning lights.
2. *"What did it do and why?"* — AI systems can be mysterious; this screen makes its reasoning visible.
3. *"Can I steer it?"* — if the robot is stuck, let a human nudge it back on course.

**Persona**: a fictional profile of a typical user. Here there are two:
- A **maintainer** (programmer who owns the code) — wants to review fixes and unstick failures.
- An **operator** (person keeping the servers healthy) — wants overall health stats.

### 2.1 "Deployment models" → *Two ways customers can use this*

The plan supports two business models at once, explained with a restaurant analogy:

- **Mode A (self-hosted)** is like being given the whole food truck. You run it in your own yard ("your own Docker" = running the software inside isolated containers on *your* machine), you have every key, you can look anywhere.
- **Mode B (hosted/SaaS)** is like eating at *our* restaurant. You don't manage any equipment; you just link your GitHub account by clicking "install," and check your results on our website. You can only see *your own* orders — never other customers'.

That last point is called **multi-tenancy**: many unrelated users ("tenants") share one server, and the software must draw hard walls between their data. Every data request must carry a tag (`installation_id` — which GitHub installation a run belongs to) so queries can answer "show me only *this* customer's runs." Forgetting that filter in even one query means one customer could read another's code patches — the most serious bug this project could ship.

Key design rule from the plan: build for Mode B's strictness first, then relax for Mode A — adding walls after the building is up is far harder than including them in the blueprint.

---

## Section 3: "Information architecture" → *How is the site organized?*

**Plain meaning:** Just as a book has chapters, a website has pages arranged in a hierarchy. This section draws that tree: a sidebar menu with Overview, Runs, Queues, Repositories, Settings.

The tree notation (`├──`, `└──`) is just ASCII art showing parent/child relationships — e.g., clicking "Runs" leads to a list, and each item in the list opens a detail page. Things marked *[phase 2]* are planned but not first priority.

---

## Section 4: "Screens" → *A blueprint for each page*

Each sub-section describes one page in detail. Some ideas worth understanding:

### 4.1 Overview
The landing page. **KPI cards** = Key Performance Indicators shown as big numbers ("Success rate: 92%"). Color codes (green/amber/red) give instant gut-feel status, exactly like traffic lights.

### 4.2 Runs list
A **table** of all fix attempts with **pagination** (showing 50 at a time with "next page," because loading thousands at once would be slow) and **filters** (e.g., show only failed ones). An "empty state" is the friendly message shown when there's no data yet.

### 4.3 Run Detail — the flagship
This page tells the full story of one fix attempt:

- **Pipeline timeline**: LazyDev works in steps — understand the issue → research the codebase → make a plan → write the patch → test it → submit it. Each step is drawn as a dot connected by lines, so you see progress visually. If testing fails, it loops back to rewrite — the diagram shows that loop with a dashed arrow labeled with the attempt number.
- **Diff viewer**: A **diff** is the standard format showing code changes — lines removed (usually red, prefixed `-`) and lines added (green, prefixed `+`). Programmers review changes by reading diffs, so the UI renders them nicely with colors.
- **Human Feedback panel (HITL)**: Human-In-The-Loop — a fancy term for "letting a human intervene in an automated process." A text box where you type advice ("you edited the wrong file"), which the robot reads mid-run. **Quick-feedback chips** are one-click preset buttons so you don't retype common advice.
- **Failure forensics**: when a run fails, show the error log (the computer's complaint message) prominently so a human can diagnose it.

### 4.4–4.7 Queues, Repositories, Settings, Global elements
- Queues: view the task waiting-line directly, retry stuck jobs. **Mode A only** — hosted users share our infrastructure and must never see (or be able to drain) other tenants' job queues.
- Settings: shows configuration (which AI provider is active) but always **masks secrets** — passwords/API keys must never be displayed, even internally. Also Mode A only; hosted users configure nothing.
- Global search with **⌘K**: pressing Command-K opens a quick-search box, a convention power users expect.
- **Login**: Mode A optional (your own machine); Mode B mandatory "Sign in with GitHub" — the standard way one website verifies your identity via GitHub without ever seeing your password. After login you only see data from repositories *you* attached LazyDev to.

---

## Section 5: "Key workflows" → *Storyboards of real usage*

**Plain meaning:** Instead of listing features, this traces journeys: "user notices a spike of failures → clicks into them → reads why → sends advice → robot recovers."

Designing around *stories* rather than *features* catches missing pieces early — e.g., the story "steer a stuck run" immediately reveals you need both a feedback box AND a retry button AND a way to see the feedback was received.

---

## Section 6: "Architecture & tech choices" → *Which building blocks, and why*

**Architecture** = the high-level structure: which programs exist, how they communicate. Key concepts:

- **Framework (Next.js)**: A framework is a toolkit that handles repetitive plumbing so developers build features faster. Next.js is the most popular React framework.
- **React / components**: Modern UIs are built from **components** — reusable Lego bricks (a button, a KPI card, a table). You compose small ones into big ones.
- **TypeScript**: JavaScript with type-checking — the compiler verifies "this field should be a number" before the code runs, catching mistakes early.
- **Tailwind CSS**: Styling via ready-made utility classes instead of hand-written stylesheets.
- **shadcn/ui**: A library of pre-built, accessible components (dialogs, dropdowns). **Accessible** means usable by people with disabilities (screen readers, keyboard-only navigation).
- **SWR / polling**: The dashboard needs fresh numbers. **Polling** means re-fetching every N seconds (like hitting refresh automatically). SWR is a tiny library that does this plus caching.
- **SSE (Server-Sent Events)**: Instead of asking repeatedly, the server *pushes* updates the moment they happen — like switching from checking your mailbox hourly to having a mail slot that delivers instantly. Planned for phase 2 because polling is simpler to start with.
- **CORS**: Browser security rule about which websites may talk to which servers; the plan mentions configuring it so the dev frontend can call the dev backend.
- **OAuth**: "Sign in with GitHub"-style login. Instead of creating a new password, another trusted site (GitHub) confirms who you are. Needed for hosted mode so strangers can prove which repositories are theirs.
- **Multi-tenancy / **`installation_id`: many customers share one server; every piece of data is tagged with *which customer* it belongs to so queries can filter strictly (see §2.1 above).
- **Monorepo**: Keeping frontend and backend in one repository folder so they version together.
- **Docker / docker-compose**: Packages apps into standardized containers ("shipping containers for code") so they run identically anywhere; compose runs several of them together (app + database + cache...).

Why not just use Grafana (already installed)? Grafana excels at time-series graphs but is the wrong tool for reading individual patches or typing feedback — hence a custom UI, with a link out to Grafana for deep metrics.

---

## Section 7: "Data contracts" → *Agreeing on the shape of data*

When frontend and backend exchange data, they use **JSON** — text formatted like labeled boxes: `{"status": "SUCCESS", "validationAttempts": 2}`.

A **contract** means both sides agree on exact field names and types. The TypeScript interfaces here are written promises: "`issueNumber` is always a number; `generatedPatch` might be absent (`null`)". If either side breaks the promise, the compiler complains — bugs caught before users ever see them.

`Paginated<T>` uses a **generic** (`<T>`): one reusable wrapper shape that can paginate *any* list — runs, jobs, whatever.

---

## Section 8: "Visual design direction" → *Making it readable at 2am*

Principles, translated:
- **Dark-mode-first**: programmers stare at screens long hours; dark themes reduce glare.
- **Consistent color language**: red always means failure everywhere in the app — never green somewhere for "failed." Predictable colors become a language of their own.
- **Monospace font for machine output**: code and logs use fonts where every character has equal width, keeping columns aligned and characters distinguishable (`l` vs `1`).
- **Density trade-off**: tables packed tight (more rows visible); reading areas airy (comfortable comprehension). Different content, different spacing.
- **Accessibility**: focus rings showing where keyboard input lands, full keyboard navigation.

---

## Section 9: "Build phases" → *Eat the elephant in three bites*

**Plain meaning:** Never build everything at once. Each phase delivers something *usable*, and later phases build on lessons from earlier ones.

1. **Phase 0 — the walls before the house**: before any UI, tag every piece of data with which customer it belongs to and build the login flow. Retrofitting this later means migrating live customer data — painful and risky.
2. **Phase 1 — look only**: dashboards and read-only pages. Lowest risk; proves value fast.
3. **Phase 2 — act**: buttons that change things (send feedback, retry). Requires more care (permissions, confirmation dialogs).
4. **Phase 3 — live polish**: real-time animations, deeper management. Nice-to-haves last.

This ordering follows a core engineering principle: **deliver working value incrementally**, so if plans change, you still have something finished.

---

## Section 10: "Risks & mitigations" → *What could go wrong, and the plan B*

Engineering habit: list risks honestly alongside responses. Examples decoded:
- *"Patches can be huge"* → don't render thousands of lines at once (**virtualization** = only draw what's visible on screen, like a window onto a long scroll).
- *"Was my feedback actually received?"* → invisible actions erode trust; add a visible "pending" indicator.
- *"Dashboard exposed publicly?"* → anything that can trigger jobs must sit behind an **authentication gate** (login required), and secrets are never rendered.

---

## Quick glossary recap

| Term | One-liner |
| --- | --- |
| Frontend / Backend | What you see in browser / the server program behind it |
| API endpoint | Web address for asking the server for data |
| Queue | Waiting line for tasks |
| Webhook | Service A instantly notifying Service B of events |
| Diff | Red/green display of code changes |
| HITL | Human-in-the-loop: human steers automation |
| Component | Reusable UI building block |
| Polling / SSE | Asking repeatedly / being pushed instantly |
| Contract (types) | Agreed data shapes between two programs |
| OAuth | "Sign in with GitHub" — proving identity via a trusted site |
| Multi-tenancy / installation_id | Many customers, one server; every datum tagged with its owner |
| Phase (build) | Deliver incrementally, not all at once |
