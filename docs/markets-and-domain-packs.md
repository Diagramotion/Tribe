# Markets monitoring and adjacent domain packs

## Markets Monitor: product boundary

**Recommendation: conditional go for a personal, read-only Markets Monitor; no-go for stock picks, buy/sell recommendations, portfolio suitability, or trading in the first release.** The useful product is a reliable view of what changed in a user-owned watchlist, with sourced facts and explicit uncertainty. A recommendation feature is a different product and requires jurisdiction-specific advice and licensing analysis before Tribe makes that claim or ships that behaviour.

The useful v1 surface is:

- User-owned watchlists and thresholds, with alerts delivered through local scheduled runs during configured exchange sessions.
- Price/volume charts, company announcements and source-linked news summaries, with the source and retrieval timestamp beside every observation.
- Clear data mode on every view: real-time, delayed, or end-of-day. Do not blend quote freshness across providers or silently imply a quote is live.
- A saved brief that separates observed facts, model interpretation and unknowns. Explain what changed against the user's chosen baseline, without personal suitability claims.
- Local polling with user-visible cadence, provider quota/cost controls, deduplication and pause/stop controls. Tribe must be open for local schedules; continuous streaming while it is closed needs a later OS service or hosted option.
- A local-first connection model: credentials stay in the OS keychain, watchlists remain on the device, and no quote, derived chart, or brief is shared unless the exact provider licence permits that audience and use.

