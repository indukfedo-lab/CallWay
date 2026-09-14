import { makeCall } from "@/lib/call";

type SearchPlot = {
  hasLocation: boolean;
  location: string | null;
  budget: string | null;
  searchQuery: string;
  callObjective: string;
};

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const { callId, callIndex, maxCalls, candidates, callObjective } =
    await request.json();

  if (!callId)
    return Response.json({ message: "Call ID is required" }, { status: 400 });

  if (process.env.CALLE_DRY_RUN === "true") {
    return Response.json({
      id: callId,
      status: "completed",
      task_completed: true,
      summary:
        "DRY RUN: CallWay found a suitable service provider. No real call was made.",
      structured_result: {
        can_help: "yes",
        service: "Car repair",
        price: "Rp500,000",
        availability: "Tomorrow afternoon",
      },
    });
  }

  const req = await fetch(`https://api.heycall-e.com/v1/calls/${callId}`, {
    headers: {
      Authorization: `Bearer ${process.env.CALLE_API_KEY}`,
    },
  });

  const result = await req.json();

  if (result.status !== "completed" && result.status !== "failed") {
    return Response.json(result);
  }

  // Provider can help → DONE
  if (result.structured_result?.can_help === "yes") {
    return Response.json(result);
  }

  // No more providers → DONE
  if (callIndex + 1 >= maxCalls) {
    return Response.json(result);
  }

  // Try next provider
  const nextIndex = callIndex + 1;
  const nextPhone = candidates[nextIndex].internationalPhoneNumber;

  const nextCall = await makeCall({ callObjective } as SearchPlot, nextPhone);

  return Response.json({
    ...nextCall,
    callIndex: nextIndex,
    maxCalls,
    candidates,
    callObjective,
    switchedProvider: true,
  });
}
