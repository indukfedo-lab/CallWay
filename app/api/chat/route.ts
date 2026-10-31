const QLOO_BASE_URL = "https://hackathon.api.qloo.com";
const MAX_INTERESTS = 5;
const MAX_RECOMMENDATIONS = 8;
const INSIGHTS_CANDIDATE_POOL = 8;
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
type UploadedImage = {
  dataUrl: string;
};
type ChatMessage = {
  role: "user" | "assistant";
  content: string;

  imageContext?: ImageContext | null;
  targetType?: string | null;

  interests?: {
    id?: string;
    name?: string;
    type?: string | null;
  }[];

  recommendations?: {
    id?: string;
    name?: string;
    type?: string;
    description?: string | null;
    metadata?: string[];
    contributors?: {
      id?: string;
      name?: string;
      score?: number;
    }[];
    affinity?: number | null;
    matchedTasteAttributes?: string[];
    whyThisFits?: string;
    explainabilityAvailable?: boolean;
  }[];
};
type VisionEntity = {
  name: string;
  type: string | null;
};

type ImageContext = {
  visualContext: string;
  identifiedEntities: VisionEntity[];
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
type RefinementTag = {
  id: string;
  name: string;
};
type ResolvedRefinementTag = RefinementTag & {
  queryMatchScore: number;
  queryPriority: number;
};
type WeightedQlooTag = RefinementTag & {
  weight: number;
  source: "taste_profile" | "explicit_refinement";
  affinity?: number;
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
type ContextMode = "new_topic" | "focused_reference" | "continuation";

type PromptInterpretation = {
  contextMode: ContextMode;
  targetType: EntityType | null;
  interestQueries: string[];
  refinementIntent: string | null;
  refinementQueries: string[];
  requestMore: boolean;
  requestedCount: number | null;
};

function getPendingImageContext(messages: ChatMessage[]): ImageContext | null {
  const previousMessage = messages[messages.length - 2];

  if (previousMessage?.role !== "assistant") return null;

  return previousMessage.imageContext ?? null;
}

const MAX_REFINEMENT_CONCEPTS = 5;
const MAX_SELECTED_TAGS = 3;
const MAX_TASTE_PROFILE_TAGS = 1;

const REFINEMENT_BASE_WEIGHT = 9;
const REFINEMENT_PRIORITY_STEP = 2;
const REFINEMENT_MATCH_BONUS_MAX = 2;
const MAX_TAG_WEIGHT = 20;
const TASTE_PROFILE_TAG_WEIGHTS = [10, 8, 6, 4, 2] as const;
const TAG_CACHE_TTL_MS = 30 * 60 * 1000;
const TASTE_PROFILE_CACHE_TTL_MS = 30 * 60 * 1000;

const tagSearchCache = new Map<
  string,
  {
    tags: Record<string, unknown>[];
    expiresAt: number;
  }
>();

const tasteProfileCache = new Map<
  string,
  {
    tags: WeightedQlooTag[];
    expiresAt: number;
  }
>();

async function interpretPromptWithGroq(
  prompt: string,
  messages: ChatMessage[],
): Promise<PromptInterpretation> {
  const conversationMessages = messages.slice(-41);
  const pendingImageContext = getPendingImageContext(conversationMessages);

  const pendingImageTargetType = pendingImageContext?.identifiedEntities.find(
    (item) => item.type && ENTITY_TYPES.includes(item.type as EntityType),
  )?.type as EntityType | undefined;

  const fallback: PromptInterpretation = {
    contextMode: pendingImageContext ? "continuation" : "new_topic",
    targetType: pendingImageTargetType ?? null,
    interestQueries:
      pendingImageContext?.identifiedEntities
        .map((item) => item.name)
        .slice(0, MAX_INTERESTS) ?? [],
    refinementIntent: null,
    refinementQueries: [],
    requestMore: false,
    requestedCount: null,
  };

  const groqApiKey = process.env.GROQ_API_KEY;

  if (!groqApiKey) {
    console.warn("GROQ_API_KEY is not configured.");
    return fallback;
  }

  try {
    const conversationMessages = messages.slice(-40);

    // Cari hasil rekomendasi assistant paling terbaru.
    let latestRecommendationIndex = -1;

    for (let i = conversationMessages.length - 1; i >= 0; i--) {
      const message = conversationMessages[i];

      if (message.role === "assistant" && message.recommendations?.length) {
        latestRecommendationIndex = i;
        break;
      }
    }

    const latestRecommendation =
      latestRecommendationIndex >= 0
        ? conversationMessages[latestRecommendationIndex]
        : null;

    // Cari pesan user yang menghasilkan rekomendasi tersebut.
    let latestRequest: ChatMessage | null = null;

    if (latestRecommendationIndex >= 0) {
      for (let i = latestRecommendationIndex - 1; i >= 0; i--) {
        if (conversationMessages[i].role === "user") {
          latestRequest = conversationMessages[i];
          break;
        }
      }
    }

    // PRIMARY CONTEXT: permintaan terakhir + hasil rekomendasinya.
    const primaryContext = latestRecommendation
      ? {
          userRequest: latestRequest?.content.slice(0, 800) ?? null,
          assistantResponse: latestRecommendation.content.slice(0, 800),

          targetType:
            latestRecommendation.targetType ??
            latestRecommendation.recommendations?.[0]?.type ??
            null,

          interests:
            latestRecommendation.interests?.map((item) => ({
              name: item.name,
              type: item.type,
            })) ?? [],

          recommendations: latestRecommendation.recommendations
            ?.slice(0, MAX_RECOMMENDATIONS)
            .map((item) => ({
              name: item.name,
              type: item.type,
              description: item.description?.slice(0, 180),
              metadata: item.metadata?.slice(0, 8) ?? [],
            })),
        }
      : null;

    // SUPPORTING HISTORY: percakapan sebelumnya selain primary context.
    const supportingHistory = conversationMessages
      .slice(0, -1)
      .slice(-40)
      .map((message) => ({
        role: message.role,
        content: message.content.slice(0, 400),

        ...(message.role === "assistant"
          ? {
              targetType: message.targetType ?? null,

              interests:
                message.interests?.map((item) => ({
                  name: item.name,
                  type: item.type,
                })) ?? [],

              imageContext: message.imageContext ?? null,

              recommendations:
                message.recommendations?.slice(0, 4).map((item) => ({
                  name: item.name,
                  type: item.type,
                })) ?? [],
            }
          : {}),
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
                  contextMode: {
                    type: "string",
                    enum: ["new_topic", "focused_reference", "continuation"],
                  },
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
                  requestMore: {
                    type: "boolean",
                  },
                  requestedCount: {
                    type: ["integer", "null"],
                  },
                },
                required: [
                  "contextMode",
                  "targetType",
                  "interestQueries",
                  "refinementIntent",
                  "refinementQueries",
                  "requestMore",
                  "requestedCount",
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
  "refinementQueries": string[],
  "requestMore": "boolean",
  "requestedCount": "integer or null"
}
Allowed targetType values:
${ENTITY_TYPES.join(", ")}

Rules:


CONVERSATION CONTEXT CLASSIFICATION:

First, classify how the current user message relates to
the previous conversation.

Choose exactly one contextMode.

1. new_topic

The user starts a new, self-contained recommendation request
that does not depend on previous recommendations.

- Interpret taste references from the current request.
- Do not carry over previous taste references.
- Do not carry over previous refinement criteria.
- Use previous history only if needed to resolve an explicit
  reference or ambiguity.

2. focused_reference

The user explicitly identifies a particular entity as the
basis for similarity, comparison, inspiration, or preference.

- Set that entity as the primary interest reference.
- Do not automatically combine it with unrelated taste
  references from previous requests.
- Previous conversation may help resolve the entity.
- The explicitly selected entity takes priority over
  previous taste references.
- The request may still be a refinement of the previous
  recommendation conversation.

3. continuation

The user is continuing or refining the previous
recommendation conversation.

Examples:
- Make them darker.
- Give me five more.
- What about TV shows?
- Make them less mainstream.

- Use the latest completed recommendation context.
- Preserve its active taste references.
- Preserve refinement criteria that remain relevant.
- Apply the current message as an update to that context.
- Do not restore taste references from older topics that
  were replaced by a more recent focused reference.
- A category change does not automatically start a new topic.

PENDING IMAGE CONTEXT:

- pendingImageContext contains entities identified from an image
  when the previous assistant message asked whether the user
  wanted recommendations based on that image.

- If the current message accepts that offer, use the identified
  image entities as the active taste references.
- Treat this as a continuation of the image-based request.
- Preserve the identified entity names and their categories.
- If the user explicitly requests a different recommendation
  category, use that category while retaining the image entities
  as taste references.
- If the user starts an unrelated new topic, ignore the pending
  image context.
- Never invent additional entities from the image context.

CONTEXT PRIORITY:

1. Current user message.
2. Latest completed recommendation context.
3. Older conversation history, only as supporting context.

IMPORTANT:

- Classify based on semantic meaning, not fixed keywords.
- Do not assume every short message is a continuation.
- Do not assume every message mentioning an entity is
  a new topic.
- A specific entity explicitly selected as a reference
  must become the primary taste signal.
- Assistant recommendations are not user preferences
  unless the user explicitly adopts them.

TASTE REFERENCES:

- interestQueries must reflect the selected contextMode.
- For new_topic, extract references from the current request.
- For focused_reference, return only the explicitly selected
  reference as the primary taste signal.
- For continuation, preserve the active references from
  primaryContext unless the user changes them.
- Never infer that the user likes an entity merely because
  the assistant recommended it.
- Do not invent entities.

REFINEMENT:

- refinementIntent describes the current requested change
  in meaning.
- refinementQueries contains up to ${MAX_REFINEMENT_CONCEPTS}
  concise, independently searchable concepts.
- For continuation, combine the current refinement with
  previous criteria that remain relevant.
- For focused_reference, prioritize characteristics of
  the explicitly selected entity.
- For new_topic, do not carry over previous refinements.
- Order concepts by relevance, most important first.
- Generate concepts dynamically; do not rely on fixed
  genre or mood mappings.
- Generate concise search terms suitable for Qloo tag search.
- Never invent Qloo tag IDs.

TARGET CATEGORY:

- Determine targetType from the current request and context.
- Switch categories when requested.
- Preserve the latest category for ordinary refinements.
- A category switch is still a continuation when it
  depends on the previous recommendation context.

ADDITIONAL RECOMMENDATIONS:

- Set requestMore to true when the user requests more results.
- requestedCount is the explicit requested number, or null.
- A category switch or ordinary refinement is not
  automatically a request for more results.

GENERAL:

- Return null or empty arrays when information cannot
  be inferred.

TARGET CATEGORY:
- Determine the recommendation category from the latest user message and conversation context.
- If the user requests a different recommendation category, switch targetType to that category.
- A category switch is not merely a refinement.
- Preserve the existing category only when the user refines recommendations without requesting a category change.
- If the latest message does not specify a category, use the most recent category clearly established in the conversation.
- Return null for targetType only if no recommendation category can be inferred.

REFINEMENT:
- refinementIntent should describe the user's requested change in meaning, using the current message and relevant context, or be null if no refinement is requested.
- refinementQueries should contain up to ${MAX_REFINEMENT_CONCEPTS} concise, independently searchable natural-language concepts.
- Order refinementQueries from the most central concepts to supporting descriptors; this order determines tag-selection priority.
- Generate concepts dynamically for any domain or preference. Do not enumerate genres or use fixed mappings.
- Qloo's tag search uses partial text matching on tag names. Generate concise, searchable tag-label terms rather than abstract paraphrases such as "darker tone" or "intense atmosphere".
- Keep queries relevant to targetType and the user's current intent.
- Break compound intent into useful concepts when appropriate, rather than repeating the same phrase in different forms.
- Never invent Qloo tag IDs or URNs. You will receive actual IDs later from Qloo.
- If no refinement is requested, return null for refinementIntent and an empty refinementQueries array.

ADDITIONAL RECOMMENDATIONS:
- Set requestMore to true when the latest user message asks for additional recommendations beyond the previous results.
- Set requestedCount to the number explicitly requested, or null if no number is specified.
- Do not treat a category switch or an ordinary refinement as a request for more results.
- Otherwise, set requestMore to false and requestedCount to null.

GENERAL:
- If a field cannot be inferred, use null or an empty array
  as appropriate.
              `.trim(),
            },
            {
              role: "user",
              content: JSON.stringify({
                currentPrompt: prompt,
                primaryContext,
                pendingImageContext,
                supportingHistory,
              }),
            },
          ],
        }),
        signal: AbortSignal.timeout(25000),
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

    const contextMode: ContextMode =
      parsed.contextMode === "new_topic" ||
      parsed.contextMode === "focused_reference" ||
      parsed.contextMode === "continuation"
        ? parsed.contextMode
        : primaryContext
          ? "continuation"
          : "new_topic";

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

    const requestMore = parsed.requestMore === true;

    const rawRequestedCount = parsed.requestedCount;
    const requestedCount =
      typeof rawRequestedCount === "number" &&
      Number.isInteger(rawRequestedCount) &&
      rawRequestedCount > 0
        ? Math.min(rawRequestedCount, MAX_RECOMMENDATIONS)
        : null;

    return {
      contextMode,
      targetType,
      interestQueries,
      refinementIntent,
      refinementQueries,
      requestMore,
      requestedCount,
    };
  } catch (error) {
    console.warn("Groq intent interpretation error:", error);
    return fallback;
  }
}

async function interpretPromptWithVision(
  prompt: string,
  messages: ChatMessage[],
  image: UploadedImage,
): Promise<ImageContext> {
  const groqApiKey = process.env.GROQ_API_KEY;

  if (!groqApiKey) {
    throw new Error("GROQ_API_KEY is not configured.");
  }

  const conversationContext = messages.slice(-41).map((message) => ({
    role: message.role,
    content: message.content.slice(0, 500),
    imageContext: message.imageContext ?? null,
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
        model: "qwen/qwen3.8-27b",
        temperature: 0,
        max_completion_tokens: 2048,
        response_format: {
          type: "json_object",
        },
        messages: [
          {
            role: "system",
            content: `
You are Loom's visual taste interpreter.

Analyze the supplied image together with the user's text prompt and conversation context.

Your task is to identify recognizable cultural entities and visual characteristics
that can be used as taste references for Qloo recommendations.

Return valid JSON with this structure:
{
  "visualContext": "string",
  "identifiedEntities": [
    {
      "name": "string",
      "type": "valid Qloo entity type or null"
    }
  ]
}

Valid entity types:
${ENTITY_TYPES.join(", ")}

Rules:
- Identify real entities only when reasonably recognizable.
- Prefer exact names of movies, TV shows, artists, books,
  brands, people, and places.
- Return the exact Qloo entity type when confidently known.
- Return null for the type when it cannot be determined.
- Order entities by visual relevance.
- Return up to 5 entities.
- Return an empty array if no recognizable cultural entity
  can be identified.
- Do not invent entity names or entity types.
- Do not generate recommendations.
- Consider the user's text prompt and image together.
- When the user's prompt is empty, visualContext must be
  a concise, natural description of the image.
            `.trim(),
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `
User prompt:
${prompt || "Analyze this image and use it as context for cultural recommendations."}

Recent conversation:
${JSON.stringify(conversationContext)}

Analyze the image and return the requested JSON.
                `.trim(),
              },
              {
                type: "image_url",
                image_url: {
                  url: image.dataUrl,
                },
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    },
  );

  if (!response.ok) {
    const errorBody = await response.text();

    console.error("[LOOM] Vision interpretation failed:", {
      status: response.status,
      body: errorBody,
    });

    throw new Error("Unable to analyze the uploaded image.");
  }

  const data: unknown = await response.json();

  if (!isRecord(data) || !Array.isArray(data.choices)) {
    throw new Error("Invalid Vision response.");
  }

  const choice = data.choices[0];

  if (
    !isRecord(choice) ||
    !isRecord(choice.message) ||
    typeof choice.message.content !== "string"
  ) {
    throw new Error("Vision returned an empty response.");
  }

  const parsed: unknown = JSON.parse(choice.message.content);

  if (!isRecord(parsed)) {
    throw new Error("Invalid Vision interpretation.");
  }

  const visualContext =
    typeof parsed.visualContext === "string" ? parsed.visualContext.trim() : "";

  const identifiedEntities: VisionEntity[] = [];
  const seenEntities = new Set<string>();

  if (Array.isArray(parsed.identifiedEntities)) {
    for (const item of parsed.identifiedEntities) {
      const name =
        typeof item === "string"
          ? item.trim()
          : isRecord(item) && typeof item.name === "string"
            ? item.name.trim()
            : "";

      const rawType =
        isRecord(item) && typeof item.type === "string" ? item.type : null;

      const type =
        rawType && ENTITY_TYPES.includes(rawType as EntityType)
          ? rawType
          : null;

      const key = normalizeText(name);

      if (!name || !key || seenEntities.has(key)) continue;

      seenEntities.add(key);
      identifiedEntities.push({ name, type });

      if (identifiedEntities.length >= MAX_INTERESTS) break;
    }
  }

  console.log("[LOOM DEBUG] VISION INTERPRETATION", {
    visualContext,
    identifiedEntities,
  });

  return {
    visualContext,
    identifiedEntities,
  };
}

function formatVisionInterpretation(
  prompt: string,
  vision: ImageContext,
): string {
  const recognizedEntities = vision.identifiedEntities
    .map((item) => `${item.name}${item.type ? ` (${item.type})` : ""}`)
    .join(", ");

  return [
    `User's original request: ${prompt}`,
    `Visual context: ${vision.visualContext}`,
    `Recognized cultural entities: ${
      recognizedEntities || "None confidently identified"
    }`,
  ].join("\n");
}

async function resolveRefinementTags(
  refinementQueries: string[],
  refinementIntent: string | null,
  targetType: EntityType,
  apiKey: string,
): Promise<ResolvedRefinementTag[]> {
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
    // Cache by both category and query so one category never reuses another category's tags.
    const cacheKey = `${targetType}:${normalizeText(searchQuery)}`;
    const cached = tagSearchCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.tags
        .slice(0, MAX_TASTE_PROFILE_TAGS)
        .map((tag) => ({ ...tag }));
    }

    if (cached) {
      tagSearchCache.delete(cacheKey);
    }

    const url = new URL(`${QLOO_BASE_URL}/v2/tags`);
    url.searchParams.set("filter.query", searchQuery);
    url.searchParams.set("filter.parents.types", targetType);
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
          targetType,
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

  const tagSearchStartedAt = Date.now();

  const resultsByQuery = await Promise.all(
    searchQueries.map(async (searchQuery) => ({
      searchQuery,
      tags: await searchTags(searchQuery),
    })),
  );

  console.log(
    "[LOOM TIMING] Qloo tag searches:",
    Date.now() - tagSearchStartedAt,
    "ms",
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

  // Qloo already filtered candidates for targetType through filter.parents.types.
  // Select locally: one relevant, real Qloo tag per refinement concept.
  function normalizeTagToken(token: string): string {
    let value = token.toLowerCase();

    if (value.length > 5 && value.endsWith("ies")) {
      value = value.slice(0, -3) + "y";
    } else if (value.length > 5 && value.endsWith("ly")) {
      value = value.slice(0, -2);
    } else if (value.length > 5 && value.endsWith("ing")) {
      value = value.slice(0, -3);
    } else if (value.length > 4 && value.endsWith("ed")) {
      value = value.slice(0, -2);
    } else if (
      value.length > 4 &&
      value.endsWith("s") &&
      !value.endsWith("ss")
    ) {
      value = value.slice(0, -1);
    }

    return value;
  }

  function getTagQueryTokens(value: string): string[] {
    return [
      ...new Set(
        normalizeText(value).split(" ").filter(Boolean).map(normalizeTagToken),
      ),
    ];
  }

  function getQueryMatchScore(
    candidate: (typeof candidates)[number],
    searchQuery: string,
  ): number {
    const query = normalizeText(searchQuery);
    const name = normalizeText(candidate.name);
    const slug = normalizeText(
      candidate.id.split(":").pop()?.replace(/_/g, " ") ?? "",
    );

    if (!query || (!name && !slug)) return 0;

    if (name === query || slug === query) return 100;

    const queryTokens = getTagQueryTokens(query);
    const candidateTokens = getTagQueryTokens(`${name} ${slug}`);

    const matchedTokens = queryTokens.filter((token) =>
      candidateTokens.includes(token),
    );

    if (matchedTokens.length === 0) return 0;

    const precision = matchedTokens.length / candidateTokens.length;
    const recall = matchedTokens.length / queryTokens.length;

    return ((2 * precision * recall) / (precision + recall)) * 100;
  }

  const selectedTags: ResolvedRefinementTag[] = [];
  const selectedIds = new Set<string>();
  const selectedNames = new Set<string>();

  for (const searchQuery of searchQueries) {
    const queryCandidates = candidates
      .filter((candidate) => candidate.searchQueries.includes(searchQuery))
      .map((candidate, index) => ({
        candidate,
        index,
        score: getQueryMatchScore(candidate, searchQuery),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index);

    const match = queryCandidates.find(({ candidate }) => {
      const normalizedName = normalizeText(candidate.name);
      return (
        !selectedIds.has(candidate.id) && !selectedNames.has(normalizedName)
      );
    });

    if (!match) {
      console.log("[LOOM DEBUG] NO RELEVANT TAG FOR CONCEPT", {
        targetType,
        searchQuery,
        candidateCount: candidates.filter((candidate) =>
          candidate.searchQueries.includes(searchQuery),
        ).length,
      });
      continue;
    }

    const { id, name } = match.candidate;
    selectedIds.add(id);
    selectedNames.add(normalizeText(name));
    selectedTags.push({
      id,
      name,
      queryMatchScore: match.score,
      queryPriority: searchQueries.indexOf(searchQuery),
    });

    if (selectedTags.length >= MAX_SELECTED_TAGS) break;
  }

  console.log("[LOOM DEBUG] TAGS SELECTED DETERMINISTICALLY", {
    targetType,
    searchQueries,
    selectedTags,
  });

  return selectedTags;
}

function getQlooTagAffinity(tag: Record<string, unknown>): number | null {
  if (!isRecord(tag.query)) return null;

  const affinity = tag.query.affinity;
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

  return null;
}

async function resolveTasteProfileTags(
  seedId: string,
  targetType: EntityType,
  apiKey: string,
): Promise<WeightedQlooTag[]> {
  const normalizedSeedId = seedId.trim();
  if (!normalizedSeedId) return [];

  const cacheKey = `${targetType}:${normalizedSeedId}`;
  const cached = tasteProfileCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.tags.map((tag) => ({ ...tag }));
  }

  if (cached) tasteProfileCache.delete(cacheKey);

  const url = new URL(`${QLOO_BASE_URL}/v2/insights`);
  url.searchParams.set("filter.type", "urn:tag");
  url.searchParams.set("signal.interests.entities", normalizedSeedId);
  url.searchParams.set("filter.parents.types", targetType);
  url.searchParams.set("take", "30");

  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      headers: { "X-Api-Key": apiKey },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const errorBody = await response.text();

      console.warn("[LOOM] Qloo Taste Analysis failed:", {
        seedId: normalizedSeedId,
        status: response.status,
        body: errorBody.slice(0, 1000),
      });

      return [];
    }

    const data: unknown = await response.json();

    if (
      !isRecord(data) ||
      !isRecord(data.results) ||
      !Array.isArray(data.results.tags)
    ) {
      console.warn("[LOOM] Taste Analysis returned an unexpected shape:", {
        seedId: normalizedSeedId,
        responseKeys: isRecord(data) ? Object.keys(data) : [],
        resultsKeys:
          isRecord(data) && isRecord(data.results)
            ? Object.keys(data.results)
            : [],
      });

      return [];
    }

    const candidates = data.results.tags
      .filter(isRecord)
      .map((tag, index) => {
        const rawId = tag.tag_id ?? tag.tag_value ?? tag.id;

        if (typeof rawId !== "string" || !rawId.startsWith("urn:tag:")) {
          return null;
        }

        const name =
          typeof tag.name === "string"
            ? tag.name
            : (rawId.split(":").pop()?.replace(/_/g, " ") ?? rawId);

        return {
          id: rawId,
          name,
          affinity: getQlooTagAffinity(tag),
          index,
        };
      })
      .filter(
        (
          tag,
        ): tag is {
          id: string;
          name: string;
          affinity: number | null;
          index: number;
        } => tag !== null,
      );

    if (candidates.some((tag) => tag.affinity !== null)) {
      candidates.sort(
        (a, b) =>
          (b.affinity ?? Number.NEGATIVE_INFINITY) -
            (a.affinity ?? Number.NEGATIVE_INFINITY) || a.index - b.index,
      );
    }

    const seenTagIds = new Set<string>();

    const uniqueCandidates = candidates.filter((candidate) => {
      if (seenTagIds.has(candidate.id)) return false;

      seenTagIds.add(candidate.id);
      return true;
    });

    // 1 identity anchor + 3 supporting tags.
    // Use only the top Taste Analysis tag per seed.
    const selectedCandidates = uniqueCandidates.slice(
      0,
      MAX_TASTE_PROFILE_TAGS,
    );
    const weights = [20];

    const selectedTags: WeightedQlooTag[] = selectedCandidates.map(
      (candidate, index) => ({
        id: candidate.id,
        name: candidate.name,
        weight: weights[index],
        source: "taste_profile",
        ...(candidate.affinity !== null
          ? { affinity: candidate.affinity }
          : {}),
      }),
    );

    tasteProfileCache.set(cacheKey, {
      tags: selectedTags,
      expiresAt: Date.now() + TASTE_PROFILE_CACHE_TTL_MS,
    });

    console.log("[LOOM] QLOO PER-SEED TASTE PROFILE", {
      seedEntityId: normalizedSeedId,
      targetType,
      elapsedMs: Date.now() - startedAt,
      identityAnchor: selectedTags[0] ?? null,
      supportingTags: selectedTags.slice(1),
    });

    return selectedTags;
  } catch (error) {
    console.warn("[LOOM] Qloo Taste Analysis request error:", {
      seedId: normalizedSeedId,
      error,
    });

    return [];
  }
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
  expectedType?: EntityType | null,
): Promise<QlooEntity | null> {
  const cacheKey = `${expectedType ?? "any"}:${normalizeText(query)}`;
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
  if (expectedType) {
    url.searchParams.set("types", expectedType);
  }
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

function getMatchedTasteAttributes(
  metadata: string[],
  weightedTags: WeightedQlooTag[],
): string[] {
  const metadataSet = new Set(metadata.map(normalizeText));

  return [...weightedTags]
    .sort((a, b) => b.weight - a.weight)
    .filter((tag) => metadataSet.has(normalizeText(tag.name)))
    .slice(0, 3)
    .map((tag) => tag.name);
}

function getNestedScore(value: unknown, depth = 0): number | undefined {
  if (depth > 6 || !isRecord(value)) return undefined;
  const scoreKeys = new Set([
    "score",
    "avg_score",
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
    "avg_score",
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
    if (score === undefined) return;

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
  let uploadedImage: UploadedImage | null = null;

  try {
    const contentType = request.headers.get("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();

      const rawPrompt = formData.get("prompt");
      const rawMessages = formData.get("messages");
      const image = formData.get("image");

      let parsedMessages: unknown = [];

      if (typeof rawMessages === "string") {
        parsedMessages = JSON.parse(rawMessages);
      }

      if (image instanceof File && image.size > 0) {
        const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp"];

        if (!allowedMimeTypes.includes(image.type)) {
          return Response.json(
            { message: "Only JPG, PNG, and WebP images are supported." },
            { status: 400 },
          );
        }

        if (image.size > 5 * 1024 * 1024) {
          return Response.json(
            { message: "Image must be 5 MB or smaller." },
            { status: 400 },
          );
        }

        const buffer = Buffer.from(await image.arrayBuffer());

        uploadedImage = {
          dataUrl: `data:${image.type};base64,${buffer.toString("base64")}`,
        };
      }

      body = {
        prompt: typeof rawPrompt === "string" ? rawPrompt : "",
        messages: parsedMessages,
      };
    } else {
      body = await request.json();
    }
  } catch {
    return Response.json(
      { message: "Invalid request or uploaded image." },
      { status: 400 },
    );
  }
  if (!isRecord(body) || typeof body.prompt !== "string") {
    return Response.json(
      { message: "A valid prompt is required." },
      { status: 400 },
    );
  }
  const prompt = body.prompt.trim();

  if ((!prompt && !uploadedImage) || prompt.length > 1000) {
    return Response.json(
      { message: "Prompt must contain between 1 and 1000 characters." },
      { status: 400 },
    );
  }
  const apiKey = process.env.QLOO_API_KEY;

  const validMessages: ChatMessage[] = Array.isArray(body.messages)
    ? body.messages.filter(
        (message): message is ChatMessage =>
          isRecord(message) &&
          (message.role === "user" || message.role === "assistant") &&
          typeof message.content === "string",
      )
    : [];
  const messages = validMessages.slice(-41);

  const latestPreviousRecommendation = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        Boolean(message.recommendations?.length),
    );

  const previousRecommendationIds = [
    ...new Set(
      latestPreviousRecommendation?.recommendations
        ?.map((item) => item.id)
        .filter((id): id is string => typeof id === "string" && Boolean(id)) ??
        [],
    ),
  ];

  try {
    if (uploadedImage && !prompt) {
      const vision = await interpretPromptWithVision(
        prompt,
        messages,
        uploadedImage,
      );

      const description =
        vision.visualContext || "I couldn't confidently describe this image.";

      if (vision.identifiedEntities.length === 0) {
        return Response.json({
          message: [
            description,
            "",
            "I couldn't confidently identify a recognizable cultural reference in this image.",
            "Try uploading a clearer image or mentioning the title or name.",
          ].join("\n"),
          interests: [],
          recommendations: [],
          targetType: null,
        });
      }

      const recognizedNames = vision.identifiedEntities
        .map((item) => item.name)
        .join(", ");

      return Response.json({
        message: [
          description,
          "",
          "",
          "",
          "Would you like recommendations with the same vibe?",
        ].join("\n"),

        imageContext: vision,

        interests: [],
        recommendations: [],
        targetType: null,
      });
    }

    if (!apiKey) {
      return Response.json(
        { message: "Qloo API key is not configured on the server." },
        { status: 500 },
      );
    }

    let stageStartedAt = Date.now();
    // 1. Collect up to five references from this prompt and prior user turns.
    const visionInterpretation = uploadedImage
      ? await interpretPromptWithVision(prompt, messages, uploadedImage)
      : null;

    const pendingImageContext = getPendingImageContext(messages);

    const interpretationPrompt = visionInterpretation
      ? formatVisionInterpretation(prompt, visionInterpretation)
      : prompt;

    const imageReferenceContext = visionInterpretation ?? pendingImageContext;

    const interpretation = await interpretPromptWithGroq(
      interpretationPrompt,
      messages,
    );

    console.log(
      "[LOOM DEBUG] GROQ INTERPRETATION",
      JSON.stringify(interpretation, null, 2),
    );

    console.log(
      "[LOOM TIMING] Groq interpretation:",
      Date.now() - stageStartedAt,
      "ms",
    );
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

    stageStartedAt = Date.now();

    const resolved = await Promise.all(
      queries.map((query) => {
        const imageEntity = imageReferenceContext?.identifiedEntities.find(
          (item) => normalizeText(item.name) === normalizeText(query),
        );

        const expectedType =
          imageEntity?.type &&
          ENTITY_TYPES.includes(imageEntity.type as EntityType)
            ? (imageEntity.type as EntityType)
            : null;

        return resolveEntity(query, apiKey, expectedType);
      }),
    );

    console.log(
      "[LOOM DEBUG] SOURCE ENTITY TAGS",
      JSON.stringify(
        resolved
          .filter((entity): entity is QlooEntity => entity !== null)
          .map((entity) => ({
            name: entity.name,
            entityId: getEntityId(entity),
            tags:
              (
                entity as QlooEntity & {
                  tags?: Record<string, unknown>[];
                }
              ).tags?.slice(0, 20) ?? [],
          })),
        null,
        2,
      ),
    );

    console.log(
      "[LOOM TIMING] Qloo entity resolution:",
      Date.now() - stageStartedAt,
      "ms",
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
    const normalizedRefinementIntent = normalizeText(
      interpretation.refinementIntent ?? "",
    );
    const isGenericSimilarityRequest =
      /^(similar|same|matching|match)( atmosphere| vibe| style| feeling| feel| taste)?$/.test(
        normalizedRefinementIntent,
      );
    const shouldApplyExplicitRefinement =
      hasRefinement &&
      (interpretation.refinementQueries.length > 0 ||
        !isGenericSimilarityRequest);

    stageStartedAt = Date.now();

    // Discover the seed's own Qloo taste profile for the requested category.
    const tasteProfilesBySeed = await Promise.all(
      seeds.map(async (seed) => ({
        seed,
        tags: await resolveTasteProfileTags(seed.id, targetType, apiKey),
      })),
    );

    const tasteProfileTags = tasteProfilesBySeed.flatMap(
      (profile) => profile.tags,
    );

    console.log(
      "[LOOM DEBUG] IDENTITY ANCHORS",
      JSON.stringify(
        tasteProfilesBySeed.map(({ seed, tags }) => ({
          entity: seed.name,
          entityId: seed.id,
          identityAnchor: tags[0] ?? null,
          supportingTags: tags.slice(1),
        })),
        null,
        2,
      ),
    );

    // Only add concept-search tags for a concrete refinement, not generic "similar vibe" requests.
    const refinementTags = shouldApplyExplicitRefinement
      ? await resolveRefinementTags(
          interpretation.refinementQueries,
          interpretation.refinementIntent,
          targetType,
          apiKey,
        )
      : [];

    const weightedTagMap = new Map<string, WeightedQlooTag>();

    // Base taste profile: preserve all selected Qloo taste signals.
    for (const tag of tasteProfileTags) {
      const existing = weightedTagMap.get(tag.id);

      // If multiple profiles return the same tag, preserve its highest weight.
      if (!existing || tag.weight > existing.weight) {
        weightedTagMap.set(tag.id, tag);
      }
    }

    // Explicit refinements receive weights based on:
    // 1. Priority in the user's requested concepts.
    // 2. Lexical match quality between the query and Qloo tag.
    for (const tag of refinementTags) {
      const boundedMatchScore = Math.max(0, Math.min(100, tag.queryMatchScore));

      const priorityBoost =
        Math.max(0, MAX_SELECTED_TAGS - 1 - tag.queryPriority) *
        REFINEMENT_PRIORITY_STEP;

      const matchBonus = Math.round(
        (boundedMatchScore / 100) * REFINEMENT_MATCH_BONUS_MAX,
      );

      const refinementWeight = Math.min(
        MAX_TAG_WEIGHT,
        REFINEMENT_BASE_WEIGHT + priorityBoost + matchBonus,
      );

      const existing = weightedTagMap.get(tag.id);

      if (existing) {
        // A tag matching both the user's general taste and explicit refinement
        // receives combined influence.
        weightedTagMap.set(tag.id, {
          ...existing,
          weight: Math.min(MAX_TAG_WEIGHT, existing.weight + refinementWeight),
          source: "explicit_refinement",
        });
      } else {
        weightedTagMap.set(tag.id, {
          id: tag.id,
          name: tag.name,
          weight: refinementWeight,
          source: "explicit_refinement",
        });
      }
    }

    const weightedTags = [...weightedTagMap.values()];

    console.log(
      "[LOOM TIMING] Taste profile and refinement tags:",
      Date.now() - stageStartedAt,
      "ms",
    );

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
      tasteProfileTags,
      refinementTags,
      weightedTags,
    });

    // 3. Ask Qloo for recommendations using the resolved entities and weighted Qloo tags.
    const insightsUrl = new URL(`${QLOO_BASE_URL}/v2/insights`);
    insightsUrl.searchParams.set("sort_by", "affinity");
    const excludedEntityIds = [
      ...new Set([
        ...seeds.map((seed) => seed.id),

        ...(interpretation.contextMode === "continuation" &&
        interpretation.requestMore
          ? previousRecommendationIds
          : []),
      ]),
    ];

    const insightsBody: Record<string, unknown> = {
      "filter.type": targetType,
      "signal.interests.entities": seeds.map((seed) => seed.id),
      "filter.exclude.entities": excludedEntityIds.join(","),
      take: INSIGHTS_CANDIDATE_POOL,
      "feature.explainability": true,
    };

    if (weightedTags.length > 0) {
      insightsBody["signal.interests.tags"] = weightedTags.map((tag) => ({
        tag: tag.id,
        weight: tag.weight,
      }));
    }

    console.log("[LOOM DEBUG] INSIGHTS REQUEST", {
      endpoint: `${insightsUrl.origin}${insightsUrl.pathname}`,
      method: "POST",
      body: insightsBody,
    });
    const insightsStartedAt = Date.now();

    let insightsResponse: Response;

    try {
      insightsResponse = await fetch(insightsUrl, {
        method: "POST",
        headers: {
          "X-Api-Key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(insightsBody),
        cache: "no-store",
        signal: AbortSignal.timeout(90000),
      });
    } catch (error) {
      const elapsedMs = Date.now() - insightsStartedAt;
      const errorName = error instanceof Error ? error.name : "UnknownError";
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const timedOut = errorName === "TimeoutError";

      console.error(
        "[LOOM] Qloo Insights request failed before HTTP response",
        {
          errorName,
          errorMessage,
          elapsedMs,
          timeoutMs: 90000,
          take: insightsBody.take,
          entitySignalCount: seeds.length,
          tagSignalCount: weightedTags.length,
          explainability: insightsBody["feature.explainability"],
        },
      );

      if (timedOut) {
        return Response.json(
          {
            message:
              "Qloo Insights did not respond within 60 seconds. " +
              "The request timed out before an HTTP response was received.",
            code: "QLOO_INSIGHTS_TIMEOUT",
          },
          { status: 504 },
        );
      }

      throw error;
    }

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

    const seedNamesById = new Map(seeds.map((seed) => [seed.id, seed.name]));

    const perRecommendationExplainability = entities.map((entity) => {
      const raw = getItemExplainability(entity);

      const signal = isRecord(raw)
        ? raw["signal.interests.entities"]
        : undefined;

      return {
        recommendation: entity.name,
        contributions: Array.isArray(signal)
          ? signal.filter(isRecord).map((item) => ({
              entity:
                typeof item.entity_id === "string"
                  ? (seedNamesById.get(item.entity_id) ?? item.entity_id)
                  : "Unknown",
              score: item.score,
            }))
          : [],
      };
    });

    const rootEntityExplainability =
      isRecord(rootExplainability) &&
      isRecord(rootExplainability["signal.interests.entities"])
        ? rootExplainability["signal.interests.entities"]
        : null;

    const aggregateAllRecs =
      rootEntityExplainability &&
      Array.isArray(rootEntityExplainability.effect_on_all_recs)
        ? rootEntityExplainability.effect_on_all_recs
            .filter(isRecord)
            .map((item) => ({
              entity:
                typeof item.entity_id === "string"
                  ? (seedNamesById.get(item.entity_id) ?? item.entity_id)
                  : "Unknown",
              avg_score: item.avg_score,
            }))
        : [];

    console.log("[LOOM DEBUG] INSIGHTS EXPLAINABILITY", {
      perRecommendation: perRecommendationExplainability,
      aggregateAllRecommendations: aggregateAllRecs,
    });

    // 4. Compact result data and capture per-item explainability.
    const eligibleEntities = entities.filter(
      (entity) =>
        typeof entity.name === "string" && Boolean(getEntityId(entity)),
    );

    // Keep Qloo's affinity as the ranking source; use original API order for ties.
    const rankedEntities = eligibleEntities
      .map((entity, index) => ({
        entity,
        index,
        affinity: getAffinityScore(entity),
      }))
      .sort((a, b) => b.affinity - a.affinity || a.index - b.index)
      .map((item) => item.entity);

    console.log("[LOOM DEBUG] QLOO AFFINITY RANKING", {
      ranking: rankedEntities
        .slice(0, MAX_RECOMMENDATIONS)
        .map((entity, index) => ({
          position: index + 1,
          id: getEntityId(entity),
          name: entity.name,
          affinity: getAffinityScore(entity),
        })),
    });

    const recommendationLimit = interpretation.requestMore
      ? (interpretation.requestedCount ?? MAX_RECOMMENDATIONS)
      : MAX_RECOMMENDATIONS;

    const recommendations = rankedEntities
      .slice(0, recommendationLimit)
      .map((entity) => {
        const itemExplainability = getItemExplainability(entity);
        const contributors = extractContributions(itemExplainability, seeds);

        const allMetadata = getRecommendationMetadata(entity);

        const matchedTasteAttributes = getMatchedTasteAttributes(
          allMetadata,
          weightedTags,
        );

        const metadata = [
          ...new Set([...allMetadata.slice(0, 8), ...matchedTasteAttributes]),
        ];

        const affinityScore = getAffinityScore(entity);
        const affinity = affinityScore > 0 ? affinityScore : null;

        const contributionText = contributors
          .map(
            (item) => `${item.name} (${((item.score ?? 0) * 100).toFixed(1)}%)`,
          )
          .join(", ");

        const whyThisFits =
          contributors.length > 0
            ? `Qloo's contribution scores: ${contributionText}.`
            : "Qloo did not return per-entity contribution data for this recommendation.";

        return {
          id: getEntityId(entity)!,
          name: entity.name!,
          type: getEntityType(entity) ?? targetType,
          imageUrl: getImageUrl(entity),
          description: getShortDescription(entity),
          metadata,
          affinity,
          matchedTasteAttributes,
          whyThisFits,
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
