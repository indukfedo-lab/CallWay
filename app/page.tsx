import Image from "next/image";
import Welcome from "@/components/Welcome";
import Sidebar from "@/components/Sidebar";
import Main from "@/components/Main";

export default function Home() {
  return (
    <main className="flex min-h-screen w-full flex-row">
      <Welcome />
    </main>
  );
}
