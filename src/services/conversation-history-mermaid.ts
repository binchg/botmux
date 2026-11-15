/** Render a small directed Mermaid flowchart without executing diagram text. */
export function renderLinearFlowchart(source: string, escape: (value: string) => string): string | undefined {
  const lines = source.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const header = /^(?:flowchart|graph)\s+(LR|TB|TD)$/i.exec(lines.shift() ?? '');
  if (!header || !lines.length || lines.length > 24 || source.length > 8000) return;
  const nodes = new Map<string, string>();
  const edges: Array<{ from: string; to: string; label: string }> = [];
  const part = /^([A-Za-z][\w-]*)(?:\["([^"\n]{1,120})"\])?$/;
  for (const line of lines) {
    const match = /^(.+?)\s*-->(?:\|"([^"\n]{1,80})"\|)?\s*(.+)$/.exec(line);
    if (!match) return;
    const from = part.exec(match[1].trim()), to = part.exec(match[3].trim());
    if (!from || !to) return;
    for (const item of [from, to]) {
      if (item[2]) nodes.set(item[1], item[2]);
      else if (!nodes.has(item[1])) nodes.set(item[1], item[1]);
    }
    edges.push({ from: from[1], to: to[1], label: match[2] ?? '' });
  }
  if (nodes.size > 30) return;
  const indegree = new Map([...nodes.keys()].map(id => [id, 0]));
  const outgoing = new Map([...nodes.keys()].map(id => [id, [] as string[]]));
  for (const edge of edges) {
    indegree.set(edge.to, indegree.get(edge.to)! + 1);
    outgoing.get(edge.from)!.push(edge.to);
  }
  const queue = [...nodes.keys()].filter(id => indegree.get(id) === 0);
  const levels = new Map([...nodes.keys()].map(id => [id, 0]));
  let visited = 0;
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]; visited++;
    for (const next of outgoing.get(id)!) {
      levels.set(next, Math.max(levels.get(next)!, levels.get(id)! + 1));
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (visited !== nodes.size) return; // Cycles need a real graph layout engine.
  const columns: string[][] = [];
  for (const id of queue) (columns[levels.get(id)!] ??= []).push(id);
  if (columns.some(column => !column || column.length > 8)) return;
  const horizontal = header[1].toUpperCase() === 'LR';
  const boxW = 174, boxH = 64, gap = 146, rowGap = 82, pad = 24;
  const maxRows = Math.max(...columns.map(column => column.length));
  const width = horizontal ? pad * 2 + columns.length * boxW + (columns.length - 1) * gap : pad * 2 + maxRows * boxW + (maxRows - 1) * rowGap;
  const height = horizontal ? pad * 2 + maxRows * boxH + (maxRows - 1) * rowGap : pad * 2 + columns.length * boxH + (columns.length - 1) * gap;
  const positions = new Map<string, { x: number; y: number }>();
  columns.forEach((column, level) => column.forEach((id, row) => {
    const cross = (maxRows - column.length) * (horizontal ? boxH + rowGap : boxW + rowGap) / 2;
    positions.set(id, { x: pad + (horizontal ? level * (boxW + gap) : row * (boxW + rowGap) + cross),
      y: pad + (horizontal ? row * (boxH + rowGap) + cross : level * (boxH + gap)) });
  }));
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="流程图"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10Z" fill="currentColor"/></marker></defs>`];
  for (const [id, { x, y }] of positions) {
    parts.push(`<rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="12"/><text x="${x + boxW / 2}" y="${y + boxH / 2}" dominant-baseline="middle" text-anchor="middle">${escape(nodes.get(id)!)}</text>`);
  }
  for (const edge of edges) {
    const { x, y } = positions.get(edge.from)!, next = positions.get(edge.to)!;
    const x1 = horizontal ? x + boxW : x + boxW / 2, y1 = horizontal ? y + boxH / 2 : y + boxH;
    const x2 = horizontal ? next.x - 6 : next.x + boxW / 2, y2 = horizontal ? next.y + boxH / 2 : next.y - 6;
    parts.push(`<path class="flow-edge" d="M${x1} ${y1} L${x2} ${y2}" marker-end="url(#arrow)"/>`);
    if (edge.label) parts.push(`<text class="flow-label" x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - (horizontal ? 12 : 8)}" text-anchor="middle">${escape(edge.label)}</text>`);
  }
  return parts.join('') + '</svg>';
}
