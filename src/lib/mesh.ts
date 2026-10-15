// Mesh view data: every memo is a circle, and two memos are joined when they share tags. The
// approach follows SNS Reader's Mesh View (top tags only, weighted and balanced edges), with a
// small force layout added so memos that share tags end up close together.
import type { Item } from "../types";

export const MESH_SIZE = 1000;
export const MESH_PAN_MARGIN = 180;
const VISIBLE_EDGE_LIMIT = 360;
const TOP_TAG_COUNT = 18;
const FORCE_LAYOUT_MAX_NODES = 400;

export interface MeshEdge {
  from: string;
  to: string;
  sharedTags: string[];
  weight: number;
}

export interface MeshNode {
  item: Item;
  x: number;
  y: number;
  degree: number;
  radius: number;
}

export interface Mesh {
  nodes: MeshNode[];
  /** Edges drawn when no tag is selected. */
  edges: MeshEdge[];
  /** All candidate edges, strongest first (used to highlight one tag). */
  sortedEdges: MeshEdge[];
  topTags: Array<[string, number]>;
}

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Deterministic pseudo-random number in [0, 1), so the same memos always get the same layout. */
function hashToUnit(text: string, salt: number): number {
  let hash = 2166136261 ^ salt;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10000) / 10000;
}

export function edgeKey(from: string, to: string): string {
  return from < to ? `${from}---${to}` : `${to}---${from}`;
}

/**
 * Picks edges so no memo or tag hogs the picture: nodes may start with a couple of lines and gain
 * more only while there is room. With `focusTag` only that tag's lines are chosen.
 */
export function selectBalancedEdges(edges: MeshEdge[], limit: number, focusTag?: string | null): MeshEdge[] {
  const selected: MeshEdge[] = [];
  const selectedKeys = new Set<string>();
  const nodeCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  const tagLimit = focusTag ? limit : Math.max(18, Math.ceil(limit / 10));

  for (const nodeCap of [2, 4, 7, Number.POSITIVE_INFINITY]) {
    for (const edge of edges) {
      if (selected.length >= limit) return selected;
      if (focusTag && !edge.sharedTags.includes(focusTag)) continue;
      const key = edgeKey(edge.from, edge.to);
      if (selectedKeys.has(key)) continue;

      const primaryTag = focusTag ?? edge.sharedTags[0] ?? "";
      const fromCount = nodeCounts.get(edge.from) ?? 0;
      const toCount = nodeCounts.get(edge.to) ?? 0;
      const tagCount = tagCounts.get(primaryTag) ?? 0;
      if (fromCount >= nodeCap || toCount >= nodeCap || (!focusTag && tagCount >= tagLimit)) continue;

      selected.push(edge);
      selectedKeys.add(key);
      nodeCounts.set(edge.from, fromCount + 1);
      nodeCounts.set(edge.to, toCount + 1);
      tagCounts.set(primaryTag, tagCount + 1);
    }
  }
  return selected;
}

/** Circles shrink as the collection grows so a large library stays readable. */
function radiusFor(count: number, degreeRatio: number): number {
  const base = clamp(90 / Math.sqrt(Math.max(1, count)), 3, 15);
  return base * (0.7 + 0.6 * degreeRatio);
}

type Point = { x: number; y: number };

