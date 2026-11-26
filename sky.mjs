// The celestial sphere behind the page: a fixed catalogue of stars with colour by temperature,
// a Milky Way baked once into a cube map (band, bulge, dust lanes), and a coordinate graticule whose meridians meet at a pole just off
// the top-right corner. The sky turns slowly; scrolling turns it a little more; a new cast is a
// time-lapse whose stars streak into short trails. The light theme prints the same sky as an
// atlas: ink dots and hairlines on paper.
import {seedRandom} from './stage.mjs';
import {program, ease, noise} from './gl-kit.mjs';

const STARS = 7000;
const HAZE_FACE = 256;

const common = `
uniform mat3 uView;
uniform vec3 uPole;
uniform float uFocal;
uniform vec2 uRes;
vec3 spin(vec3 v, float a) {
  float c = cos(a), s = sin(a);
  return v * c + cross(uPole, v) * s + uPole * dot(uPole, v) * (1. - c);
}`;

const starVertex = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aStar;
layout(location = 2) in vec4 aTint;
uniform float uSpin;
uniform float uStreak;
uniform float uSegment;
uniform float uSegments;
uniform float uDpr;
uniform float uTime;
uniform float uInk;
uniform float uTwinkle;
uniform vec3 uStarColor;
out vec2 vLocal;
out float vHalf;
out float vRadius;
out vec4 vColor;
${common}
vec2 project(vec3 world, out float ok) {
  vec3 v = uView * world;
  ok = step(.08, -v.z);
  return v.xy / max(-v.z, .08) * uFocal;
}
void main() {
  float okA, okB;
  // A trail is drawn as a few chords so it bends around the pole.
  float piece = uStreak / uSegments;
  vec2 a = project(spin(aStar.xyz, uSpin - piece * (uSegment + 1.)), okA);
  vec2 b = project(spin(aStar.xyz, uSpin - piece * uSegment), okB);
  float magnitude = aStar.w;
  float radius = mix(mix(2.4, 1.6, uInk), .65, magnitude);
  radius *= uDpr;
  vec2 axis = b - a;
  float len = length(axis);
  vec2 dir = len > .001 ? axis / len : vec2(1., 0.);
  vec2 normal = vec2(-dir.y, dir.x);
  float halfLen = len * .5;
  vec2 local = vec2(aCorner.x * (halfLen + radius * 2.), aCorner.y * radius * 2.);
  vec2 position = (a + b) * .5 + dir * local.x + normal * local.y;
  vLocal = local;
  vHalf = halfLen;
  vRadius = radius;
  float shimmer = 1. + uTwinkle * .35 * sin(uTime * (1.3 + aTint.w * 2.7) + aTint.w * 61.) * (1. - magnitude * .6);
  // On paper only the brighter stars are printed, so ink dots never crowd the text.
  float alpha = mix(mix(1., .2, magnitude) * shimmer, .75 * (1. - smoothstep(.45, .8, magnitude)), uInk);
  // Trails spread their light over their length.
  alpha /= 1. + halfLen * uSegments / (radius * 3.);
  alpha *= 1. - .5 * uSegment / uSegments;
  vec3 color = mix(mix(aTint.rgb, uStarColor, .3), uStarColor, uInk);
  vColor = vec4(color, alpha);
  gl_Position = okA * okB > .5 ? vec4(position / (uRes * .5), 0., 1.) : vec4(4., 4., 0., 1.);
}`;

const starFragment = `#version 300 es
precision highp float;
in vec2 vLocal;
in float vHalf;
in float vRadius;
in vec4 vColor;
uniform float uInk;
out vec4 outColor;
void main() {
  vec2 q = vec2(max(abs(vLocal.x) - vHalf, 0.), vLocal.y);
  float d = length(q);
  float glow = exp(-d * d / (vRadius * vRadius * .5));
  float dot = 1. - smoothstep(vRadius * .8 - .6, vRadius * .8 + .6, d);
  float shape = mix(glow, dot, uInk);
  float alpha = vColor.a * shape;
  outColor = vec4(vColor.rgb * alpha, alpha);
}`;

const lineVertex = `#version 300 es
layout(location = 0) in vec3 aPos;
uniform float uSpin;
${common}
void main() {
  vec3 v = uView * spin(aPos, uSpin);
  gl_Position = vec4(v.x * uFocal / (uRes.x * .5), v.y * uFocal / (uRes.y * .5), 0., -v.z);
}`;

const fullVertex = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0., 1.); }`;

