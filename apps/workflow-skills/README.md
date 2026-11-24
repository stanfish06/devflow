# workflow-skills

The RPI (research, plan, implement) skills that agent sessions run: research questions, research,
design discussion, structure outline, plan, implement, PRD/TDD, PR description, and the iterate-*
variants. The agent-runner passes this folder to every Claude Code session as the `rpi` plugin
(`apps/agent-runner/src/plugins/bundled-rpi-plugin.ts`), so skills are invoked as `rpi:<skill>`.

To use the skills in Claude Code outside devflow, from the repository root:

```
/plugin marketplace add ./apps/workflow-skills
/plugin install rpi@devflow
```