This boundary matters in Australia. ASIC says financial product advice requires AFS licence authorisation. Its guidance distinguishes factual information from general and personal advice, and says the communication's overall impression matters: even a factual comparison may imply a recommendation when framed to influence a product decision. A disclaimer or a label such as “analysis” does not decide the classification. Moneysmart's current AI guidance says AI can help explain technical information and track general market trends, but advises against using it for stock tips. Keep the first release to sourced observations and user-requested comparisons; do not rank securities or imply what a user should buy, hold, or sell. [ASIC's advice overview](https://www.asic.gov.au/regulatory-resources/financial-services/giving-financial-product-advice), [ASIC RG 36](https://www.asic.gov.au/regulatory-resources/find-a-document/regulatory-guides/rg-36-licensing-financial-product-advice-and-dealing), and [Moneysmart's AI guidance](https://moneysmart.gov.au/online-safety/ai-and-money-decisions) support this boundary.

Market data also has contractual and freshness constraints. Alpha Vantage intraday and quote APIs default to end-of-day or historical data unless the relevant entitlement is requested; realtime and 15-minute-delayed US feeds are sold for personal use, while commercial use is directed to sales. Its terms define commercial use broadly enough to include some investment analysis, research, testing and monitoring activity, so Tribe must not assume that a user's individual watchlist or API key qualifies without written provider confirmation. Exchange policies also separate display, non-display processing, redistribution and derived-data rights: Euronext says realtime use may be fee-bearing and redistribution requires a licence; NZX identifies distinct distribution, non-display and derived-data licences; ASX requires a New Original Work licence for certain transformed data products. A local-first app does not remove provider obligations. Per-user API keys are not a substitute for checking display, non-display, derived-data, caching, retention, professional-user, and redistribution rights. [Alpha Vantage API documentation](https://www.alphavantage.co/documentation/), [Alpha Vantage terms](https://www.alphavantage.co/terms_of_service/), [Euronext market-data policies](https://www.euronext.com/en/data/real-time-data/pricing-specs-agreements/market-data-pricing-policies), [NZX data licensing](https://www.nzx.com/services/products-tools/data-connectivity/nzx-market-data/data-licensing), [ASX New Original Work licensing](https://www.asx.com.au/connectivity-and-data/information-services/new-original-work), and [ASX realtime data access](https://www.asx.com.au/connectivity-and-data/information-services/real-time-data) describe these constraints.

For investment guidance, the jurisdiction matters as much as the data. In Australia, a recommendation or opinion that is intended, or could reasonably be seen as intended, to influence a financial-product decision can be financial-product advice; ASIC says an AFS licence or authorised provider is required. Its guidance also warns that factual facts can become advice through their overall presentation. Moneysmart describes AI as useful for explaining information and general market trends, but not as a source of stock tips. In the US, FINRA reminds member firms that existing supervision and communications rules apply to generative-AI outputs. These sources support keeping the initial Tribe pack to sourced observations, user-defined threshold alerts and neutral comparisons. Stock rankings, buy/hold/sell language, suitability, portfolio-aware recommendations and trading should remain out of scope until Tribe has a licensed partner and jurisdiction-specific product, supervision and record-keeping controls. [ASIC's licensing overview](https://www.asic.gov.au/limited-financial-services), [ASIC RG 36](https://www.asic.gov.au/regulatory-resources/find-a-document/regulatory-guides/rg-36-licensing-financial-product-advice-and-dealing), [Moneysmart's AI guidance](https://moneysmart.gov.au/online-safety/ai-and-money-decisions), and [FINRA Regulatory Notice 24-09](https://www.finra.org/sites/default/files/2024-06/regulatory-notice-24-09.pdf) support this boundary.

**Launch gates:**

1. Select an exchange and obtain written provider terms that cover Tribe's specific single-user or team use, display, charts, summaries, caching and retention. If any of these are unclear, do not enable that feed.
2. Represent quote mode (`real-time`, `delayed`, `end-of-day`), exchange, currency, source timestamp, retrieval time, entitlement and session on every result. Reject stale or ambiguous quotes instead of showing them as live.
3. Use an exchange calendar and session timezone for triggers, including holidays, early closes and daylight-saving changes. The local scheduler already provides a durable execution path, but delivery stops when Tribe is closed.
4. Keep the first version to manual watchlists, thresholds, observed facts and source-linked context. Do not ingest a brokerage account or ask the model to infer a user's risk tolerance, investment horizon or suitability.
5. Obtain specialist review of the actual UX and output examples before marketing the pack as investment assistance. If the intended output is a recommendation, use a licensed provider or defer the feature until Tribe has the required authorisation and controls.

**Architecture:** reuse project-scoped connections, role-granted deferred tools, schedules, event records, charts and artifacts. Keep credentials in the OS keychain and watchlists local. Persist source and freshness metadata beside any derived observation. A streaming adapter can publish events into Tribe's existing trigger system. Hosted execution is unnecessary while the desktop is open; continuous delivery with every local device closed requires an OS service or hosted worker. Team sharing remains off until both the provider contract and each derived-output right permit it.

## Adjacent packs, ranked

| Rank | Pack | Tribe primitives | Boundary |
| --- | --- | --- | --- |
| 1 | Operations intelligence | MCP data sources, scheduled/event-triggered KPI briefs, anomaly charts and shared documents | Best next pack after core runtime hardening: read-only first, show source/query timestamps and underlying numbers, approval for writes. |
| 2 | Support operations | Ticket search/summarisation, issue clustering, draft replies and routing | Human approval before sending or changing customer records; respect per-role connector grants. |
| 3 | Data and ML workspace | Notebook previews, approved local kernels, datasets, experiment runs, long-running jobs, charts and model artifacts | Strong current vertical; finish local reproducibility and artifact handling before remote/GPU execution, with explicit cost and data-transfer approval. |
| 4 | Product and design | Reusable design systems, managed browser, visual review, design/frontend workflows | Preview outputs before applying changes; keep external publishing an explicit action. |
| 5 | Internal policy and compliance review | Versioned documents, source citations, review comments and scheduled change monitoring | Assist review and traceability; do not make legal, eligibility or compliance decisions. |

Operations intelligence ranks first for the next adjacent pack because it exercises Tribe's existing triggers, role grants, charts, schedules and shared documents without immediately taking on market-data redistribution or financial-advice claims. These should be portable packs of roles, skills, workflows, connector configuration and optional schedules, not separate orchestration engines. Pack install must preserve Tribe's project selection, tool grants, exact approvals, local execution and user-owned data.

## Sources checked on 2 November 2026

- [ASIC: Giving financial product advice](https://www.asic.gov.au/regulatory-resources/financial-services/giving-financial-product-advice)
- [ASIC: RG 36, Licensing: Financial product advice and dealing](https://www.asic.gov.au/regulatory-resources/find-a-document/regulatory-guides/rg-36-licensing-financial-product-advice-and-dealing)
- [ASIC: RG 255, Providing digital financial product advice to retail clients](https://www.asic.gov.au/regulatory-resources/find-a-document/regulatory-guides/rg-255-providing-digital-financial-product-advice-to-retail-clients)
- [Alpha Vantage API documentation](https://www.alphavantage.co/documentation/)
- [Alpha Vantage premium data entitlements](https://www.alphavantage.co/premium/)
- [Polygon Market Data Terms of Service](https://polygon.io/terms/market_data_terms.pdf)
- [ASX real-time data](https://www.asx.com.au/connectivity-and-data/information-services/real-time-data)
- [ASX New Original Work licensing](https://www.asx.com.au/connectivity-and-data/information-services/new-original-work)
- [Moneysmart: AI and money decisions](https://moneysmart.gov.au/online-safety/ai-and-money-decisions)
- [ASIC: Limited financial services and the meaning of financial-product advice](https://www.asic.gov.au/limited-financial-services)
- [FINRA Regulatory Notice 24-09: AI and large language models](https://www.finra.org/sites/default/files/2024-06/regulatory-notice-24-09.pdf)
- [Euronext market-data policies](https://www.euronext.com/en/data/real-time-data/pricing-specs-agreements/market-data-pricing-policies)
- [NZX market-data licensing](https://www.nzx.com/services/products-tools/data-connectivity/nzx-market-data/data-licensing)
- [Alpha Vantage Terms of Service](https://www.alphavantage.co/terms_of_service/)
