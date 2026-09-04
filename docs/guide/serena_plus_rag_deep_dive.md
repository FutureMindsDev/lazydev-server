# Serena MCP + RAG: How They Work Together in LazyDev

## The Problem With Your Current Pipeline

Let's trace what happens today when a GitHub issue arrives. I'll use a concrete example:

> **Issue #142**: "The `calculateTotal` function in the order service doesn't apply discount codes correctly. When a user enters a percentage-based discount, it subtracts the percentage number directly instead of calculating the percentage of the subtotal."

### Current Flow (What Actually Happens Today)

```
1. IssueAnalyzerAgent (issue-analyzer.agent.ts)
   └─ LLM extracts: "calculateTotal function, discount codes, percentage calculation"

2. ResearchAgent (research.agent.ts)
   └─ LLM extracts keywords: "calculateTotal, discount, subtotal"
   └─ ripgrep searches the worktree for each keyword
   └─ Returns RAW text lines like:
        src/orders/order.service.ts:87 - calculateTotal(items: CartItem[], discountCode?: string) {
        src/orders/order.service.ts:102 - const discount = discountCode ? getDiscount(discountCode) : 0;
        src/orders/order.service.ts:103 - return subtotal - discount;  // BUG IS HERE
        src/discounts/discount.util.ts:14 - export function getDiscount(code: string): number {
        src/payments/payment.service.ts:33 - const total = await this.orderService.calculateTotal(items, code);
        src/tests/order.spec.ts:55 - expect(calculateTotal(items, 'SAVE20')).toBe(80);
        ...30 more lines across 12 files

3. PlanningAgent (planning.agent.ts)
   └─ Receives ALL those raw grep lines as context
   └─ LLM has to figure out the relationships between files BY READING RAW TEXT

4. PatchGeneratorAgent (patch-generator.agent.ts)
   └─ Reads ENTIRE files from disk (line 49: fs.readFile)
   └─ Sends COMPLETE file contents to LLM
   └─ LLM regenerates the ENTIRE file with the fix
```

### What's Wrong With This

| Problem | Where It Happens | Impact |
|---|---|---|
| **Grep returns noise** | ResearchAgent line 64 | 30+ matches for "discount" across tests, comments, unrelated files |
| **No understanding of relationships** | PlanningAgent | LLM gets flat text, doesn't know `PaymentService` calls `OrderService.calculateTotal()` |
| **Entire files sent to LLM** | PatchGenerator line 50 | A 500-line `order.service.ts` burns ~2000 tokens even though only 3 lines need to change |
| **Blind to the blast radius** | PlanningAgent | Doesn't know what OTHER functions call `calculateTotal` → might break callers |
| **No historical memory** | ResearchAgent | Doesn't know issue #98 was a similar discount bug that was already fixed in a different module |

---

## How Serena + RAG Fix This (Together)

The key insight: **RAG answers "WHERE should I look?"** and **Serena answers "WHAT exactly is there?"**

Neither can do the other's job:

```
                    "Where should I look?"              "What exactly is there?"
                    ─────────────────────               ────────────────────────
  RAG (Qdrant)      ✅ Semantic similarity              ❌ No code structure
                    finds related files even            returns raw text chunks
                    if naming is different              no function signatures

  Serena (LSP)      ❌ Only finds exact names           ✅ Full symbol tree
                    can't find "discount logic"         function signatures,
                    if the function is called           callers, references,
                    "applyPromotion"                    type information
```

### Concrete Example: The 3-Phase Research Model

Here's exactly how your [research.agent.ts](file:///Users/arkarchanmyae/Desktop/projects/lazy-issue-resolver/src/orchestration/agents/research.agent.ts) would work with both:

---

#### Phase 1: RAG — "Cast a Wide Net" (Semantic Discovery)

**Input**: The issue text — `"calculateTotal function doesn't apply discount codes correctly..."`

**What RAG does**: Converts the issue text to an embedding vector, then queries Qdrant for the most semantically similar code chunks in the repository.

```typescript
// In ResearchAgent.invoke()

// 1. Embed the issue summary
const issueEmbedding = await this.embeddingService.getEmbedding(query);

// 2. Search Qdrant for similar code chunks
const semanticMatches = await this.vectorDbService.searchSimilar(
  'code-chunks',   // collection name
  issueEmbedding,
  10,              // top 10 results
);
```

