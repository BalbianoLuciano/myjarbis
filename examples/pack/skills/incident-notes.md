---
name: incident-notes
description: How Example Co writes up an incident
trigger: an outage, a rollback, a post-mortem
---

# Incident notes

Fictional content, included to show the file shape.

Write the incident up as a single note with `topic_key: incidents/<date>`,
so re-saving it as more becomes known updates the same note instead of
leaving three partial accounts to reconcile.

Record, in this order: what the user saw, when it started, what the cause
turned out to be, and what stops it recurring. Link the commit that fixed
it with `add_ref`, rather than pasting the diff.
