/**
 * Procedural mesh generation + OBJ export (original).
 * Meshy/Tripo-inspired local workflow — not those products; no cloud ML weights.
 */

/** @typedef {{ x:number,y:number,z:number }} Vec3 */
/** @typedef {{ vertices: Vec3[], faces: number[][] }} Mesh */

/** @returns {Mesh} */
export function boxMesh(sx = 1, sy = 1, sz = 1) {
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  const vertices = [
    { x: -hx, y: -hy, z: -hz },
    { x: hx, y: -hy, z: -hz },
    { x: hx, y: hy, z: -hz },
    { x: -hx, y: hy, z: -hz },
    { x: -hx, y: -hy, z: hz },
    { x: hx, y: -hy, z: hz },
    { x: hx, y: hy, z: hz },
    { x: -hx, y: hy, z: hz },
  ];
  const faces = [
    [1, 2, 3, 4],
    [5, 8, 7, 6],
    [1, 5, 6, 2],
    [2, 6, 7, 3],
    [3, 7, 8, 4],
    [5, 1, 4, 8],
  ];
  return { vertices, faces };
}

/** @returns {Mesh} */
export function uvSphereMesh(rings = 12, segments = 16, radius = 1) {
  /** @type {Vec3[]} */
  const vertices = [];
  for (let y = 0; y <= rings; y += 1) {
    const v = y / rings;
    const phi = v * Math.PI;
    for (let x = 0; x <= segments; x += 1) {
      const u = x / segments;
      const theta = u * Math.PI * 2;
      vertices.push({
        x: radius * Math.sin(phi) * Math.cos(theta),
        y: radius * Math.cos(phi),
        z: radius * Math.sin(phi) * Math.sin(theta),
      });
    }
  }
  /** @type {number[][]} */
  const faces = [];
  const stride = segments + 1;
  for (let y = 0; y < rings; y += 1) {
    for (let x = 0; x < segments; x += 1) {
      const a = y * stride + x;
      const b = a + stride;
      faces.push([a + 1, b + 1, b + 2, a + 2]);
    }
  }
  return { vertices, faces };
}

/** Simple heightfield terrain. @returns {Mesh} */
export function terrainMesh(res = 24, size = 2, seed = 1) {
  const vertices = [];
  for (let z = 0; z <= res; z += 1) {
    for (let x = 0; x <= res; x += 1) {
      const u = x / res;
      const v = z / res;
      const h =
        Math.sin((u * 6 + seed) * 1.7) * 0.15 +
        Math.cos((v * 5 + seed * 0.3) * 2.1) * 0.12 +
        Math.sin((u + v) * 8 + seed) * 0.05;
      vertices.push({ x: (u - 0.5) * size, y: h, z: (v - 0.5) * size });
    }
  }
  const faces = [];
  const stride = res + 1;
  for (let z = 0; z < res; z += 1) {
    for (let x = 0; x < res; x += 1) {
      const a = z * stride + x;
      faces.push([a + 1, a + 2, a + stride + 2, a + stride + 1]);
    }
  }
  return { vertices, faces };
}

/**
 * Map a free-text prompt to a procedural mesh (deterministic keyword router).
 * Not a neural Meshy model — DOCUMENTED limitation.
 * @param {string} prompt
 * @returns {{ kind: string, mesh: Mesh }}
 */
export function meshFromPrompt(prompt) {
  const p = String(prompt || '').toLowerCase();
  if (/\b(sphere|ball|orb|planet)\b/.test(p)) return { kind: 'sphere', mesh: uvSphereMesh() };
  if (/\b(terrain|landscape|hills|ground)\b/.test(p)) {
    const seed = [...p].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 97;
    return { kind: 'terrain', mesh: terrainMesh(20, 2, seed || 1) };
  }
  return { kind: 'box', mesh: boxMesh() };
}

/** @param {Mesh} mesh */
export function toObj(mesh) {
  const lines = ['# Mesh Studio OBJ', `# vertices ${mesh.vertices.length}`];
  for (const v of mesh.vertices) {
    lines.push(`v ${v.x.toFixed(6)} ${v.y.toFixed(6)} ${v.z.toFixed(6)}`);
  }
  for (const f of mesh.faces) {
    lines.push(`f ${f.join(' ')}`);
  }
  return `${lines.join('\n')}\n`;
}
