"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRouter, usePathname } from "next/navigation";
import { toast } from "sonner";

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

  const pathname = usePathname();
  const [deletingMissionId, setDeletingMissionId] = useState<string | null>(
    null,
  );

  async function performDeleteMission(id: string) {
    if (!user) return;

    setDeletingMissionId(id);

    try {
      const { error } = await supabase
        .from("missions")
        .delete()
        .eq("id", id)
        .eq("user_id", user.id);

      if (error) throw error;

      setMission((previous) => previous.filter((item) => item.id !== id));

      if (pathname === `/mission/${id}`) {
        router.replace("/mission/new");
      }

      toast.success("Chat deleted", {
        description: "Your conversation has been deleted.",
      });
    } catch (error) {
      console.error("DELETE MISSION ERROR:", error);

      toast.error("Failed to delete chat", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setDeletingMissionId(null);
    }
  }

  function deleteMission(id: string) {
    if (!user || deletingMissionId) return;

    toast("Delete this conversation?", {
      description: "This action cannot be undone.",
      duration: 10000,

      action: {
        label: "Delete",
        onClick: () => {
          void performDeleteMission(id);
        },
      },

      cancel: {
        label: "Cancel",
        onClick: () => {},
      },
    });
  }

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
      <section className="relative sidebar flex h-screen w-64 shrink-0 bg-white items-center flex-col overflow-hidden">
        <Image
          src="/loom-header-logo.png"
          alt="Logo"
          width={250}
          height={80}
          className="w-auto h-[80px] mt-[5%] translate-x-[-15%]"
        />
        <Link
          href={`/mission/new`}
          className={`text-lg font-bold text-black mt-10 hover:scale-115 transition-transform duration-300 translate-x-[-10%]`}
        >
          + New Chat
        </Link>
        <p className="text-sm text-gray-500 mt-20 translate-x-[-30%]">
          History
        </p>
        <div className="mt-[10px] w-full px-4 flex-1 min-h-0 overflow-y-auto">
          {mission.map((misi) => (
            <div
              key={misi.id}
              className={`group flex w-full items-center rounded-lg px-3 py-2 transition-colors ${
                pathname === `/mission/${misi.id}`
                  ? "bg-gray-100"
                  : "hover:bg-gray-100"
              }`}
            >
              <Link
                href={`/mission/${misi.id}`}
                className="min-w-0 flex-1 truncate text-sm font-bold text-gray-700"
              >
                {misi.title}
              </Link>

              <button
                type="button"
                aria-label={`Delete ${misi.title}`}
                title="Delete chat"
                disabled={deletingMissionId === misi.id}
                onClick={() => deleteMission(misi.id)}
                className="ml-2 shrink-0 rounded-md p-1.5 text-gray-400 opacity-0 transition-all hover:bg-red-100 hover:text-red-600 group-hover:opacity-100 focus:opacity-100 disabled:opacity-50"
              >
                {deletingMissionId === misi.id ? (
                  <span className="text-xs">...</span>
                ) : (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    className="h-4 w-4"
                  >
                    <path d="M3 6h18" />
                    <path d="M8 6V4h8v2" />
                    <path d="m19 6-1 14H6L5 6" />
                    <path d="M10 11v5M14 11v5" />
                  </svg>
                )}
              </button>
            </div>
          ))}
        </div>
        <div className="mt-auto shrink-0 w-full border-t border-gray-200 p-4 bg-white">
          <button
            type="button"
            onClick={() => setProfileOpen((isOpen) => !isOpen)}
            className="flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-gray-100"
            aria-expanded={profileOpen}
          >
            <div className="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-blue-900">
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
