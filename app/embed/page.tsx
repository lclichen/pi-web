import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

/** /embed without a token is not a usable page. */
export default function EmbedIndexPage() {
  notFound();
}
