# Cumulative delivery readiness

Add an optional `delivery` object to the existing v1 manifest only when stage scope is agreed. All task IDs refer to `phases[].tasks`; evidence, owners, weights, and gates stay in those canonical records.

```json
{
  "schemaVersion": 1,
  "activeStage": "alpha",
  "nextMilestoneId": "integrated-alpha",
  "stages": [
    {"id":"alpha","name":"Alpha","taskRefs":["existing-alpha-task"],"milestoneRefs":["integrated-alpha"]},
    {"id":"beta","name":"Beta","taskRefs":["existing-beta-task"],"milestoneRefs":[]},
    {"id":"live","name":"Live launch","taskRefs":["existing-live-task"],"milestoneRefs":[]}
  ],
  "milestones": [
    {"id":"integrated-alpha","name":"Integrated Alpha acceptance","taskRefs":["existing-alpha-task"]}
  ]
}
```

This is the extension value, not a complete manifest. Replace example references with real, validated tasks. Each ordered stage adds to the preceding scope. A repeated task or milestone across stages is counted once; duplicate references within one record are invalid. Every referenced milestone's tasks must lie within that stage's cumulative scope. Milestones need nonempty task scope.

`percent = 100 × accepted task weight / cumulative scoped task weight`. A task qualifies only when its status is complete, its evidence meets the minimum count/tier and is verified/current at calculation time, and its gates are satisfied or explicitly waived. Partial implementation earns no stage acceptance credit. Existing historical score semantics are unchanged. Evidence expiry may lower current readiness without rewriting task history; stale audit and service health are separate observations.

An empty cumulative task scope yields null percent and null remaining task count, not 0% or 100%. Stage denominators and changes remain visible. Record approved scope changes at the project checkpoint; never shrink scope to inflate readiness. Milestone counters count configured milestones only, not a claim that unscoped future work is known.

Use the CLI summary or public projection. Gap output includes public owner labels and actionable next steps, never private owner IDs or evidence locators. RunGlance supplies activity independently: `implemented`, `tested`, and `accepted` are not interchangeable. A task percentage needs measured completed/total units or an explicitly labeled estimate; no fixed percentages for state labels.

Update through existing task/evidence events and milestone checkpoints. Do not create duplicate ledgers, background model polling, or global scheduling rules.
