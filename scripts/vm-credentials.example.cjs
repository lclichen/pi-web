/**
 * 模板 — 复制为 scripts/vm-credentials.cjs 并填入真实值。
 * vm-credentials.cjs 已被 .gitignore 排除，绝不提交；本模板只含占位符。
 */
module.exports = {
  host: "<your-vm-host>",
  username: "<your-vm-user>",
  password: "<your-vm-password>",
  // VM 上 pi-web 实例的 web 登录账号（smoke 脚本用；环境变量形态
  // VM_APP_<USER>_PASSWORD 可覆盖）。不需要就删掉这段。
  appAccounts: {
    admin: "<admin-web-password>",
    test: "<test-web-password>",
  },
};
