import Main from "@/components/Main";
import Sidebar from "@/components/Sidebar";

export default async function page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <main className="flex min-h-screen w-full flex-row">
      <Sidebar />
      <Main missionId={id} />
    </main>
  );
}
