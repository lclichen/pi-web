import { NextRequest } from "next/server";
import {
  DELETE as deleteWithSegments,
  GET as getWithSegments,
  PATCH as patchWithSegments,
  POST as postWithSegments,
  PUT as putWithSegments,
} from "./[...path]/route";

export const dynamic = "force-dynamic";

// Root alias for /api/files: the file explorer lists the workspace root as an
// EMPTY path, and Next.js catch-all routes don't match /api/files without a
// segment — the initial root listing would 404. Delegate to the catch-all
// handlers with an empty segment list (which normalize back to "/").
type CatchAllCtx = { params: Promise<{ path: string[] }> };
const rootCtx: CatchAllCtx = { params: Promise.resolve({ path: [] }) };

export function GET(req: NextRequest): Promise<Response> {
  return getWithSegments(req, rootCtx);
}

export function PUT(req: NextRequest): Promise<Response> {
  return putWithSegments(req, rootCtx);
}

export function POST(req: NextRequest): Promise<Response> {
  return postWithSegments(req, rootCtx);
}

export function DELETE(req: NextRequest): Promise<Response> {
  return deleteWithSegments(req, rootCtx);
}

export function PATCH(req: NextRequest): Promise<Response> {
  return patchWithSegments(req, rootCtx);
}
