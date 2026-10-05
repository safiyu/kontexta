import { describe, it, expect } from "vitest";
import { gradeShellCommand, gradeEvent, commandVerbs, isHumanPrompt } from "../../src/journal/event-triage.js";

const grade = (cmd: string) => gradeShellCommand(cmd).grade;

describe("gradeShellCommand: reads are noise", () => {
  it.each([
    ["ls -la /tmp"],
    ["cat lib/x.ts; grep -n foo bar.ts"],
    ["git status --short && git log --oneline -3"],
    ["cd /a/b && ls"],
    ["sed -n 1,20p file"],
    ["echo hi > /dev/null"],
    ["ls 2>&1 | head"],
    ["git branch"],
    ["git tag"],
    ["git tag --contains abc123"],
    ["gh pr view 12 --json state"],
    ["gh run list --workflow ci"],
    ["gh api repos/o/r"],
    ["kubectl get pods"],
    ["terraform plan"],
  ])("%s is grade 0", (cmd) => expect(grade(cmd)).toBe(0));

  it("treats navigation alone as noise", () => expect(gradeShellCommand("cd /somewhere")).toMatchObject({ grade: 0 }));
});

describe("gradeShellCommand: text inside heredocs, quotes and PR bodies does not count", () => {
  it("a heredoc that writes a file is a write even if its body says 'assert fail error'", () => {
    expect(grade("cat >> tests/x.test.ts <<'EOF'\ndescribe('assert fail error', () => {})\nEOF")).toBe(2);
  });
  it("an inline script that only prints is routine, however alarming the words", () => {
    expect(grade("python3 - <<'EOF'\nprint('assert fail error crash')\nEOF")).toBe(1);
  });
  it("an inline script that writes files is a state change", () => {
    expect(grade("python3 - <<'EOF'\np='a.css'\nopen(p,'w').write('x')\nEOF")).toBe(2);
    expect(grade("cd /x\npython3 -c \"open('f','w').write('x')\"")).toBe(2);
  });
  it("a PR whose body talks about refactoring and deprecation is a PR, not a critical pivot", () => {
    expect(grade("gh pr create --title t --body \"$(cat <<'EOF'\nrefactor entire module, architecture decision, deprecate\nEOF\n)\"")).toBe(3);
  });
  it("a commit message does not change the grade", () => {
    expect(grade('git commit -m "fix: handle error; assert crash"')).toBe(3);
  });
  it("an unterminated heredoc (hook truncation) hides its body instead of leaking it", () => {
    expect(grade("cp a b; python3 - <<'EOF'\nopen('f','w').write('x')\ngcloud run services update svc --image x")).toBe(2);
  });
});

describe("gradeShellCommand: state changes and milestones", () => {
  it.each([
    ["npm test", 1], ["pnpm build", 1], ["tsc --noEmit", 1], ["curl -s https://x.dev", 1], ["some-unknown-tool --flag", 1],
    ["npm install zod", 2], ["pnpm add -D vitest", 2], ["git add -A", 2], ["git checkout -b feat/x", 2], ["git branch -D old", 2],
    ["git reset HEAD file.ts", 2], ["sed -i '' 's/a/b/' file", 2], ["echo hi > out.txt", 2], ["mv a b", 2], ["rm -rf dist", 2], ["mkdir -p x", 2], ["export FOO=bar", 2],
    ["git commit -m wip", 3], ["git push origin develop", 3], ["git reset --hard origin/develop", 3], ["git tag -d old", 3],
    ["gh api repos/o/r/pulls/44 -X PATCH -f title=x", 3],
    ["git push --force origin main", 4], ["git tag 6.1.0", 4], ["gh pr merge 44 --squash", 4], ["npm publish --access public", 4],
    ["docker push img:tag", 4], ["kubectl apply -f x.yaml", 4], ["terraform apply", 4],
  ])("%s is grade %i", (cmd, want) => expect(grade(cmd)).toBe(want));

  it("takes the highest grade across a compound command", () => {
    expect(grade("cd repo && ls && git push origin main")).toBe(3);
  });
});

describe("commandVerbs", () => {
  it("lists the verbs of a pipeline, skipping navigation", () => {
    expect(commandVerbs("cd /x && grep foo a | head -3")).toEqual(["grep", "head"]);
  });
});

describe("gradeEvent", () => {
  it("grades by event kind", () => {
    expect(gradeEvent({ event: "error" }).grade).toBe(3);
    expect(gradeEvent({ event: "git_commit" }).grade).toBe(3);
    expect(gradeEvent({ event: "agent_note" }).grade).toBe(3);
    expect(gradeEvent({ event: "user_intent" }).grade).toBe(4);
    expect(gradeEvent({ event: "agent_reply" }).grade).toBe(1);
    expect(gradeEvent({ event: "agent_question" }).grade).toBe(2);
  });

  it("grades MCP tool calls by what the tool does", () => {
    expect(gradeEvent({ event: "tool_call", tool: "files_search" }).grade).toBe(0);
    expect(gradeEvent({ event: "tool_call", tool: "files_update" }).grade).toBe(2);
    expect(gradeEvent({ event: "tool_call", tool: "files_read", status: "error" }).grade).toBe(3);
  });

  it("grades a typed prompt above a system message posing as one", () => {
    expect(gradeEvent({ event: "user_prompt", text: "please do the thing now" }).grade).toBe(2);
    expect(gradeEvent({ event: "user_prompt", text: "<task-notification> done" }).grade).toBe(1);
  });

  it("handles a shell event with no command", () => {
    expect(gradeEvent({ event: "shell" }).grade).toBe(1);
  });
});

describe("isHumanPrompt", () => {
  it("rejects agent and system messages, accepts typed text", () => {
    expect(isHumanPrompt("<agent-message from=\"x\"> hi")).toBe(false);
    expect(isHumanPrompt("<system-reminder>x</system-reminder>")).toBe(false);
    expect(isHumanPrompt("fix the login bug")).toBe(true);
    expect(isHumanPrompt(undefined)).toBe(false);
  });
});
