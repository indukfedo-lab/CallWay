"use client";

import Image from "next/image";
import React, { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";

type MainProps = {
  missionId?: string;
};

type TasteInterest = {
  id: string;
  name: string;
  type: string | null;
};

type RecommendationContributor = {
  id: string;
  name: string;
  score?: number;
};

type RecommendationCard = {
  id: string;
  name: string;
  type: string;
  imageUrl: string | null;
  description: string | null;
  metadata?: string[];
  affinity?: number | null;
  matchedTasteAttributes?: string[];
  whyThisFits?: string;
  contributors?: RecommendationContributor[];
  explainabilityAvailable: boolean;
};

type SignalValidation = {
  metadataAvailable: boolean;
  confirmed: Array<{
    id: string;
    name: string;
    type: string | null;
    recommendationCount: number;
    aggregateConfirmed: boolean;
  }>;
  notExposed: TasteInterest[];
  warning: string | null;
};

type message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  interests?: TasteInterest[];
  recommendations?: RecommendationCard[];
  signalValidation?: SignalValidation;
  targetType?: string | null;
  imageContext?: {
    visualContext: string;
    identifiedEntities: {
      name: string;
      type: string | null;
    }[];
  };
};

export default function Main({ missionId }: MainProps) {
  const router = useRouter();

  const [input, setInput] = useState("");
  const [start, setStart] = useState(false);
  const [messages, setMessages] = useState<message[]>([]);
  const [status, setStatus] = useState("idle");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!selectedImage) {
      setImagePreview(null);
      return;
    }

    const url = URL.createObjectURL(selectedImage);
    setImagePreview(url);

    return () => URL.revokeObjectURL(url);
  }, [selectedImage]);

  const [activeMissionId, setActiveMissionId] = useState<string | null>(
    missionId && missionId !== "new" ? missionId : null,
  );

  useEffect(() => {
    if (!missionId || missionId === "new") {
      setActiveMissionId(null);
      setMessages([]);
      setStart(false);
      setError(null);
      return;
    }

    const currentMissionId = missionId;

    async function loadMission() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setError("You must be logged in.");
        return;
      }

      const { data, error } = await supabase
        .from("missions")
        .select("messages")
        .eq("id", currentMissionId)
        .eq("user_id", user.id)
        .single();

      if (error) {
        setError(error.message);
        return;
      }

      setActiveMissionId(currentMissionId);
      setMessages(data.messages || []);
      setStart((data.messages || []).length > 0);
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

    const userReq = input.trim();
    const imageFile = selectedImage;

    if ((!userReq && !imageFile) || isLoading) return;

    if (imageFile) {
      setSelectedImage(null);
      setImagePreview(null);

      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }

    setIsLoading(true);
    setError(null);

    let currentMissionId = activeMissionId;

    try {
      // Buat mission baru bila user belum memilikinya.
      if (!currentMissionId) {
        const {
          data: { user },
        } = await supabase.auth.getUser();

        if (!user) {
          throw new Error("You must be logged in.");
        }

        const { data, error } = await supabase
          .from("missions")
          .insert({
            title: userReq || "Image-based recommendations",
            messages: [],
            user_id: user.id,
          })
          .select()
          .single();

        if (error) throw error;

        currentMissionId = data.id;
        setActiveMissionId(data.id);
      }

      const userMessage: message = {
        id: crypto.randomUUID(),
        role: "user",
        content: [
          userReq,
          imageFile ? `[Image attached: ${imageFile.name}]` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };

      const newMessages = [...messages, userMessage];

      setMessages(newMessages);
      setStart(true);
      setInput("");

      if (textareaRef.current) {
        textareaRef.current.style.height = "56px";
      }

      // Simpan pesan user ke Supabase.
      await saveMessages(newMessages, currentMissionId);

      // Kirim prompt dan konteks chat ke backend Loom.
      let request: Response;

      if (imageFile) {
        const formData = new FormData();
        formData.append("prompt", userReq);
        formData.append("messages", JSON.stringify(newMessages));
        formData.append("image", imageFile);

        request = await fetch("/api/chat", {
          method: "POST",
          body: formData,
        });
      } else {
        request = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: userReq,
            messages: newMessages,
          }),
        });
      }

      const response = await request.json();

      if (!request.ok) {
        throw new Error(
          response.message || "An error occurred while sending the prompt.",
        );
      }

      setSelectedImage(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }

      const assistantMessage: message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: response.message,
        interests: response.interests ?? undefined,
        recommendations: response.recommendations ?? undefined,
        signalValidation: response.signalValidation ?? undefined,
        targetType: response.targetType ?? undefined,
        imageContext: response.imageContext ?? undefined,
      };

      const updatedMessages = [...newMessages, assistantMessage];

      setMessages(updatedMessages);

      // Simpan balasan assistant.
      await saveMessages(updatedMessages, currentMissionId);

      // Pertahankan perilaku navigasi mission yang lama.
      if (missionId === "new" || !missionId) {
        router.replace(`/mission/${currentMissionId}`);
      }
    } catch (error) {
      console.error("SEND PROMPT ERROR:", error);

      setError(
        error instanceof Error
          ? error.message
          : "An error occurred while sending the prompt.",
      );
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <>
      <section
        className={`hero relative m-0 flex flex-col items-center w-screen h-screen overflow-hidden bg-[radial-gradient(ellipse_at_50%_45%,rgba(17,79,99,0.5),transparent_48%),linear-gradient(145deg,#071522_0%,#0b1d31_48%,#071522_100%)]`}
      >
        <div
          className={`flex flex-col items-center ${start ? "hidden" : ""} mt-[5%] w-full`}
        >
          <Image
            src="/loom-starter-logo.png"
            alt="Logo"
            width={250}
            height={80}
            className="h-auto w-[32%] hover:scale-110 transition-transform duration-300"
          />
          <h1 className="text-[1.4rem] font-bold text-white-200 mt-1 hover:scale-105 transition-transform duration-300">
            Let's have a chat!
          </h1>
        </div>
        <form
          className={`prompt ${
            start
              ? "absolute bottom-[20px] left-1/2 -translate-x-1/2 w-[min(640px,80%)]"
              : "w-[70%]"
          } flex flex-col items-center justify-center h-auto mt-2 gap-4`}
          onSubmit={sendPrompt}
        >
          <div className="w-full">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;

                if (file.size > 5 * 1024 * 1024) {
                  setError("Image must be 5 MB or smaller.");
                  e.target.value = "";
                  return;
                }

                setError(null);
                setSelectedImage(file);
              }}
            />

            {/* Image preview - separate from input container */}
            {imagePreview && (
              <div className="mb-3 flex w-full items-center gap-3 rounded-xl border border-white/15 bg-white/10 p-2">
                <img
                  src={imagePreview}
                  alt="Selected image"
                  className="h-16 w-16 rounded-lg object-cover"
                />

                <span className="flex-1 truncate text-sm text-white/80">
                  {selectedImage?.name}
                </span>

                <button
                  type="button"
                  onClick={() => {
                    setSelectedImage(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                  className="px-3 text-white/70 hover:text-white"
                >
                  ✕
                </button>
              </div>
            )}

            {/* Input and buttons */}
            <div className="flex w-full items-center gap-2 rounded-[32px] border border-gray-300 bg-white px-3 py-2 focus-within:ring-2 focus-within:ring-blue-900">
              {/* Upload button */}
              <button
                type="button"
                aria-label="Upload image"
                onClick={() => fileInputRef.current?.click()}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="h-5 w-5"
                >
                  <rect x="3" y="3" width="18" height="18" rx="3" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="m21 15-5-5L5 21" />
                </svg>
              </button>

              {/* Textarea */}
              <textarea
                ref={textareaRef}
                rows={1}
                placeholder="Recommend me Movies, Music, Books, Fashion, Travel, More..."
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);

                  const textarea = e.currentTarget;
                  textarea.style.height = "auto";
                  textarea.style.height = `${textarea.scrollHeight}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
                className="min-h-[40px] max-h-40 min-w-0 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-1 py-2 leading-6 text-black placeholder-gray-400 outline-none focus:ring-0"
              />

              {/* Send button */}
              <button
                type="submit"
                aria-label="Submit prompt"
                disabled={isLoading}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-900 text-white hover:bg-blue-800 disabled:opacity-50"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-5 w-5"
                >
                  <path d="M5 12h14" />
                  <path d="m12 5 7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        </form>
        {error && (
          <div className="absolute mt-[10px] bg-white p-[20px] rounded-[20px]">
            {error}
          </div>
        )}
        {start && (
          <div className="messages w-full flex flex-col flex-1 min-h-0 overflow-y-auto px-[25%] pt-[5%] pb-[100px] gap-[50px]">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`message min-w-0 text-sm ${
                  message.role === "user"
                    ? "max-w-[60%] bg-[rgba(255,255,255,0.2)] border border-white rounded-[20px] self-end [overflow-wrap:anywhere]"
                    : "self-start"
                } ${
                  message.role === "assistant" &&
                  message.recommendations?.length
                    ? "w-full max-w-4xl"
                    : ""
                } p-[20px] whitespace-pre-line`}
              >
                {message.role === "assistant" &&
                message.recommendations?.length ? (
                  <div className="w-full space-y-4 text-white">
                    <p className="font-semibold text-base text-white">
                      {message.content}
                    </p>

                    {message.interests?.length ? (
                      <div className="flex flex-wrap gap-2">
                        {message.interests.map((interest) => (
                          <span
                            key={interest.id}
                            className="rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs text-white/80"
                          >
                            {interest.name}
                          </span>
                        ))}
                      </div>
                    ) : null}

                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      {message.recommendations.map((recommendation, index) => (
                        <article
                          key={recommendation.id}
                          className="overflow-hidden rounded-2xl border border-white/15 bg-white/[0.06]"
                        >
                          {recommendation.imageUrl ? (
                            <img
                              src={recommendation.imageUrl}
                              alt={recommendation.name}
                              loading="lazy"
                              referrerPolicy="no-referrer"
                              className="h-44 w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-32 items-center justify-center bg-white/[0.04] text-4xl text-white/30">
                              ✦
                            </div>
                          )}

                          <div className="space-y-3 p-4">
                            <div className="flex items-start gap-3">
                              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-900 text-xs font-semibold">
                                {index + 1}
                              </span>

                              <div className="min-w-0">
                                <h3 className="font-semibold text-white">
                                  {recommendation.name}
                                </h3>

                                <p className="mt-1 text-xs capitalize text-white/50">
                                  {recommendation.type
                                    .replace("urn:entity:", "")
                                    .replaceAll("_", " ")}
                                </p>
                                {typeof recommendation.affinity ===
                                  "number" && (
                                  <p className="mt-1 text-xs text-cyan-200/70">
                                    Qloo affinity:{" "}
                                    {recommendation.affinity.toFixed(3)}
                                  </p>
                                )}
                              </div>
                            </div>

                            {recommendation.description ? (
                              <p className="text-sm leading-relaxed text-white/70">
                                {recommendation.description}
                              </p>
                            ) : (
                              <p className="text-sm italic text-white/45">
                                No short description available from Qloo.
                              </p>
                            )}

                            {recommendation.metadata?.length ? (
                              <div className="space-y-2">
                                <p className="text-xs font-semibold uppercase tracking-wide text-white/50">
                                  Qloo attributes
                                </p>

                                <div className="flex flex-wrap gap-2">
                                  {recommendation.metadata.map(
                                    (item, index) => (
                                      <span
                                        key={`${recommendation.id}-${index}`}
                                        className="rounded-lg border border-white/10 bg-white/[0.06] px-2 py-1 text-xs capitalize text-white/70"
                                      >
                                        {item}
                                      </span>
                                    ),
                                  )}
                                </div>
                              </div>
                            ) : null}

                            <div className="border-t border-white/10 pt-3">
                              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-blue-200">
                                Why this may fit
                              </p>

                              {(recommendation.contributors ?? []).length >
                              0 ? (
                                <div className="flex flex-wrap gap-2">
                                  {recommendation.contributors!.map(
                                    (contributor) => (
                                      <span
                                        key={contributor.id}
                                        className="rounded-lg bg-white/10 px-2 py-1 text-xs text-white/80"
                                      >
                                        {contributor.name}
                                        {typeof contributor.score === "number"
                                          ? ` · ${contributor.score.toFixed(2)}`
                                          : ""}
                                      </span>
                                    ),
                                  )}
                                </div>
                              ) : (
                                <p className="text-xs leading-relaxed text-white/50">
                                  {recommendation.whyThisFits ??
                                    "Qloo did not return per-entity contribution data for this recommendation."}
                                </p>
                              )}
                            </div>
                          </div>
                        </article>
                      ))}
                    </div>

                    {message.signalValidation ? (
                      <div className="space-y-2 rounded-xl border border-white/10 bg-black/10 p-4">
                        <h3 className="text-sm font-semibold text-white">
                          Taste signal validation
                        </h3>

                        {!message.signalValidation.metadataAvailable ? (
                          <p className="text-xs leading-relaxed text-white/60">
                            Qloo did not return readable explainability metadata
                            for this response, so signal contributions could not
                            be verified.
                          </p>
                        ) : (
                          <>
                            <p className="text-xs text-white/70">
                              <span className="font-semibold text-green-300">
                                Exposed by Qloo:
                              </span>{" "}
                              {message.signalValidation.confirmed.length
                                ? message.signalValidation.confirmed
                                    .map((item) => {
                                      const count = item.recommendationCount;
                                      return count > 0
                                        ? `${item.name} (${count} recommendations)`
                                        : `${item.name} (aggregate metadata)`;
                                    })
                                    .join(", ")
                                : "No input signals were identified in the available metadata."}
                            </p>

                            {message.signalValidation.notExposed.length > 0 ? (
                              <p className="text-xs text-white/70">
                                <span className="font-semibold text-amber-200">
                                  Not exposed:
                                </span>{" "}
                                {message.signalValidation.notExposed
                                  .map((item) => item.name)
                                  .join(", ")}
                              </p>
                            ) : null}

                            <p className="text-xs leading-relaxed text-white/45">
                              A signal not exposed in the metadata is not
                              necessarily irrelevant. Qloo may omit low-impact
                              contributions.
                            </p>

                            {message.signalValidation.warning ? (
                              <p className="text-xs text-amber-200">
                                Explainability warning:{" "}
                                {message.signalValidation.warning}
                              </p>
                            ) : null}
                          </>
                        )}
                      </div>
                    ) : null}
                  </div>
                ) : message.role === "assistant" &&
                  message.content.includes("\n") ? (
                  message.content.split("\n").map((line, index) => (
                    <p
                      key={index}
                      className={
                        index === 0
                          ? "font-semibold text-base text-white"
                          : "text-sm text-white/80"
                      }
                    >
                      {line}
                    </p>
                  ))
                ) : (
                  message.content
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
