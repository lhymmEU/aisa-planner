/**
 * Hand-maintained clean-pass data for the catalog build, derived from a
 * five-way audit of the live spec (2026-08, 691 operations). Revisit when the
 * weekly spec-drift workflow flags changes.
 *
 * Policy notes:
 * - LLM-inference endpoints (chat, messages, embeddings, rerank, image gen)
 *   declare op-level `servers` pointing at https://api.aisa.one/v1[beta] —
 *   they are not reachable at the /apis/v1 data gateway, so the flattener
 *   excludes any operation served off the data plane (generic rule) and the
 *   entries below document the specific cases.
 * - The "Other" tag is NOT junk wholesale: it holds real data APIs (EDINET
 *   filings, Exa search, Firecrawl scraping, Instagram, Pinterest). Those are
 *   kept and re-tagged by path family for retrieval quality.
 */

/** Tags excluded wholesale from the catalog: tag → reason. */
export const DENYLIST_TAGS: ReadonlyMap<string, string> = new Map([
  [
    "Image Generation",
    "media generation on the LLM-inference plane (/v1), not a data API reachable at /apis/v1",
  ],
]);

/** Individual operations excluded from the catalog: "METHOD path" → reason. */
export const DENYLIST_OPERATIONS: ReadonlyMap<string, string> = new Map([
  ["POST /messages", "Anthropic-compatible LLM inference (served at /v1, not the data gateway)"],
  [
    "POST /models/{model}:generateContent",
    "Gemini-compatible LLM inference (served at /v1beta, not the data gateway)",
  ],
  ["POST /embeddings", "embeddings relay on the LLM-inference plane (/v1), not a data API"],
  ["POST /rerank", "reranker relay on the LLM-inference plane (/v1), not a data API"],
  [
    "POST /apollo/usage_stats/api_usage_stats",
    "account-plane usage introspection; requires an Apollo master key the gateway Bearer key is not",
  ],
  ["GET /agentmail/api-keys", "API-key management, not a data operation"],
]);

/**
 * Path-prefix → tag overrides for families the spec leaves in "Other" (or a
 * misleading tag). Applied before denylist checks.
 */
export const TAG_REMAP: ReadonlyArray<{ prefix: string; tag: string }> = [
  { prefix: "/edinet/", tag: "Financial Data" },
  { prefix: "/exa/", tag: "Web & News Search" },
  { prefix: "/firecrawl/", tag: "Web & News Search" },
  { prefix: "/perplexity/", tag: "Web & News Search" },
  { prefix: "/instagram/", tag: "Instagram" },
  { prefix: "/pinterest/", tag: "Pinterest" },
];

/** Descriptions that are pure junk when equal to one of these strings. */
export const JUNK_DESCRIPTIONS_EXACT: ReadonlySet<string> = new Set(["Pricing"]);

/**
 * Stripped from stored descriptions AND embedding text (pure noise):
 * AgentMail's CLI-only fences and DataForSEO's checkmark icons.
 */
export const STRIP_ALWAYS_REGEXES: ReadonlyArray<RegExp> = [
  /\*\*CLI:\*\*\s*```bash[\s\S]*?```/g,
  /!\[checked\]\([^)]*checked-circle\.svg\)\s*/g,
];

/**
 * Literal sentences stripped from the EMBEDDING text only (they carry
 * provider-mechanics info a human may still want in the stored record).
 * Curly quotes are exact matches from the spec — do not "fix" them.
 */
export const EMBED_STRIP_STRINGS: ReadonlyArray<string> = [
  "Requires a master API key.",
  "Each Live SERP API call can contain only one task.",
  "Then, you can collect the results using the **‘Task GET’** endpoint.",
  "The **‘Tasks Ready’** endpoint is designed to provide you with the list of completed tasks, which haven’t been collected yet.",
  "You can send up to 100 tasks per POST call and retrieve completed results later by task id or via postback/pingback.",
  "Your account is not charged for using this endpoint.",
  "Note that Google Ads Keywords Data API is based on the latest version of the [Google Ads API](https://developers.google.com/google-ads/api/docs/start) that has replaced legacy Google AdWords API.",
];

