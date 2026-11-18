import { notFound } from "next/navigation";
import { EmbedAuthGate } from "@/components/EmbedAuthGate";
import { I18nProvider } from "@/hooks/useI18n";
import { getEmbedProjectPageContext } from "@/lib/embed-auth";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Stable project embed page. Authentication is handled in the client gate
 * (product API access token in the hash, or an API-key form fallback).
 */
export default async function EmbedProjectPage({ params, searchParams }: PageProps) {
  const { projectId } = await params;
  const query = await searchParams;
  const requestedSession = typeof query.session === "string" ? query.session : undefined;
  const context = await getEmbedProjectPageContext(projectId, requestedSession);
  if (!context) notFound();

  return (
    <I18nProvider>
      <EmbedAuthGate context={context} />
    </I18nProvider>
  );
}
