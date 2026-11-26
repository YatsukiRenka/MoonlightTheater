// The moon as a lit body: a procedural lunar surface (maria, craters, ray systems) baked into a
// cube map per cast, then shaded every frame with Lommel–Seeliger reflectance and tinted with the
// cast's palette. Each drawing style has its own shading: soft wash, cel bands, or halftone.
// A new cast is a lunation: the moon wanes to new, the surface changes in the dark, and it waxes
// to the new phase. Without WebGL2 the CSS moon underneath stays in place.
import {seedRandom} from './stage.mjs';
import {program, ease, noise} from './gl-kit.mjs';

const FACE = 512;
const CRATERS = 72;
const GRADIENT_SCALE = 6;

const quadVertex = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0., 1.); }`;


// Bake: one cube face per draw. RGB holds the height gradient, A the albedo.
const bakeFragment = `#version 300 es
precision highp float;
uniform int uFace;
uniform float uSize;
uniform vec3 uSeed;
uniform vec4 uCrater[${CRATERS}];
uniform vec4 uInfo[${CRATERS}];
uniform vec4 uBasin[4];
out vec4 outColor;
${noise}
vec3 hash33(vec3 p) {
  p = fract(p * vec3(.1031, .103, .0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
// Saturation cratering: small bowls on a jittered grid, about half the cells occupied.
float craterlets(vec3 p, float scale) {
  vec3 x = p * scale, i = floor(x), f = fract(x);
  float h = 0.;
  for (int dz = -1; dz <= 1; dz++)
  for (int dy = -1; dy <= 1; dy++)
  for (int dx = -1; dx <= 1; dx++) {
    vec3 o = vec3(dx, dy, dz);
    vec3 cell = i + o;
    vec3 jitter = hash33(cell);
    if (jitter.x > .55) continue;
    float radius = .16 + .22 * hash13(cell + 7.1);
    float d = length(f - o - jitter) / radius;
    if (d > 1.6) continue;
    h += (d < 1. ? d * d - 1. : 0.) * .6 + .25 * exp(-pow((d - 1.) / .22, 2.));
  }
  return h * .5 / scale;
}
vec3 faceDir(int face, vec2 st) {
  vec2 c = st * 2. - 1.;
  if (face == 0) return vec3(1., -c.y, -c.x);
  if (face == 1) return vec3(-1., -c.y, c.x);
  if (face == 2) return vec3(c.x, 1., c.y);
  if (face == 3) return vec3(c.x, -1., -c.y);
  if (face == 4) return vec3(c.x, -c.y, 1.);
  return vec3(-c.x, -c.y, -1.);
}
void surface(vec3 p, out float h, out float albedo) {
  vec3 q = p + uSeed;
  vec3 warp = vec3(fbm(q * 2.1), fbm(q * 2.1 + 5.2), fbm(q * 2.1 + 9.7)) - .5;
  float mare = smoothstep(.6, .7, fbm(q * 1.5 + warp * 1.2));
  for (int i = 0; i < 4; i++) {
    float d = length(p - uBasin[i].xyz + warp * .3) / uBasin[i].w;
    mare = max(mare, smoothstep(1.08, .6, d));
  }
  float rough = fbm(q * 11.) - .5;
  h = -.012 * mare + .004 * rough;
  h += (.26 * craterlets(p, 18.) + .07 * craterlets(p + 3.7, 41.)) * (1. - .7 * mare);
  albedo = mix(.76, .42, mare) + .1 * (fbm(q * 3.7 + warp) - .5) + .04 * rough;
  for (int i = 0; i < ${CRATERS}; i++) {
    vec4 c = uCrater[i];
    vec4 info = uInfo[i];
    vec3 dv = p - c.xyz;
    float d = length(dv) / c.w;
    if (d > 9.) continue;
    float bowl = d < 1. ? d * d - 1. : 0.;
    float rim = exp(-pow((d - 1.) / .2, 2.));
    h += c.w * info.x * (.2 * bowl + .08 * rim);
    if (d < 1.2) h += c.w * .02 * (vnoise(dv * 40. / c.w) - .5);
    albedo += info.w * (.05 * exp(-max(d - 1., 0.) * 3.) - .03 * step(d, 1.) * (1. - d)) * (1. - .5 * mare);
    if (info.y > 0. && d > .9) {
      vec3 t1 = normalize(cross(c.xyz, vec3(.31, .95, .12)));
      float az = atan(dot(dv, cross(c.xyz, t1)), dot(dv, t1));
      float streak = vnoise(vec3(cos(az) * 16., sin(az) * 16., info.z)) * vnoise(vec3(d * 1.7, az * 3., info.z));
      albedo += info.y * pow(streak, 2.2) * exp(-(d - 1.) / 2.2) * 1.4;
    }
  }
  albedo = clamp(albedo, 0., 1.);
}
void main() {
  vec3 p = normalize(faceDir(uFace, gl_FragCoord.xy / uSize));
  float h, albedo, hx, hy, hz, ignored;
  float e = 1.5 / uSize;
  surface(p, h, albedo);
  surface(p + vec3(e, 0, 0), hx, ignored);
  surface(p + vec3(0, e, 0), hy, ignored);
  surface(p + vec3(0, 0, e), hz, ignored);
  vec3 gradient = vec3(hx - h, hy - h, hz - h) / e;
  outColor = vec4(clamp(gradient / ${GRADIENT_SCALE.toFixed(1)} * .5 + .5, 0., 1.), albedo);
}`;

const moonFragment = `#version 300 es
precision highp float;
uniform samplerCube uSurfA;
uniform samplerCube uSurfB;
uniform float uMix;
uniform vec2 uRes;
uniform float uDisc;
uniform float uDpr;
uniform float uTime;
uniform vec3 uLight;
uniform mat3 uRot;
uniform vec3 uTone[3];
uniform vec3 uStyle;
uniform float uPaper;
out vec4 outColor;
${noise}
// Gradient map through the palette: shadow, deep, middle, light, then a near-white glint.
vec3 gmap(float v) {
  vec3 c0 = uTone[2] * .03, c1 = uTone[2], c2 = uTone[1], c3 = uTone[0], c4 = mix(uTone[0], vec3(1.), .6);
  v = clamp(v, 0., 1.1);
  if (v < .2) return mix(c0, c1, (v / .2) * (v / .2));
  if (v < .48) return mix(c1, c2, (v - .2) / .28);
  if (v < .8) return mix(c2, c3, (v - .48) / .32);
  return mix(c3, c4, (v - .8) / .3);
}
vec4 sampleSurface(vec3 s) {
  return mix(texture(uSurfA, s), texture(uSurfB, s), uMix);
}
void main() {
  vec2 uv = (gl_FragCoord.xy - .5 * uRes) / (.5 * uRes.y);
  vec2 p = uv / uDisc;
  float r = length(p);
  float edge = fwidth(r);
  float inside = 1. - smoothstep(1. - edge, 1. + edge, r);
  vec3 n = vec3(p, sqrt(max(0., 1. - dot(p, p))));
  vec3 s = uRot * n;
  vec4 t = sampleSurface(s);
  vec3 g = transpose(uRot) * ((t.rgb * 2. - 1.) * ${GRADIENT_SCALE.toFixed(1)});
  vec3 nb = normalize(n - .55 * (g - dot(g, n) * n));
  float albedo = t.a;

  float mu0 = dot(nb, uLight);
  float mu = max(n.z, .02);
  float lam = max(mu0, 0.);
  float ls = 2. * lam / (lam + mu);
  float lit = mix(lam, ls, .6);
  float sphere = max(dot(n, uLight), 0.);
  float earthshine = .065 * (1. - smoothstep(-.15, .25, dot(n, uLight)));
  float grain = hash13(vec3(gl_FragCoord.xy, floor(uTime * 24.))) - .5;

  // One tonal field, three renderings: a continuous gradient map (soft), the same map in
  // hard cel bands, or a halftone screen of it (graphic).
  // Earthshine: the unlit side keeps a faint ashen light, so a thin crescent still reads as a whole moon.
  vec3 ash = mix(uTone[2], uTone[1], .55) * earthshine * (.35 + albedo) * 1.6;
  float tonal = lit * (.4 + .72 * albedo);
  vec3 soft = gmap(tonal + .015 * grain) + ash;

  vec3 nc = normalize(mix(n, nb, .18));
  float lamC = max(dot(nc, uLight), 0.);
  float litC = mix(lamC, 2. * lamC / (lamC + mu), .6);
  float tonalC = litC * (.4 + .72 * albedo);
  float w = edge * 5.;
  float stepped = .02 + .33 * smoothstep(.1 - w, .1 + w, tonalC) + .3 * smoothstep(.45 - w, .45 + w, tonalC)
    + .27 * smoothstep(.74 - w, .74 + w, tonalC) + .08 * smoothstep(.96 - w, .96 + w, tonalC);
  vec3 cel = gmap(stepped) + ash * (1. - smoothstep(.0, .1, tonalC));
  float ink = smoothstep(1. - edge * 3.5, 1. - edge * .5, r);
  cel = mix(cel, uTone[2] * .35, ink * .7 * smoothstep(.0, .2, tonalC));

  vec2 cell = mat2(.7071, -.7071, .7071, .7071) * gl_FragCoord.xy / (5. * uDpr);
  float dist = length(fract(cell) - .5);
  float radius = .64 * sqrt(clamp(1. - tonal, 0., 1.));
  float dotInk = 1. - smoothstep(radius - .08, radius + .08, dist);
  vec3 paper = mix(uTone[0], vec3(1.), .35);
  vec3 graphic = mix(paper, uTone[2] * .55, dotInk) * smoothstep(-.05, .02, dot(n, uLight) + earthshine * 3.);

  vec3 color = uStyle.x * soft + uStyle.y * cel + uStyle.z * graphic;

  // Halo: the lit side glows into the sky; brighter the fuller the moon.
  float full = .5 + .5 * uLight.z;
  vec2 side = normalize(uLight.xy + 1e-5);
  float bias = .45 + .55 * max(dot(normalize(p + 1e-5), side) * length(uLight.xy), 0.) + .5 * full;
  float halo = exp(-max(r - 1., 0.) * 7.) * (.1 + .32 * full) * bias * (1. - inside) * (1. - uPaper);
  vec3 haloColor = pow(mix(uTone[1], uTone[0], .7), vec3(1. / 2.2));
  // On paper the unlit side is left unprinted: only the lit body is inked, and a hairline draws the limb.
  float direct = mix(lit, litC, uStyle.y) * (.4 + .72 * albedo);
  float printed = mix(1., smoothstep(.01, .09, direct), uPaper);
  float body = inside * printed;
  float limb = uPaper * (1. - smoothstep(0., edge * 1.6, abs(r - 1. + edge))) * .55;
  vec3 limbColor = pow(uTone[2], vec3(1. / 2.2)) * .6;
  float alpha = body + halo + limb * (1. - body);
  vec3 premultiplied = pow(max(color, 0.), vec3(1. / 2.2)) * body + haloColor * halo + limbColor * limb * (1. - body);
  outColor = vec4(premultiplied, clamp(alpha, 0., 1.));
}`;

const clamp01 = value => Math.max(0, Math.min(1, value));
const lerp = (from, to, amount) => from + (to - from) * amount;
const span = (t, start, end) => clamp01((t - start) / (end - start));

function linearColor(hex) {
  const value = /^#?([0-9a-f]{6})$/i.exec(hex || '')?.[1];
  if (!value) return [.8, .78, .9];
  return [0, 2, 4].map(offset => (parseInt(value.slice(offset, offset + 2), 16) / 255) ** 2.2);
}

function craterField(seed) {
  const random = seedRandom(`${seed}|craters`);
  const craters = new Float32Array(CRATERS * 4);
  const info = new Float32Array(CRATERS * 4);
  let rays = 0;
  for (let index = 0; index < CRATERS; index++) {
    const z = random() * 2 - 1;
    const angle = random() * Math.PI * 2;
    const ring = Math.sqrt(1 - z * z);
    const size = random();
    const radius = .018 + .13 * size ** 2.6;
    craters.set([ring * Math.cos(angle), ring * Math.sin(angle), z, radius], index * 4);
    const fresh = random();
    const ray = rays < 3 && radius < .07 && fresh > .55 ? .55 + random() * .4 : 0;
    if (ray) rays++;
    info.set([.6 + random() * .8, ray, random() * 50, .4 + fresh * .9], index * 4);
  }
  const basins = new Float32Array(16);
  for (let index = 0; index < 4; index++) {
    const z = random() * 1.6 - .8;
    const angle = random() * Math.PI * 2;
    const ring = Math.sqrt(1 - z * z);
    basins.set([ring * Math.cos(angle), ring * Math.sin(angle), z, .22 + random() * .26], index * 4);
  }
  return {craters, info, basins, offset: [random() * 40, random() * 40, random() * 40]};
}

function rotation(yaw, pitch, roll) {
  const [cy, sy, cp, sp, cr, sr] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch), Math.cos(roll), Math.sin(roll)];
  // R = Rz(roll) · Rx(pitch) · Ry(yaw), column-major for WebGL.
  const ry = [cy, 0, -sy, 0, 1, 0, sy, 0, cy];
  const rx = [1, 0, 0, 0, cp, sp, 0, -sp, cp];
  const rz = [cr, sr, 0, -sr, cr, 0, 0, 0, 1];
  const multiply = (a, b) => {
    const out = new Array(9).fill(0);
    for (let column = 0; column < 3; column++) {
      for (let row = 0; row < 3; row++) {
        for (let k = 0; k < 3; k++) out[column * 3 + row] += a[k * 3 + row] * b[column * 3 + k];
      }
    }
    return out;
  };
  return new Float32Array(multiply(rz, multiply(rx, ry)));
}

const styleWeights = {soft: [1, 0, 0], cel: [0, 1, 0], graphic: [0, 0, 1]};

function castFrom({seed, art}) {
  const random = seedRandom(`${seed}|phase`);
  const angle = parseFloat(art.vars['--m-angle']) * Math.PI / 180;
  const tones = ['--m-light', '--m-mid', '--m-deep'].map(name => linearColor(art.vars[name]));
  return {
    seed,
    // Lit side, in GL screen coordinates (y up).
    direction: Math.atan2(-Math.cos(angle), -Math.sin(angle)),
    phase: (28 + random() * 84) * Math.PI / 180,
    yaw: random() * Math.PI * 2,
    tones,
    style: styleWeights[art.variant] || styleWeights.soft
  };
}

function start() {
  const figure = document.querySelector('.hero-dial');
  const moon = document.getElementById('dialMoon');
  if (!figure || !moon) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'moon-gl';
  canvas.setAttribute('aria-hidden', 'true');
  const gl = canvas.getContext('webgl2', {premultipliedAlpha: true, antialias: false, alpha: true});
  if (!gl) return;

  let moonProgram;
  let bakeProgram;
  try {
    moonProgram = program(gl, quadVertex, moonFragment);
    bakeProgram = program(gl, quadVertex, bakeFragment);
  } catch (error) {
    console.warn('Moon shader unavailable', error);
    return;
  }

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const cube = () => {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, texture);
    for (let face = 0; face < 6; face++) {
      gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, gl.RGBA8, FACE, FACE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  };
  const surfaces = [cube(), cube()];
  const framebuffer = gl.createFramebuffer();
  // Which cube map is the shown one (A); the other receives the next bake.
  let front = 0;
  let bake = null;

  function bakeFace() {
    if (!bake) return;
    const {target, field, face} = bake;
    gl.useProgram(bakeProgram.linked);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, surfaces[target], 0);
    gl.viewport(0, 0, FACE, FACE);
    gl.disable(gl.BLEND);
    gl.uniform1i(bakeProgram.uniforms.uFace, face);
    gl.uniform1f(bakeProgram.uniforms.uSize, FACE);
    gl.uniform3fv(bakeProgram.uniforms.uSeed, field.offset);
    gl.uniform4fv(bakeProgram.uniforms.uCrater, field.craters);
    gl.uniform4fv(bakeProgram.uniforms.uInfo, field.info);
    gl.uniform4fv(bakeProgram.uniforms.uBasin, field.basins);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    bake.face++;
    if (bake.face === 6) {
      bake.done = true;
      bake = null;
    }
  }

  const motion = matchMedia('(prefers-reduced-motion: no-preference)');
  const view = {
    direction: 0, phase: Math.PI, yaw: 0, mix: 1,
    tones: [[.9, .86, .95], [.4, .3, .55], [.05, .03, .09]],
    style: [1, 0, 0]
  };
  let current = null;
  let transition = null;
  let lean = {x: 0, y: 0};
  let paper = 0;
  let visible = true;
  let frame = 0;
  let size = {width: 0, height: 0, dpr: 1};

  function resize() {
    const box = canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(box.width * dpr));
    const height = Math.max(1, Math.round(box.height * dpr));
    if (width !== canvas.width || height !== canvas.height) {
      canvas.width = width;
      canvas.height = height;
    }
    size = {width, height, dpr, discFraction: moon.getBoundingClientRect().width / Math.max(box.height, 1)};
  }

  function begin(cast) {
    const previous = current;
    current = cast;
    const target = previous ? 1 - front : front;
    bake = {target, field: craterField(cast.seed), face: 0, done: false};
    if (!previous) {
      // Opening: bake both cube maps now (the spare one too, so its first use is not mid-lunation),
      // then rise from new moon.
      while (bake) bakeFace();
      bake = {target: 1 - front, field: bake?.field ?? craterField(cast.seed), face: 0, done: false};
      while (bake) bakeFace();
      view.tones = cast.tones;
      view.style = cast.style;
      view.direction = cast.direction;
      view.yaw = cast.yaw;
      view.mix = 0;
      transition = motion.matches ? {kind: 'rise', start: performance.now(), duration: 2600, from: {...view, phase: Math.PI * .97}, to: cast} : null;
      if (!transition) view.phase = cast.phase;
      return;
    }
    const from = {...view, tones: view.tones.map(tone => [...tone]), style: [...view.style]};
    if (!motion.matches) {
      while (bake) bakeFace();
      front = target;
      Object.assign(view, {direction: cast.direction, phase: cast.phase, yaw: cast.yaw, tones: cast.tones, style: cast.style, mix: 0});
      transition = null;
      return;
    }
    // Bake the new surface in one go: interleaving bakes with the sky's trails stalls frames.
    while (bake) bakeFace();
    transition = {kind: 'lunation', start: performance.now(), duration: 2400, from, to: cast, target};
  }

  function recolor(cast) {
    const same = (a, b) => a.flat().every((value, index) => Math.abs(value - b.flat()[index]) < 1e-4);
    if (same(cast.tones, current.tones) && same(cast.style, current.style)) return;
    current = {...current, tones: cast.tones, style: cast.style};
    // A lunation or moonrise in progress simply lands on the new colours.
    if (transition && transition.kind !== 'recolor') {
      transition.to = {...transition.to, tones: cast.tones, style: cast.style};
      return;
    }
    const from = {...view, tones: view.tones.map(tone => [...tone]), style: [...view.style]};
    if (!motion.matches) {
      Object.assign(view, {tones: cast.tones, style: cast.style});
      return;
    }
    transition = {kind: 'recolor', start: performance.now(), duration: 900, from, to: current};
  }

  function step(now) {
    if (!transition) return false;
    const {kind, from, to} = transition;
    const t = clamp01((now - transition.start) / transition.duration);
    const mixTones = amount => from.tones.map((tone, index) => tone.map((channel, c) => lerp(channel, to.tones[index][c], amount)));
    const mixStyle = amount => from.style.map((weight, index) => lerp(weight, to.style[index], amount));
    if (kind === 'rise') {
      view.phase = lerp(from.phase, to.phase, ease.outExpo(t));
      view.tones = mixTones(1);
      view.style = mixStyle(1);
    } else if (kind === 'recolor') {
      view.tones = mixTones(ease.inOutSine(t));
      view.style = mixStyle(ease.inOutSine(t));
    } else {
      // Wane to new, swap the surface in the dark, wax to the new phase.
      const dark = Math.PI * .985;
      if (t < .42) view.phase = lerp(from.phase, dark, ease.inCubic(t / .42));
      else view.phase = lerp(dark, to.phase, ease.outExpo((t - .42) / .58));
      let turn = to.direction - from.direction;
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      view.direction = from.direction + turn * ease.inOutCubic(t);
      view.yaw = from.yaw + Math.PI * .5 * ease.inOutCubic(t);
      const swap = span(t, .3, .55);
      view.mix = swap;
      view.tones = mixTones(ease.inOutSine(span(t, .25, .7)));
      view.style = mixStyle(ease.inOutSine(span(t, .3, .6)));
    }
    if (t >= 1) {
      if (kind === 'lunation') {
        front = transition.target;
        view.mix = 0;
      }
      transition = null;
    }
    return true;
  }

  function draw(now) {
    resize();
    const {width, height, dpr, discFraction} = size;
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(moonProgram.linked);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, surfaces[front]);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, surfaces[transition?.kind === 'lunation' ? transition.target : front]);
    const u = moonProgram.uniforms;
    gl.uniform1i(u.uSurfA, 0);
    gl.uniform1i(u.uSurfB, 1);
    gl.uniform1f(u.uMix, transition?.kind === 'lunation' ? view.mix : 0);
    gl.uniform2f(u.uRes, width, height);
    gl.uniform1f(u.uDisc, discFraction || .67);
    gl.uniform1f(u.uDpr, dpr);
    gl.uniform1f(u.uTime, now / 1000);
    const slow = motion.matches ? now / 1000 : 0;
    // Libration: the face nods a little; the pointer leans the light.
    gl.uniformMatrix3fv(u.uRot, false, rotation(view.yaw + Math.sin(slow * .05) * .12, .35 + Math.sin(slow * .037) * .06, .2));
    const sinPhase = Math.sin(view.phase);
    const dx = Math.cos(view.direction) * sinPhase + lean.x * .22;
    const dy = Math.sin(view.direction) * sinPhase - lean.y * .22;
    const dz = Math.cos(view.phase);
    const length = Math.hypot(dx, dy, dz) || 1;
    gl.uniform3f(u.uLight, dx / length, dy / length, dz / length);
    gl.uniform3fv(u.uTone, view.tones.flat());
    gl.uniform3fv(u.uStyle, view.style);
    gl.uniform1f(u.uPaper, paper);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  let last = 0;
  function loop(now) {
    frame = 0;
    if (!visible || !current) return;
    const animating = step(now);
    const target = readLean();
    lean.x += (target.x - lean.x) * .08;
    lean.y += (target.y - lean.y) * .08;
    const settling = Math.abs(target.x - lean.x) + Math.abs(target.y - lean.y) > .002;
    // At most 60 frames a second even on fast displays; idle libration needs only 30.
    const due = now - last >= (animating || settling ? 1000 / 61 : 1000 / 30);
    if (due) {
      draw(now);
      last = now;
    }
    if (motion.matches) frame = requestAnimationFrame(loop);
  }

  function readLean() {
    const style = figure.style;
    return {x: parseFloat(style.getPropertyValue('--lean-x')) || 0, y: parseFloat(style.getPropertyValue('--lean-y')) || 0};
  }

  function wake() {
    if (!frame) frame = requestAnimationFrame(loop);
  }

  function readPaper() {
    paper = document.documentElement.dataset.theme === 'light' ? 1 : 0;
  }

  document.addEventListener('moon:paint', event => {
    const cast = castFrom(event.detail);
    if (!current || cast.seed !== current.seed) begin(cast);
    else recolor(cast);
    wake();
  });
  new ResizeObserver(() => { if (current) { draw(performance.now()); wake(); } }).observe(canvas);
  new IntersectionObserver(entries => {
    visible = entries.some(entry => entry.isIntersecting);
    if (visible) wake();
  }).observe(figure);
  new MutationObserver(() => { readPaper(); wake(); }).observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
  motion.addEventListener('change', wake);
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    document.documentElement.classList.remove('has-moon-gl');
    canvas.remove();
  });

  readPaper();
  moon.after(canvas);
  document.documentElement.classList.add('has-moon-gl');
}

if (typeof document !== 'undefined') start();