// The Milky Way, computed once per cube face: a band about the galactic plane, a brighter bulge,
// cloudy structure, and dark dust lanes along the mid-plane.
const hazeBake = `#version 300 es
precision highp float;
uniform int uFace;
uniform float uSize;
uniform vec3 uPlane;
uniform vec3 uCore;
out vec4 outColor;
${noise}
vec3 faceDir(int face, vec2 st) {
  vec2 c = st * 2. - 1.;
  if (face == 0) return vec3(1., -c.y, -c.x);
  if (face == 1) return vec3(-1., -c.y, c.x);
  if (face == 2) return vec3(c.x, 1., c.y);
  if (face == 3) return vec3(c.x, -1., -c.y);
  if (face == 4) return vec3(c.x, -c.y, 1.);
  return vec3(-c.x, -c.y, -1.);
}
void main() {
  vec3 d = normalize(faceDir(uFace, gl_FragCoord.xy / uSize));
  float lat = dot(d, uPlane);
  float band = exp(-lat * lat / (2. * .17 * .17));
  float bulge = exp(-pow(length(d - uCore), 2.) * 4.);
  float clouds = fbm(d * 3.2 + 4.1);
  float lanes = smoothstep(.42, .7, fbm(d * 7.5 + 9.3)) * exp(-lat * lat / (2. * .045 * .045));
  float density = band * (.35 + 1.1 * clouds) * (1. - .7 * lanes) + .7 * bulge * band;
  outColor = vec4(vec3(clamp(density * .55, 0., 1.)), 1.);
}`;

// Each pixel looks back along its ray into the baked Milky Way.
const hazeFragment = `#version 300 es
precision highp float;
uniform samplerCube uHaze;
uniform vec3 uTint;
uniform float uSpin;
uniform float uStrength;
${common}
out vec4 outColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec3 ray = normalize(vec3((gl_FragCoord.xy - .5 * uRes) / uFocal, -1.));
  vec3 world = spin(transpose(uView) * ray, -uSpin);
  float density = texture(uHaze, world).r;
  // Dither so the faint gradient does not band.
  float light = density * uStrength + (hash(gl_FragCoord.xy) - .5) / 255.;
  outColor = vec4(uTint * max(light, 0.), 0.);
}`;

// The cast's colours as a slow aura around the moon, drawn here so a new cast never repaints the page.
const auraVertex = `#version 300 es
layout(location = 0) in vec2 aCorner;
uniform vec4 uBox;
uniform vec2 uRes;
out vec2 vUv;
void main() {
  vUv = aCorner;
  vec2 pixel = uBox.xy + aCorner * uBox.zw;
  gl_Position = vec4(pixel.x / uRes.x * 2. - 1., 1. - pixel.y / uRes.y * 2., 0., 1.);
}`;

const auraFragment = `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec3 uAura[3];
uniform float uTurn;
uniform float uInk;
out vec4 outColor;
float blob(vec2 p, vec2 at, float size) {
  float d = length(p - at) / size;
  return exp(-d * d * 3.);
}
void main() {
  float c = cos(uTurn), s = sin(uTurn);
  vec2 p = mat2(c, -s, s, c) * vUv;
  vec3 color = uAura[1] * .26 * blob(p, vec2(-.3, -.2), .5)
    + uAura[0] * .16 * blob(p, vec2(.35, .25), .45)
    + uAura[2] * .22 * blob(p, vec2(.12, -.4), .42);
  float alpha = max(max(color.r, color.g), color.b) * mix(1., .9, uInk);
  outColor = uInk > .5 ? vec4(color, alpha) : vec4(color, 0.);
}`;

