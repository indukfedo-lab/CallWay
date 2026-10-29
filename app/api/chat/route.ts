const QLOO_BASE_URL = "https://hackathon.api.qloo.com";
const MAX_INTERESTS = 5;
const MAX_RECOMMENDATIONS = 8;
const INSIGHTS_CANDIDATE_POOL = 20;
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
type PromptInterpretation = {
  targetType: EntityType | null;
  interestQueries: string[];
  refinementIntent: string | null;
  refinementQueries: string[];
};

const MAX_REFINEMENT_CONCEPTS = 5;
const MAX_SELECTED_TAGS = 3;
const TAG_CACHE_TTL_MS = 30 * 60 * 1000;

const tagSearchCache = new Map<
  string,
  {
    tags: Record<string, unknown>[];
    expiresAt: number;
  }
>();

async function interpretPromptWithGroq(
  prompt: string,
  messages: ChatMessage[],
): Promise<PromptInterpretation> {
  const fallback: PromptInterpretation = {
    targetType: null,
    interestQueries: [],
    refinementIntent: null,
    refinementQueries: [],
  };

  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    console.warn("GROQ_API_KEY is not configured.");
    return fallback;
  }

  try {
    const conversationMessages = messages.slice(-20);

    const conversation = conversationMessages.map((message) => ({
      role: message.role,
      content: message.content.slice(0, 800),
    }));

    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${groqApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-120b",
          temperature: 0,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "prompt_interpretation",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  targetType: {
                    type: ["string", "null"],
                  },
                  interestQueries: {
                    type: "array",
                    items: { type: "string" },
                  },
                  refinementIntent: {
                    type: ["string", "null"],
                  },
                  refinementQueries: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
                required: [
                  "targetType",
                  "interestQueries",
                  "refinementIntent",
                  "refinementQueries",
                ],
                additionalProperties: false,
              },
            },
          },
          messages: [
            {
              role: "system",
              content: `
You are Loom's recommendation intent interpreter. Loom uses Qloo for cultural recommendations.
Interpret the conversation dynamically. Do not rely on predefined genre, mood, or category keyword lists.
Return only a JSON object with this schema:
{
  "targetType": string or null,
  "interestQueries": string[],
  "refinementIntent": string or null,
  "refinementQueries": string[]
}
Allowed targetType values:
${ENTITY_TYPES.join(", ")}

Rules:
- Use the latest user message and conversation context to understand intent.
- Determine the recommendation category from the latest user message and conversation context.
- If the user requests a different recommendation category, switch targetType to that category.
- A category switch is not merely a refinement.
- Preserve previously established taste references when switching categories.
- Preserve the existing category only when the user refines recommendations without requesting a category change.
- If the latest message does not specify a category, use the most recent category clearly established in the conversation.
- Return null for targetType only if no recommendation category can be inferred.
- interestQueries must contain up to ${MAX_INTERESTS} recognizable entities the user explicitly says they like, enjoy, prefer, or want to use as taste references. Use user messages as evidence; do not treat entities merely suggested by the assistant as user preferences.
- Preserve relevant taste references established earlier in the conversation.
- refinementIntent should describe the user's requested change in meaning, including relevant context, or be null if no refinement is requested.
- refinementQueries should contain up to ${MAX_REFINEMENT_CONCEPTS} concise, independently searchable natural-language concepts that represent the refinement. Generate concepts dynamically for any domain or preference; do not enumerate genres or use fixed mappings.
- Queries should be useful for searching Qloo's tag catalog. Break compound intent into useful concepts when appropriate, rather than repeating the same phrase in different forms.
- Never invent Qloo tag IDs or URNs. You will receive actual IDs later from Qloo.
- Do not invent taste references or imply the user likes an entity without evidence in user messages.
- If no refinement is requested, return null for refinementIntent and an empty refinementQueries array.
- If a field cannot be inferred, use null or an empty array as appropriate.
              `.trim(),
            },
            {
              role: "user",
              content: JSON.stringify({ currentPrompt: prompt, conversation }),
            },
          ],
        }),
        signal: AbortSignal.timeout(12000),
      },
    );

    if (!response.ok) {
      console.warn(
        "Groq intent interpretation failed:",
        response.status,
        await response.text(),
      );
      return fallback;
    }

    const data: unknown = await response.json();
    if (!isRecord(data) || !Array.isArray(data.choices)) return fallback;

    const firstChoice = data.choices[0];
    if (
      !isRecord(firstChoice) ||
      !isRecord(firstChoice.message) ||
      typeof firstChoice.message.content !== "string"
    ) {
      return fallback;
    }

    const parsed: unknown = JSON.parse(firstChoice.message.content);
    if (!isRecord(parsed)) return fallback;

    const rawTargetType = parsed.targetType;
    const targetType =
      typeof rawTargetType === "string" &&
      ENTITY_TYPES.includes(rawTargetType as EntityType)
        ? (rawTargetType as EntityType)
        : null;

    const interestQueries: string[] = [];
    const seenInterestQueries = new Set<string>();

    if (Array.isArray(parsed.interestQueries)) {
      for (const value of parsed.interestQueries) {
        if (typeof value !== "string") continue;

        const query = value.trim().slice(0, 100);
        const key = normalizeText(query);

        if (!query || !key || seenInterestQueries.has(key)) continue;

        seenInterestQueries.add(key);
        interestQueries.push(query);

        if (interestQueries.length >= MAX_INTERESTS) break;
      }
    }

    const refinementQueries: string[] = [];
    const seenRefinementQueries = new Set<string>();

    if (Array.isArray(parsed.refinementQueries)) {
      for (const value of parsed.refinementQueries) {
        if (typeof value !== "string") continue;

        const query = value.trim().slice(0, 100);
        const key = normalizeText(query);

        if (!query || !key || seenRefinementQueries.has(key)) continue;

        seenRefinementQueries.add(key);
        refinementQueries.push(query);

        if (refinementQueries.length >= MAX_REFINEMENT_CONCEPTS) break;
      }
    }

    const refinementIntent =
      typeof parsed.refinementIntent === "string"
        ? parsed.refinementIntent.trim().slice(0, 500) || null
        : null;

    return { targetType, interestQueries, refinementIntent, refinementQueries };
  } catch (error) {
    console.warn("Groq intent interpretation error:", error);
    return fallback;
  }
}

