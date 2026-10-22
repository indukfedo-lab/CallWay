const QLOO_BASE_URL = "https://hackathon.api.qloo.com";
const MAX_INTERESTS = 5;
const MAX_RECOMMENDATIONS = 8;

const ENTITY_TYPES = [
  "urn:entity:artist",
  "urn:entity:book",
  "urn:entity:brand",
  "urn:entity:destination",
  "urn:entity:movie",
  "urn:entity:person",
  "urn:entity:place",
  "urn:entity:podcast",
  "urn:entity:tv_show",
  "urn:entity:videogame",
] as const;

type EntityType = (typeof ENTITY_TYPES)[number];

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type QlooEntity = {
  entity_id?: string;
  id?: string;
  name?: string;
  type?: string;
  types?: string[];
  properties?: Record<string, unknown>;
  query?: Record<string, unknown>;
};

type Seed = {
  id: string;
  name: string;
  type: EntityType | null;
};

type Contribution = {
  id: string;
  name: string;
  score?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getEntities(payload: unknown): QlooEntity[] {
  if (!isRecord(payload)) return [];

  const results = payload.results;

  // Format aktual Qloo: { results: [...] }
  if (Array.isArray(results)) {
    return results.filter(isRecord) as QlooEntity[];
  }

  // Fallback jika respons menggunakan format bersarang.
  if (isRecord(results) && Array.isArray(results.entities)) {
    return results.entities.filter(isRecord) as QlooEntity[];
  }

  return [];
}

function getEntityId(entity: QlooEntity): string | null {
  return entity.entity_id ?? entity.id ?? null;
}

function getEntityType(entity: QlooEntity): EntityType | null {
  const type = entity.type ?? entity.types?.[0];

  return typeof type === "string" && ENTITY_TYPES.includes(type as EntityType)
    ? (type as EntityType)
    : null;
}

function extractInterestCandidates(text: string): string[] {
  const patterns = [
    /\b(?:i|we)\s+(?:(?:really|absolutely)\s+)?(?:love|like|enjoy|adore|prefer|am into|are into|am a fan of|are a fan of)\s+(.+?)(?=[.!?\n]|$)/i,
    /\bi['’]m\s+(?:really\s+)?(?:into|a fan of)\s+(.+?)(?=[.!?\n]|$)/i,
    /\bmy\s+(?:favorite|favourite)(?:\s+\w+)?\s+(?:is|are|include|includes)\s+(.+?)(?=[.!?\n]|$)/i,
    /\b(?:similar to|inspired by|based on|for fans of|fan of)\s+(.+?)(?=[.!?\n]|$)/i,
  ];

  const generic = new Set([
    "music",
    "movies",
    "films",
    "books",
    "fashion",
    "travel",
    "food",
    "restaurants",
    "recommendations",
    "anything",
    "everything",
  ]);

  const candidates: string[] = [];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;

    const clause = match[1].trim();

    // Pisahkan daftar dengan koma, termasuk "A, B, and C".
    const parts = clause.includes(",") ? clause.split(",") : [clause];

    for (const part of parts) {
      const candidate = part
        .trim()
        .replace(/^(?:and|or|also)\s+/i, "")
        .replace(/^["'“”]+|["'“”]+$/g, "")
        .trim();

      const normalized = normalizeText(candidate);

      if (
        candidate.length < 2 ||
        candidate.length > 100 ||
        generic.has(normalized)
      ) {
        continue;
      }

      if (
        !candidates.some((existing) => normalizeText(existing) === normalized)
      ) {
        candidates.push(candidate);
      }
    }
  }

  return candidates;
}

function collectInterestQueries(
  prompt: string,
  messages: ChatMessage[],
): string[] {
  const previousUserPrompts = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .reverse();

  const result: string[] = [];

  for (const text of [prompt, ...previousUserPrompts]) {
    for (const candidate of extractInterestCandidates(text)) {
      if (
        !result.some(
          (existing) => normalizeText(existing) === normalizeText(candidate),
        )
      ) {
        result.push(candidate);
      }

      if (result.length >= MAX_INTERESTS) return result;
    }
  }

  return result;
}

function inferTargetType(text: string): EntityType | null {
  const prompt = text.toLowerCase();

  if (
    /\b(restaurants?|cafes?|cafés|dining|places to eat|food spots?)\b/.test(
      prompt,
    )
  ) {
    return "urn:entity:place";
  }

  if (/\b(movies?|films?|cinema)\b/.test(prompt)) {
    return "urn:entity:movie";
  }

  if (/\b(tv shows?|series|television)\b/.test(prompt)) {
    return "urn:entity:tv_show";
  }

  if (/\b(books?|novels?|reading)\b/.test(prompt)) {
    return "urn:entity:book";
  }

  if (/\b(fashion|streetwear|clothing|outfits?|brands?)\b/.test(prompt)) {
    return "urn:entity:brand";
  }

  if (
    /\b(destinations?|travel|vacations?|trips?|places to visit)\b/.test(prompt)
  ) {
    return "urn:entity:destination";
  }

  if (/\b(podcasts?)\b/.test(prompt)) {
    return "urn:entity:podcast";
  }

  if (/\b(video games?|gaming)\b/.test(prompt)) {
    return "urn:entity:videogame";
  }

  if (
    /\b(artists?|singers?|musicians?|bands?|music|songs?|tracks?)\b/.test(
      prompt,
    )
  ) {
    return "urn:entity:artist";
  }

  return null;
}

function getTypeLabel(type: EntityType): string {
  const labels: Record<EntityType, string> = {
    "urn:entity:artist": "music and artists",
    "urn:entity:book": "books",
    "urn:entity:brand": "brands and fashion",
    "urn:entity:destination": "travel destinations",
    "urn:entity:movie": "movies",
    "urn:entity:person": "people",
    "urn:entity:place": "places",
    "urn:entity:podcast": "podcasts",
    "urn:entity:tv_show": "TV shows",
    "urn:entity:videogame": "video games",
  };

  return labels[type];
}

async function resolveEntity(
  query: string,
  apiKey: string,
): Promise<QlooEntity | null> {
  const url = new URL(`${QLOO_BASE_URL}/search`);

  url.searchParams.set("query", query);
  url.searchParams.set("take", "5");

  const response = await fetch(url, {
    headers: { "X-Api-Key": apiKey },
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });

  if (response.status === 404) return null;

  if (!response.ok) {
    throw new Error(`Qloo Search failed: ${response.status}`);
  }

  const data: unknown = await response.json();

  const entities = getEntities(data).filter(
    (entity) => typeof entity.name === "string" && Boolean(getEntityId(entity)),
  );

  if (entities.length === 0) {
    console.warn("Qloo Search returned no parsed entities:", {
      query,
      responseKeys: isRecord(data) ? Object.keys(data) : [],
      resultsIsArray: isRecord(data) && Array.isArray(data.results),
      resultsKeys:
        isRecord(data) && isRecord(data.results)
          ? Object.keys(data.results)
          : [],
    });
  }

  const exactMatch = entities.find(
    (entity) => normalizeText(entity.name!) === normalizeText(query),
  );

  // Kalau hasilnya ambigu, jangan mengklaim kecocokan persis.
  // Qloo mengembalikan kandidat teratas jika exact match tidak ada.
  return exactMatch ?? entities[0] ?? null;
}

function getImageUrl(entity: QlooEntity): string | null {
  const properties = entity.properties;
  if (!properties) return null;

  const image = properties.image;

  const possibleUrls: unknown[] = [
    properties.image_url,
    properties.imageUrl,
    typeof image === "string" ? image : null,
    isRecord(image) ? image.url : null,
    isRecord(image) ? image.src : null,
    isRecord(image) ? image.thumbnail_url : null,
  ];

  for (const value of possibleUrls) {
    if (typeof value === "string" && /^https?:\/\//i.test(value)) {
      return value;
    }
  }

  return null;
}

function getShortDescription(entity: QlooEntity): string | null {
  const properties = entity.properties;

  const possibleDescriptions: unknown[] = [
    properties?.short_description,
    properties?.description,
    properties?.tagline,
    properties?.overview,
  ];

  for (const value of possibleDescriptions) {
    if (typeof value !== "string") continue;

    const cleaned = value
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleaned) continue;

    // Batasi deskripsi agar kartu tetap ringkas.
    return cleaned.length > 180
      ? `${cleaned.slice(0, 177).trimEnd()}…`
      : cleaned;
  }

  return null;
}

function getNestedScore(value: unknown, depth = 0): number | undefined {
  if (depth > 6 || !isRecord(value)) return undefined;

  const scoreKeys = new Set([
    "score",
    "normalized_score",
    "normalizedscore",
    "contribution",
    "influence",
    "affinity",
  ]);

  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();

    if (
      scoreKeys.has(normalizedKey) &&
      typeof item === "number" &&
      Number.isFinite(item) &&
      item >= 0 &&
      item <= 1
    ) {
      return item;
    }
  }

  for (const item of Object.values(value)) {
    const score = getNestedScore(item, depth + 1);
    if (score !== undefined) return score;
  }

  return undefined;
}

// Membaca metadata kontribusi tanpa mengasumsikan satu struktur
// internal tertentu untuk seluruh versi response Qloo.
function extractContributions(
  rawExplainability: unknown,
  seeds: Seed[],
): Contribution[] {
  const found = new Map<string, Contribution>();
  const scoreKeys = new Set([
    "score",
    "normalized_score",
    "normalizedscore",
    "contribution",
    "influence",
    "affinity",
  ]);
  const nameKeys = new Set([
    "name",
    "entity_name",
    "input_entity",
    "entity",
    "label",
    "title",
  ]);

  function add(seed: Seed, score?: number) {
    const existing = found.get(seed.id);

    found.set(seed.id, {
      id: seed.id,
      name: seed.name,
      score: score ?? existing?.score,
    });
  }

  function walk(value: unknown, depth = 0) {
    if (depth > 10) return;

    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }

    if (!isRecord(value)) return;

    const entries = Object.entries(value);

    // Bentuk umum: { entity_id, name, score }.
    for (const seed of seeds) {
      const matched = entries.some(([key, item]) => {
        if (typeof item !== "string") return false;

        if (item === seed.id) return true;

        return (
          nameKeys.has(key.toLowerCase()) &&
          normalizeText(item) === normalizeText(seed.name)
        );
      });

      if (matched) {
        const scoreEntry = entries.find(
          ([key, item]) =>
            scoreKeys.has(key.toLowerCase()) &&
            typeof item === "number" &&
            Number.isFinite(item) &&
            item >= 0 &&
            item <= 1,
        );

        add(
          seed,
          typeof scoreEntry?.[1] === "number" ? scoreEntry[1] : undefined,
        );
      }
    }

    // Bentuk alternatif: { "<entity-id>": 0.24 }.
    for (const [key, item] of entries) {
      const seed = seeds.find(
        (candidate) =>
          key === candidate.id ||
          normalizeText(key) === normalizeText(candidate.name),
      );

      if (seed) {
        if (
          typeof item === "number" &&
          Number.isFinite(item) &&
          item >= 0 &&
          item <= 1
        ) {
          add(seed, item);
        } else {
          add(seed, getNestedScore(item));
        }
      }

      walk(item, depth + 1);
    }
  }

  walk(rawExplainability);

  return [...found.values()];
}