/** Spiral start (busiest memos near the middle), then a short spring layout over the drawn edges. */
function layout(items: Item[], degrees: Map<string, number>, edges: MeshEdge[]): Map<string, Point> {
  const ordered = [...items].sort(
    (a, b) => (degrees.get(b.id) ?? 0) - (degrees.get(a.id) ?? 0) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const maxDegree = Math.max(1, ...degrees.values());
  const golden = Math.PI * (3 - Math.sqrt(5));
  const points = new Map<string, Point>();

  ordered.forEach((item, index) => {
    const ratio = Math.sqrt((degrees.get(item.id) ?? 0) / maxDegree);
    const base = Math.sqrt((index + 0.5) / Math.max(1, ordered.length));
    const radial = clamp(base * (1 - ratio * 0.22) + (hashToUnit(item.id, 31) - 0.5) * 0.08, 0.06, 0.98);
    const angle = index * golden + hashToUnit(item.id + item.createdAt, 17) * 0.42;
    points.set(item.id, {
      x: clamp(MESH_SIZE / 2 + Math.cos(angle) * 438 * radial, 48, 952),
      y: clamp(MESH_SIZE / 2 + Math.sin(angle) * 438 * radial, 48, 952),
    });
  });

  if (ordered.length < 2 || ordered.length > FORCE_LAYOUT_MAX_NODES || !edges.length) return points;

  const ids = ordered.map((item) => item.id);
  const k = Math.sqrt((900 * 900) / ids.length) * 0.7;
  for (let step = 0; step < 140; step += 1) {
    const heat = 40 * (1 - step / 140) + 1;
    const push = new Map<string, Point>(ids.map((id) => [id, { x: 0, y: 0 }]));
    for (let i = 0; i < ids.length; i += 1) {
      const a = points.get(ids[i])!;
      for (let j = i + 1; j < ids.length; j += 1) {
        const b = points.get(ids[j])!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.01) {
          dx = hashToUnit(ids[i], 3) - 0.5;
          dy = hashToUnit(ids[j], 5) - 0.5;
          distance = Math.hypot(dx, dy) || 0.01;
        }
        const force = (k * k) / distance;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        push.get(ids[i])!.x += fx;
        push.get(ids[i])!.y += fy;
        push.get(ids[j])!.x -= fx;
        push.get(ids[j])!.y -= fy;
      }
    }
    for (const edge of edges) {
      const a = points.get(edge.from);
      const b = points.get(edge.to);
      if (!a || !b) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const distance = Math.hypot(dx, dy) || 0.01;
      const force = ((distance * distance) / k) * (1 + 0.4 * (edge.weight - 1));
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      push.get(edge.from)!.x -= fx;
      push.get(edge.from)!.y -= fy;
      push.get(edge.to)!.x += fx;
      push.get(edge.to)!.y += fy;
    }
    for (const id of ids) {
      const point = points.get(id)!;
      const move = push.get(id)!;
      // A weak pull to the middle keeps unconnected memos from drifting to the border.
      move.x += (MESH_SIZE / 2 - point.x) * 0.9;
      move.y += (MESH_SIZE / 2 - point.y) * 0.9;
      const length = Math.hypot(move.x, move.y) || 1;
      const step2 = Math.min(length, heat);
      point.x = clamp(point.x + (move.x / length) * step2, 48, 952);
      point.y = clamp(point.y + (move.y / length) * step2, 48, 952);
    }
  }
  return points;
}

export function buildMesh(items: Item[]): Mesh {
  const tagCounts = new Map<string, number>();
  for (const item of items) for (const tag of item.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);

  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP_TAG_COUNT);
  const visibleTags = new Set(topTags.map(([tag]) => tag));

  const byTag = new Map<string, string[]>();
  for (const item of items) {
    for (const tag of item.tags) {
      if (visibleTags.has(tag)) byTag.set(tag, [...(byTag.get(tag) ?? []), item.id]);
    }
  }

  const degrees = new Map<string, number>();
  const weights = new Map<string, MeshEdge>();
  for (const [tag, ids] of byTag) {
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const key = edgeKey(ids[i], ids[j]);
        const existing = weights.get(key);
        if (existing) {
          existing.sharedTags.push(tag);
          existing.weight += 1;
        } else {
          weights.set(key, { from: ids[i], to: ids[j], sharedTags: [tag], weight: 1 });
        }
        degrees.set(ids[i], (degrees.get(ids[i]) ?? 0) + 1);
        degrees.set(ids[j], (degrees.get(ids[j]) ?? 0) + 1);
      }
    }
  }

  const sortedEdges = [...weights.values()].sort(
    (a, b) => b.weight - a.weight || (degrees.get(b.from) ?? 0) - (degrees.get(a.from) ?? 0),
  );
  const edges = selectBalancedEdges(sortedEdges, VISIBLE_EDGE_LIMIT);
  const points = layout(items, degrees, edges);
  const maxDegree = Math.max(1, ...degrees.values());

  const nodes: MeshNode[] = items.map((item) => {
    const point = points.get(item.id) ?? { x: MESH_SIZE / 2, y: MESH_SIZE / 2 };
    const degree = degrees.get(item.id) ?? 0;
    return { item, x: point.x, y: point.y, degree, radius: radiusFor(items.length, Math.sqrt(degree / maxDegree)) };
  });

  return { nodes, edges, sortedEdges, topTags };
}

export { VISIBLE_EDGE_LIMIT };