/** Cost notes by exact "METHOD path" key (from the spec's own pricing text). */
export const COST_NOTES_EXACT: ReadonlyMap<string, string> = new Map([
  ["POST /agentmail/inboxes/{inbox_id}/messages/send", "Sends a REAL email from the AgentMail inbox to real recipients — irreversible external communication."],
  ["POST /agentmail/inboxes/{inbox_id}/messages/{message_id}/reply", "Sends a REAL reply email to the original sender."],
  ["POST /agentmail/inboxes/{inbox_id}/messages/{message_id}/reply-all", "Sends a REAL reply email to ALL recipients on the thread."],
  ["POST /agentmail/inboxes/{inbox_id}/messages/{message_id}/forward", "Forwards a REAL email to new recipients."],
  ["POST /agentmail/inboxes/{inbox_id}/drafts/{draft_id}/send", "Sends an existing draft as a REAL email to its recipients."],
  ["POST /twitter/post_twitter", "Publishes or edits a REAL tweet on the linked X account — publicly visible, requires tweet.write OAuth scope."],
  ["POST /twitter/like_twitter", "Likes a tweet from the linked REAL X account (visible public action)."],
  ["POST /twitter/unlike_twitter", "Removes a like from the linked REAL X account."],
  ["POST /twitter/follow_twitter", "Follows a user from the linked REAL X account (visible public action)."],
  ["POST /twitter/unfollow_twitter", "Unfollows a user from the linked REAL X account."],
  ["POST /apollo/people/match", "Consumes Apollo credits per enrichment; reveal_personal_emails / reveal_phone_number reveal personal PII and consume additional credits (phone reveal requires webhook_url)."],
  ["POST /apollo/people/bulk_match", "Consumes Apollo credits for up to 10 people per call; supports reveal_personal_emails / reveal_phone_number (extra credits, exposes PII)."],
  ["GET /apollo/organizations/enrich", "GET that consumes Apollo credits per call (company enrichment) as part of your Apollo pricing plan."],
  ["POST /apollo/organizations/bulk_enrich", "Consumes Apollo credits for up to 10 companies per call."],
  ["POST /apollo/mixed_companies/search", "Consumes Apollo credits as part of your Apollo pricing plan."],
  ["GET /apollo/organizations/{organization_id}/job_postings", "GET that consumes Apollo credits per call."],
  ["GET /apollo/organizations/{id}", "GET that potentially consumes your account's Apollo credits."],
  ["POST /apollo/news_articles/search", "Consumes Apollo credits as part of your Apollo pricing plan."],
  ["POST /apollo/emailer_campaigns/{sequence_id}/add_contact_ids", "Adds contacts to an Apollo outreach sequence — can trigger REAL outreach emails to real people."],
  ["POST /apollo/emailer_campaigns/{sequence_id}/approve", "Activates an Apollo sequence — starts sending REAL outreach emails to enrolled contacts."],
  ["POST /images/generations", "Paid image generation: each of the n images is billed separately at the per-image rate."],
  ["POST /chat/completions", "Paid image generation via chat route; seedream-4-5-251128 billed at $0.036 per request."],
  ["POST /exa/search", "Billed flat $0.08 per successful Exa request."],
  ["POST /exa/contents", "Billed flat $0.08 per successful request; cache miss triggers a live crawl."],
  ["POST /exa/answer", "Billed flat $0.08 per successful request."],
  ["POST /exa/agent/runs", "Async research agent run billed flat $0.10 per run (settled cost reported in micro-USD)."],
  ["POST /firecrawl/scrape", "Billed 1 Firecrawl credit per page scraped."],
  ["POST /firecrawl/search", "Billed ~2 Firecrawl credits per 10 results (ceil(limit/10)*2)."],
  ["POST /firecrawl/map", "Billed 1 Firecrawl credit per discovered link/page; limit can be up to 100000 — cost scales with discoveries."],
  ["POST /firecrawl/parse", "Billed 1 Firecrawl credit per parse."],
  ["POST /firecrawl/crawl", "Billed 1 Firecrawl credit per page crawled, up to 1000 pages per job — total cost scales with pages actually processed."],
  ["POST /firecrawl/batch-scrape", "Billed 1 Firecrawl credit per page scraped, up to 1000 URLs per job — cost scales with pages processed."],
  ["POST /tavily/search", "Consumes Tavily credits per request (usage reported when include_usage=true)."],
  ["POST /tavily/extract", "Consumes Tavily credits per request (usage reported when include_usage=true)."],
  ["POST /tavily/crawl", "Consumes Tavily credits per request; crawl scope multiplies usage."],
  ["POST /tavily/map", "Consumes Tavily credits per request (usage reported when include_usage=true)."],
  ["GET /instagram/post", "With download_media=true, downloads media to permanent Supabase storage and costs 10 credits if media is found (1 credit otherwise)."],
  ["POST /waveinflu/email-lookup", "Consumes WaveInflu credits per lookup; response reports credits consumed and remaining quota."],
  ["POST /perplexity/sonar", "Perplexity Sonar billed $0.012 per request."],
  ["POST /perplexity/sonar-pro", "Perplexity Sonar Pro billed $0.012 per request; search_context affects per-request cost."],
  ["POST /perplexity/sonar-reasoning-pro", "Perplexity Sonar Reasoning Pro billed $0.012 per request; search_context affects per-request cost."],
  ["POST /perplexity/sonar-deep-research", "Perplexity Deep Research billed $0.012 per request; exhaustive research runs take significantly longer and consume more search context."],
]);

