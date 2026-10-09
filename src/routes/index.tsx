import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const Builder = lazy(() => import("@/components/workflow/Builder"));

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "KOMA/flow — Supabase Workflow Builder" },
      { name: "description", content: "Visual workflow builder that chains Supabase edge functions, database functions, queries and role switching via the JS SDK." },
      { property: "og:title", content: "KOMA/flow — Supabase Workflow Builder" },
      { property: "og:description", content: "Chain edge functions, RPCs and role switches on a visual canvas." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index
});

function Index() {
  const fallback = <div className="wf-loading">Loading canvas…</div>;
  return (
    <ClientOnly fallback={fallback}>
      <Suspense fallback={fallback}><Builder /></Suspense>
    </ClientOnly>
  );
}