**What RAG returns** (ranked by relevance):

| Rank | File | Score | Why It Matched |
|---|---|---|---|
| 1 | `src/orders/order.service.ts` | 0.94 | Contains "calculateTotal", "discount", "subtotal" |
| 2 | `src/discounts/discount.util.ts` | 0.91 | Contains "discount", "percentage", "apply" |
| 3 | `src/promotions/promo.engine.ts` | 0.85 | Contains "percentage-based", "calculate" — **different naming but semantically related!** |
| 4 | `src/cart/cart.service.ts` | 0.78 | Contains "subtotal", "items", "total" |
| 5 | `src/payments/payment.service.ts` | 0.72 | Contains "total", "calculateTotal" |

> [!IMPORTANT]
> **This is something Serena CANNOT do.** Serena's `find_symbol("calculateTotal")` would find the function by name. But it would **never** find `promo.engine.ts` because that file doesn't use the word "calculateTotal" — it uses "applyPromotion." RAG found it because the *semantics* (meaning) are similar even though the *text* is different.

**What RAG also does** — historical issue matching:

```typescript
// 3. Search for similar past issues
const pastIssues = await this.vectorDbService.searchSimilar(
  'issue-history',
  issueEmbedding,
  3,
);
// Returns: Issue #98 "Percentage discount applied as flat amount in promo engine"
//          → Fixed by changing: `subtotal - percentage` → `subtotal * (1 - percentage/100)`
//          → This is the SAME bug pattern! The LLM can learn from this fix.
```

**Phase 1 Output**: A list of ~5-10 **candidate files** + any historical fix patterns.

---

#### Phase 2: Serena — "Zoom In With Precision" (Structural Analysis)

**Input**: The candidate file list from RAG.

**What Serena does**: For each candidate file, use LSP-powered tools to extract **structured, token-efficient** context.

```typescript
// 4. Activate the project for this worktree
await this.serenaMcp.activateProject(worktreePath);

// 5. For each RAG candidate file, get the symbol overview
for (const candidate of semanticMatches) {
  const filePath = candidate.payload.filePath;

  // Instead of reading the full 500-line file, get just the symbol tree
  const symbols = await this.serenaMcp.getSymbolsOverview(filePath);
  // Returns structured data like:
  // {
  //   "OrderService": {
  //     kind: "class",
  //     methods: [
  //       "constructor(discountUtil, taxService)",
  //       "calculateTotal(items: CartItem[], discountCode?: string): number",
  //       "getSubtotal(items: CartItem[]): number",
  //       "applyTax(amount: number, region: string): number"
  //     ]
  //   }
  // }
}
```

**Token comparison**:

| Approach | What Gets Sent to LLM | Token Count |
|---|---|---|
| Current (read full file) | All 500 lines of `order.service.ts` | ~2,000 tokens |
| Serena `getSymbolsOverview` | 4-line summary of class + method signatures | ~80 tokens |
| **Savings** | | **96% fewer tokens** |

```typescript
// 6. For the specific symbol mentioned in the issue, get deep context
const symbolDetail = await this.serenaMcp.findSymbol('OrderService.calculateTotal');
// Returns: exact function body, parameter types, return type, line range

// 7. Find everything that CALLS this function (blast radius)
const callers = await this.serenaMcp.findReferencingSymbols('calculateTotal');
// Returns:
// [
//   { file: "src/payments/payment.service.ts", symbol: "PaymentService.processOrder", line: 33 },
//   { file: "src/cart/cart.service.ts", symbol: "CartService.checkout", line: 71 },
//   { file: "src/api/order.controller.ts", symbol: "OrderController.preview", line: 22 },
//   { file: "src/tests/order.spec.ts", symbol: "describe.calculateTotal", line: 48 }
// ]
```

> [!IMPORTANT]
> **This is something RAG CANNOT do.** RAG can tell you "payment.service.ts is related to this issue." But it can't tell you that specifically `PaymentService.processOrder` on **line 33** calls `calculateTotal`. Serena knows this because it uses the actual LSP (Language Server Protocol) — the same engine that powers "Go to Definition" and "Find All References" in VS Code.

