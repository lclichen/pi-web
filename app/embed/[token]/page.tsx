import { notFound } from "next/navigation";
import { EmbedShell } from "@/components/EmbedShell";
import { I18nProvider } from "@/hooks/useI18n";
import { getEmbedPageContext } from "@/lib/embed-auth";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Token-gated, workspace-scoped chat page for embedding by another product. */
export default async function EmbedPage({ params, searchParams }: PageProps) {
  const { token } = await params;
  const query = await searchParams;
  const requestedSession = typeof query.session === "string" ? query.session : undefined;
  const context = await getEmbedPageContext(token, requestedSession);
  if (!context) notFound();

  return (
    <I18nProvider>
      <EmbedShell
        token={context.token}
        product={context.product}
        scope={context.scope}
        label={context.label}
        mode={context.mode}
        allowedCommands={context.allowedCommands}
        expiresAt={context.expiresAt}
        {...(context.initialSessionId ? { initialSessionId: context.initialSessionId } : {})}
      />
    </I18nProvider>
  );
}