async function resolveRefinementTagIds(
  refinementQueries: string[],
  refinementIntent: string | null,
  targetType: EntityType,
  apiKey: string,
): Promise<string[]> {
  const groqApiKey = process.env.GROQ_API_KEY;
  const searchQueries = [
    ...new Set(
      (refinementQueries.length > 0
        ? refinementQueries
        : refinementIntent
          ? [refinementIntent]
          : []
      )
        .map((query) => query.trim())
        .filter(Boolean),
    ),
  ];
  if (searchQueries.length === 0) return [];

  async function searchTags(
    searchQuery: string,
  ): Promise<Record<string, unknown>[]> {
    const cacheKey = normalizeText(searchQuery);
    const cached = tagSearchCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.tags;
    }

    if (cached) {
      tagSearchCache.delete(cacheKey);
    }

    const url = new URL(`${QLOO_BASE_URL}/v2/tags`);
    url.searchParams.set("filter.query", searchQuery);
    url.searchParams.set("take", "20");

    try {
      const response = await fetch(url, {
        headers: { "X-Api-Key": apiKey },
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        console.warn("[LOOM] Tag search failed:", {
          query: searchQuery,
          status: response.status,
        });
        return [];
      }

      const data: unknown = await response.json();

      if (
        !isRecord(data) ||
        !isRecord(data.results) ||
        !Array.isArray(data.results.tags)
      ) {
        return [];
      }

      const tags = data.results.tags.filter(isRecord);
      console.log(
        "[TAGS EXTRACTED]",
        tags.map((tag) => ({
          query: searchQuery,
          id: tag.tag_id ?? tag.tag_value ?? tag.id,
          name: tag.name,
        })),
      );

      tagSearchCache.set(cacheKey, {
        tags,
        expiresAt: Date.now() + TAG_CACHE_TTL_MS,
      });

      return tags;
    } catch (error) {
      console.warn("[LOOM] Tag lookup error:", searchQuery, error);
      return [];
    }
  }

  function getTagId(tag: Record<string, unknown>): string | null {
    const id = tag.tag_id ?? tag.tag_value ?? tag.id;
    return typeof id === "string" && id.startsWith("urn:tag:") ? id : null;
  }

  function getTagName(tag: Record<string, unknown>, id: string): string {
    return typeof tag.name === "string"
      ? tag.name
      : (id.split(":").pop()?.replace(/_/g, " ") ?? "");
  }

  // This is structural/type validation, not a list of semantic genres or moods.
  function isRelevantTag(tag: Record<string, unknown>): boolean {
    return getTagId(tag) !== null;
  }

  const resultsByQuery = await Promise.all(
    searchQueries.map(async (searchQuery) => ({
      searchQuery,
      tags: await searchTags(searchQuery),
    })),
  );

  const uniqueTags = new Map<
    string,
    { tag: Record<string, unknown>; searchQueries: string[] }
  >();

  for (const result of resultsByQuery) {
    for (const tag of result.tags.filter(isRelevantTag)) {
      const id = getTagId(tag);
      if (!id) continue;

      const existing = uniqueTags.get(id);
      if (existing) {
        if (!existing.searchQueries.includes(result.searchQuery)) {
          existing.searchQueries.push(result.searchQuery);
        }
      } else {
        uniqueTags.set(id, { tag, searchQueries: [result.searchQuery] });
      }
    }
  }

  const candidates = [...uniqueTags.entries()].map(([id, value]) => ({
    id,
    name: getTagName(value.tag, id),
    searchQueries: value.searchQueries,
  }));

  console.log("[LOOM DEBUG] TAG CANDIDATES", {
    refinementIntent,
    searchQueries,
    candidates,
  });

  if (candidates.length === 0) return [];

  // Ask the LLM to select only among real Qloo-returned IDs; validate its output below.
  if (groqApiKey) {
    try {
      const response = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${groqApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "openai/gpt-oss-120b",
            temperature: 0,
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "tag_selection",
                strict: true,
                schema: {
                  type: "object",
                  properties: {
                    tagIds: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                  required: ["tagIds"],
                  additionalProperties: false,
                },
              },
            },
            messages: [
              {
                role: "system",
                content: `
You select relevant tags from Qloo's actual tag search results.
Return only JSON: { "tagIds": string[] }.
Select at most ${MAX_SELECTED_TAGS} tags that best represent the full refinement intent.
Choose based on the intent and tag names, not on fixed genre, mood, or namespace preferences.
Prefer coverage of distinct parts of the intent and avoid redundant synonyms when possible.
Only return IDs appearing in the provided candidates. Never invent or alter IDs.
If no candidate is relevant, return an empty array.
                `.trim(),
              },
              {
                role: "user",
                content: JSON.stringify({
                  targetType,
                  refinementIntent,
                  searchQueries,
                  candidates,
                }),
              },
            ],
          }),
          signal: AbortSignal.timeout(12000),
        },
      );

      if (response.ok) {
        const data: unknown = await response.json();
        if (isRecord(data) && Array.isArray(data.choices)) {
          const choice = data.choices[0];
          if (
            isRecord(choice) &&
            isRecord(choice.message) &&
            typeof choice.message.content === "string"
          ) {
            const parsed: unknown = JSON.parse(choice.message.content);
            if (isRecord(parsed) && Array.isArray(parsed.tagIds)) {
              const validIds = new Set(
                candidates.map((candidate) => candidate.id),
              );
              const selectedIds = [
                ...new Set(
                  parsed.tagIds.filter(
                    (id): id is string =>
                      typeof id === "string" && validIds.has(id),
                  ),
                ),
              ].slice(0, MAX_SELECTED_TAGS);

              console.log("[LOOM DEBUG] TAGS SELECTED BY LLM", {
                selectedIds,
                selectedTags: candidates.filter((candidate) =>
                  selectedIds.includes(candidate.id),
                ),
              });
              return selectedIds;
            }
          }
        }
      } else {
        console.warn("[LOOM] Tag selection LLM failed:", response.status);
      }
    } catch (error) {
      console.warn("[LOOM] Tag selection LLM error:", error);
    }
  }

  // Generic safety fallback: preserve Qloo's returned order, without semantic scoring rules.
  const seenNames = new Set<string>();
  const fallbackIds: string[] = [];
  for (const candidate of candidates) {
    const key = normalizeText(candidate.name);
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    fallbackIds.push(candidate.id);
    if (fallbackIds.length >= MAX_SELECTED_TAGS) break;
  }
  console.warn("[LOOM] Using Qloo-order tag fallback:", fallbackIds);
  return fallbackIds;
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
const ENTITY_CACHE_TTL_MS = 30 * 60 * 1000;
const entityCache = new Map<
  string,
  {
    entity: QlooEntity;
    expiresAt: number;
  }
