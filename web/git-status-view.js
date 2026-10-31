function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function trackingText(repo) {
  if (repo.detached) return "分离头指针";
  if (repo.upstreamGone) return `上游已删除${repo.upstream ? ` · ${repo.upstream}` : ""}`;
  if (!repo.upstream) return "无上游";
  const ahead = repo.ahead ?? 0;
  const behind = repo.behind ?? 0;
  if (!ahead && !behind) return `与 ${repo.upstream} 同步`;
  const bits = [];
  if (ahead) bits.push(`领先 ${ahead}`);
  if (behind) bits.push(`落后 ${behind}`);
  return bits.join(" · ");
}

function summaryText(data) {
  const repos = Array.isArray(data?.repos) ? data.repos : [];
  if (!repos.length) return "未发现 Git 仓库";
  const dirty = repos.filter((repo) => repo.dirty).length;
  let text = `${repos.length} 个仓库`;
  text += dirty ? ` · ${dirty} 个有变更` : " · 全部干净";
  if (data.truncated) text += " · 结果已截断";
  return text;
}

function repoBlock(repo) {
  const where = repo.relPath === "." ? "工作区根目录" : repo.relPath;
  const branch = repo.detached ? "HEAD" : repo.branch || "—";
  const state = repo.error ? "读取失败" : repo.noCommits ? "尚无提交" : repo.dirty ? "有变更" : "干净";
  const stateClass = repo.error ? "git-state bad" : repo.dirty ? "git-state dirty" : "git-state clean";
  const sha = repo.head ? `<span class="git-sha">${escapeHtml(repo.head)}</span>` : "";
  const subject = repo.subject ? `<span class="git-subject">${escapeHtml(repo.subject)}</span>` : "";
  const files = Array.isArray(repo.files) ? repo.files : [];
  let fileHtml = "";
  if (repo.error) {
    fileHtml = `<p class="git-error">${escapeHtml(repo.error)}</p>`;
  } else if (files.length) {
    const rows = files
      .map((file) => {
        const name = file.origPath
          ? `${file.origPath} → ${file.path}`
          : file.path;
        return `<li class="git-file"><span class="git-code">${escapeHtml(file.code || "")}</span><span class="git-path" title="${escapeHtml(name)}">${escapeHtml(name)}</span><span class="git-label">${escapeHtml(file.label || "")}</span></li>`;
      })
      .join("");
    const more = repo.filesTruncated
      ? `<li class="git-file-more muted">还有更多变更未列出</li>`
      : "";
    fileHtml = `<ul class="git-files">${rows}${more}</ul>`;
  }
  return `<article class="git-repo">
    <div class="git-repo-head">
      <span class="git-where">${escapeHtml(where)}</span>
      <span class="git-branch">${escapeHtml(branch)}</span>
      ${sha}
      <span class="${stateClass}">${state}</span>
      <span class="git-tracking muted">${escapeHtml(trackingText(repo))}</span>
    </div>
    ${subject ? `<p class="git-subject-line">${subject}</p>` : ""}
    ${fileHtml}
  </article>`;
}

/**
 * @param {HTMLElement | null} bodyEl
 * @param {HTMLElement | null} summaryEl
 * @param {object | null} data
 * @param {string | null} error
 */
export function renderGitStatus(bodyEl, summaryEl, data, error) {
  if (summaryEl) {
    summaryEl.textContent = error ? error : summaryText(data);
    summaryEl.classList.toggle("bad", Boolean(error));
  }
  if (!bodyEl) return;
  if (error) {
    bodyEl.innerHTML = `<p class="git-error">${escapeHtml(error)}</p>`;
    return;
  }
  const repos = Array.isArray(data?.repos) ? data.repos : [];
  if (!repos.length) {
    const hint = data?.truncated
      ? "扫描已达上限，未找到 Git 仓库。"
      : "此工作区路径下没有 Git 仓库（根目录或嵌套目录都没有 .git）。";
    bodyEl.innerHTML = `<p class="git-empty muted">${escapeHtml(hint)}</p>`;
    return;
  }
  let note = "";
  if (data.truncated && data.caps) {
    note = `<p class="git-note muted">扫描已达上限（深度 ${escapeHtml(String(data.caps.maxDepth))}、仓库 ${escapeHtml(String(data.caps.maxRepos))}、目录 ${escapeHtml(String(data.caps.maxDirs))}），可能还有未列出的仓库。已跳过 node_modules、vendor 等大目录。</p>`;
  }
  bodyEl.innerHTML = note + repos.map(repoBlock).join("");
}
