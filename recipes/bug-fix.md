---
id: bug-fix
title: "Bug fix"
description: "Reproduce a defect, find its cause and verify a focused regression fix."
version: 1
---

Start by locating the reported behaviour and reproducing it with the smallest reliable case. Record the observed result and the expected result. Trace the cause through relevant code before proposing a change.

Create a plan that separates diagnosis, fix, regression coverage and independent review when useful. Make the smallest change that fixes the root cause without broad cleanup. Add or update a regression check that fails before the fix and passes afterwards.

Run the relevant checks and report what was run and its result. The reviewer should inspect the diff for regressions and confirm the original failure is addressed. Attach logs, diffs or other useful evidence to the mission.
