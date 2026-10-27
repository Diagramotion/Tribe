---
id: code-review
title: "Code review"
description: "Review a change for correctness, security and operational reliability."
version: 1
---

Inspect the requested change and its surrounding code before forming conclusions. Understand the intended behaviour, scope and relevant tests. Do not edit files unless the mission explicitly asks for remediation.

Prioritise actionable findings in order of severity. For each finding, identify the affected file and line, explain the failure mode and give a concrete scenario. Check correctness, security, data integrity, concurrency and operational recovery where relevant. Distinguish confirmed defects from questions or suggestions.

If no blocking findings remain, summarise the reviewed scope, checks performed and any material residual risks. Attach review notes or test output as mission artifacts.
