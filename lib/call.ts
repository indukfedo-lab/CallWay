type SearchPlot = {
  hasLocation: boolean;
  location: string | null;
  budget: string | null;
  searchQuery: string;
  callObjective: string;
};

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


export async function makeCall(plotSearch: SearchPlot, number: string) {
  const CallEApiKey = process.env.CALLE_API_KEY;

  if (!CallEApiKey) throw new Error("CALL-E API Key is Missing");

  const call = await fetch("https://api.heycall-e.com/v1/calls", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CallEApiKey}`,
      "Idempotency-Key": crypto.randomUUID(),
    },

    body: JSON.stringify({
      task: plotSearch.callObjective,
      recipients: [
        {
          phones: [number],
        },
      ],
      result_schema: CALL_RESULT_SCHEMA,
    }),
  });

  const result = await call.json();

  if (!call.ok) {
    throw new Error(result.message ?? "CALL-E Failed");
  }

  return result;
}