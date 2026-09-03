import {
  DELETE as deleteWithSegments,
  GET as getWithSegments,
  PATCH as patchWithSegments,
  POST as postWithSegments,
  PUT as putWithSegments,
} from "./[...path]/route";

export const dynamic = "force-dynamic";

// Root alias for /api/remotefs: the client encodes the workspace root ("/")
// as an EMPTY path, and Next.js catch-all routes don't match /api/remotefs
// without a segment — the file explorer's initial root listing would 404.
// Delegate to the catch-all handlers with an empty segment list (which the
// handlers normalize back to "/").
type CatchAllCtx = { params: Promise<{ path: string[] }> };
const rootCtx: CatchAllCtx = { params: Promise.resolve({ path: [] }) };

export function GET(req: Request): Promise<Response> {
  return getWithSegments(req, rootCtx);
}

export function PUT(req: Request): Promise<Response> {
  return putWithSegments(req, rootCtx);
}

export function DELETE(req: Request): Promise<Response> {
  return deleteWithSegments(req, rootCtx);
}

export function PATCH(req: Request): Promise<Response> {
  return patchWithSegments(req, rootCtx);
}

// POST（上传 upload-check / multipart upload）同样委托——根路由别名漏了它时，
// 远程会话在根目录（"/" 编码为空路径）上传会得到无 body 的 405。
export function POST(req: Request): Promise<Response> {
  return postWithSegments(req, rootCtx);
}
