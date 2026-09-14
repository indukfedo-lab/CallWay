import { NextResponse } from "next/server";
import { makeCall } from "@/lib/call";
import Groq from "groq-sdk";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const PLACES_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";

const PLACES_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.googleMapsUri",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
].join(",");

const CALL_RESULT_SCHEMA = {
  type: "object",
  required: ["can_help", "service", "price", "availability"],
  properties: {
    can_help: {
      type: "string",
      enum: ["yes", "no", "unknown"],
      description:
        "Whether the provider can help with the customer's request. Use 'unknown' if this cannot be determined.",
    },

    service: {
      type: "string",
      description:
        "The service or solution the provider says they can offer. Use 'unknown' if not provided.",
    },

    price: {
      type: "string",
      description:
        "The approximate price or price range given by the provider. Use 'unknown' if not provided.",
    },

    availability: {
      type: "string",
      description:
        "When the provider says they are available or how soon they can provide the service. Use 'unknown' if not provided.",
    },
  },

  additionalProperties: false,
};

type SearchPlot = {
  hasLocation: boolean;
  location: string | null;
  budget: string | null;
  searchQuery: string;
  callObjective: string;
};

type GooglePlaces = {
  id: string;
  displayName: string;
  formattedAddress: string;
  location: {
    latitude: number;
    longitude: number;
  };
  googleMapsUri: string;
  internationalPhoneNumber: string;
  websiteUri: string;
  rating: number;
  userRatingCount: number;
};

type RankedPhoneNumber = GooglePlaces & {
  score: number;
};

async function SearchPlotter(
  input: string,
  location: string | null,
): Promise<SearchPlot> {
  const query = await groq.chat.completions.create({
    model: "openai/gpt-oss-20b",

    messages: [
      {
        role: "system",
        content: `
        You are the planning system for CallWay.

Analyze the user's request and the provided location.

Your job is to determine:

1. Whether a location was provided.
2. The location, or null if none was provided.
3. The type of business/service provider needed.
4. A clear Google Places search query.
5. The user's budget, or null if none was provided.
6. A clear and safe objective for the CALL-E AI phone agent.

IMPORTANT FOR callObjective:

The CALL-E agent will autonomously handle the phone conversation.
Write the objective as a clear set of instructions for the agent.

The objective MUST:
- Explain why the agent is calling.
- Describe the customer's actual need.
- Tell the agent what information to obtain from the provider.
- Tell the agent to identify itself as an AI assistant calling on behalf of a customer.
- Tell the agent NOT to make bookings, purchases, payments, or commitments.
- Tell the agent not to invent or assume information.
- Tell the agent to politely end the call if the provider cannot help.
- Keep the conversation focused and reasonably concise.
- Tell the agent to summarize the provider's response when finished.
- If a location is provided, determine the most appropriate language for the CALL-E agent based on that location and instruct the agent to conduct the call in that language.
- If no location is provided, default to English for the CALL-E agent.

The agent should gather information for the customer, not make decisions on the customer's behalf.

For example, if the customer needs a car repair service, the objective should instruct the agent to ask whether the provider can help, what services are available, approximate pricing if available, and availability.

If the user's request contains a budget, include it in the objective.
Do not invent a budget if none was provided.

Return ONLY valid JSON in this exact format:

{
  "hasLocation": boolean,
  "location": string or null,
  "budget": string or null,
  "searchQuery": string,
  "callObjective": string
}
`,
      },

      {
        role: "user",
        content: JSON.stringify({
          input: input,
          location: location,
        }),
      },
    ],

    temperature: 0.2,
  });

  const result = query.choices[0]?.message?.content;

  if (!result) throw new Error("Groq returns nothing");

  const cleanContent = result
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    const parsedResult = JSON.parse(cleanContent);

    if (
      typeof parsedResult.hasLocation !== "boolean" ||
      (parsedResult.location !== null &&
        typeof parsedResult.location !== "string") ||
      (parsedResult.budget !== null &&
        typeof parsedResult.budget !== "string") ||
      typeof parsedResult.searchQuery !== "string" ||
      typeof parsedResult.callObjective !== "string"
    ) {
      throw new Error("Invalid search plot from Groq");
    }

    return parsedResult as SearchPlot;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Invalid search plot from Groq"
    ) {
      throw error;
    }

    throw new Error("Failed to parse Groq result");
  }
}

async function SearchPlaces(
  searchQuery: string,
  apiKey: string,
): Promise<GooglePlaces[]> {
  const placeQuery = await fetch(PLACES_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": PLACES_FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery: searchQuery,
      languageCode: "en",
      maxResultCount: 10,
    }),
    cache: "no-store",
  });

  const result = (await placeQuery.json()) as {
    places?: GooglePlaces[];
    error?: {
      message?: string;
    };
  };

  if (!placeQuery.ok) {
    throw new Error(result.error?.message ?? "Failed to search for places");
  }

  return result.places ?? [];
}

async function rankPhoneNumbers(
  plotSearch: SearchPlot,
): Promise<RankedPhoneNumber[]> {
  const placesApiKey = process.env.PLACES_API_KEY;

  if (!placesApiKey) throw new Error("Places API Key is Missing");

  const searchPlace = await SearchPlaces(plotSearch.searchQuery, placesApiKey);

  return searchPlace
    .filter((p) => Boolean(p.internationalPhoneNumber))
    .map((place) => {
      let score = 0;
      if (place.rating) {
        score += place.rating * 10;
      }

      if (place.userRatingCount) {
        score += Math.min(Math.log10(place.userRatingCount + 1) * 5, 20);
      }

      return {
        ...place,
        score,
      };
    })
    .sort((a, b) => b.score - a.score);
}

export async function POST(req: Request) {
  try {
    const query = await req.json();

    console.log("API QUERY:", query);
    console.log("LOCATION:", query.location);

    if (typeof query.prompt !== "string" || !query.prompt.trim()) {
      return NextResponse.json(
        { message: "Prompt is required" },
        { status: 400 },
      );
    }

    if (!query.location || !query.location.trim()) {
      return NextResponse.json(
        {
          message: `Where exactly is the service needed?
Please provide the specific street name, house/building number, block, or other detailed location.`,
          needsLocation: true,
        },
        { status: 200 },
      );
    }

    const plotSearch = await SearchPlotter(query.prompt, query.location);

    console.log("SEARCH PLOT:", plotSearch);

    const places = await rankPhoneNumbers(plotSearch);

    console.log("PLACES:", places);

    if (!places[0]) throw new Error("No business or service provider found");

    console.log("Selected provider:", places[0]);

    const candidates = places.slice(0, 3);

    console.log("CANDIDATES: ", candidates);

    if (process.env.CALLE_DRY_RUN === "true")
      return Response.json({
        id: "ABC123",
        status: "queue",
        dryRun: true,
        callIndex: 0,
        maxCalls: candidates.length,
        candidates,
        callObjective: plotSearch.callObjective,
      });

    const call = await makeCall(plotSearch, places[0].internationalPhoneNumber);

    return Response.json({
      id: call.id,
      status: call.status,
      callIndex: 0,
      maxCalls: candidates.length,
      candidates,
      callObjective: plotSearch.callObjective,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        message:
          error instanceof Error ? error.message : "Something went wrong",
      },
      { status: 500 },
    );
  }
}
