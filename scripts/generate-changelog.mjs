import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_TAG = /^v?\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/;
const GROUPS = {
  feat: ["Features", "新增功能"],
  fix: ["Bug fixes", "问题修复"],
  perf: ["Performance", "性能优化"],
  docs: ["Documentation", "文档更新"],
  other: ["Other changes", "其他变更"],
};

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function classify(subject) {
  const match = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(subject);
  if (!match) return { group: "other", text: subject };
  const [, type, scope, breaking, description] = match;
  return {
    group: Object.hasOwn(GROUPS, type) ? type : "other",
    text: `${scope ? `**${scope}**: ` : ""}${description}${breaking ? " ⚠ BREAKING CHANGE" : ""}`,
  };
}

function render(releases, language) {
  const index = language === "zh" ? 1 : 0;
  const title = index ? "更新日志" : "Changelog";
  const notice = index
    ? "根据 Git 提交自动生成。分类使用中文，变更描述保留提交原文。"
    : "Generated from Git commits. Change descriptions retain their original language.";
  const sections = releases.map(({ version, date, commits }) => {
    const groups = Object.entries(GROUPS).flatMap(([key, labels]) => {
      const entries = commits.filter((commit) => commit.group === key);
      return entries.length
        ? [`### ${labels[index]}\n\n${entries.map(({ text, hash }) => `- ${text} (\`${hash}\`)`).join("\n")}`]
        : [];
    });
    const body = groups.join("\n\n") || (index ? "无变更。" : "No changes.");
    const heading = version ?? (index ? "未发布" : "Unreleased");
    return `## ${heading} (${date})\n\n${body}`;
  });
  return `# ${title}\n\n${notice}\n\n${sections.join("\n\n")}\n`;
}

export function generateChangelog({ cwd = process.cwd(), ref = "HEAD", outputDir = cwd } = {}) {
  // Resolve user-supplied refs to hashes before using them in revision ranges.
  const target = git(cwd, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`);
  if (git(cwd, "rev-parse", "--is-shallow-repository") === "true") {
    throw new Error("Changelog generation requires full Git history and tags (fetch-depth: 0).");
  }
  const tags = git(cwd, "tag", "--merged", target).split("\n").filter((tag) => VERSION_TAG.test(tag));
  const tagsByCommit = new Map();
  for (const tag of tags) {
    const commit = git(cwd, "rev-parse", "--verify", `${tag}^{commit}`);
    const names = tagsByCommit.get(commit) ?? [];
    names.push(tag);
    tagsByCommit.set(commit, names);
  }

  // Only mainline tags delimit releases; tags on merged side branches are not release boundaries.
  const history = git(cwd, "rev-list", "--first-parent", target).split("\n");
  const boundaries = history.filter((commit) => tagsByCommit.has(commit));
  if (boundaries[0] !== target) boundaries.unshift(target);
  const releases = boundaries.map((commit, index) => {
    const previous = boundaries[index + 1];
    const range = previous ? `${previous}..${commit}` : commit;
    const log = git(cwd, "log", "--no-merges", "--format=%h%x09%s", range);
    const commits = log ? log.split("\n").map((line) => {
      const separator = line.indexOf("\t");
      return { hash: line.slice(0, separator), ...classify(line.slice(separator + 1)) };
    }) : [];
    return {
      version: tagsByCommit.get(commit)?.join(" / "),
      date: git(cwd, "show", "-s", "--format=%cs", commit),
      commits,
    };
  });
  mkdirSync(outputDir, { recursive: true });
  for (const [language, filename] of [["en", "CHANGELOG.md"], ["zh", "CHANGELOG.zh.md"]]) {
    writeFileSync(resolve(outputDir, filename), render(releases, language));
  }
  return releases;
}

function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = { "--ref": "ref", "--output-dir": "outputDir" }[args[index]];
    if (!key || !args[index + 1]) {
      throw new Error("Usage: node scripts/generate-changelog.mjs [--ref <tag|commit>] [--output-dir <directory>]");
    }
    options[key] = args[index + 1];
  }
  generateChangelog(options);
  console.log(`Generated CHANGELOG.md and CHANGELOG.zh.md in ${options.outputDir ?? process.cwd()}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`Changelog generation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
