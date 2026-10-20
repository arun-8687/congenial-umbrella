---
name: release-notes
description: Drafts release notes from merged pull requests in the team's house format. Use when asked for release notes, a changelog, or "what shipped".
---

# Release notes

1. Collect the pull requests merged between the two refs (or in the requested time window).
2. Drop bot-only and chore PRs unless they change user-facing behavior.
3. Group the rest under these headings, in this order, omitting empty ones:
   - **Breaking changes**: what breaks and the migration step, first.
   - **New**
   - **Improved**
   - **Fixed**
4. One line per change, in the user's terms rather than the implementation's, ending with the PR link: `(#123)`.
5. Finish with "Thanks to" and the external contributors' @handles, if any.

See `template.md` in this folder for an example.
