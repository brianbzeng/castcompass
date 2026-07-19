#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const JOB_ID_PATTERN = /^airj_[a-f0-9]{32}$/;

export function buildReplayPlan(jobId) {
  if (!JOB_ID_PATTERN.test(jobId ?? "")) {
    throw new Error("--job-id must be one opaque airj_ queue job ID");
  }
  return {
    schemaVersion: "castingcompass.ai-review-queue-replay-plan/1.0.0",
    jobId,
    requiredCurrentState: "needs_attention",
    changesProviderState: false,
    sql: `UPDATE ai_review_jobs
SET state = 'pending', attempts = 0,
  available_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  lease_expires_at = NULL, last_error_code = NULL,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), completed_at = NULL
WHERE id = '${jobId}' AND state = 'needs_attention'
  AND EXISTS (
    SELECT 1 FROM trips
    WHERE trips.id = ai_review_jobs.trip_id
      AND trips.status = 'completed'
      AND (trips.ai_review_status IS NULL
        OR trips.ai_review_status = 'queued'
        OR trips.ai_review_status = 'retry'
        OR trips.ai_review_status = 'needs_attention')
  )
RETURNING id, state, attempts, available_at;`,
  acceptance: "Exactly one opaque job row returned; the scheduled dispatcher performs any later enqueue.",
  warning: "This plan does not execute SQL. Run only through approved least-privilege D1 operator access and preserve the redacted receipt.",
  rollback: "No provider call or queue publish occurs in this statement; restore needs_attention before the dispatcher runs if replay was unintended.",
  };
}

function parseArguments(args) {
  if (args[0] !== "plan-replay") throw new Error("Usage: plan-replay --job-id airj_<32 lowercase hex>");
  if (args[1] !== "--job-id" || args.length !== 3) {
    throw new Error("Usage: plan-replay --job-id airj_<32 lowercase hex>");
  }
  return { jobId: args[2] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(buildReplayPlan(parseArguments(process.argv.slice(2)).jobId), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
