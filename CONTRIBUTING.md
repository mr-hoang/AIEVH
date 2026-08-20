# Contributing to AIEV

🇬🇧 English · [🇻🇳 Tiếng Việt](CONTRIBUTING.vi.md)

Thanks for taking the time. This is a small project maintained by Nguyễn Văn Hoàng, so the rules here are short and practical.

## Before you start

- **Small fixes** (typos, docs, an obviously wrong condition): just open a Pull Request.
- **Anything larger** (a new feature, a new page, a change to the render pipeline): open an issue first and describe the problem you are hitting. It saves you from building something that does not fit the architecture.
- Only you can decide if your idea fits, but the project has a clear focus: **finishing a real video faster or better**. Features that do not serve that are usually declined, with thanks.

## Getting the project running

```bash
git clone https://github.com/mr-hoang/AIEVH.git
cd AIEV
npm install
npm run dev          # web on http://localhost:6868, backend on 6869
```

You need **Node.js 22+**, **FFmpeg** on PATH and **Google Chrome**. `node start/doctor.mjs --fix` checks all of it and installs what it can. Claude and Gemini credentials are only needed to actually run the AI parts, not to build or typecheck the code.

## Before you open a Pull Request

Both of these must pass. CI runs exactly the same two commands on every PR:

```bash
npm run typecheck    # server + web + remotion
npm run build        # server + web
```

If you changed anything that renders, also make one real draft video and look at it. Type safety does not tell you a card is covering the subject of an image.

## How the repo is organised

| Path | What it is |
|---|---|
| `apps/web/` | Next.js dashboard (port 6868). Display and control only, never video processing. |
| `apps/server/` | Express backend (port 6869): Claude Agent SDK, render queue, SQLite. The source of truth for job state. |
| `engines/remotion/` | The assembly layer: scenes + footage + audio + captions into the final video. |
| `.claude/skills/` | Production know-how in markdown. This is where lessons live, not in code comments. |
| `docs/API.md` | The backend contract. If you change a route shape, change this file in the same PR. |
| `CLAUDE.md` | Architecture rules and the golden rules of the pipeline. Read it before touching the pipeline. |

## Conventions

- **TypeScript** for everything under `apps/`. Plain JavaScript + GSAP inside HyperFrames compositions (no React in scenes, that is the framework's rule).
- **Commit messages in English**, short, imperative.
- **Skills are written in English**; the web UI, video content and user-facing docs stay **Vietnamese**.
- **Comments explain constraints, not mechanics.** Most comments in this codebase record something that was measured or that broke in production. Keep that style: write down why a number is what it is, not what the next line does.
- **Use regular hyphens** in code, strings and docs, never em-dashes.
- **Colors come from CSS custom properties** (`var(--primary)`), never hardcoded hex in components. See the `webui-design` skill.
- **Windows matters.** Use `path.join`, never hardcode `/` or `\`. Every script must run in PowerShell.
- **The backend owns job state.** The web UI displays what the backend reports and never invents a status of its own.
- **Two style layers do not mix**: Style Design is brand identity (colors, fonts, logo) and is always enforced; a video style is the visual language of a single video (material and motion). See CLAUDE.md section 5.6 before touching prompt construction.

## Things that will get a PR sent back

- A new npm dependency without a reason in the PR description. Every dependency is a supply-chain risk in a project that holds API keys.
- Committing generated or private material: `renders/`, `outputs/`, `imports/`, `video-projects/`, `image-projects/`, `assets/voices/`, `.env`, `*.tsbuildinfo`. These are gitignored for a reason.
- Media files (sound effects, music, fonts, logos) without a clear source and license.
- A change to the render pipeline that skips the draft stage or the QC gate.
- Reformatting a whole file alongside a small fix. It makes the real change impossible to review.

## Contributing a skill

Skills are markdown files under `.claude/skills/<name>/SKILL.md`. They are how the AI learns this project's craft, so the bar is: **write down what you verified, not what you assume**. Read the `skill-authoring` skill first. A skill that says "the fix for X is Y, measured on Z" is worth ten skills full of general advice.

## Review and merge

Open PRs are reviewed by the maintainer. Expect questions rather than instant merges, and do not take a "no" personally. Merges are squashed into a single commit, so you do not need to keep your branch history tidy.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE) that covers this project.
