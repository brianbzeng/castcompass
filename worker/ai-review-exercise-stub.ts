interface ExerciseStubEnv {
  SECURITY_EXERCISE_ID?: string;
  CF_VERSION_METADATA?: { id?: string };
}

const EXERCISE_ID_PATTERN = /^sec_[a-f0-9]{32}$/;
const WORKER_VERSION_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const EXPECTED_HOST = "ai-review-stub.invalid";
const EXPECTED_PATH = "/v1/chat/completions";
const EXPECTED_MODEL = "castingcompass-isolated-stub-v1";
const EXPECTED_CONTRACT = "castingcompass.ai-review-exercise-provider/1.0.0";
const MAXIMUM_REQUEST_BYTES = 64 * 1024;

const worker = {
  async fetch(request: Request, env: ExerciseStubEnv): Promise<Response> {
    const exerciseId = validExerciseId(env.SECURITY_EXERCISE_ID);
    const workerVersion = validWorkerVersion(env.CF_VERSION_METADATA?.id);
    if (!exerciseId || !workerVersion) return refusal(503, "stub_not_ready");

    const url = new URL(request.url);
    if (request.method !== "POST" || url.protocol !== "https:" || url.hostname !== EXPECTED_HOST
      || url.port || url.pathname !== EXPECTED_PATH || url.search || url.hash) {
      return refusal(404, "not_found");
    }
    if (request.headers.has("api-key") || request.headers.has("authorization")
      || request.headers.get("X-CastingCompass-Exercise-Contract") !== EXPECTED_CONTRACT
      || request.headers.get("X-CastingCompass-Exercise-Id") !== exerciseId
      || request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      return refusal(403, "exercise_identity_rejected");
    }

    const payload = await readBoundedJson(request, MAXIMUM_REQUEST_BYTES);
    if (!validRequestEnvelope(payload)) return refusal(400, "request_contract_rejected");

    const review = {
      quality_score: 0,
      flags: ["exercise_stub_output"],
      summary: "Synthetic isolated-staging exercise output; not a real model review.",
      needs_human_review: true,
      gear_analysis: {
        rod: { brand: null, series: null, model: null, confidence: "low" },
        reel: { brand: null, series: null, model: null, confidence: "low" },
        lure: { brand: null, series: null, model: null, confidence: "low" },
        setup_tags: [],
        compatibility_flags: ["exercise_stub_output"],
        technique_match_summary: null,
      },
      discussion: {
        publish: false,
        summary: "",
        gear_summary: null,
        technique_tags: [],
      },
    };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(review) } }] }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-CastingCompass-Exercise-Provider-Version": workerVersion,
      },
    });
  },
};

async function readBoundedJson(request: Request, maximumBytes: number): Promise<unknown> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maximumBytes) {
        void reader.cancel("request too large").catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return null;
  }
}

function validRequestEnvelope(value: unknown) {
  if (!exactRecord(value, ["model", "max_completion_tokens", "response_format", "thinking", "messages"])) {
    return false;
  }
  if (value.model !== EXPECTED_MODEL || value.max_completion_tokens !== 950
    || !exactRecord(value.response_format, ["type"]) || value.response_format.type !== "json_object"
    || !exactRecord(value.thinking, ["type"]) || value.thinking.type !== "disabled"
    || !Array.isArray(value.messages) || value.messages.length !== 2) return false;
  const [system, user] = value.messages;
  if (!exactRecord(system, ["role", "content"]) || system.role !== "system"
    || typeof system.content !== "string" || system.content.length < 100 || system.content.length > 16_384
    || !exactRecord(user, ["role", "content"]) || user.role !== "user"
    || typeof user.content !== "string" || user.content.length < 2 || user.content.length > 32_768) return false;
  try {
    const trip = JSON.parse(user.content) as unknown;
    return Boolean(trip && typeof trip === "object" && !Array.isArray(trip));
  } catch {
    return false;
  }
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validExerciseId(value: unknown) {
  return typeof value === "string" && EXERCISE_ID_PATTERN.test(value) ? value : null;
}

function validWorkerVersion(value: unknown) {
  return typeof value === "string" && WORKER_VERSION_PATTERN.test(value) ? value : null;
}

function refusal(status: number, code: string) {
  return new Response(JSON.stringify({ error: { code } }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export default worker;
