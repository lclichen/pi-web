import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * v1 的共享 KEK 管理接口已移除。
 *
 * v2 的接收方私钥在打包时封进解密二进制，pi-web 只读取公钥元信息；管理面见
 * GET /api/admin/apkg-identity（只读）。旧客户端收到 410 后会停止重试。
 */
function gone() {
  return NextResponse.json(
    {
      error:
        "v1 共享 KEK 管理已移除：.apkg v2 的私钥封装在解密组件中，请查看「加密身份」页（/api/admin/apkg-identity）",
    },
    { status: 410 },
  );
}

export async function GET() {
  return gone();
}

export async function POST() {
  return gone();
}

export async function DELETE() {
  return gone();
}