// The follow spot: a soft pool of light that trails the pointer across the whole page.
const spotFragment = `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec3 uSpotColor;
uniform float uSpotAlpha;
out vec4 outColor;
void main() {
  float d = length(vUv);
  float light = exp(-d * d * 4.) * (1. - smoothstep(.8, 1., d)) * uSpotAlpha;
  outColor = vec4(uSpotColor * light, light);
}`;

const lineFragment = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main() { outColor = vec4(uColor.rgb * uColor.a, uColor.a); }`;

const normalize = ([x, y, z]) => {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// Projects just above the top edge, right of centre, so trails visibly turn around it.
const pole = normalize([.59, .42, -1]);
const galaxy = normalize([.75, -.66, .05]);

const temperatures = [
  [[.72, .8, 1], .12], [[.96, .95, 1], .38], [[1, .95, .88], .25], [[1, .87, .72], .15], [[1, .76, .58], .1]
];

function gauss(random) {
  return Math.sqrt(-2 * Math.log(random() || 1e-6)) * Math.cos(2 * Math.PI * random());
}

function catalogue() {
  const random = seedRandom('moonlight-sky');
  const plane = galaxy;
  const a = normalize(cross(plane, [0, 0, 1]));
  const b = cross(plane, a);
  const onBand = spread => {
    const angle = random() * Math.PI * 2;
    const offset = gauss(random) * spread;
    return normalize([0, 1, 2].map(i => a[i] * Math.cos(angle) + b[i] * Math.sin(angle) + plane[i] * offset));
  };
  const anywhere = () => {
    const z = random() * 2 - 1;
    const angle = random() * Math.PI * 2;
    const ring = Math.sqrt(1 - z * z);
    return [ring * Math.cos(angle), ring * Math.sin(angle), z];
  };
  const pick = () => {
    let roll = random();
    for (const [color, weight] of temperatures) {
      roll -= weight;
      if (roll <= 0) return color;
    }
    return temperatures[1][0];
  };
  const stars = new Float32Array(STARS * 8);
  for (let index = 0; index < STARS; index++) {
    const position = random() < .4 ? onBand(.16) : anywhere();
    const magnitude = 1 - random() ** 2.6;
    stars.set([...position, magnitude, ...pick(), random()], index * 8);
  }
  return {stars, core: onBand(.02)};
}

function graticule() {
  const x = normalize(cross(pole, [0, 0, 1]));
  const y = cross(pole, x);
  const point = (ra, dec) => [0, 1, 2].map(i => Math.cos(dec) * (Math.cos(ra) * x[i] + Math.sin(ra) * y[i]) + Math.sin(dec) * pole[i]);
  const vertices = [];
  const degrees = Math.PI / 180;
  for (let dec = -75; dec <= 75; dec += 15) {
    for (let ra = 0; ra < 360; ra += 2) vertices.push(...point(ra * degrees, dec * degrees), ...point((ra + 2) * degrees, dec * degrees));
  }
  for (let ra = 0; ra < 360; ra += 30) {
    for (let dec = -88; dec < 88; dec += 2) vertices.push(...point(ra * degrees, dec * degrees), ...point(ra * degrees, (dec + 2) * degrees));
  }
  return new Float32Array(vertices);
}

function viewMatrix(yaw, pitch) {
  const [cy, sy, cp, sp] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch)];
  // Ry(yaw) · Rx(pitch), column-major.
  return new Float32Array([cy, sp * sy, -cp * sy, 0, cp, sp, sy, -sp * cy, cp * cy]);
}

function hexColor(value) {
  const match = /#([0-9a-f]{6})/i.exec(value || '');
  if (!match) return null;
  return [0, 2, 4].map(offset => parseInt(match[1].slice(offset, offset + 2), 16) / 255);
}

function start() {
  const canvas = document.createElement('canvas');
  canvas.className = 'sky-gl';
  canvas.setAttribute('aria-hidden', 'true');
  const gl = canvas.getContext('webgl2', {premultipliedAlpha: true, antialias: true, alpha: true});
  if (!gl) return;
  let stars;
  let lines;
  let aura;
  let spot;
  let haze;
  let hazeBaker;
  try {
    haze = program(gl, fullVertex, hazeFragment);
    hazeBaker = program(gl, fullVertex, hazeBake);
    stars = program(gl, starVertex, starFragment);
    lines = program(gl, lineVertex, lineFragment);
    aura = program(gl, auraVertex, auraFragment);
    spot = program(gl, auraVertex, spotFragment);
  } catch (error) {
    console.warn('Sky shader unavailable', error);
    return;
  }

  const {stars: starData, core} = catalogue();
  const corners = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const instanced = data => {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16);
    gl.vertexAttribDivisor(2, 1);
    return {vao, count: data.length / 8};
  };
  const starSet = instanced(starData);
  const fullVao = gl.createVertexArray();
  gl.bindVertexArray(fullVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const hazeCube = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, hazeCube);
  for (let face = 0; face < 6; face++) {
    gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, gl.RGBA8, HAZE_FACE, HAZE_FACE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  const bakeTarget = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, bakeTarget);
  gl.viewport(0, 0, HAZE_FACE, HAZE_FACE);
  gl.useProgram(hazeBaker.linked);
  gl.uniform1f(hazeBaker.uniforms.uSize, HAZE_FACE);
  gl.uniform3fv(hazeBaker.uniforms.uPlane, galaxy);
  gl.uniform3fv(hazeBaker.uniforms.uCore, core);
  for (let face = 0; face < 6; face++) {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, hazeCube, 0);
    gl.uniform1i(hazeBaker.uniforms.uFace, face);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const gridData = graticule();
  const gridVao = gl.createVertexArray();
  gl.bindVertexArray(gridVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, gridData, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const motion = matchMedia('(prefers-reduced-motion: no-preference)');
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  const state = {
    spin: 0, extra: 0, lapse: null, lastSpin: 0, streak: 0,
    tilt: {x: 0, y: 0}, aim: {x: 0, y: 0},
    ink: 0, star: [.93, .9, .98], line: [.93, .9, .98], tint: [.78, .7, .95], tintTarget: [.78, .7, .95],
    aura: null, auraTarget: null,
    spot: null, spotAim: null, spotAlpha: 0
  };
  const dial = document.querySelector('.hero-dial');
  const quadVao = gl.createVertexArray();
  gl.bindVertexArray(quadVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  let frame = 0;
  let last = 0;
  let previousSeed = null;

  function readTheme() {
    const styles = getComputedStyle(document.documentElement);
    state.ink = document.documentElement.dataset.theme === 'light' ? 1 : 0;
    state.star = hexColor(styles.getPropertyValue('--moon')) || state.star;
    state.line = hexColor(styles.getPropertyValue('--moon')) || state.line;
  }

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    const width = Math.round(innerWidth * dpr);
    const height = Math.round(innerHeight * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return dpr;
  }

  function draw(now, dt) {
    const dpr = resize();
    const {width, height} = canvas;
    const moving = motion.matches;
    const seconds = now / 1000;
    if (moving) state.spin += dt * .004;
    let lapse = 0;
    if (state.lapse) {
      const t = Math.min(1, (now - state.lapse.start) / state.lapse.duration);
      lapse = state.lapse.from + (state.lapse.to - state.lapse.from) * ease.inOutCubic(t);
      state.extra = lapse;
      if (t >= 1) state.lapse = null;
    }
    const angle = state.spin + state.extra + (moving ? scrollY * .00025 : 0);
    // Streak length is the angle swept during a short exposure.
    const velocity = dt > 0 ? (angle - state.lastSpin) / dt : 0;
    state.lastSpin = angle;
    state.streak += (Math.min(.2, Math.max(0, velocity * .3)) - state.streak) * .25;
    state.tilt.x += (state.aim.x - state.tilt.x) * .04;
    state.tilt.y += (state.aim.y - state.tilt.y) * .04;
    state.tint = state.tint.map((channel, index) => channel + (state.tintTarget[index] - channel) * .03);
    if (state.auraTarget) {
      state.aura ??= state.auraTarget.map(tone => [...tone]);
      state.aura = state.aura.map((tone, i) => tone.map((channel, c) => channel + (state.auraTarget[i][c] - channel) * .045));
    }

    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    const view = viewMatrix(state.tilt.x * .03, -state.tilt.y * .02);
    const focal = height * .9;
    const shared = shader => {
      gl.useProgram(shader.linked);
      gl.uniformMatrix3fv(shader.uniforms.uView, false, view);
      gl.uniform3fv(shader.uniforms.uPole, pole);
      gl.uniform1f(shader.uniforms.uFocal, focal);
      gl.uniform2f(shader.uniforms.uRes, width, height);
      gl.uniform1f(shader.uniforms.uSpin, angle);
    };

    shared(lines);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform4f(lines.uniforms.uColor, ...state.line, state.ink ? .075 : .04);
    gl.bindVertexArray(gridVao);
    gl.drawArrays(gl.LINES, 0, gridData.length / 3);

    shared(stars);
    const u = stars.uniforms;
    gl.uniform1f(u.uStreak, state.streak);
    gl.uniform1f(u.uDpr, dpr);
    gl.uniform1f(u.uTime, seconds);
    gl.uniform1f(u.uInk, state.ink);
    gl.uniform1f(u.uTwinkle, moving && !state.ink ? 1 : 0);
    gl.uniform3fv(u.uStarColor, state.star);
    if (!state.ink) {
      shared(haze);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, hazeCube);
      gl.uniform1i(haze.uniforms.uHaze, 0);
      gl.uniform3fv(haze.uniforms.uTint, state.tint);
      gl.uniform1f(haze.uniforms.uStrength, .3);
      gl.bindVertexArray(fullVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    drawAura(seconds, dpr);
    drawSpot(dpr);
    gl.useProgram(stars.linked);
    gl.blendFunc(gl.ONE, state.ink ? gl.ONE_MINUS_SRC_ALPHA : gl.ONE);
    gl.bindVertexArray(starSet.vao);
    const segments = state.streak > .01 ? 4 : 1;
    gl.uniform1f(u.uSegments, segments);
    for (let segment = 0; segment < segments; segment++) {
      gl.uniform1f(u.uSegment, segment);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, starSet.count);
    }
    gl.bindVertexArray(null);
  }

  function drawAura(seconds, dpr) {
    if (!dial || !state.aura) return;
    const box = dial.getBoundingClientRect();
    if (!box.width || box.bottom < -box.height || box.top > innerHeight + box.height) return;
    const half = box.width * .92;
    gl.useProgram(aura.linked);
    gl.uniform4f(aura.uniforms.uBox, (box.left + box.width / 2) * dpr, (box.top + box.height / 2) * dpr, half * dpr, half * dpr);
    gl.uniform2f(aura.uniforms.uRes, canvas.width, canvas.height);
    gl.uniform3fv(aura.uniforms.uAura, state.aura.flat());
    gl.uniform1f(aura.uniforms.uTurn, motion.matches ? seconds * Math.PI * 2 / 120 : 0);
    gl.uniform1f(aura.uniforms.uInk, state.ink);
    gl.blendFunc(gl.ONE, state.ink ? gl.ONE_MINUS_SRC_ALPHA : gl.ONE);
    gl.bindVertexArray(quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.blendFunc(gl.ONE, state.ink ? gl.ONE_MINUS_SRC_ALPHA : gl.ONE);
  }

  function drawSpot(dpr) {
    const target = state.spotAim ? 1 : 0;
    state.spotAlpha += (target - state.spotAlpha) * .06;
    if (state.spotAim) {
      state.spot ??= {...state.spotAim};
      state.spot.x += (state.spotAim.x - state.spot.x) * .14;
      state.spot.y += (state.spotAim.y - state.spot.y) * .14;
    }
    if (!state.spot || state.spotAlpha < .01) return;
    const radius = 30 * parseFloat(getComputedStyle(document.documentElement).fontSize || '16');
    gl.useProgram(spot.linked);
    gl.uniform4f(spot.uniforms.uBox, state.spot.x * dpr, state.spot.y * dpr, radius * dpr, radius * dpr);
    gl.uniform2f(spot.uniforms.uRes, canvas.width, canvas.height);
    gl.uniform3fv(spot.uniforms.uSpotColor, state.ink ? [1, 1, 1] : state.tint);
    gl.uniform1f(spot.uniforms.uSpotAlpha, state.spotAlpha * (state.ink ? .32 : .07));
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function loop(now) {
    frame = 0;
    const dt = last ? Math.min(.1, (now - last) / 1000) : 0;
    const auraMoving = state.aura && state.auraTarget && state.aura.flat().some((value, index) => Math.abs(value - state.auraTarget.flat()[index]) > .004);
    const spotMoving = state.spotAim ? !state.spot || Math.abs(state.spotAim.x - state.spot.x) + Math.abs(state.spotAim.y - state.spot.y) > .5 || state.spotAlpha < .99 : state.spotAlpha > .01;
    const busy = state.lapse || auraMoving || spotMoving || state.streak > .002 || Math.abs(state.aim.x - state.tilt.x) + Math.abs(state.aim.y - state.tilt.y) > .002;
    // At most 60 frames a second; idle drift is slow and 30 is plenty.
    if (now - last >= (busy ? 1000 / 61 : 1000 / 30)) {
      draw(now, dt);
      last = now;
    }
    if (motion.matches) frame = requestAnimationFrame(loop);
  }

  function wake() {
    if (!frame) frame = requestAnimationFrame(loop);
  }

  document.addEventListener('moon:paint', event => {
    const {seed, art} = event.detail;
    const light = hexColor(art.vars['--m-mid']);
    if (light) state.tintTarget = light.map(channel => channel * .6 + .35);
    const tones = ['--m-light', '--m-mid', '--m-deep'].map(name => hexColor(art.vars[name]));
    if (tones.every(Boolean)) state.auraTarget = tones;
    if (previousSeed && seed !== previousSeed && motion.matches) {
      state.lapse = {start: performance.now(), duration: 2400, from: state.extra, to: state.extra + .6};
    }
    previousSeed = seed;
    wake();
  });
  addEventListener('pointermove', event => {
    if (!finePointer.matches || !motion.matches) return;
    state.aim = {x: event.clientX / innerWidth * 2 - 1, y: event.clientY / innerHeight * 2 - 1};
    state.spotAim = {x: event.clientX, y: event.clientY};
    wake();
  }, {passive: true});
  document.documentElement.addEventListener('pointerleave', () => { state.spotAim = null; wake(); });
  addEventListener('resize', wake);
  addEventListener('scroll', wake, {passive: true});
  new MutationObserver(() => { readTheme(); wake(); }).observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
  motion.addEventListener('change', wake);
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    document.documentElement.classList.remove('has-sky');
    canvas.remove();
  });

  readTheme();
  document.body.prepend(canvas);
  document.documentElement.classList.add('has-sky');
  wake();
}

if (typeof document !== 'undefined') start();
