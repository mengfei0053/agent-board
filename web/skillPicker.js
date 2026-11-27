// Complete a leading /name, leaving the rest of the prompt to the user.
export function attachSkillPicker(input, menu, getSkills) {
  let pending;
  let matches = [];
  let active = 0;

  function close() {
    pending = undefined;
    menu.hidden = true;
    menu.replaceChildren();
    input.removeAttribute("aria-activedescendant");
    matches = [];
  }

  function highlight() {
    Array.from(menu.children).forEach((el, index) => {
      el.classList.toggle("is-active", index === active);
      el.setAttribute("aria-selected", String(index === active));
    });
    const el = menu.children[active];
    input.setAttribute("aria-activedescendant", el.id);
    el.scrollIntoView({ block: "nearest" });
  }

  function select(name) {
    input.value = `/${name} `;
    close();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function update() {
    const value = input.value;
    const command = /^\/(\S*)$/u.exec(value);
    if (!command) return close();
    menu.hidden = false;
    menu.textContent = "正在读取技能…";
    matches = [];
    active = 0;
    input.removeAttribute("aria-activedescendant");
    const request = pending ??= getSkills();
    try {
      const skills = await request;
      if (request !== pending || input.value !== value) return;
      const query = command[1].toLowerCase();
      matches = skills.filter((name) => name.toLowerCase().includes(query));
      menu.replaceChildren();
      if (!matches.length) {
        menu.textContent = query ? "没有匹配的技能" : "当前 Agent 和工作区没有可列出的技能";
        return;
      }
      matches.forEach((name, index) => {
        const option = document.createElement("button");
        option.type = "button";
        option.tabIndex = -1;
        option.id = `${menu.id}-${index}`;
        option.className = "model-option";
        option.setAttribute("role", "option");
        option.textContent = `/${name}`;
        option.onmousedown = (e) => e.preventDefault();
        option.onclick = () => select(name);
        menu.append(option);
      });
      highlight();
    } catch {
      if (request !== pending) return;
      pending = undefined;
      menu.textContent = "读取技能失败，请重新输入 / 重试";
    }
  }

  input.addEventListener("input", update);
  input.addEventListener("focus", update);
  input.addEventListener("blur", close);
  input.addEventListener("keydown", (e) => {
    if (menu.hidden || e.isComposing || e.keyCode === 229 || e.shiftKey) return;
    if (e.key === "Tab" && (!matches.length || e.ctrlKey || e.altKey || e.metaKey)) return;
    if (!["Escape", "Enter", "Tab", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    e.stopImmediatePropagation(); // Do not submit/enqueue a task or dismiss its dialog.
    if (e.key === "Escape") return close();
    if (!matches.length) return;
    if (e.key === "Tab" || e.key === "Enter") return select(matches[active]);
    active = (active + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
    highlight();
  });
}