**Phase 2 Output**: Structured context — symbol trees, function signatures, caller maps, and only the specific function bodies that matter.

---

#### Phase 3: Combined Context Assembly

Now the Research Agent assembles a **focused, structured context package** for the Planning Agent:

```typescript
return {
  researchContext: JSON.stringify({
    // From RAG — broad discovery
    semanticallySimilarFiles: ['order.service.ts', 'discount.util.ts', 'promo.engine.ts'],
    historicalFixes: [{
      issue: '#98',
      pattern: 'Percentage applied as flat amount',
      fix: 'Changed subtotal - percentage → subtotal * (1 - percentage/100)',
    }],

    // From Serena — precise structure
    targetSymbol: {
      name: 'OrderService.calculateTotal',
      signature: '(items: CartItem[], discountCode?: string): number',
      body: '...only the 15 lines of this function...',
      lineRange: [87, 104],
    },
    calledBy: [
      'PaymentService.processOrder (line 33)',
      'CartService.checkout (line 71)',
      'OrderController.preview (line 22)',
    ],
    relatedSymbols: {
      'getDiscount': {
        file: 'src/discounts/discount.util.ts',
        signature: '(code: string): { type: "flat"|"percentage", value: number }',
        body: '...only this function body...',
      },
    },
  }),
};
```

---

## How This Flows Through the Full LangGraph Pipeline

Here's your actual pipeline from [orchestration.service.ts](file:///Users/arkarchanmyae/Desktop/projects/lazy-issue-resolver/src/orchestration/orchestration.service.ts) with both tools:

```
┌─────────────────────────────────────────────────────────────────────┐
│  1. IssueAnalyzerAgent                                              │
│     Input:  Raw GitHub issue                                        │
│     Uses:   LLM only (same as today, no change)                     │
│     Output: "Fix calculateTotal to apply percentage discounts        │
│              correctly by multiplying instead of subtracting"        │
└────────────────────────────┬────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│  2. ResearchAgent  ← THIS IS WHERE BOTH TOOLS WORK TOGETHER        │
│                                                                     │
│     Step A — RAG (wide net):                                        │
│       • Embed the analysis text                                     │
│       • Query Qdrant → 5-10 candidate files                         │
│       • Query Qdrant issue-history → similar past fixes             │
│       TOKEN COST: ~200 tokens (file list + past fix summary)        │
│                                                                     │
│     Step B — Serena (precision zoom):                                │
│       • activateProject(worktreePath)                                │
│       • getSymbolsOverview() for each candidate file                 │
│       • findSymbol('calculateTotal') → exact body                   │
│       • findReferencingSymbols('calculateTotal') → callers           │
│       TOKEN COST: ~300 tokens (symbol signatures + function body)   │
│                                                                     │
│     Step C — ripgrep (fallback for text patterns):                   │
│       • Search for error messages, string literals                   │
│       • Catch anything RAG and Serena might miss                     │
│       TOKEN COST: ~100 tokens (filtered results)                    │
│                                                                     │
│     TOTAL CONTEXT: ~600 tokens (vs ~5000+ tokens today)             │
│     Output: Structured researchContext with files, symbols, callers  │
└────────────────────────────┬────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│  3. PlanningAgent                                                   │
│     Input: Structured researchContext (symbols + callers + history)  │
│     Now the LLM knows:                                              │
│       • EXACTLY which function to modify (calculateTotal, L87-104)  │
│       • WHO calls it (3 callers — check if their contracts break)   │
│       • The return type is `number` (callers expect this)           │
│       • A SIMILAR BUG was fixed before (can reuse the pattern)      │
│     Output: Implementation plan that is precise and safe            │
│                                                                     │
│     vs. TODAY: LLM gets 30 grep lines and has to guess              │
└────────────────────────────┬────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│  4. PatchGeneratorAgent                                             │
│     TODAY (without Serena):                                         │
│       • Reads ENTIRE order.service.ts (500 lines → ~2000 tokens)    │
│       • LLM regenerates the ENTIRE file                             │
│       • Risk: LLM accidentally changes unrelated functions          │
│                                                                     │
│     WITH SERENA:                                                    │
│       • Only reads the 15-line function body from Serena             │
│       • LLM generates ONLY the replacement body                     │
│       • Serena.replaceSymbolBody('OrderService.calculateTotal', ...) │
│       • Safe: only that function changes, nothing else touched      │
│     TOKEN COST: ~200 tokens (vs ~4000 tokens today)                 │
└────────────────────────────┬────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│  5. ValidationAgent → Docker Sandbox (no change)                    │
│  6. GitAgent → Push branch (no change)                              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Why One Without the Other Fails

### Scenario A: Serena Only, No RAG

The issue says: *"Discount calculation is broken when users apply promo codes."*

```
Serena: findSymbol("discount") → ❌ Too vague, no such single symbol
Serena: findSymbol("applyPromotion") → ✅ Found in promo.engine.ts
Serena: findSymbol("calculateTotal") → ✅ Found in order.service.ts

