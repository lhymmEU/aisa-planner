/**
 * CI helper: compare the live spec's sha256 against the bundled catalog's
 * stamp and expose `drifted`, `live_sha`, `stamped_sha` as step outputs.
 */
import { createHash } from "node:crypto";
import { readFileSync, appendFileSync } from "node:fs";
import { decodeCatalog } from "../src/catalog-format.js";

const res = await fetch("https://aisa.one/openapi.yaml");
if (!res.ok) throw new Error(`Failed to fetch live spec: HTTP ${res.status}`);
const live = Buffer.from(await res.arrayBuffer());
const liveSha = createHash("sha256").update(live).digest("hex");

const catalog = decodeCatalog(readFileSync("catalogs/aisa-jina-v3.catalog"));
const rawStamped = String(catalog.header.specSha256 ?? "");
// Guard the value before it becomes a step output other steps consume.
const stamped = /^[0-9a-f]{64}$/.test(rawStamped) ? rawStamped : "invalid-stamp";
const drifted = liveSha !== stamped;

console.log("live   ", liveSha);
console.log("stamped", stamped, "(fetched", String(catalog.header.specFetchedAt).slice(0, 40) + ")");

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `drifted=${drifted}\nlive_sha=${liveSha}\nstamped_sha=${stamped}\n`,
  );
}
