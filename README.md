# @pipeworx/esef-filings

XBRL filings index MCP — published company annual reports from the filings.xbrl.org index run by XBRL International, plus the IFRS financial facts inside each one. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1663+ live data sources.

The European counterpart to `sec-xbrl`: same idea (accounting facts straight out of a regulator's XBRL), different filing regime.

## Tools

- `esef_search_filings(entity_name?, country?, regime?, year?, period_end?, period_end_from?, period_end_to?, with_errors?, sort?, limit?, page?)` — search the index. Returns company name, LEI or national identifier, country, regime, period end, XBRL validation error/warning counts, report language and links to the xBRL-JSON, HTML report, viewer and package. Any argument not in this list is rejected with a `user_error` naming the accepted set — it is never silently dropped (see GOTCHA 1).
- `esef_entity_filings(entity, limit?)` — every filing for one company, resolving a name, LEI or national registration number. Returns what it resolved to and how, plus filings grouped into distinct reports (see "Language editions" below).
- `esef_filing_facts(fxo_id? | entity?, year?, concept?, include_dimensioned?, limit?)` — the second hop. Opens the filing's xBRL-JSON report and returns named IFRS facts with value, currency, period and concept.

`esef_search_filings` and `esef_entity_filings` prove a filing exists; only `esef_filing_facts` returns money.

## Scope

25,640 filings under exactly **two** reporting regimes:

| Regime | Filings | Countries |
|---|---|---|
| `ESEF` | ~15,996 | AT BE CY CZ DK ES FI FR GB GR IS IT LT NL NO PL PT RO SE |
| `UAIFRS` | ~9,644 | UA |

The pack name says ESEF; the source is broader than ESEF. Both `country` and `regime` are first-class filters so a caller can pin the scope they meant. See GOTCHA 2 below — this is not a cosmetic detail.

## Auth

None. No key, no account, no rate-limit documentation published.

filings.xbrl.org is a nonprofit index, so the pack is deliberately quiet with it: one index request per call, at most one report fetch, no probing or fan-out, and a real contactable `User-Agent` (`Pipeworx/1.0 (+https://pipeworx.io; support@pipeworx.io)`).

## Gotchas

### GOTCHA 1 — a wrong filter param is silently ignored, not rejected

This is the dangerous one and it is why filter construction lives in exactly one helper.

The API takes JSON:API filters in two forms:

```
?filter%5Bcountry%5D=FI     bracketed shortcut, percent-encoded  -> meta.count 1168, Finnish records
?country=FI                 bracketed form written WITHOUT the brackets
                            -> HTTP 200, meta.count 25640, first record Ukrainian
```

The second is the entire unfiltered index wearing a successful filtered query's clothes. Same status code, same envelope, same field names — nothing to catch.

Two defences, both in `src/index.ts`:

1. **The pack never uses the bracketed shortcut for filters.** It uses the flask-rest-jsonapi complex form, `?filter=[{"name":"country","op":"eq","val":"FI"}]` — a single unbracketed param, so there is no bracket encoding to get wrong, *and* a bad attribute name is rejected loudly (`HTTP 400 "FilingSchema has no attribute bogus"`) instead of ignored. Only `page[size]` / `page[number]` are bracketed, and they go through `buildUrl()`, which uses `URLSearchParams` (which percent-encodes brackets).
2. **`verifyFilters()` re-checks the returned rows** against what was asked for. Every `esef_search_filings` response carries `filters_applied`, `filters_verified` and `filter_mismatches`, so a filter that somehow failed to bite shows up in the payload rather than quietly widening the answer.

**The same failure mode existed one layer up, on our own tool boundary, and got fixed the same way (fleet #2317).** `esef_search_filings` never declared `period_end_from`/`period_end_to`, so a caller who guessed those (a plausible name for a date range) had the arguments silently dropped by the handler — no schema error, `filters_requested` echoed them as `null`, and the response still claimed `filters_verified: true`. A date-bounded query for Portugal returned the identical 128-row unfiltered total as a query with no date at all. Fixed two ways: `period_end_from`/`period_end_to` are now real, declared range filters (`op: 'ge'`/`'le'` against `period_end`, verified by `verifyFilters()` like every other filter), and `rejectUnknownArgs()` throws a `user_error` naming the accepted argument list for anything else the caller might guess — so an undeclared argument can no longer be dropped silently, whatever its name.

### GOTCHA 2 — this index is not ESEF-only, and saying otherwise is a wrong answer

An unfiltered probe's first record is Ukrainian: `EDRPOU-32033791-2020-12-31-UAIFRS-UA-0`. 38% of the index is UAIFRS. Describing the pack as "European filings" while it can return Ukraine is the resolver-grain trap — the caller gets a confident answer at the wrong grain.

So: every tool description names both regimes out loud, `regime` is a filter, every returned row states its own `country` and `regime`, and search responses carry a `scope_note`. If you edit a description, keep the scope sentence in it.

### GOTCHA 3 — the same annual report is indexed once per language edition

Citycon's FY2022 appears twice — `…-ESEF-FI-1` (Finnish) and `…-ESEF-FI-0` (English) — identical figures, different `fxo_id`. Counting index rows as reports inflates a company's filing history: Citycon has **11 filings but 6 distinct financial years**.

`esef_entity_filings` therefore returns both `filing_count` (index rows) and `report_count` (distinct years), and groups editions under a `preferred_edition` — English when available, since the narrative facts are then readable. `esef_filing_facts` picks the English edition when resolving from a company name.

Note this is *not* what the language dimension inside a report does. Each xBRL-JSON document is single-language; the language variance is one level up, across filings.

### GOTCHA 4 — one figure is tagged many times inside a report

Citycon's FY2022 `ifrs-full:ProfitLoss` of EUR 5,100,000 appears **three times** with byte-identical dimensions (primary statement, notes, equity reconciliation), plus further copies broken down by `ComponentsOfEquityAxis`. Returned naively that is one profit figure looking like six different ones.

`esef_filing_facts` groups on every dimension except language, collapses identical values, and reports `occurrences` (how many taggings backed the value) and `dedup.repeat_taggings_collapsed`. Axis-dimensioned breakdowns are excluded by default (`include_dimensioned: false`) and counted in `dedup.dimensioned_facts_excluded`. Genuinely contradictory values for one dimension set surface in `conflicting_values` rather than being silently picked between.

### GOTCHA 5 — `json_url` can be null

About 1.5% of index rows have no machine-readable report, and in the sampled cases `report_url` and `viewer_url` were null too — the row is metadata only (e.g. Cloetta AB `549300CSLHPO6Y1AZN37-2021-12-31-ESEF-SE-1`, which has `error_count: 1` and only a package zip). `esef_filing_facts` returns `{found: false, reason: 'no_machine_readable_report'}` naming whatever URL did survive, instead of throwing.

### GOTCHA 6 — entities are addressed by `identifier`, not by `id`

A JSON:API entity record carries both `id: "1597"` and `attributes.identifier: "549300P8N0P6KDGTJ206"`. Only the identifier is addressable: `/api/entities/1597` returns 404.

Worse, the identifier is **not** always the `fxo_id` prefix. Ukrainian filings use `EDRPOU-32033791-…` in the fxo_id but are addressed as plain `32033791`. Joining filings to entity names on the fxo_id prefix left every Ukrainian filing with `entity_name: null`; the pack joins on the tail of `relationships.entity.links.related` instead.

### GOTCHA 7 — xBRL instants are stamped one day late

An xBRL-JSON instant period of `2023-01-01T00:00:00` is the **2022-12-31** balance sheet — the instant is the start of the following day. Reading the raw string is a full year of error. `describePeriod()` normalises both forms, so `period_end` and `period_label` ("as at 2022-12-31", "2022-01-01 to 2022-12-31") are already corrected.

### GOTCHA 8 — narrative notes are tagged as facts

`DisclosureOfShareCapitalReservesAndOtherEquityInterestExplanatory` in Citycon's FY2022 report is 2,500 characters of prose. Text values are clipped at 600 characters with `value_truncated` / `value_length` set, and within a period measured figures sort ahead of narrative, so `concept: "Equity"` leads with the EUR 2,310,300,000 balance rather than pages of note text.

### GOTCHA 9 — the index lags the filing season; current-year coverage is close to empty

This is not a bug in the pack, but it is the gotcha that actually costs users, and it went undocumented for a while (fleet #2317 — an external developer independently measured these same counts and rejected the pack over it). `filings.xbrl.org` is a voluntary community index, not a real-time regulator feed: a company's annual report typically lands weeks to months after the reporting period closes and after XBRL International (or a national collector) has processed it.

Measured live 2026-09-23 via `esef_search_filings` with the `year` filter:

| Country | 2023 | 2024 | 2025 |
|---|---|---|---|
| PT | 7 | 7 | 0 |
| ES | 125 | 113 | 1 |

A search for the current calendar year will typically come back with few or zero rows — that reflects upstream lag, not a broken query or a country with no filers. If you are building a pipeline that expects near-real-time coverage of the current fiscal year, this index will disappoint you; the prior 1-2 calendar years is where it is actually populated. Every `esef_search_filings` response (matches and no-matches alike) now carries this as a machine-readable `coverage_note` so a caller learns it from the tool rather than from a query that quietly returns zero.

## Data sources

- Index: `https://filings.xbrl.org/api/filings` (JSON:API, header `Accept: application/vnd.api+json`)
- Entities: `https://filings.xbrl.org/api/entities`, `…/api/entities/<identifier>/filings`
- Reports: root-relative `json_url` resolved against `https://filings.xbrl.org` — xBRL-JSON (OIM), `{documentInfo, facts}`, typically 500 KB–1 MB

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "esef-filings": {
      "url": "https://gateway.pipeworx.io/esef-filings/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/esef-filings/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1663+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/esef_search_filings \
  -H 'Content-Type: application/json' \
  -d '{"entity_name":"Citycon","country":"FI"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/esef_search_filings`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "esef-filings": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-esef-filings"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-esef-filings
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Esef Filings data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
