"use client";

import Image from "next/image";
import { supabase } from "@/lib/supabase";

export const loginWithGoogle = async () => {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
  });

  if (error) {
    console.error(error);
  }
};

function Nav() {
  return (
    <>
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(115deg,rgba(255,255,255,0.22),transparent_35%,rgba(120,32,0,0.18))]" />
      <nav className="relative z-10 grid w-full grid-cols-[1fr_auto_1fr] items-center border-b border-white/30 bg-white/15 px-5 py-5 backdrop-blur-md sm:px-10">
        <a
          href="/"
          className="logo justify-self-start"
          aria-label="CallWay home"
        >
          <Image
            src="/callway_logogray.png"
            alt="Logo"
            width={250}
            height={80}
            className="h-auto w-[135px] sm:w-[165px]"
          />
        </a>
        <ul className="flex items-center gap-5 text-sm font-semibold tracking-wide sm:gap-10 sm:text-base">
          <li>
            <a
              className="text-stone-900/80 transition-colors hover:text-white"
              href="/"
            >
              Home
            </a>
          </li>
          <li>
            <a
              className="text-stone-900/80 transition-colors hover:text-white"
              href="/about"
            >
              About
            </a>
          </li>
          <li>
            <a
              className="text-stone-900/80 transition-colors hover:text-white"
              href="/contact"
            >
              Contact
            </a>
          </li>
        </ul>
        <div className="login-signup flex items-center justify-self-end gap-2 sm:gap-3">
          <button
            onClick={loginWithGoogle}
            className="rounded-full border border-stone-900/20 bg-white/20 px-3 py-2 text-xs font-semibold text-stone-900 transition hover:bg-white/40 sm:px-5 sm:text-sm"
          >
            Log In
          </button>
          <button className="rounded-full bg-stone-950 px-3 py-2 text-xs font-semibold text-white shadow-lg shadow-orange-950/20 transition hover:-translate-y-0.5 hover:bg-stone-800 sm:px-5 sm:text-sm">
            Sign Up
          </button>
        </div>
      </nav>
    </>
  );
}

export default Nav;