>();
async function resolveEntity(
  query: string,
  apiKey: string,
): Promise<QlooEntity | null> {
  const cacheKey = normalizeText(query);
  // 1. Cek cache terlebih dahulu.
  const cached = entityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.entity;
  }
  // Hapus cache yang sudah kedaluwarsa.
  if (cached) {
    entityCache.delete(cacheKey);
  }
  // 2. Kalau tidak ada di cache, panggil Qloo Search.
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
    return null;
  }
  const exactMatch = entities.find(
    (entity) => normalizeText(entity.name!) === cacheKey,
  );
  // Pertahankan perilaku pencarian sebelumnya.
  const resolvedEntity = exactMatch ?? entities[0];
  // 3. Simpan entity yang berhasil ditemukan selama 30 menit.
  entityCache.set(cacheKey, {
    entity: resolvedEntity,
    expiresAt: Date.now() + ENTITY_CACHE_TTL_MS,
  });
  return resolvedEntity;
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
function isRecommendationMetadataKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
  const base = normalized.replace(/(?:ids?|names?)$/, "");
  return [
    "genre",
    "genres",
    "keyword",
    "keywords",
    "tag",
    "tags",
    "category",
    "categories",
    "theme",
    "themes",
    "mood",
    "moods",
    "descriptor",
    "descriptors",
    "subject",
    "subjects",
    "subtype",
  ].includes(base);
}
function collectMetadataLeaves(
  value: unknown,
  output: string[],
  depth = 0,
): void {
  if (depth > 8) return;
  if (typeof value === "string") {
    if (!/^https?:\/\//i.test(value)) {
      output.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectMetadataLeaves(item, output, depth + 1);
    }
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      collectMetadataLeaves(item, output, depth + 1);
    }
  }
}
function collectRecommendationMetadata(
  value: unknown,
  output: string[],
  depth = 0,
): void {
  if (depth > 8 || !isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (isRecommendationMetadataKey(key)) {
      collectMetadataLeaves(item, output, depth + 1);
    } else if (isRecord(item) || Array.isArray(item)) {
      collectRecommendationMetadata(item, output, depth + 1);
    }
  }
}
function getRecommendationMetadata(entity: QlooEntity): string[] {
  const values: string[] = [];
  const rawEntity = entity as unknown as Record<string, unknown>;
  // Metadata yang berada di properties.
  collectRecommendationMetadata(entity.properties, values);
  // Fallback jika metadata dikirim langsung pada entity.
  for (const key of [
    "genre",
    "genres",
    "keywords",
    "tags",
    "categories",
    "themes",
    "moods",
    "subtype",
  ]) {
    if (rawEntity[key] !== undefined) {
      collectMetadataLeaves(rawEntity[key], values);
    }
  }
  return [...new Set(values.map(normalizeText).filter(Boolean))];
}
function getAffinityScore(entity: QlooEntity): number {
  const affinity = entity.query?.affinity;
  if (typeof affinity === "number" && Number.isFinite(affinity)) {
    return affinity;
  }
  if (isRecord(affinity)) {
    for (const key of ["score", "normalized_score", "value"]) {
      const value = affinity[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    }
  }
  return 0;
}
async function rankInsightEntitiesWithGroq(
  entities: QlooEntity[],
  refinementIntent: string | null,
): Promise<QlooEntity[]> {
  if (!refinementIntent || entities.length < 2) return entities;

  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) return entities;

  const candidates = entities.map((entity, index) => ({
    id: getEntityId(entity)!,
    name: entity.name ?? "",
    type: getEntityType(entity),
    affinity: getAffinityScore(entity),
    description: getShortDescription(entity),
    metadata: getRecommendationMetadata(entity).slice(0, 30),
    originalPosition: index + 1,
  }));

  if (candidates.length < 2) return entities;

  try {
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${groqApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-120b",
          temperature: 0,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "recommendation_ranking",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  orderedEntityIds: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
                required: ["orderedEntityIds"],
                additionalProperties: false,
              },
            },
          },
          messages: [
            {
              role: "system",
              content: `
You rank recommendation candidates for Loom.
Return only JSON: { "orderedEntityIds": string[] }.
Rank the provided candidates by how well their available metadata fits the user's refinement intent.
Use the candidate names, descriptions, metadata, and Qloo affinity as evidence. Do not infer attributes unsupported by that evidence.
Do not use fixed genre or mood rules, and do not invent candidates or IDs.
Return candidate IDs only, best fit first. Include all provided IDs exactly once when possible.
                `.trim(),
            },
            {
              role: "user",
              content: JSON.stringify({ refinementIntent, candidates }),
            },
          ],
        }),
        signal: AbortSignal.timeout(12000),
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();

      console.warn("[LOOM] Recommendation ranking LLM failed:", {
        status: response.status,
        body: errorBody,
      });

      return entities;
    }

    const data: unknown = await response.json();
    if (!isRecord(data) || !Array.isArray(data.choices)) return entities;
    const choice = data.choices[0];
    if (
      !isRecord(choice) ||
      !isRecord(choice.message) ||
      typeof choice.message.content !== "string"
    )
      return entities;

    const parsed: unknown = JSON.parse(choice.message.content);
    if (!isRecord(parsed) || !Array.isArray(parsed.orderedEntityIds))
      return entities;

    const entitiesById = new Map(
      entities.map((entity) => [getEntityId(entity), entity] as const),
    );
    const validIds = new Set(entitiesById.keys());
    const orderedIds = [
      ...new Set(
        parsed.orderedEntityIds.filter(
          (id): id is string => typeof id === "string" && validIds.has(id),
        ),
      ),
    ];

    // If the model omitted candidates, append them in Qloo's original order.
    for (const entity of entities) {
      const id = getEntityId(entity);
      if (id && !orderedIds.includes(id)) orderedIds.push(id);
    }

    const ranked = orderedIds
      .map((id) => entitiesById.get(id))
      .filter((entity): entity is QlooEntity => entity !== undefined);

    console.log("[LOOM DEBUG] LLM RANKED RECOMMENDATIONS", {
      refinementIntent,
      ranking: ranked.map((entity, index) => ({
        position: index + 1,
        id: getEntityId(entity),
        name: entity.name,
        affinity: getAffinityScore(entity),
      })),
    });

    return ranked.length === entities.length ? ranked : entities;
  } catch (error) {
    console.warn("[LOOM] Recommendation ranking LLM error:", error);
    return entities;
  }
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
  const validMessages: ChatMessage[] = Array.isArray(body.messages)
    ? body.messages.filter(
        (message): message is ChatMessage =>
          isRecord(message) &&
          (message.role === "user" || message.role === "assistant") &&
          typeof message.content === "string",
      )
    : [];
  const firstUserMessage = validMessages.find(
    (message: any) => message.role === "user",
  );
  const recentMessages = validMessages.slice(-19);
  const messages =
    firstUserMessage && !recentMessages.includes(firstUserMessage)
      ? [firstUserMessage, ...recentMessages]
      : validMessages.slice(-20);
  try {
    // 1. Collect up to five references from this prompt and prior user turns.
    const interpretation = await interpretPromptWithGroq(prompt, messages);
    const queries = interpretation.interestQueries;
    console.log("[LOOM DEBUG] HISTORY CHECK", {
      prompt,
      firstUserMessage: messages.find((m) => m.role === "user"),
      queries,
    });
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
    const targetType = interpretation.targetType;

    if (!targetType) {
      return Response.json({
        message:
          "I couldn't determine the recommendation category. " +
          "Tell me what you'd like recommendations for.",
        interests: seeds,
        recommendations: [],
        targetType: null,
        needsCategory: true,
      });
    }

    const hasRefinement = Boolean(
      interpretation.refinementIntent ||
      interpretation.refinementQueries.length,
    );
    const refinementTagIds = hasRefinement
      ? await resolveRefinementTagIds(
          interpretation.refinementQueries,
          interpretation.refinementIntent,
          targetType,
          apiKey,
        )
      : [];

    console.log("[LOOM DEBUG] CONTEXT", {
      prompt,
      interpretation,
      queries,
      targetType,
      seeds: seeds.map((s) => ({
        name: s.name,
        type: s.type,
        entity_id: s.id,
      })),
      refinementTagIds,
    });
    if (hasRefinement && refinementTagIds.length === 0) {
      console.warn(
        "[LOOM] Skipping Insights: no matching refinement tag found.",
      );
      return Response.json({
        message:
          `I understood your refinement as "${interpretation.refinementIntent ?? interpretation.refinementQueries.join(", ")}", ` +
          `but couldn't find a matching Qloo tag for ${getTypeLabel(targetType)}. ` +
          "Try specifying a genre or story theme.",
        interests: seeds,
        recommendations: [],
        targetType,
        refinementApplied: false,
      });
    }
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
    if (refinementTagIds.length > 0) {
      insightsUrl.searchParams.set(
        "signal.interests.tags",
        refinementTagIds.join(","),
      );
    }
    insightsUrl.searchParams.set("take", String(INSIGHTS_CANDIDATE_POOL));
    insightsUrl.searchParams.set("feature.explainability", "true");
    console.log("[LOOM DEBUG] INSIGHTS REQUEST", {
      endpoint: `${insightsUrl.origin}${insightsUrl.pathname}`,
      params: Object.fromEntries(insightsUrl.searchParams.entries()),
    });
    const insightsStartedAt = Date.now();

    const insightsResponse = await fetch(insightsUrl, {
      headers: { "X-Api-Key": apiKey },
      cache: "no-store",
      signal: AbortSignal.timeout(60000),
    });

    console.log("[LOOM DEBUG] INSIGHTS HEADERS RECEIVED", {
      status: insightsResponse.status,
      elapsedMs: Date.now() - insightsStartedAt,
    });

    const insightsData: unknown = await insightsResponse
      .json()
      .catch(() => null);

    console.log("[LOOM DEBUG] INSIGHTS BODY PARSED", {
      elapsedMs: Date.now() - insightsStartedAt,
      entityCount: getEntities(insightsData).length,
    });

    console.log("[LOOM DEBUG] INSIGHTS RESPONSE", {
      status: insightsResponse.status,
      ok: insightsResponse.ok,
      responseKeys: isRecord(insightsData) ? Object.keys(insightsData) : [],
      resultsType:
        isRecord(insightsData) && Array.isArray(insightsData.results)
          ? "array"
          : typeof (isRecord(insightsData) ? insightsData.results : undefined),
    });
    //console.log(
    //"[LOOM DEBUG] INSIGHTS RESPONSE",
    //JSON.stringify(insightsData).slice(0, 10000),
    //);
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

    console.log("[LOOM DEBUG] INSIGHTS PARSED", {
      entityCount: entities.length,
      entityNames: entities.slice(0, 5).map((entity) => entity.name),
    });

    const rootExplainability = getRootExplainability(insightsData);
    const aggregateContributions = extractContributions(
      rootExplainability,
      seeds,
    );
    // 4. Compact result data and capture per-item explainability.
    const eligibleEntities = entities.filter(
      (entity) =>
        typeof entity.name === "string" && Boolean(getEntityId(entity)),
    );
    const rankedEntities = await rankInsightEntitiesWithGroq(
      eligibleEntities,
      interpretation.refinementIntent,
    );

    const recommendations = rankedEntities
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
