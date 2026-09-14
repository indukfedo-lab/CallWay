"use client";

import Image from "next/image";
import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";

type MainProps = {
  missionId?: string;
};

type message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export default function Main({ missionId }: MainProps) {
  const router = useRouter();

  const [input, setInput] = useState("");
  const [start, setStart] = useState(false);
  const [messages, setMessages] = useState<message[]>([]);
  const [status, setStatus] = useState("idle");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitingForLocation, setWaitingForLocation] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState("");

  const [activeMissionId, setActiveMissionId] = useState<string | null>(
    missionId && missionId !== "new" ? missionId : null,
  );

  useEffect(() => {
    if (!missionId || missionId === "new") return;

    async function loadMission() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      const { data, error } = await supabase
        .from("missions")
        .select("messages")
        .eq("id", missionId)
        .eq("user_id", user!.id)
        .single();

      if (error) {
        setError(error.message);
        return;
      }

      setMessages(data.messages || []);
      setStart(true);
    }

    loadMission();
  }, [missionId]);

  async function saveMessages(
    newMessages: message[],
    id: string | null = activeMissionId,
  ) {
    if (!id) return;

    await supabase
      .from("missions")
      .update({ messages: newMessages })
      .eq("id", id);
  }

  async function sendPrompt(event: React.FormEvent) {
    event.preventDefault();
    // Handle the prompt submission logic here
    const userReq = input.trim();
    if (!userReq || isLoading) return;

    let prompt = userReq;
    let location = null;

    if (waitingForLocation) {
      prompt = pendingPrompt;
      location = userReq;

      setWaitingForLocation(false);
    }

    let currentMissionId = activeMissionId;

    if (!currentMissionId) {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setError("You must be logged in");
        return;
      }

      const { data, error } = await supabase
        .from("missions")
        .insert({
          title: userReq,
          messages: [],
          user_id: user.id,
        })
        .select()
        .single();

      if (error) {
        setError(error.message);
        return;
      }

      currentMissionId = data.id;
      setActiveMissionId(data.id);
    }

    const userMessage: message = {
      id: crypto.randomUUID(),
      role: "user",
      content: userReq,
    };

    const newMessages = [...messages, userMessage];

    setMessages(newMessages);
    await saveMessages(newMessages, currentMissionId);

    setStatus("looking for nearest service provider");
    setIsLoading(true);
    setError(null);
    setStart(true);
    setInput("");

    try {
      const request = await fetch("/api", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt, location: location }),
      });

      const response = await request.json();

      if (response.needsLocation) {
        setPendingPrompt(prompt);
        setWaitingForLocation(true);
        setIsLoading(false);

        const assistantMessage: message = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: response.message,
        };

        const updatedMessages = [...newMessages, assistantMessage];

        setMessages(updatedMessages);
        await saveMessages(updatedMessages, currentMissionId);

        return;
      }

      if (!request.ok) {
        setError(
          response.message || "An error occurred while sending the prompt.",
        );
        setIsLoading(false);
        return;
      }

      let callId = response.id;
      let callIndex = response.callIndex;
      const maxCalls = response.maxCalls;
      const candidates = response.candidates;
      const callObjective = response.callObjective;

      if (!callId) throw new Error("Failed to fetch Call ID");

      setMessages((prev) => {
        const finalMessage = [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant" as const,
            content: "Calling a nearby provider...",
          },
        ];

        saveMessages(finalMessage, currentMissionId);

        return finalMessage;
      });

      let lastStatus = "";

      const polling = async () => {
        try {
          const query = await fetch("/api/call-status", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              callId,
              callIndex,
              maxCalls,
              candidates,
              callObjective,
            }),
          });

          const result = await query.json();

          if (result.switchedProvider) {
            setMessages((prev) => {
              const finalMessage = [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "assistant" as const,
                  content:
                    "Provider are not available, calling other provider...",
                },
              ];

              saveMessages(finalMessage, currentMissionId);

              return finalMessage;
            });

            callId = result.id;
            callIndex = result.callIndex;
          }

          const condition = result.status;

          if (condition !== lastStatus) {
            lastStatus = condition;
            setStatus(condition);

            if (condition !== "completed" && condition !== "failed") {
              let cleanStatus = condition;

              if (condition === "queue") {
                cleanStatus = "Queue";
              } else if (condition === "ringing") {
                cleanStatus = "Ringing";
              } else if (condition === "in_progress") {
                cleanStatus = "In progress";
              }
              setMessages((prev) => {
                const finalMessage = [
                  ...prev,
                  {
                    id: crypto.randomUUID(),
                    role: "assistant" as const,
                    content: cleanStatus,
                  },
                ];

                saveMessages(finalMessage, currentMissionId);

                return finalMessage;
              });
            }
          }

          if (condition == "completed" || condition == "failed") {
            const formedResult = `🔧 ${result.structured_result?.service ?? "Unknown"}
💰 ${result.structured_result?.price ?? "Unknown"}
🕐 ${result.structured_result?.availability ?? "Unknown"}

${result.summary ?? ""}`;

            setMessages((prev) => {
              const finalMessage = [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "assistant" as const,
                  content: formedResult ?? condition,
                },
              ];

              saveMessages(finalMessage, currentMissionId);

              return finalMessage;
            });

            setIsLoading(false);

            if (missionId === "new" || !missionId) {
              router.replace(`/mission/${currentMissionId}`);
            }

            return;
          }

          setTimeout(polling, 2000);
        } catch {
          setError("Failed to check Call status");
          setIsLoading(false);
        }
      };

      polling();
    } catch (error) {
      setError("An error occurred while sending the prompt.");
      setIsLoading(false);
      return;
    }
  }

  return (
    <>
      <section
        className={`hero relative m-0 flex flex-col items-center w-screen h-screen ${start ? "px-[19%] py-[2%]" : ""} bg-yellow-500 bg-[radial-gradient(circle_at_20%_30%,yellow_0%,transparent_50%),radial-gradient(circle_at_80%_20%,gold_0%,transparent_50%),radial-gradient(circle_at_50%_80%,white_0%,transparent_50%)]`}
      >
        <div
          className={`flex flex-col items-center ${start ? "hidden" : ""} mt-[5%] w-full`}
        >
          <Image
            src="/callway_logogray.png"
            alt="Logo"
            width={250}
            height={80}
            className="h-auto w-[32%] hover:scale-110 transition-transform duration-300"
          />
          <h1 className="text-[1.4rem] font-bold text-gray-600 mt-1 hover:scale-105 transition-transform duration-300">
            State your problem and CallWay will find and call techincians nearby
            for you.
          </h1>
        </div>
        <form
          className={`prompt ${
            start
              ? "absolute bottom-[20px] left-1/2 -translate-x-1/2 min-w-[min(640px,80%)]"
              : "w-[70%]"
          } flex flex-col items-center justify-center h-auto mt-8 gap-4`}
          onSubmit={sendPrompt}
        >
          <div className="relative w-full">
            <input
              type="text"
              placeholder="Enter your need here..."
              className="w-full p-4 pr-16 pl-9 rounded-[30px] border border-gray-300 focus:outline-none focus:ring-2 focus:ring-yellow-500 bg-white"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <button
              type="submit"
              aria-label="Submit prompt"
              className="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-yellow-500 text-xl text-white transition-colors hover:bg-yellow-600"
            >
              <svg
                aria-hidden="true"
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 12h14M13 6l6 6-6 6"
                />
              </svg>
            </button>
          </div>
        </form>
        {error && (
          <div className="absolute mt-[10px] bg-white p-[20px] rounded-[20px]">
            {error}
          </div>
        )}
        {start && (
          <div className="messages w-full flex flex-col px-[5%] pb-[100px] gap-[50px]">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`message text-sm ${message.role === "user" ? "bg-[rgba(255,255,255,0.2)] border border-white rounded-[20px] self-end" : "self-start"}  p-[20px] whitespace-pre-line`}
              >
                {message.role === "assistant" && message.content.includes("\n")
                  ? message.content.split("\n").map((line, index) => (
                      <p
                        key={index}
                        className={
                          index === 0
                            ? "font-semibold text-base"
                            : "text-sm text-gray-500"
                        }
                      >
                        {line}
                      </p>
                    ))
                  : message.content}
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
