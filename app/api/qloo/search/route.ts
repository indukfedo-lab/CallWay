const QLOO_SEARCH_URL = "https://hackathon.api.qloo.com/search";

const ALLOWED_TYPES = [
  "urn:entity:artist",
  "urn:entity:movie",
  "urn:entity:tv_show",
  "urn:entity:book",
  "urn:entity:place",
  "urn:entity:brand",
  "urn:entity:destination",
  "urn:entity:podcast",
  "urn:entity:video_game",
];

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const query = searchParams.get("query")?.trim();
  const type = searchParams.get("type") ?? "urn:entity:artist";

  if (!query) {
    return Response.json({ error: "Query is required" }, { status: 400 });
  }

  if (query.length > 120 || !ALLOWED_TYPES.includes(type)) {
    return Response.json(
      { error: "Invalid query or entity type" },
      { status: 400 },
    );
  }

  const apiKey = process.env.QLOO_API_KEY;

  if (!apiKey) {
    return Response.json(
      { error: "Qloo API key is not configured on the server" },
      { status: 500 },
    );
  }

  const url = new URL(QLOO_SEARCH_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("types", type);
  url.searchParams.set("take", "5");

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Api-Key": apiKey,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      return Response.json(
        {
          error: "Qloo API request failed",
          status: response.status,
        },
        { status: response.status },
      );
    }

    return Response.json(data);
  } catch {
    return Response.json(
      { error: "Unable to connect to Qloo" },
      { status: 502 },
    );
  }
}
