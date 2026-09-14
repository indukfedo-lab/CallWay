"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";

type Mission = {
  id: string;
  title: string;
};

export default function Sidebar() {
  const router = useRouter();

  const [mission, setMission] = useState<Mission[]>([]);
  const [user, setUser] =
    useState<Awaited<ReturnType<typeof supabase.auth.getUser>>["data"]["user"]>(
      null,
    );
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    async function getMissions() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      setUser(user);
      console.log("USER METADATA:", user?.user_metadata);

      if (!user) return;

      const { data, error } = await supabase
        .from("missions")
        .select("id, title")
        .eq("user_id", user!.id)
        .order("created_at", { ascending: false });

      if (error) {
        console.log(error);
        return;
      }

      setMission(data);
    }

    getMissions();
  }, []);

  return (
    <>
      <section className="relative sidebar flex h-screen w-64 shrink-0 bg-white items-center flex-col">
        <Image
          src="/callway_logocropped.png"
          alt="Logo"
          width={250}
          height={80}
          className="w-auto h-[80px] mt-[5%] translate-x-[-15%]"
        />
        <Link
          href={`/mission/new`}
          className={`text-lg font-bold text-black-100 mt-10 hover:scale-115 transition-transform duration-300 translate-x-[-10%]`}
        >
          + New Mission
        </Link>
        <p className="text-sm text-gray-500 mt-20 translate-x-[-30%]">
          History
        </p>
        <div className="mt-[10px] w-full px-4">
          {mission.map((misi) => (
            <Link
              key={misi.id}
              href={`/mission/${misi.id}`}
              className="block truncate font-bold rounded-lg px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
            >
              {misi.title}
            </Link>
          ))}
        </div>
        <div className="absolute bottom-[10px] w-full border-t border-gray-200 p-4">
          <button
            type="button"
            onClick={() => setProfileOpen((isOpen) => !isOpen)}
            className="flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-gray-100"
            aria-expanded={profileOpen}
          >
            <div className="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-yellow-500">
              {user?.user_metadata?.picture ? (
                <img
                  referrerPolicy="no-referrer"
                  src={user.user_metadata.picture}
                  alt="Profile"
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-sm font-bold text-white">
                  {(
                    user?.user_metadata?.name?.[0] ||
                    user?.email?.[0] ||
                    "U"
                  ).toUpperCase()}
                </div>
              )}
            </div>
            <span className="min-w-0 truncate text-sm font-semibold text-gray-800">
              {user?.user_metadata?.name || user?.email || "User"}
            </span>
          </button>
          {profileOpen && (
            <button
              type="button"
              onClick={async () => {
                await supabase.auth.signOut();
                router.push("/");
              }}
              className="mt-2 w-full rounded-lg px-3 py-2 text-left text-sm font-semibold text-red-600 transition-colors hover:bg-red-50"
            >
              Log out
            </button>
          )}
        </div>
      </section>
    </>
  );
}
