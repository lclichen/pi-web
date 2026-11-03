/**
 * Browser-tab badge: mirror the sidebar's unread/running counts on the
 * favicon so a background tab shows activity after the completion chime fades.
 * Draws a small canvas icon; restoring writes each link's original href back.
 */

type IconLink = { element: HTMLLinkElement; href: string };

let originalIcons: IconLink[] = [];

function iconLinks(doc: Document): HTMLLinkElement[] {
  return Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
}

function restore(doc: Document): void {
  for (const { element, href } of originalIcons) {
    if (element.isConnected) element.href = href;
  }
  if (originalIcons.length > 0 && iconLinks(doc).length === 0) originalIcons = [];
}

function drawBadge(count: number, color: string, doc: Document): string | null {
  const canvas = doc.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(32, 32, 30, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 34px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(count > 99 ? "99+" : String(count), 32, 35);
  return canvas.toDataURL("image/png");
}

export function applyFaviconBadge(
  counts: { unread: number; running: number },
  doc: Document = document,
): void {
  const links = iconLinks(doc);
  if (links.length === 0) return;
  if (originalIcons.length === 0) {
    originalIcons = links.map((element) => ({ element, href: element.href }));
  }

  const count = counts.unread > 0 ? counts.unread : counts.running;
  if (count <= 0) {
    restore(doc);
    return;
  }

  const dataUrl = drawBadge(count, counts.unread > 0 ? "#f59e0b" : "#3b82f6", doc);
  if (!dataUrl) return;
  for (const link of links) link.href = dataUrl;
}

/** Test seam: forget the captured original links. */
export function resetFaviconBadgeForTests(): void {
  originalIcons = [];
}
