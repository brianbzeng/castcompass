import type { CuratedSite, D1DatabaseLike, TripRow } from "./trips";

interface DiscussionEnv {
  DB?: D1DatabaseLike;
}

export interface PublicDiscussionDraft {
  publish: boolean;
  summary: string;
  gearSummary?: string | null;
  techniqueTags?: string[];
}

const initializedDatabases = new WeakMap<object, Promise<void>>();

const CREATE_DISCUSSIONS_SQL = `CREATE TABLE IF NOT EXISTS site_discussion_posts (
  id TEXT PRIMARY KEY NOT NULL,
  trip_id TEXT NOT NULL UNIQUE,
  site_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  gear_summary TEXT,
  technique_tags_json TEXT,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  review_model TEXT,
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
)`;

async function initialize(db: D1DatabaseLike) {
  let pending = initializedDatabases.get(db as object);
  if (!pending) {
    pending = db.batch([
      db.prepare(CREATE_DISCUSSIONS_SQL),
      db.prepare("CREATE INDEX IF NOT EXISTS site_discussion_posts_site_time_idx ON site_discussion_posts (site_id, observed_at DESC)"),
    ]).then(() => undefined).catch((error) => {
      initializedDatabases.delete(db as object);
      throw error;
    });
    initializedDatabases.set(db as object, pending);
  }
  await pending;
}

export async function handleDiscussionRequest(
  request: Request,
  env: DiscussionEnv,
  curatedSites: readonly CuratedSite[],
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/discussions\/([a-z0-9-]+)$/);
  if (!match) return null;
  if (request.method !== "GET") {
    return jsonResponse({ error: { code: "method_not_allowed", message: "Use GET for this endpoint." } }, 405, { Allow: "GET" });
  }
  if (!env.DB) return jsonResponse({ posts: [] });
  const siteId = match[1];
  if (!curatedSites.some((site) => site.id === siteId)) {
    return jsonResponse({ error: { code: "invalid_site", message: "Choose a current CastCompass location." } }, 404);
  }
  await initialize(env.DB);
  const rows = await env.DB.prepare(`SELECT id, site_id, summary, gear_summary, technique_tags_json,
      observed_at, created_at
    FROM site_discussion_posts
    WHERE site_id = ?
    ORDER BY observed_at DESC
    LIMIT 12`)
    .bind(siteId)
    .all<DiscussionRow>();
  return jsonResponse({
    posts: (rows.results ?? []).map((row) => ({
      id: row.id,
      siteId: row.site_id,
      summary: row.summary,
      gearSummary: row.gear_summary,
      techniqueTags: safeTags(row.technique_tags_json),
      observedAt: row.observed_at,
      postedAt: row.created_at,
    })),
  }, 200, { "Cache-Control": "public, max-age=10, s-maxage=20" });
}

export async function publishTripDiscussion(
  env: DiscussionEnv,
  trip: TripRow,
  draft: PublicDiscussionDraft,
  model: string,
) {
  if (!env.DB) return;
  await initialize(env.DB);
  if (!draft.publish || !trip.notes?.trim()) {
    await env.DB.prepare("DELETE FROM site_discussion_posts WHERE trip_id = ?").bind(trip.id).run();
    return;
  }
  const summary = sanitizePublicText(draft.summary, 420);
  if (!summary) return;
  const gearSummary = sanitizePublicText(draft.gearSummary ?? "", 220) || null;
  const techniqueTags = (draft.techniqueTags ?? [])
    .filter((tag) => typeof tag === "string")
    .map((tag) => sanitizePublicText(tag, 42))
    .filter(Boolean)
    .slice(0, 6);
  const timestamp = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO site_discussion_posts
      (id, trip_id, site_id, summary, gear_summary, technique_tags_json, observed_at, created_at, updated_at, review_model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(trip_id) DO UPDATE SET
      site_id = excluded.site_id,
      summary = excluded.summary,
      gear_summary = excluded.gear_summary,
      technique_tags_json = excluded.technique_tags_json,
      observed_at = excluded.observed_at,
      updated_at = excluded.updated_at,
      review_model = excluded.review_model`)
    .bind(
      `discussion_${crypto.randomUUID()}`,
      trip.id,
      trip.site_id,
      summary,
      gearSummary,
      JSON.stringify(techniqueTags),
      trip.ended_at ?? trip.started_at,
      timestamp,
      timestamp,
      model,
    )
    .run();
}

interface DiscussionRow {
  id: string;
  site_id: string;
  summary: string;
  gear_summary: string | null;
  technique_tags_json: string | null;
  observed_at: string;
  created_at: string;
}

function safeTags(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string").slice(0, 6) : [];
  } catch {
    return [];
  }
}

function sanitizePublicText(value: string, maximum: number) {
  return value
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "")
    .replace(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function jsonResponse(body: unknown, status = 200, extraHeaders?: HeadersInit) {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}
