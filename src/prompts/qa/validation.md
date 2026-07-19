Apply this rubric before deciding:

- Treat only `medium` and `high` severity issues as blocking. A `low` severity issue never by itself prevents `"pass"`.
- If the current iteration count has already reached the maximum allowed, and any blocking issue remains, the decision must be `"failClosed"` — never `"needsRevision"`, since there is no revision budget left to spend.
- If a blocking issue from an earlier pass no longer appears in the current review output, treat it as resolved — do not carry it forward into `remainingIssues`.
- Never decide `"pass"` while a `high` severity issue is present, regardless of how many other issues have been resolved.
