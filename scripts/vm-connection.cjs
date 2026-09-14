/**
 * VM SSH 连接参数 — 凭据绝不硬编码进脚本（教训见 git 历史）。
 * 解析顺序：环境变量 VM_HOST/VM_USER/VM_PASSWORD → 本地不入库的
 * scripts/vm-credentials.cjs（复制 vm-credentials.example.cjs 填写，
 * 已被 .gitignore 排除）。两者都没有时给出可操作的错误提示。
 */
function loadVmConnection() {
  const { VM_HOST, VM_USER, VM_PASSWORD } = process.env;
  if (VM_HOST && VM_USER && VM_PASSWORD) {
    return { host: VM_HOST, username: VM_USER, password: VM_PASSWORD };
  }
  try {
    return require("./vm-credentials.cjs");
  } catch {
    console.error(
      "缺少 VM 凭据。任选其一：\n" +
        "  1) 导出环境变量 VM_HOST / VM_USER / VM_PASSWORD；\n" +
        "  2) cp scripts/vm-credentials.example.cjs scripts/vm-credentials.cjs 并填入真实值（该文件已被 .gitignore 排除，不会入库）。",
    );
    process.exit(1);
  }
}

/**
 * VM 上 pi-web 实例的应用账号密码（web 登录用）。凭据文件里 appAccounts
 * 是 username → password 映射；环境变量形态为 VM_APP_<USER>_PASSWORD
 * （如 VM_APP_ADMIN_PASSWORD、VM_APP_TEST_PASSWORD）。
 */
function loadVmAppPassword(username) {
  const fromEnv = process.env["VM_APP_" + username.toUpperCase() + "_PASSWORD"];
  if (fromEnv) return fromEnv;
  try {
    const creds = require("./vm-credentials.cjs");
    const pw = creds.appAccounts && creds.appAccounts[username];
    if (pw) return pw;
  } catch {
    // fall through to the actionable error below
  }
  console.error(
    "缺少 VM 应用账号密码（" + username + "）。任选其一：\n" +
      "  1) 导出环境变量 VM_APP_" + username.toUpperCase() + "_PASSWORD；\n" +
      "  2) 在 scripts/vm-credentials.cjs 的 appAccounts 里补一条（该文件不入库）。",
  );
  process.exit(1);
}

module.exports = { loadVmConnection, loadVmAppPassword };