/**
 * DataForSEO billing: every paid endpoint is a POST (live requests and
 * task_post submissions). GETs, task-result collectors and the on_page
 * result-retrieval POSTs below are free — the crawl was paid at task_post.
 */
const DATAFORSEO_NOTE =
  "DataForSEO metered endpoint — billed per request (live) or per task set (task_post; collect results free via task_get).";
const DATAFORSEO_COLLECTOR = /task_get|tasks_ready|id_list|\/errors/;
const DATAFORSEO_FREE_POSTS: ReadonlySet<string> = new Set([
  "POST /dataforseo/on_page/content_parsing",
  "POST /dataforseo/on_page/duplicate_content",
  "POST /dataforseo/on_page/duplicate_tags",
  "POST /dataforseo/on_page/force_stop",
  "POST /dataforseo/on_page/keyword_density",
  "POST /dataforseo/on_page/links",
  "POST /dataforseo/on_page/microdata",
  "POST /dataforseo/on_page/non_indexable",
  "POST /dataforseo/on_page/page_screenshot",
  "POST /dataforseo/on_page/raw_html",
  "POST /dataforseo/on_page/resources",
  "POST /dataforseo/on_page/uncrawlable_resources",
  "POST /dataforseo/on_page/waterfall",
]);

/**
 * GET operations that mutate real-world state. (Credit consumption alone is a
 * cost note, not a write — see COST_NOTES_EXACT for the Apollo/Instagram GETs.)
 */
export const GET_WRITE_OVERRIDES: ReadonlyMap<string, string> = new Map([]);

export function costNoteFor(
  method: string,
  path: string,
  description = "",
): string | undefined {
  const key = `${method} ${path}`;
  const exact = COST_NOTES_EXACT.get(key);
  if (exact) return exact;
  if (
    path.startsWith("/dataforseo/") &&
    method === "POST" &&
    !DATAFORSEO_COLLECTOR.test(path) &&
    !DATAFORSEO_FREE_POSTS.has(key) &&
    !description.includes("not charged")
  ) {
    return DATAFORSEO_NOTE;
  }
  return undefined;
}

export function remapTag(path: string, tag: string): string {
  for (const rule of TAG_REMAP) {
    if (path.startsWith(rule.prefix)) return rule.tag;
  }
  return tag;
}
