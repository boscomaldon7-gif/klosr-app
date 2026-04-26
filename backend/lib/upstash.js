// Upstash Redis REST client — thin wrapper for telemetry + admin queries.
//
// Why Upstash over Postgres for this use case:
//   - Counters / sorted sets / sets are native (perfect for DAU/WAU/events)
//   - REST API works inside Vercel serverless with zero connection pooling
//   - Free tier: 10k commands/day + 256MB storage, plenty for early users
//   - One env pair to configure: UPSTASH_REDIS_REST_URL + _TOKEN
//
// All functions fail soft — if Upstash is unconfigured or errors out, we
// return null / false / [] rather than throwing. Telemetry should NEVER
// break the primary flow.

function hasUpstash() {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function run(command) {
  if (!hasUpstash()) return null;
  try {
    const res = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.warn("[upstash] non-ok", res.status, t.slice(0, 160));
      return null;
    }
    const data = await res.json().catch(() => null);
    return data?.result ?? null;
  } catch (e) {
    console.warn("[upstash] exception", e && e.message);
    return null;
  }
}

// Batched pipeline — fewer round-trips when writing multiple keys at once.
async function pipe(commands) {
  if (!hasUpstash() || !Array.isArray(commands) || commands.length === 0) return null;
  try {
    const res = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/pipeline`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

// ───── High-level helpers ─────────────────────────────────────────

export async function logEvent({ installId, event, metadata, userMeta }) {
  if (!hasUpstash() || !installId || !event) return false;
  const ts = Date.now();
  const date = new Date(ts).toISOString().slice(0, 10);   // YYYY-MM-DD
  const record = {
    installId,
    event: String(event).slice(0, 60),
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    ts,
  };
  const json = JSON.stringify(record);

  // Fan out:
  //   - LPUSH kl:events (capped LPUSH + LTRIM keeps memory bounded)
  //   - SADD kl:daily:YYYY-MM-DD installId (DAU set)
  //   - HINCRBY kl:counters:{event} YYYY-MM-DD 1 (per-feature per-day)
  //   - HSET kl:user:{installId} lastSeen/lastEvent/eventCount — MERGE user meta
  const pipeline = [
    ["LPUSH", "kl:events", json],
    ["LTRIM", "kl:events", "0", "9999"],          // keep last 10k
    ["SADD", `kl:daily:${date}`, installId],
    ["EXPIRE", `kl:daily:${date}`, "5184000"],    // 60-day retention on daily sets
    ["HINCRBY", `kl:counters:${record.event}`, date, "1"],
    ["SADD", "kl:users:all", installId],
    ["HSET", `kl:user:${installId}`,
      "lastSeen", String(ts),
      "lastEvent", record.event,
    ],
    ["HINCRBY", `kl:user:${installId}`, "eventCount", "1"],
  ];

  // If user identity metadata was passed (email, company, role, ICP), persist
  // it on the user hash. These get overwritten on every event — always latest.
  if (userMeta && typeof userMeta === "object") {
    const userFields = [];
    const copy = (k) => {
      const v = userMeta[k];
      if (typeof v === "string" && v.trim()) userFields.push(k, v.trim().slice(0, 400));
    };
    copy("email");
    copy("yourName");
    copy("yourRole");
    copy("companyName");
    copy("icp");
    copy("linkedinUrl");
    copy("firstSeen");
    copy("language");
    if (userFields.length > 0) {
      pipeline.push(["HSET", `kl:user:${installId}`, ...userFields]);
    }
  }

  await pipe(pipeline);
  return true;
}

// ───── Admin queries ─────────────────────────────────────────────

export async function getOverviewStats() {
  if (!hasUpstash()) return null;

  const today = new Date().toISOString().slice(0, 10);
  const past7 = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() - i * 86400000);
    return d.toISOString().slice(0, 10);
  });

  // Pipeline: totals + daily sets
  const pipeline = [
    ["SCARD", "kl:users:all"],
    ["LLEN", "kl:events"],
    ...past7.map(d => ["SCARD", `kl:daily:${d}`]),
  ];
  const result = await pipe(pipeline);
  if (!result || !Array.isArray(result)) return null;

  const totalUsers = result[0]?.result || 0;
  const totalEvents = result[1]?.result || 0;
  const dailyActive = past7.map((date, i) => ({
    date,
    count: result[2 + i]?.result || 0,
  }));
  const dau = dailyActive[0]?.count || 0;
  const wau = dailyActive.reduce((a, b) => a + b.count, 0);   // over-counts repeats but fine for a rough signal

  return { totalUsers, totalEvents, dau, wau, dailyActive };
}

export async function getFeatureCounters(events = [], days = 7) {
  if (!hasUpstash() || !events.length) return {};
  const dates = Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.now() - i * 86400000);
    return d.toISOString().slice(0, 10);
  });

  const pipeline = events.flatMap(ev => [
    ["HMGET", `kl:counters:${ev}`, ...dates],
  ]);
  const result = await pipe(pipeline);
  const out = {};
  if (!result) return out;
  events.forEach((ev, i) => {
    const vals = result[i]?.result || [];
    const total = vals.reduce((a, v) => a + (parseInt(v, 10) || 0), 0);
    out[ev] = total;
  });
  return out;
}

export async function getAllUsers(limit = 200) {
  if (!hasUpstash()) return [];
  const ids = (await run(["SMEMBERS", "kl:users:all"])) || [];
  if (!ids.length) return [];
  const pipeline = ids.slice(0, limit).map(id => ["HGETALL", `kl:user:${id}`]);
  const result = await pipe(pipeline);
  if (!result) return [];
  return ids.slice(0, limit).map((id, i) => {
    const hash = result[i]?.result || [];
    // Upstash returns hash as [field, value, field, value, ...] array
    const obj = {};
    for (let j = 0; j < hash.length; j += 2) {
      obj[hash[j]] = hash[j + 1];
    }
    return { installId: id, ...obj };
  });
}

export async function getRecentEvents(n = 100) {
  if (!hasUpstash()) return [];
  const raw = (await run(["LRANGE", "kl:events", "0", String(n - 1)])) || [];
  return raw.map(r => {
    try { return JSON.parse(r); } catch { return null; }
  }).filter(Boolean);
}

export { hasUpstash };
