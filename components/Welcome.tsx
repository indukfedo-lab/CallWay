"use client";

import Image from "next/image";
import { supabase } from "@/lib/supabase";
import { useEffect, useState } from "react";
import { User } from "@supabase/supabase-js";
import Nav, { loginWithGoogle } from "@/components/Nav";
import Sidebar from "@/components/Sidebar";
import Main from "@/components/Main";

export function Welcome() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkUser = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      console.log("USER:", user);
      setUser(user);
      setLoading(false);
    };

    checkUser();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (loading) return null;

  if (!user) {
    return (
      <section className="hero relative flex min-h-screen w-full flex-col overflow-hidden bg-[radial-gradient(circle_at_50%_42%,#ffd84d_0%,#f5a800_35%,#e87500_70%,#b93b05_100%)] text-stone-950">
        <Nav />

        <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 py-16 text-center sm:py-24">
          <p className="mb-5 rounded-full border border-white/40 bg-white/20 px-4 py-2 text-xs font-bold uppercase tracking-[0.28em] text-stone-900/75 backdrop-blur-sm">
            Help is closer than you think
          </p>
          <div className="logo mb-7 w-full max-w-[460px] drop-shadow-[0_18px_20px_rgba(112,39,0,0.22)] sm:max-w-[600px]">
            <Image
              src="/callway_logogray.png"
              alt="CallWay"
              width={600}
              height={190}
              priority
              className="h-auto w-full"
            />
          </div>
          <h1 className="max-w-3xl text-4xl font-black leading-[0.95] tracking-tight text-stone-950 sm:text-6xl lg:text-7xl">
            The right help, right when you need it.
          </h1>
          <p className="mt-6 max-w-xl text-base leading-7 text-stone-900/75 sm:text-lg">
            Tell us what went wrong. CallWay finds a nearby technician and makes
            the call for you.
          </p>
          <button
            onClick={loginWithGoogle}
            className="mt-9 rounded-full bg-stone-950 px-7 py-4 text-sm font-bold text-white shadow-xl shadow-orange-950/25 transition hover:-translate-y-1 hover:bg-stone-800"
          >
            Start a request <span aria-hidden="true">-&gt;</span>
          </button>
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
