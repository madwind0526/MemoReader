import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";

import { categoryHue } from "../lib/media";
import { MESH_PAN_MARGIN, MESH_SIZE, VISIBLE_EDGE_LIMIT, buildMesh, clamp, edgeKey, selectBalancedEdges } from "../lib/mesh";
import type { Item } from "../types";

interface Viewport {
  centerX: number;
  centerY: number;
  zoom: number;
}

const DEFAULT_HOME: Viewport = { centerX: MESH_SIZE / 2, centerY: MESH_SIZE / 2, zoom: 1 };
// Titles next to every circle only stay readable for a few memos; beyond that they show on hover.
const LABEL_ALL_BELOW = 12;

function clampViewport(centerX: number, centerY: number, zoom: number): Viewport {
  const size = MESH_SIZE / zoom;
  const min = size / 2 - MESH_PAN_MARGIN;
  const max = MESH_SIZE - size / 2 + MESH_PAN_MARGIN;
  return { centerX: clamp(centerX, min, max), centerY: clamp(centerY, min, max), zoom };
}

/** Starting view: zoomed in on where the circles are, so a few memos do not sit lost in a big empty map. */
function fitViewport(nodes: Array<{ x: number; y: number }>): Viewport {
  if (!nodes.length) return DEFAULT_HOME;
  const xs = nodes.map((node) => node.x);
  const ys = nodes.map((node) => node.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  // Room around the edge for titles and the circle radius.
  const span = Math.max(maxX - minX, maxY - minY) + 240;
  return clampViewport((minX + maxX) / 2, (minY + maxY) / 2, clamp(MESH_SIZE / span, 1, 4));
}

/**
 * Mesh view: each memo is a circle and memos that share tags are joined by lines (thicker for more
 * shared tags). Drag to pan, wheel to zoom, pick a tag on the right to see only its lines, and
 * click a circle to open the memo.
 */
export function MeshView({ items, onOpen }: { items: Item[]; onOpen: (id: string) => void }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const mesh = useMemo(() => buildMesh(items), [items]);
  const home = useMemo(() => fitViewport(mesh.nodes), [mesh]);
  const [viewport, setViewport] = useState<Viewport>(home);
  const [drag, setDrag] = useState<{ pointerX: number; pointerY: number; centerX: number; centerY: number } | null>(null);
  const moved = useRef(false);
  const [tag, setTag] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const dataKey = `${items.length}:${items[0]?.id ?? ""}:${items.at(-1)?.id ?? ""}`;

  // A different set of memos starts from a fresh view.
  useEffect(() => {
    setViewport(home);
    setDrag(null);
    setTag(null);
    setHovered(null);
    // `home` follows the same memos as `dataKey`; resetting on every layout recompute would undo panning.
  }, [dataKey]);

  const highlighted = useMemo(
    () => (tag ? selectBalancedEdges(mesh.sortedEdges, VISIBLE_EDGE_LIMIT, tag) : []),
    [mesh, tag],
  );
  const highlightedKeys = useMemo(() => new Set(highlighted.map((edge) => edgeKey(edge.from, edge.to))), [highlighted]);
  const background = useMemo(() => mesh.edges.filter((edge) => !highlightedKeys.has(edgeKey(edge.from, edge.to))), [mesh, highlightedKeys]);
  const positions = useMemo(() => new Map(mesh.nodes.map((node) => [node.item.id, node])), [mesh]);

  // The wheel listener is native because React's own wheel handler cannot cancel page scrolling.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = svg.getBoundingClientRect();
      setViewport((current) => {
        const size = MESH_SIZE / current.zoom;
        const originX = clamp(current.centerX - size / 2, -MESH_PAN_MARGIN, MESH_SIZE - size + MESH_PAN_MARGIN);
        const originY = clamp(current.centerY - size / 2, -MESH_PAN_MARGIN, MESH_SIZE - size + MESH_PAN_MARGIN);
        const pointX = originX + ((event.clientX - bounds.left) / bounds.width) * size;
        const pointY = originY + ((event.clientY - bounds.top) / bounds.height) * size;
        const zoom = clamp(current.zoom * (event.deltaY < 0 ? 1.18 : 1 / 1.18), 1, 8);
        const nextSize = MESH_SIZE / zoom;
        // Keep the point under the cursor where it was while the scale changes.
        const nextOriginX = pointX - ((event.clientX - bounds.left) / bounds.width) * nextSize;
        const nextOriginY = pointY - ((event.clientY - bounds.top) / bounds.height) * nextSize;
        return clampViewport(nextOriginX + nextSize / 2, nextOriginY + nextSize / 2, zoom);
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [mesh.nodes.length]);

  const size = MESH_SIZE / viewport.zoom;
  const originX = clamp(viewport.centerX - size / 2, -MESH_PAN_MARGIN, MESH_SIZE - size + MESH_PAN_MARGIN);
  const originY = clamp(viewport.centerY - size / 2, -MESH_PAN_MARGIN, MESH_SIZE - size + MESH_PAN_MARGIN);

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    moved.current = false;
    setDrag({ pointerX: event.clientX, pointerY: event.clientY, centerX: viewport.centerX, centerY: viewport.centerY });
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (!drag || !svgRef.current) return;
    const dx = event.clientX - drag.pointerX;
    const dy = event.clientY - drag.pointerY;
    if (Math.hypot(dx, dy) > 4) moved.current = true;
    const bounds = svgRef.current.getBoundingClientRect();
    setViewport(clampViewport(drag.centerX - (dx / bounds.width) * size, drag.centerY - (dy / bounds.height) * size, viewport.zoom));
  };
  const endDrag = () => setDrag(null);

  const open = (id: string) => {
    // A pan that ends over a circle must not open it.
    if (moved.current) return;
    onOpen(id);
  };

  if (!items.length) {
    return <div className="empty">보여 줄 메모가 없어요.</div>;
  }

  const tagged = mesh.nodes.filter((node) => node.item.tags.length > 0).length;
  const maxTagCount = Math.max(1, ...mesh.topTags.map(([, count]) => count));
  const labelAll = items.length <= LABEL_ALL_BELOW;
  const fontSize = 13 / Math.sqrt(viewport.zoom);

  return (
    <div className="mesh-wrap">
      <div className="mesh-canvas">
        <svg
          ref={svgRef}
          className={drag ? "mesh-svg dragging" : "mesh-svg"}
          viewBox={`${originX} ${originY} ${size} ${size}`}
          role="group"
          aria-label="태그로 연결된 메모 지도"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
          onPointerCancel={endDrag}
        >
          {background.map((edge) => {
            const from = positions.get(edge.from);
            const to = positions.get(edge.to);
            if (!from || !to) return null;
            return (
              <line
                key={`${edge.from}-${edge.to}`}
                className={tag ? "mesh-edge muted" : "mesh-edge"}
                style={{ "--edge-weight": Math.min(4, edge.weight) } as CSSProperties}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
              >
                <title>{edge.sharedTags.map((name) => `#${name}`).join(" ")}</title>
              </line>
            );
          })}
          {highlighted.map((edge) => {
            const from = positions.get(edge.from);
            const to = positions.get(edge.to);
            if (!from || !to) return null;
            return (
              <line
                key={`h-${edge.from}-${edge.to}`}
                className="mesh-edge highlighted"
                style={{ "--edge-weight": Math.min(4, edge.weight) } as CSSProperties}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
              >
                <title>{edge.sharedTags.map((name) => `#${name}`).join(" ")}</title>
              </line>
            );
          })}
          {mesh.nodes.map((node) => {
            const dim = tag !== null && !node.item.tags.includes(tag);
            const showLabel = hovered === node.item.id || (!dim && (labelAll || (tag !== null && node.item.tags.includes(tag))));
            return (
              <g
                key={node.item.id}
                className={`mesh-node${dim ? " dim" : ""}`}
                style={{ "--hue": categoryHue(node.item.category) } as CSSProperties}
                tabIndex={0}
                role="button"
                aria-label={`${node.item.title || "제목 없음"} 열기`}
                onClick={() => open(node.item.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onOpen(node.item.id);
                  }
                }}
                onPointerEnter={() => setHovered(node.item.id)}
                onPointerLeave={() => setHovered(null)}
                onFocus={() => setHovered(node.item.id)}
                onBlur={() => setHovered(null)}
              >
                <circle className="hit" cx={node.x} cy={node.y} r={node.radius + 6} />
                <circle className="dot" cx={node.x} cy={node.y} r={node.radius} />
                {showLabel && (
                  <text x={node.x} y={node.y - node.radius - 6} textAnchor="middle" style={{ fontSize }}>
                    {(node.item.title || "제목 없음").slice(0, 24)}
                  </text>
                )}
                <title>{`${node.item.title || "제목 없음"}${node.item.category ? `\n${node.item.category}` : ""}\n연결 ${node.degree}`}</title>
              </g>
            );
          })}
        </svg>
        <div className="mesh-controls">
          <button type="button" className="btn small" onClick={() => setViewport(home)}>
            처음 위치
          </button>
          <span className="muted">
            메모 {mesh.nodes.length}개 · 연결 {mesh.edges.length}개 · 확대 {Math.round(viewport.zoom * 100)}%
          </span>
        </div>
        {tagged === 0 && <div className="mesh-hint">태그가 달린 메모가 아직 없어서 연결선이 없어요. 정리가 끝나면 태그가 생겨요.</div>}
      </div>

      <aside className="mesh-side" aria-label="태그">
        <h2>자주 쓰인 태그</h2>
        <p className="muted small-text">태그를 누르면 그 태그로 이어진 선만 강조돼요. 같은 색의 원은 같은 카테고리예요.</p>
        <div className="mesh-tags">
          {mesh.topTags.map(([name, count]) => (
            <button
              type="button"
              key={name}
              className={`mesh-tag${tag === name ? " active" : ""}`}
              // How often the tag is used, 0..1. The stylesheet turns it into a bar or a text size.
              style={{ "--ratio": count / maxTagCount } as CSSProperties}
              title={`메모 ${count}개`}
              aria-pressed={tag === name}
              onClick={() => setTag((current) => (current === name ? null : name))}
            >
              <span>#{name}</span>
              <strong>{count}</strong>
            </button>
          ))}
          {!mesh.topTags.length && <span className="muted small-text">아직 태그가 없어요.</span>}
        </div>
      </aside>
    </div>
  );
}
