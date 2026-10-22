"use client";

import { supabase } from "@/lib/supabase";
import { useEffect, useState } from "react";
import { User } from "@supabase/supabase-js";
import { loginWithGoogle } from "@/components/Nav";
import Image from "next/image";
import Sidebar from "@/components/Sidebar";
import Main from "@/components/Main";

export function Welcome() {
  const [loading, setLoading] = useState(true);
  const [loggedIn, setLoggedIn] = useState(false);
  const [prompt, setPrompt] = useState("");

  useEffect(() => {
    const checkUser = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      console.log("USER:", user);
      console.log("USER:", user);
      setLoggedIn(!!user);
      setLoading(false);
    };

    checkUser();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setLoggedIn(!!session?.user);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (loading) return null;

  if (!loggedIn) {
    return (
      <section className="loom-home relative flex min-h-screen w-full flex-col overflow-hidden text-white">
        <div className="silk-field" aria-hidden="true">
          <div className="silk-ribbon silk-ribbon-one" />
          <div className="silk-ribbon silk-ribbon-two" />
          <div className="silk-ribbon silk-ribbon-three" />
          <div className="ocean-glow" />
        </div>

        <header className="fixed z-10 flex items-center justify-between px-6 py-5 sm:px-10 sm:py-7">
          <a
            href="/"
            className="flex items-center gap-3"
            aria-label="Loom AI home"
          >
            <Image
              aria-hidden="true"
              src="/loom-logo.png"
              alt="Loom AI"
              width={32}
              height={32}
              className="w-12 h-auto rounded-full "
            />
            <span className="text-lg font-semibold tracking-wide">
              loom<span className="text-cyan-200">.</span>
            </span>
          </a>
          <div className="flex fixed right-4 items-center gap-3">
            <span className="hidden text-xs font-medium tracking-wide text-slate-300 sm:inline">
              Your personal AI
            </span>
            <button
              onClick={loginWithGoogle}
              className="rounded-full border border-white/20 px-4 py-2 text-sm font-medium text-white/90 transition hover:border-cyan-200/60 hover:bg-white/10"
            >
              Log in
            </button>
          </div>
        </header>

        <main className="relative z-10 mx-auto mt-10rem flex w-full max-w-5xl flex-1 flex-col items-center justify-center px-5 pb-16 pt-10 text-center sm:px-8 sm:pb-24 sm:pt-14">
          <h1 className="max-w-4xl text-5xl font-semibold leading-[1.02] mt-7 tracking-tight text-white sm:text-7xl lg:text-[88px]">
            AI that knows
            <span className="block font-normal text-cyan-100">
              your kind of thing.
            </span>
          </h1>
          <p className="mt-6 max-w-xl text-base leading-7 text-slate-300 sm:text-lg">
            Meet Loom. A thoughtful chatbot that gets to know your taste, so
            every conversation feels a little more like you.
          </p>

          <form
            className="loom-composer mt-10 w-full max-w-2xl text-left"
            onSubmit={(event) => {
              event.preventDefault();
              void loginWithGoogle();
            }}
            onClick={() => {
              if (!loggedIn) {
                loginWithGoogle();
              }
            }}
          >
            <label htmlFor="loom-prompt" className="sr-only">
              Start a conversation with Loom
            </label>
            <textarea
              id="loom-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void loginWithGoogle();
                }
              }}
              rows={2}
              placeholder="Tell Loom what you're in the mood for..."
              className="w-full resize-none bg-transparent px-5 pt-5 text-base leading-6 text-white outline-none placeholder:text-slate-400 sm:px-6"
            />
            <div className="flex items-center justify-between gap-3 px-4 pb-4 pt-2 sm:px-5">
              <span className="text-xs text-slate-400">
                A good place to begin
              </span>
              <button
                type="submit"
                aria-label="Start chatting with Loom"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-cyan-100 text-slate-950 transition hover:scale-105 hover:bg-white"
              >
                <span aria-hidden="true">-&gt;</span>
              </button>
            </div>
          </form>

          <div className="mt-5 flex max-w-2xl flex-wrap justify-center gap-2">
            {[
              "Find my next comfort show",
              "Build a playlist for a rainy day",
              "Help me plan a weekend",
            ].map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => setPrompt(suggestion)}
                className="rounded-full border border-white/15 bg-white/[0.04] px-3.5 py-2 text-xs text-slate-300 transition hover:border-cyan-100/50 hover:bg-white/10 hover:text-white sm:text-sm"
              >
                {suggestion}
              </button>
            ))}
          </div>

          <p className="mt-12 text-xs tracking-wide text-slate-400">
            Your taste, remembered. Your choices, always yours.
          </p>
        </main>
      </section>
    );
  }

  return (
    <>
      <Sidebar />
      <Main />
    </>
  );
}

export default Welcome;