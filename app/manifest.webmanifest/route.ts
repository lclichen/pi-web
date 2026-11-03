import { NextResponse } from "next/server";

// Read at request time so a deployment can rename the installed app without a
// rebuild (`PI_WEB_APP_NAME`); a static app/manifest.ts would bake the name in
// at build time.
export const dynamic = "force-dynamic";

const DEFAULT_APP_NAME = "amedac.ai WebUI";

function appName(): string {
  const configured = process.env.PI_WEB_APP_NAME?.trim();
  return configured || DEFAULT_APP_NAME;
}

export function GET() {
  const name = appName();
  return NextResponse.json(
    {
      id: "/",
      name,
      short_name: name,
      description: "Local web interface for the pi coding agent",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#1a1a1a",
      categories: ["developer", "productivity"],
      lang: "en",
      icons: [
        {
          src: "/icons/icon-192.png",
          sizes: "192x192",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "/icons/icon-512.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "any",
        },
      ],
    },
    {
      headers: {
        "Content-Type": "application/manifest+json; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    },
  );
}
