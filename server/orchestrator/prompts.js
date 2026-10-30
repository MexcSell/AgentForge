import { roleInfo, ROLES } from '../roles.js';

export function parseJson(text) {
  if (!text) return null;
  const blocks = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = blocks.length ? blocks.reverse() : [];
  const s = String(text);
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(s.slice(first, last + 1));
  for (const c of candidates) {
    try { return JSON.parse(c.trim()); } catch { /* try next */ }
  }
  return null;
}

const imageNote = (attachments) => {
  const imgs = (attachments || []).filter((a) => a.path);
  return imgs.length ? `\nAttached images (open them with the Read tool):\n${imgs.map((a) => `- ${a.path}`).join('\n')}\n` : '';
};

export function planPrompt({ project, gm, command, attachments, agents, recent }) {
  const roster = agents
    .filter((a) => !['executive', 'evolution', 'analyst', 'optimizer', 'manager'].includes(a.role))
    .map((a) => `- ${a.name} · ${a.role} · L${a.level} · skills: ${a.skills.map((s) => `${s.name}:${s.level}`).join(', ')} · ${a.status}`)
    .join('\n');
  const system = `You are ${gm.name}, General Manager of the software project "${project.name}" inside AgentForge, a hierarchical multi-agent engineering organization.
You receive orders from the user, decompose them into small, independently verifiable task contracts, and staff them from the agent registry. You do not write code yourself.
Rules:
- Split by independently testable outcome, not by file. Prefer 2–8 tasks; very large orders may use up to 14.
- Use "depends_on" so independent tasks run in parallel; serialize tasks that edit the same files.
- Valid roles: ${Object.keys(ROLES).filter((r) => !['executive', 'evolution', 'analyst', 'optimizer', 'manager'].includes(r)).join(', ')}. You may invent a new specialist role (kebab-case) when none fits; the platform will recruit that agent.
- Code-changing work must be followed by an independent verification task (role "reviewer" or "qa") that depends on it.
- If the message is a question or small talk that needs no work, answer it in "reply" and return an empty "tasks" array.
- Never include git commit/push steps: the platform syncs GitHub automatically after the mission.`;
  const prompt = `Project: ${project.name}
Working directory: ${project.path}
Project brief: ${project.description || '(none)'}
${recent ? `Recent missions:\n${recent}\n` : ''}
Agent registry:
${roster || '(empty)'}

ORDER FROM THE USER:
"""
${command}
"""
${imageNote(attachments)}
You may inspect the project files (read-only) to plan precisely. Respond with ONLY one JSON object in a \`\`\`json block:
{
  "analysis": "one or two sentences on what is needed",
  "reply": "optional direct answer to the user (for questions/small talk)",
  "tasks": [
    { "key": "T1", "title": "short imperative title", "role": "frontend", "skills": ["react"],
      "description": "precise scope: what to change and where", "acceptance": ["verifiable criterion"], "depends_on": [] }
  ]
}`;
  return { system, prompt };
}

export function taskPrompt({ project, agent, task, gm, supervisor, deps, mission, attachments, playbook }) {
  const info = roleInfo(agent.role);
  const lessons = (playbook || []).slice(0, 12);
  const system = `You are ${agent.name}, ${agent.title} (tier ${agent.tier}, ${info.department}) in the AgentForge engineering organization.
Mission: ${agent.mission || '-'}
Purpose: ${agent.purpose || '-'}
Skills: ${agent.skills.map((s) => `${s.name} (${s.level}/100)`).join(', ')}
Hierarchy: you received this task from ${gm.name} (General Manager of "${project.name}")${supervisor ? `; your line supervisor is ${supervisor}` : ''}. Report results upward honestly; raise proposals for improvements you notice.
${lessons.length ? `Playbook v${agent.prompt_version} (lessons learned from previous projects):\n${lessons.map((l) => `- ${l}`).join('\n')}` : ''}
Operating rules:
- Stay strictly inside the task scope and the working directory ${project.path}.
- ${info.access === 'write' ? 'You may edit files needed for this task. Keep changes minimal and consistent with the existing code style.' : 'You are read-only: inspect, analyze and report. Do not modify files.'}
- Do not run git commit, git push, or restart services; the platform does that after verification.
- Never print secrets.`;
  const depText = deps.length
    ? `Results from upstream tasks:\n${deps.map((d) => `### ${d.key} ${d.title} (${d.agent_name || 'agent'}, ${d.status})\n${(d.report?.summary || d.result || '').slice(0, 1800)}`).join('\n\n')}\n`
    : '';
  const prompt = `TASK CONTRACT
${JSON.stringify({ task_id: task.key, mission: mission.command.slice(0, 600), project: project.name, role: task.role, goal: task.title, description: task.description, acceptance: task.acceptance, depends_on: task.depends_on }, null, 2)}

${depText}${imageNote(attachments)}
Do the work now. When finished, end your reply with a JSON report in a \`\`\`json block:
{
  "status": "done" | "failed" | "blocked",
  "summary": "what you did and the evidence (tests run, files changed)",
  "artifacts": ["relative/paths/changed/or/created"],
  "lesson": "one reusable lesson for future tasks of this kind",
  "proposals": [{ "title": "follow-up you recommend", "description": "why and what", "role": "role" }],
  "confidence": 0.0
}`;
  return { system, prompt };
}
