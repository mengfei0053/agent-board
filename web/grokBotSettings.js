import { validBotSlug } from "./grokBot.js";

const login = document.querySelector("#grok-login");
const check = document.querySelector("#grok-login-check");
const link = document.querySelector("#grok-login-link");
const loginStatus = document.querySelector("#grok-login-status");
const refresh = document.querySelector("#grok-refresh-deployments");
const choices = document.querySelector("#grok-deployments");
const deploymentsStatus = document.querySelector("#grok-deployments-status");
const slug = document.querySelector("#grok-bot-slug");

async function request(resource, method = "GET") {
  const post = method === "POST";
  const response = await fetch(`/api/settings/grok/${resource}`, {
    method, mode: "same-origin", redirect: "error", cache: "no-store",
    headers: { "X-Board-Local": "1", ...(post && { "Content-Type": "application/json" }) },
    body: post ? "{}" : undefined,
  });
  if (!response.ok) throw new Error("Grok settings request failed", { cause: response.status });
  return response.json();
}

function errorText(error) {
  if (error.cause === 403) return "仅允许本机直连操作，请勿通过反向代理访问。";
  if (error.cause === 404) return "当前看板不支持此接口，请升级看板。";
  return "请求失败，请稍后重试。";
}

function clearLink() {
  link.hidden = true;
  link.removeAttribute("href");
}

// Match the literal HTTPS authority and path, allowing only an optional query.
function allowedLoginUrl(raw) {
  return typeof raw === "string" && !/[\s\u0000-\u001f\u007f\\#]/u.test(raw) &&
    /^https:\/\/cursor\.com\/loginDeepControl(?:\?[^#]*)?$/.test(raw);
}

let pollTimer;
async function loadLogin(method, deadline) {
  clearTimeout(pollTimer);
  login.disabled = check.disabled = true;
  let pending = false;
  try {
    const result = await request("login", method);
    if (result.state === "pending") {
      if (result.loginUrl !== undefined) {
        clearLink();
        if (allowedLoginUrl(result.loginUrl)) {
          link.href = result.loginUrl;
          link.hidden = false;
        }
      }
      pending = Date.now() < deadline;
      if (pending) {
        loginStatus.textContent = link.hidden ? "等待 Cursor 授权，暂无可信授权链接。" : "等待授权，请在 Cursor 页面完成登录。";
        pollTimer = setTimeout(() => loadLogin("GET", deadline), 2000);
      } else {
        loginStatus.textContent = "已停止等待，请重新查询登录状态。";
      }
    } else if (result.state === "success") {
      loginStatus.textContent = "Cursor 已登录，可以刷新部署。";
    } else if (result.state === "idle") {
      loginStatus.textContent = "当前没有进行中的登录。";
    } else if (result.state === "failed") {
      // Only display known failure reasons, never CLI output or an arbitrary message.
      if (result.message === "Environment credentials take precedence. Remove them before using browser login.") {
        loginStatus.textContent = "服务器已配置环境凭据，可直接刷新部署，无需浏览器登录。";
      } else if (result.message === "BDK login timed out. Please retry.") {
        loginStatus.textContent = "Cursor 授权已超时，请重新登录。";
      } else {
        loginStatus.textContent = "Cursor 登录失败，请重试。";
      }
    } else {
      throw new Error("Unexpected login state");
    }
  } catch (error) {
    loginStatus.textContent = errorText(error);
  } finally {
    if (!pending) clearLink();
    login.disabled = pending;
    check.disabled = false;
  }
}

login.addEventListener("click", () => {
  clearLink();
  loginStatus.textContent = "正在发起登录…";
  loadLogin("POST", Date.now() + 5 * 60_000);
});
check.addEventListener("click", () => loadLogin("GET", Date.now() + 5 * 60_000));

refresh.addEventListener("click", async () => {
  refresh.disabled = true;
  choices.hidden = true;
  choices.replaceChildren();
  deploymentsStatus.textContent = "正在读取已部署的 Agent…";
  try {
    const { slugs } = await request("deployments");
    if (!Array.isArray(slugs)) throw new Error("Unexpected deployments");
    const valid = [...new Set(slugs.filter(validBotSlug))];
    choices.add(new Option("选择部署以填入 slug", ""));
    for (const value of valid) choices.add(new Option(value, value));
    choices.hidden = valid.length === 0;
    deploymentsStatus.textContent = valid.length ? "选择后将填入 slug，保存设置后生效。" : "没有可选部署，可手动填写 slug。";
  } catch (error) {
    deploymentsStatus.textContent = `${errorText(error)} 仍可手动填写 slug。`;
  } finally {
    refresh.disabled = false;
  }
});
choices.addEventListener("change", () => {
  if (validBotSlug(choices.value)) slug.value = choices.value;
  choices.value = "";
});
