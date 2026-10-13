---
name: commit-hygiene
description: Example Co commit format — replaces the generic baseline
trigger: every commit
---

# Commit hygiene (Example Co)

This file sits in `overrides/`, so it REPLACES the baseline skill of the
same name rather than sitting alongside it. That is the whole point of the
directory: a pack that could only add skills would leave every project
running a generic default that contradicts the organization's own rule.

Fictional rule, to show the shape: every commit subject starts with the
ticket id, and the body answers "why" before "what".