function getItemExplainability(entity: QlooEntity): unknown {
  const query = entity.query;

  if (isRecord(query) && "explainability" in query) {
    return query.explainability;
  }

  return undefined;
}

function getRootExplainability(payload: unknown): unknown {
  if (!isRecord(payload) || !isRecord(payload.query)) {
    return undefined;
  }

  return payload.query.explainability;
}

function getExplainabilityWarning(value: unknown): string | null {
  if (!isRecord(value)) return null;

  return typeof value.warning === "string" ? value.warning : null;
}

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json({ message: "Invalid JSON request." }, { status: 400 });
  }

  if (!isRecord(body) || typeof body.prompt !== "string") {
    return Response.json(
      { message: "A valid prompt is required." },
      { status: 400 },
    );
  }

  const prompt = body.prompt.trim();

  if (!prompt || prompt.length > 1000) {
    return Response.json(
      { message: "Prompt must contain between 1 and 1000 characters." },
      { status: 400 },
    );
  }

  const apiKey = process.env.QLOO_API_KEY;

  if (!apiKey) {
    return Response.json(
      { message: "Qloo API key is not configured on the server." },
      { status: 500 },
    );
  }

  const messages: ChatMessage[] = Array.isArray(body.messages)
    ? body.messages
        .filter(
          (item): item is ChatMessage =>
            isRecord(item) &&
            (item.role === "user" || item.role === "assistant") &&
            typeof item.content === "string",
        )
        .slice(-20)
    : [];

  try {
    // 1. Collect up to five references from this prompt and prior user turns.
    const queries = collectInterestQueries(prompt, messages);

    // Tes ekstraksi lokal tanpa memanggil Qloo.
    if (
      process.env.NODE_ENV !== "production" &&
      body.debugExtractOnly === true
    ) {
      return Response.json({
        mode: "extraction-only",
        queries,
      });
    }

    if (queries.length === 0) {
      return Response.json({
        message:
          "Tell me a few artists, films, books, brands, or places you like. " +
          "Then tell me what category you'd like recommendations for.",
        recommendations: [],
      });
    }

    // 2. Resolve all references in parallel.
    const resolved = await Promise.all(
      queries.map((query) => resolveEntity(query, apiKey)),
    );

    const seenIds = new Set<string>();

    const seeds: Seed[] = resolved
      .filter((entity): entity is QlooEntity => entity !== null)
      .filter((entity) => {
        const id = getEntityId(entity);
        if (!id || seenIds.has(id)) return false;

        seenIds.add(id);
        return true;
      })
      .map((entity) => ({
        id: getEntityId(entity)!,
        name: entity.name!,
        type: getEntityType(entity),
      }))
      .slice(0, MAX_INTERESTS);

    if (seeds.length === 0) {
      return Response.json({
        message:
          "I couldn't identify those references in Qloo. " +
          "Try using the full names of recognizable artists, movies, books, or brands.",
        recommendations: [],
      });
    }

    const targetType =
      inferTargetType(prompt) ??
      seeds.find((seed) => seed.type)?.type ??
      "urn:entity:artist";

    // 3. Ask Qloo for recommendations conditioned on ALL resolved signals.
    const insightsUrl = new URL(`${QLOO_BASE_URL}/v2/insights`);

    insightsUrl.searchParams.set("filter.type", targetType);
    insightsUrl.searchParams.set(
      "signal.interests.entities",
      seeds.map((seed) => seed.id).join(","),
    );
    insightsUrl.searchParams.set(
      "filter.exclude.entities",
      seeds.map((seed) => seed.id).join(","),
    );
    insightsUrl.searchParams.set("take", String(MAX_RECOMMENDATIONS));
    insightsUrl.searchParams.set("feature.explainability", "true");

    const insightsResponse = await fetch(insightsUrl, {
      headers: { "X-Api-Key": apiKey },
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });

    const insightsData: unknown = await insightsResponse
      .json()
      .catch(() => null);

    if (!insightsResponse.ok) {
      console.error(
        "Qloo Insights failed:",
        insightsResponse.status,
        insightsData,
      );

      return Response.json(
        {
          message:
            "Qloo couldn't generate recommendations for this combination. " +
            "Try another category or different references.",
        },
        { status: 502 },
      );
    }

    const entities = getEntities(insightsData);

    const rootExplainability = getRootExplainability(insightsData);
    const aggregateContributions = extractContributions(
      rootExplainability,
      seeds,
    );

    // 4. Compact result data and capture per-item explainability.
    const recommendations = entities
      .filter(
        (entity) =>
          typeof entity.name === "string" && Boolean(getEntityId(entity)),
      )
      .slice(0, MAX_RECOMMENDATIONS)
      .map((entity) => {
        const itemExplainability = getItemExplainability(entity);

        const contributors = extractContributions(itemExplainability, seeds);

        return {
          id: getEntityId(entity)!,
          name: entity.name!,
          type: getEntityType(entity) ?? targetType,
          imageUrl: getImageUrl(entity),
          description: getShortDescription(entity),
          contributors,
          explainabilityAvailable: itemExplainability !== undefined,
        };
      });

    if (recommendations.length === 0) {
      return Response.json({
        message:
          `I found your taste references (${seeds.map((seed) => seed.name).join(", ")}), ` +
          `but Qloo returned no ${getTypeLabel(targetType)} for this combination.`,
        interests: seeds,
        recommendations: [],
        targetType,
      });
    }

    // 5. Validate which input signals Qloo exposed in the explainability metadata.
    const perRecommendationCounts = new Map<string, number>();

    for (const recommendation of recommendations) {
      for (const contributor of recommendation.contributors) {
        perRecommendationCounts.set(
          contributor.id,
          (perRecommendationCounts.get(contributor.id) ?? 0) + 1,
        );
      }
    }

    const aggregateIds = new Set(
      aggregateContributions.map((contributor) => contributor.id),
    );

    const signalValidation = {
      metadataAvailable:
        rootExplainability !== undefined ||
        recommendations.some((item) => item.explainabilityAvailable),
      confirmed: seeds
        .filter(
          (seed) =>
            (perRecommendationCounts.get(seed.id) ?? 0) > 0 ||
            aggregateIds.has(seed.id),
        )
        .map((seed) => ({
          ...seed,
          recommendationCount: perRecommendationCounts.get(seed.id) ?? 0,
          aggregateConfirmed: aggregateIds.has(seed.id),
        })),
      notExposed: seeds
        .filter(
          (seed) =>
            (perRecommendationCounts.get(seed.id) ?? 0) === 0 &&
            !aggregateIds.has(seed.id),
        )
        .map(({ id, name, type }) => ({ id, name, type })),
      warning: getExplainabilityWarning(rootExplainability),
    };

    // Intro text stays short; cards hold the actual recommendation details.
    const names = seeds.map((seed) => seed.name).join(", ");

    return Response.json({
      message:
        `Using your taste references (${names}), here are some ` +
        `${getTypeLabel(targetType)} surfaced by Qloo.`,
      interests: seeds,
      recommendations,
      signalValidation,
      targetType,
    });
  } catch (error) {
    console.error("CHAT API ERROR:", error);

    return Response.json(
      { message: "An error occurred while processing your message." },
      { status: 502 },
    );
  }
}
