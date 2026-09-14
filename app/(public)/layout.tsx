import Nav from "@/components/Nav";

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <section className="relative min-h-screen w-full overflow-hidden bg-[radial-gradient(circle_at_50%_42%,#ffd84d_0%,#f5a800_35%,#e87500_70%,#b93b05_100%)] text-stone-950">
      <Nav />
      {children}
    </section>
  );
}