But wait — the issue didn't mention "applyPromotion" or "calculateTotal" by name.
The LLM would need to GUESS symbol names to search for.
And if the codebase uses unexpected naming (e.g., "computeOrderAmount"),
Serena would find NOTHING because it only does exact/pattern matching.
```

> RAG doesn't care about names. It understands that "discount calculation" is semantically close to code that does `subtotal * (1 - rate)`, regardless of what the function is called.

### Scenario B: RAG Only, No Serena

RAG correctly identifies that `order.service.ts` is relevant (score 0.94).

```
RAG returns text chunks from order.service.ts:
  "...calculateTotal(items, discountCode) { const subtotal = items.reduce(...)
   const discount = getDiscount(discountCode); return subtotal - discount; }..."

Problems:
1. What TYPE does getDiscount return? Is it a number? An object with {type, value}?
   → RAG doesn't know, it returns raw text chunks
2. What OTHER functions call calculateTotal?
   → RAG has no concept of call graphs
3. If we change the return type, will callers break?
   → RAG can't answer this
4. Where exactly is getDiscount defined?
   → RAG might return 3 different chunks — which one is the real definition?
```

> Serena answers all of these instantly with `findReferencingSymbols()`, `findSymbol()`, and `getSymbolsOverview()`.

---

## Visual Summary

```
GitHub Issue: "Discount calculation broken"
                  │
                  ▼
        ┌─────────────────┐
        │   ISSUE TEXT     │
        │   (natural       │
        │    language)     │
        └────────┬────────┘
                 │
    ┌────────────┼──────────────┐
    │            │              │
    ▼            ▼              ▼
 ┌──────┐   ┌───────┐    ┌──────────┐
 │ RAG  │   │Serena │    │ ripgrep  │
 │      │   │       │    │          │
 │WHERE │   │ WHAT  │    │ TEXT     │
 │should│   │exactly│    │patterns  │
 │I look│   │is     │    │fallback  │
 │  ?   │   │there? │    │          │
 └──┬───┘   └───┬───┘    └────┬─────┘
    │           │              │
    │ Files:    │ Symbols:     │ Matches:
    │ order.ts  │ calculateTotal│ error msgs
    │ discount. │  → signature  │ string
    │ promo.ts  │  → body       │ literals
    │           │  → callers    │
    │ History:  │  → types      │
    │ Issue #98 │              │
    │ fix patt. │              │
    └─────┬─────┴──────┬───────┘
          │            │
          ▼            ▼
    ┌──────────────────────────┐
    │  Combined Context        │
    │  • 5 candidate files     │
    │  • Symbol tree per file  │
    │  • 1 target function body│
    │  • 3 callers identified  │
    │  • 1 historical fix      │
    │  ~600 tokens total       │
    │  (vs ~5000+ today)       │
    └──────────────────────────┘
```

> [!TIP]
> **The simplest way to think about it**: RAG is your **search engine** (Google — "find me things about discounts"). Serena is your **IDE** (VS Code — "show me the definition, find all references, rename this symbol"). You need Google to know *where* to look. You need the IDE to *understand* what you're looking at. LazyDev needs both because it's an autonomous agent that must do everything a human developer does: search → understand → plan → edit.
